import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { Pool, types } from 'pg'

const migrations = [
  { version: 1, name: 'initial_schema', url: new URL('./migrations/001_initial_schema.sql', import.meta.url) },
  { version: 2, name: 'saved_version_snapshots', url: new URL('./migrations/002_saved_version_snapshots.sql', import.meta.url) },
  { version: 3, name: 'locked_version_guards', url: new URL('./migrations/003_locked_version_guards.sql', import.meta.url) },
]
const validStatuses = new Set(['DRAFT', 'SAVED', 'LOCKED'])
const supportedDays = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
const migrationLockId = 716_204_817
const saveLockId = 716_204_818
types.setTypeParser(20, (value) => Number(value))

function normalizedTeacherName(name) {
  return String(name ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function comparableTeacherIdentity(name) {
  return String(name ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function serialize(value, fallback = '{}') {
  return JSON.stringify(value ?? {}) ?? fallback
}

function withTransaction(database, work) {
  if (database.transactionContext.getStore()) return work()
  return database.transaction(async (client) => database.transactionContext.run(client, work))
}

function postgresParameters(sql, parameters) {
  let index = 0
  const query = sql.replace(/\?/g, () => `$${++index}`)
  if (index !== parameters.length) {
    throw new Error(`PostgreSQL query expected ${index} parameters but received ${parameters.length}.`)
  }
  return { query, values: parameters }
}

class PostgresDatabase {
  constructor(pool) {
    this.pool = pool
    this.transactionContext = new AsyncLocalStorage()
  }

  async query(sql, values = []) {
    const { query, values: parameters } = sql.includes('?')
      ? postgresParameters(sql, values)
      : { query: sql, values }
    const client = this.transactionContext.getStore() ?? this.pool
    return client.query(query, parameters)
  }

  prepare(sql) {
    const ignoreConflicts = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)
    const statement = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO').trim()
    const query = ignoreConflicts ? `${statement.replace(/;$/, '')} ON CONFLICT DO NOTHING` : statement
    return {
      all: async (...parameters) => (await this.query(query, parameters)).rows,
      get: async (...parameters) => (await this.query(query, parameters)).rows[0],
      run: async (...parameters) => {
        const result = await this.query(query, parameters)
        return { changes: result.rowCount }
      },
    }
  }

  async transaction(work) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async close() {
    await this.pool.end()
  }
}

function rowToSection(row) {
  return {
    id: row.source_id,
    name: row.section_name,
    ...(row.class_advisor_teacher_id ? { classAdvisorId: row.class_advisor_teacher_id } : {}),
  }
}

function itemDefinitions(configuration) {
  return [
    ...(configuration.subjects ?? []).map((row) => ['CORE_SUBJECT', row]),
    ...(configuration.otherSubjects ?? []).map((row) => ['OTHER_SUBJECT', row]),
    ...(configuration.labs ?? []).map((row) => ['LAB', row]),
    ...(configuration.placement ? [['PLACEMENT', configuration.placement]] : []),
    ...(configuration.specialActivities ?? []).map((row) => ['SPECIAL_ACTIVITY', row]),
  ]
}

function itemToConfigurationRow(row, type, assignments) {
  const source = JSON.parse(row.source_json || '{}')
  const base = {
    ...source,
    id: row.source_id,
    code: row.code,
    name: row.name,
    teacherAssignments: source.teacherAssignments ?? assignments,
  }
  if (row.allowed_start_periods_json) base.allowedStartPeriods = JSON.parse(row.allowed_start_periods_json)
  if (row.block_duration !== null) base.blockDuration = row.block_duration
  if (type === 'CORE_SUBJECT' || type === 'OTHER_SUBJECT') {
    if (row.weekly_periods !== null) base.weeklyHours = row.weekly_periods
  } else if (row.weekly_periods !== null) base.weeklyPeriods = row.weekly_periods
  if (type === 'LAB') base.blockDuration = row.block_duration
  return base
}

function timetableRow(row) {
  if (!row) return null
  return {
    id: row.id,
    configurationId: row.configuration_id,
    sectionId: row.section_id,
    sectionName: row.section_name,
    generationId: row.generation_id,
    activeVersionId: row.active_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function versionRow(row) {
  if (!row) return null
  return {
    id: row.id,
    timetableId: row.timetable_id,
    versionNumber: row.version_number,
    status: row.status,
    generationId: row.generation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lockedAt: row.locked_at,
    validation: JSON.parse(row.validation_json || '{}'),
    setupSnapshot: JSON.parse(row.setup_snapshot_json || '{}'),
    ...(row.cell_count !== undefined ? { cellCount: row.cell_count } : {}),
  }
}

function cellRow(row) {
  return {
    id: row.id,
    timetableVersionId: row.timetable_version_id,
    configurationItemId: row.configuration_item_id,
    sourceItemKey: row.source_item_key,
    cellType: row.cell_type,
    day: row.day,
    period: row.period,
    subjectCode: row.subject_code,
    subjectName: row.subject_name,
    abbreviation: row.abbreviation ?? '',
    blockId: row.block_id ?? undefined,
    activityName: row.activity_name,
    isTest: Boolean(row.is_test),
    teacherId: row.teacher_id,
    teacherNameSnapshot: row.teacher_name_snapshot,
    sectionName: row.section_name,
    department: row.department,
    year: row.year,
    semester: row.semester,
    academicYear: row.academic_year,
    createdAt: row.created_at,
  }
}

function conflictMessage(conflicts) {
  return conflicts.map((conflict) => [
    `${conflict.teacherName} conflicts${conflict.week === 'alternate' ? ' in the alternate week' : ''} at ${conflict.day} P${conflict.period}.`,
    `Existing: ${conflict.existing.department}, ${conflict.existing.year}, ${conflict.existing.semester}, Section ${conflict.existing.section}, ${conflict.existing.subject}.`,
    `Candidate: ${conflict.candidate.department}, ${conflict.candidate.year}, ${conflict.candidate.semester}, Section ${conflict.candidate.section}, ${conflict.candidate.subject}.`,
  ].join('\n')).join('\n\n')
}

function invalidTimetableData(message) {
  const error = new Error(message)
  error.code = 'INVALID_TIMETABLE_DATA'
  return error
}

/** Opens the shared PostgreSQL database and applies pending versioned migrations. */
export async function openTimetableRepository({ databaseUrl = process.env.DATABASE_URL, schema } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required to connect to timetable storage.')
  if (schema && !/^mvit_test_[a-f0-9]+$/.test(schema)) throw new Error('PostgreSQL schema name is invalid.')
  if (schema) {
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 })
    try {
      await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    } finally {
      await adminPool.end()
    }
  }
  const database = new PostgresDatabase(new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  }))
  try {
    await database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId])
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      const currentVersion = rows[0]?.version ?? 0
      const latestVersion = migrations.at(-1).version
      if (currentVersion > latestVersion) {
        throw new Error(`Timetable database schema ${currentVersion} is newer than this application supports.`)
      }
      for (const migration of migrations.filter(({ version }) => version > currentVersion)) {
        await client.query(await readFile(migration.url, 'utf8'))
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
      }
    })
    return new TimetableRepository(database)
  } catch (error) {
    await database.close()
    throw error
  }
}

/** Node-only persistence services. This repository has no dependency on the scheduler or UI. */
export class TimetableRepository {
  constructor(database) {
    this.database = database
  }

  close() {
    return this.database.close()
  }

  withSaveTransaction(work) {
    return withTransaction(this.database, async () => {
      await this.database.query('SELECT pg_advisory_xact_lock($1)', [saveLockId])
      return work()
    })
  }

  async createTimetableConfiguration(configuration) {
    const id = configuration.id || randomUUID()
    const configurationVersion = configuration.configurationVersion ?? 1
    for (const field of ['department', 'year', 'semester', 'academicYear']) {
      if (!String(configuration[field] ?? '').trim()) throw new Error(`${field} is required for a timetable configuration.`)
    }
    if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
      throw new Error('Configuration version must be a positive whole number.')
    }

    return withTransaction(this.database, async () => {
      await this.database.prepare(`
        INSERT INTO timetable_configurations
          (id, department, year, semester, academic_year, configuration_version, rules_json, candidate_count, extra_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        String(configuration.department ?? ''),
        String(configuration.year ?? ''),
        String(configuration.semester ?? ''),
        String(configuration.academicYear ?? ''),
        configurationVersion,
        serialize(configuration.rules),
        Number.isInteger(configuration.candidateCount) ? configuration.candidateCount : null,
        serialize(configuration.extra),
      )

      const insertTeacher = this.database.prepare(`
        INSERT INTO teachers (id, canonical_name, normalized_name)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          normalized_name = excluded.normalized_name,
          updated_at = CURRENT_TIMESTAMP
      `)
      const insertConfigurationTeacher = this.database.prepare(
        'INSERT INTO configuration_teachers (configuration_id, teacher_id) VALUES (?, ?)',
      )
      const knownTeacherIds = new Set()
      for (const teacher of configuration.staff ?? []) {
        if (!teacher?.id) continue
        const canonicalName = String(teacher.canonicalName ?? teacher.name ?? '').trim()
        if (!canonicalName) throw new Error(`Staff ID ${teacher.id} needs a canonical name.`)
        await insertTeacher.run(teacher.id, canonicalName, normalizedTeacherName(canonicalName))
        if (!knownTeacherIds.has(teacher.id)) await insertConfigurationTeacher.run(id, teacher.id)
        knownTeacherIds.add(teacher.id)
      }

      const sectionRows = new Map()
      const insertSection = this.database.prepare(`
        INSERT INTO sections (id, configuration_id, source_id, section_name, class_advisor_teacher_id)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const section of configuration.sections ?? []) {
        const sourceId = String(section.id ?? section.sectionName ?? '').trim()
        const sectionName = String(section.sectionName ?? section.name ?? section.id ?? '').trim()
        if (!sourceId || !sectionName) throw new Error('Each configured section needs an ID and a name.')
        const databaseSectionId = randomUUID()
        const advisorId = section.classAdvisorId || null
        await insertSection.run(databaseSectionId, id, sourceId, sectionName, advisorId)
        sectionRows.set(sourceId, databaseSectionId)
      }

      const insertItem = this.database.prepare(`
        INSERT INTO configuration_items
          (id, configuration_id, source_id, item_type, code, name, weekly_periods, block_duration, enabled, allowed_start_periods_json, source_json, item_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const [itemOrder, [itemType, item]] of itemDefinitions(configuration).entries()) {
        const sourceId = String(item.id ?? '').trim()
        if (!sourceId) throw new Error(`${item.name || itemType} needs a stable ID.`)
        const databaseItemId = randomUUID()
        const weeklyPeriods = item.weeklyHours ?? item.weeklyPeriods ?? null
        const blockDuration = item.blockDuration ?? null
        const allowedStarts = item.allowedStartPeriods ?? null
        const sourceJson = { ...item }
        await insertItem.run(
          databaseItemId,
          id,
          sourceId,
          itemType,
          item.code ?? null,
          String(item.name ?? ''),
          weeklyPeriods === 0 ? null : weeklyPeriods,
          blockDuration,
          item.enabled === false ? 0 : 1,
          allowedStarts ? serialize(allowedStarts) : null,
          serialize(sourceJson),
          itemOrder,
        )
        for (const assignment of item.teacherAssignments ?? []) {
          const databaseSectionId = sectionRows.get(assignment.sectionId)
          if (!databaseSectionId) throw new Error(`${item.name || sourceId} has a teacher assignment for unknown Section ${assignment.sectionId}.`)
          const teacherId = assignment.teacherId || null
          if (!teacherId) continue
          // The relational index is one teacher per item/section. Preserve any
          // richer source assignment structure in source_json for exact reload.
          await this.database.prepare(`
            INSERT OR IGNORE INTO item_teacher_assignments
              (configuration_id, item_id, section_id, teacher_id)
            VALUES (?, ?, ?, ?)
          `).run(id, databaseItemId, databaseSectionId, teacherId)
        }
      }
      return id
    })
  }

  async getTimetableConfiguration(configurationId) {
    const row = await this.database.prepare('SELECT * FROM timetable_configurations WHERE id = ?').get(configurationId)
    if (!row) return null
    const sections = await this.getSections(configurationId)
    const staff = (await this.getTeachers(configurationId)).map(({ id, canonicalName }) => ({ id, name: canonicalName }))
    const assignments = await this.database.prepare(`
      SELECT assignments.item_id, sections.source_id AS section_source_id, assignments.teacher_id
      FROM item_teacher_assignments assignments
      JOIN sections ON sections.id = assignments.section_id
      WHERE assignments.configuration_id = ?
      ORDER BY sections.section_name
    `).all(configurationId)
    const assignmentMap = new Map()
    for (const assignment of assignments) {
      if (!assignmentMap.has(assignment.item_id)) assignmentMap.set(assignment.item_id, [])
      assignmentMap.get(assignment.item_id).push({ sectionId: assignment.section_source_id, teacherId: assignment.teacher_id ?? '' })
    }
    const rows = await this.database.prepare(`
      SELECT * FROM configuration_items WHERE configuration_id = ? ORDER BY item_type, item_order
    `).all(configurationId)
    const groups = new Map()
    for (const item of rows) {
      if (!groups.has(item.item_type)) groups.set(item.item_type, [])
      const mapped = itemToConfigurationRow(item, item.item_type, assignmentMap.get(item.id) ?? [])
      if (item.item_type === 'PLACEMENT') groups.set(item.item_type, mapped)
      else groups.get(item.item_type).push(mapped)
    }
    const extra = JSON.parse(row.extra_json || '{}')
    return {
      ...extra,
      id: row.id,
      configurationVersion: row.configuration_version,
      department: row.department,
      year: row.year,
      semester: row.semester,
      academicYear: row.academic_year,
      sections,
      staff,
      subjects: groups.get('CORE_SUBJECT') ?? [],
      otherSubjects: groups.get('OTHER_SUBJECT') ?? [],
      labs: groups.get('LAB') ?? [],
      ...(groups.has('PLACEMENT') ? { placement: groups.get('PLACEMENT') } : {}),
      specialActivities: groups.get('SPECIAL_ACTIVITY') ?? [],
      rules: JSON.parse(row.rules_json || '{}'),
      ...(row.candidate_count === null ? {} : { candidateCount: row.candidate_count }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async getSections(configurationId) {
    return (await this.database.prepare(`
      SELECT source_id, section_name, class_advisor_teacher_id
      FROM sections WHERE configuration_id = ? ORDER BY section_name
    `).all(configurationId)).map(rowToSection)
  }

  async getTeachers(configurationId) {
    const rows = configurationId
      ? this.database.prepare(`
          SELECT teachers.id, teachers.canonical_name, teachers.normalized_name, teachers.created_at, teachers.updated_at
          FROM teachers
          JOIN configuration_teachers ON configuration_teachers.teacher_id = teachers.id
          WHERE configuration_teachers.configuration_id = ?
          ORDER BY teachers.normalized_name, teachers.id
        `).all(configurationId)
      : this.database.prepare(`
          SELECT id, canonical_name, normalized_name, created_at, updated_at
          FROM teachers ORDER BY normalized_name, id
        `).all()
    return (await rows).map((teacher) => ({
      id: teacher.id,
      canonicalName: teacher.canonical_name,
      normalizedName: teacher.normalized_name,
      createdAt: teacher.created_at,
      updatedAt: teacher.updated_at,
    }))
  }

  async getTimetableConfigurationByIdentity({ department, year, semester, academicYear, configurationVersion = 1 }) {
    const row = await this.database.prepare(`
      SELECT id FROM timetable_configurations
      WHERE department = ? AND year = ? AND semester = ? AND academic_year = ? AND configuration_version = ?
    `).get(department, year, semester, academicYear, configurationVersion)
    return row?.id ?? null
  }

  async saveGeneratedTimetableData({ configurationId, generationId = randomUUID(), sections, validation = {}, setupSnapshot = {}, staff }) {
    const configuration = await this.database.prepare('SELECT * FROM timetable_configurations WHERE id = ?').get(configurationId)
    if (!configuration) throw new Error(`Timetable configuration ${configurationId} does not exist.`)
    if (typeof generationId !== 'string' || !generationId.trim()) throw invalidTimetableData('A generated timetable needs a non-empty generation ID.')
    if (!Array.isArray(sections) || sections.length === 0) throw new Error('At least one generated section is required.')
    const candidateStaff = staff ?? await this.getTeachers(configurationId)
    const candidateStaffById = new Map()
    for (const teacher of candidateStaff) {
      const teacherId = String(teacher?.id ?? '').trim()
      const canonicalName = String(teacher?.canonicalName ?? teacher?.name ?? '').trim()
      if (!teacherId || !canonicalName) throw invalidTimetableData('Every generated timetable teacher needs a stable ID and name.')
      candidateStaffById.set(teacherId, canonicalName)
    }
    if (candidateStaffById.size !== candidateStaff.length) throw invalidTimetableData('Generated timetable teacher IDs must be unique.')
    const sectionIds = sections.map((section) => String(section?.sectionId ?? '').trim())
    if (sectionIds.some((sectionId) => !sectionId) || new Set(sectionIds).size !== sectionIds.length) {
      throw invalidTimetableData('Generated section IDs must be present and unique.')
    }
    for (const generatedSection of sections) {
      const schedule = generatedSection.schedule
      if (!schedule || typeof schedule !== 'object'
        || Object.keys(schedule).length !== supportedDays.size
        || [...supportedDays].some((day) => !Object.hasOwn(schedule, day))) {
        throw invalidTimetableData(`Section ${generatedSection.sectionId} must include all six timetable days.`)
      }
      let occupiedCells = 0
      for (const day of supportedDays) {
        const dayCells = schedule[day]
        if (!dayCells || typeof dayCells !== 'object' || Object.keys(dayCells).length !== 8
          || Array.from({ length: 8 }, (_, index) => String(index + 1)).some((period) => !Object.hasOwn(dayCells, period))) {
          throw invalidTimetableData(`Section ${generatedSection.sectionId} ${day} must include periods 1 through 8 exactly once.`)
        }
        for (const [periodText, cell] of Object.entries(dayCells)) {
          occupiedCells += 1
          if (!cell || typeof cell !== 'object' || !String(cell.itemId ?? '').trim()
            || !String(cell.name ?? '').trim() || !String(cell.abbreviation ?? '').trim()
            || !candidateStaffById.has(String(cell.teacherId ?? '').trim())
            || !['core', 'other', 'lab', 'activity'].includes(cell.kind)) {
            throw invalidTimetableData(`Section ${generatedSection.sectionId} ${day} P${periodText} has incomplete timetable data or an unknown teacher.`)
          }
          if (cell.isCoreTest && (cell.kind !== 'core' || periodText !== '1')) {
            throw invalidTimetableData(`Section ${generatedSection.sectionId} ${day} P${periodText} has an invalid Core Test cell.`)
          }
          if (cell.alternateSubject && (cell.kind !== 'activity'
            || !String(cell.alternateSubject.subjectId ?? '').trim()
            || !candidateStaffById.has(String(cell.alternateSubject.teacherId ?? '').trim()))) {
            throw invalidTimetableData(`Section ${generatedSection.sectionId} ${day} P${periodText} has invalid alternate-week subject data.`)
          }
        }
      }
      if (occupiedCells !== 48) throw invalidTimetableData(`Section ${generatedSection.sectionId} must contain exactly 48 timetable periods.`)
    }

    return withTransaction(this.database, async () => {
      await this.database.query('SELECT pg_advisory_xact_lock($1)', [saveLockId])
      const occupancyConflicts = await this.getTeacherGenerationOccupancyConflicts({
        identity: {
          department: configuration.department,
          year: configuration.year,
          semester: configuration.semester,
          academicYear: configuration.academic_year,
        },
        sections,
        staff: staff ?? await this.getTeachers(configurationId),
      })
      if (occupancyConflicts.length) {
        const error = new Error(`Saved timetable teacher occupancy conflict:\n${conflictMessage(occupancyConflicts)}`)
        error.code = 'TEACHER_OCCUPANCY_CONFLICT'
        error.conflicts = occupancyConflicts
        throw error
      }

      const sectionRows = await this.database.prepare(`
        SELECT id, source_id, section_name FROM sections WHERE configuration_id = ?
      `).all(configurationId)
      const sectionBySourceId = new Map(sectionRows.map((section) => [section.source_id, section]))
      const configItems = await this.database.prepare(`
        SELECT id, source_id, item_type FROM configuration_items WHERE configuration_id = ?
      `).all(configurationId)
      const upsertTeacher = this.database.prepare(`
        INSERT INTO teachers (id, canonical_name, normalized_name)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          normalized_name = excluded.normalized_name,
          updated_at = CURRENT_TIMESTAMP
      `)
      const linkTeacher = this.database.prepare(`
        INSERT OR IGNORE INTO configuration_teachers (configuration_id, teacher_id) VALUES (?, ?)
      `)
      const staffNames = new Map()
      for (const teacher of candidateStaff) {
        const teacherId = String(teacher?.id ?? '').trim()
        const canonicalName = candidateStaffById.get(teacherId)
        await upsertTeacher.run(teacherId, canonicalName, normalizedTeacherName(canonicalName))
        await linkTeacher.run(configurationId, teacherId)
        staffNames.set(teacherId, canonicalName)
      }
      const result = []
      const findTimetable = this.database.prepare(
        'SELECT * FROM generated_timetables WHERE configuration_id = ? AND section_id = ?',
      )
      const insertTimetable = this.database.prepare(`
        INSERT INTO generated_timetables (id, configuration_id, section_id, generation_id)
        VALUES (?, ?, ?, ?)
      `)
      const alreadySaved = this.database.prepare(`
        SELECT versions.id FROM timetable_versions versions
        JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
        WHERE timetables.configuration_id = ? AND versions.generation_id = ? LIMIT 1
      `).get(configurationId, generationId)
      const existingGeneration = await alreadySaved
      if (existingGeneration) throw new Error(`Generation ${generationId} has already been saved.`)

      const insertVersion = this.database.prepare(`
        INSERT INTO timetable_versions
          (id, timetable_id, version_number, status, generation_id, locked_at, validation_json, setup_snapshot_json)
        VALUES (?, ?, ?, 'SAVED', ?, NULL, ?, ?)
      `)
      const insertCell = this.database.prepare(`
        INSERT INTO timetable_cells
          (id, timetable_version_id, configuration_item_id, source_item_key, cell_type, day, period, subject_code, subject_name, abbreviation, block_id, activity_name,
           is_test, teacher_id, teacher_name_snapshot, section_name, department, year, semester, academic_year)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const updateActive = this.database.prepare(`
        UPDATE generated_timetables
        SET generation_id = ?, active_version_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)

      for (const generatedSection of sections) {
        const section = sectionBySourceId.get(generatedSection.sectionId)
        if (!section) throw new Error(`Generated Section ${generatedSection.sectionId} is not in configuration ${configurationId}.`)
        for (const [field, configuredValue] of [
          ['department', configuration.department],
          ['academicYear', configuration.academic_year],
          ['year', configuration.year],
          ['semester', configuration.semester],
        ]) {
          if (generatedSection[field] !== undefined && generatedSection[field] !== configuredValue) {
            throw invalidTimetableData(`Generated Section ${generatedSection.sectionId} has mismatched ${field} metadata.`)
          }
        }
        let timetable = await findTimetable.get(configurationId, section.id)
        if (!timetable) {
          const id = randomUUID()
          await insertTimetable.run(id, configurationId, section.id, generationId)
          timetable = await findTimetable.get(configurationId, section.id)
        }
        const versionNumber = this.database.prepare(
          'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM timetable_versions WHERE timetable_id = ?',
        ).get(timetable.id)
        const nextVersion = (await versionNumber).next_version
        const versionId = randomUUID()
        await insertVersion.run(versionId, timetable.id, nextVersion, generationId, serialize(validation), serialize(setupSnapshot))

        for (const [day, dayCells] of Object.entries(generatedSection.schedule ?? {})) {
          if (!supportedDays.has(day)) throw new Error(`Unsupported timetable day ${day}.`)
          for (const [periodText, cell] of Object.entries(dayCells ?? {})) {
            const period = Number(periodText)
            if (!Number.isInteger(period) || period < 1 || period > 8) throw new Error(`Invalid teaching period ${periodText}.`)
            if (!cell?.teacherId || !staffNames.has(cell.teacherId)) throw new Error(`A generated cell at ${day} P${period} has no known teacher identity.`)
            const cellType = cell.kind === 'core' ? 'SUBJECT'
              : cell.kind === 'other' ? 'OTHER_SUBJECT'
                : cell.kind === 'lab' ? 'LAB'
                  : cell.kind === 'activity' ? 'SPECIAL_ACTIVITY' : null
            if (!cellType) throw new Error(`Unsupported generated cell type ${cell.kind}.`)
            const itemType = cell.kind === 'core' ? 'CORE_SUBJECT'
              : cell.kind === 'other' ? 'OTHER_SUBJECT'
                : cell.kind === 'lab' ? 'LAB'
                  : null
            const linkedItem = configItems
              .filter((item) => itemType ? item.item_type === itemType : ['PLACEMENT', 'SPECIAL_ACTIVITY'].includes(item.item_type))
              .filter((item) => cell.itemId === item.source_id || cell.itemId.endsWith(`:${item.source_id}`))
              .sort((left, right) => right.source_id.length - left.source_id.length)[0]
            const persistedCellType = cell.kind === 'activity' && linkedItem?.item_type === 'PLACEMENT'
              ? 'PLACEMENT'
              : cellType
            const isActivity = cell.kind === 'activity'
            await insertCell.run(
              randomUUID(), versionId, linkedItem?.id ?? null, cell.itemId ?? null, persistedCellType, day, period,
              isActivity ? null : (cell.code || null),
              isActivity ? null : (cell.name || null),
              cell.abbreviation || null,
              cell.blockId || null,
              isActivity ? (cell.name || null) : null,
              cell.isCoreTest ? 1 : 0,
              cell.teacherId,
              staffNames.get(cell.teacherId),
              section.section_name,
              configuration.department,
              configuration.year,
              configuration.semester,
              configuration.academic_year,
            )
          }
        }
        await updateActive.run(generationId, versionId, timetable.id)
        result.push(await this.getActiveVersion(timetable.id))
      }
      return result
    })
  }

  async getTeacherOccupancyConflicts({ identity, sections, staff = [] }) {
    const existingOccupancy = await this.database.prepare(`
      SELECT cells.teacher_id, cells.teacher_name_snapshot, cells.day, cells.period,
        cells.department, cells.year, cells.semester, cells.section_name,
        COALESCE(cells.activity_name, cells.subject_name, cells.subject_code, 'Unlabeled activity') AS subject,
        configurations.department AS configured_department, configurations.year AS configured_year,
        configurations.semester AS configured_semester, configurations.academic_year
      FROM timetable_cells cells
      JOIN timetable_versions versions ON versions.id = cells.timetable_version_id
      JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
      JOIN timetable_configurations configurations ON configurations.id = timetables.configuration_id
      WHERE versions.status IN ('SAVED', 'LOCKED')
        AND versions.id = timetables.active_version_id
        AND NOT (
          configurations.department = ? AND configurations.year = ?
          AND configurations.semester = ? AND configurations.academic_year = ?
        )
    `).all(
      identity.department,
      identity.year,
      identity.semester,
      identity.academicYear,
    )
    const teacherNames = new Map(staff.map((teacher) => [teacher.id, teacher.canonicalName ?? teacher.name ?? teacher.id]))
    const existingBySlotAndTeacher = new Map()
    for (const existing of existingOccupancy) {
      if (!existing.teacher_id) continue
      const key = `${existing.teacher_id}|${existing.day}|${existing.period}`
      if (!existingBySlotAndTeacher.has(key)) existingBySlotAndTeacher.set(key, existing)
    }
    const conflicts = []
    for (const section of sections ?? []) {
      for (const [day, dayCells] of Object.entries(section.schedule ?? {})) {
        for (const [periodText, cell] of Object.entries(dayCells ?? {})) {
          if (!cell?.teacherId) continue
          const period = Number(periodText)
          const existing = existingBySlotAndTeacher.get(`${cell.teacherId}|${day}|${period}`)
          if (!existing) continue
          conflicts.push({
            teacherId: cell.teacherId,
            teacherName: teacherNames.get(cell.teacherId) ?? existing.teacher_name_snapshot ?? cell.teacherId,
            day,
            period,
            existing: {
              department: existing.configured_department,
              year: existing.configured_year,
              semester: existing.configured_semester,
              section: existing.section_name,
              subject: existing.subject,
            },
            candidate: {
              department: identity.department,
              year: identity.year,
              semester: identity.semester,
              section: section.sectionId,
              subject: cell.name || cell.code || 'Unlabeled activity',
            },
          })
        }
      }
    }
    return conflicts
  }

  async getTeacherGenerationOccupancyConflicts({ identity, sections, staff = [] }) {
    const { unavailableSlots, alternateWeekUnavailableSlots } = await this.getTeacherUnavailableOccupancy({ identity, staff })
    const normalBySlotAndTeacher = new Map(unavailableSlots.map((slot) => [`${slot.teacherId}|${slot.day}|${slot.period}`, slot]))
    const alternateBySlotAndTeacher = new Map(alternateWeekUnavailableSlots.map((slot) => [`${slot.teacherId}|${slot.day}|${slot.period}`, slot]))
    const teacherNames = new Map(staff.map((teacher) => [teacher.id, teacher.canonicalName ?? teacher.name ?? teacher.id]))
    const conflicts = []
    for (const section of sections ?? []) {
      for (const [day, dayCells] of Object.entries(section.schedule ?? {})) {
        for (const [periodText, cell] of Object.entries(dayCells ?? {})) {
          if (!cell?.teacherId) continue
          const period = Number(periodText)
          const addConflict = (teacherId, existing, week) => {
            conflicts.push({
              teacherId,
              teacherName: teacherNames.get(teacherId) ?? teacherId,
              day,
              period,
              ...(week === 'alternate' ? { week } : {}),
              existing: existing.existing,
              candidate: {
                department: identity.department,
                year: identity.year,
                semester: identity.semester,
                section: section.sectionId,
                subject: cell.name || cell.code || 'Unlabeled activity',
              },
            })
          }
          const normalConflict = normalBySlotAndTeacher.get(`${cell.teacherId}|${day}|${period}`)
          if (normalConflict) addConflict(cell.teacherId, normalConflict, 'normal')

          const alternateTeacherId = cell.alternateSubject?.teacherId ?? cell.teacherId
          if (alternateTeacherId !== cell.teacherId || !normalConflict) {
            const alternateConflict = alternateBySlotAndTeacher.get(`${alternateTeacherId}|${day}|${period}`)
            if (alternateConflict) addConflict(alternateTeacherId, alternateConflict, 'alternate')
          }
        }
      }
    }
    return conflicts
  }

  async getTeacherUnavailableSlots({ identity, staff = [] }) {
    return (await this.getTeacherUnavailableOccupancy({ identity, staff })).unavailableSlots
  }

  async getTeacherUnavailableOccupancy({ identity, staff = [] }) {
    const existingOccupancy = await this.database.prepare(`
      SELECT versions.id AS version_id, versions.setup_snapshot_json,
        cells.teacher_id, cells.teacher_name_snapshot, cells.day, cells.period, cells.cell_type, cells.block_id,
        cells.department, cells.year, cells.semester, cells.section_name,
        sections.source_id AS section_source_id,
        COALESCE(cells.activity_name, cells.subject_name, cells.subject_code, 'Unlabeled activity') AS subject,
        configurations.department AS configured_department, configurations.year AS configured_year,
        configurations.semester AS configured_semester, configurations.academic_year
      FROM timetable_cells cells
      JOIN timetable_versions versions ON versions.id = cells.timetable_version_id
      JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
      JOIN sections ON sections.id = timetables.section_id
      JOIN timetable_configurations configurations ON configurations.id = timetables.configuration_id
      WHERE versions.status IN ('SAVED', 'LOCKED')
        AND versions.id = timetables.active_version_id
        AND NOT (
          configurations.department = ? AND configurations.year = ?
          AND configurations.semester = ? AND configurations.academic_year = ?
        )
    `).all(
      identity.department,
      identity.year,
      identity.semester,
      identity.academicYear,
    )

    const candidateNames = new Map(staff.map((teacher) => [teacher.id, teacher.canonicalName ?? teacher.name ?? teacher.id]))
    const unavailable = new Map()
    const alternateWeekUnavailable = new Map()
    const setupSnapshots = new Map()
    const snapshotFor = (existing) => {
      if (!setupSnapshots.has(existing.version_id)) {
        try { setupSnapshots.set(existing.version_id, JSON.parse(existing.setup_snapshot_json || '{}')) }
        catch { setupSnapshots.set(existing.version_id, {}) }
      }
      return setupSnapshots.get(existing.version_id)
    }
    const placementBlocks = new Map()
    for (const existing of existingOccupancy) {
      const placementException = snapshotFor(existing).placementException
      if (existing.cell_type !== 'PLACEMENT' || placementException?.enabled !== true) continue
      const blockKey = `${existing.version_id}|${existing.day}|${existing.block_id || `unblocked:${existing.section_name}`}`
      const block = placementBlocks.get(blockKey) ?? []
      block.push(existing)
      placementBlocks.set(blockKey, block)
    }
    const alternateTeacherForCell = new Map()
    for (const block of placementBlocks.values()) {
      const ordered = [...block].sort((left, right) => left.period - right.period)
      const placementException = snapshotFor(ordered[0]).placementException
      for (const [index, existing] of ordered.entries()) {
        const alternate = placementException.alternateSubjects?.find((row) => row.placementPosition === index + 1)
        const assignment = alternate?.teacherAssignments?.find((row) => row.sectionId === existing.section_source_id)
        if (assignment?.teacherId) alternateTeacherForCell.set(existing, {
          teacherId: assignment.teacherId,
          teacherName: assignment.teacherNameSnapshot
            || snapshotFor(existing).staff?.find((teacher) => teacher.id === assignment.teacherId)?.name
            || assignment.teacherId,
        })
      }
    }
    // Resolve aliases against teachers who actually occupy active saved slots.
    // Candidate configuration rows are deliberately excluded: registering a
    // formatting variant must not make a unique saved identity ambiguous.
    const persistedIds = new Set()
    const persistedIdsByName = new Map()
    const rememberPersistedTeacher = (teacherId, teacherName) => {
      if (!teacherId) return
      persistedIds.add(teacherId)
      const comparableName = comparableTeacherIdentity(teacherName)
      if (!comparableName) return
      const ids = persistedIdsByName.get(comparableName) ?? new Set()
      ids.add(teacherId)
      persistedIdsByName.set(comparableName, ids)
    }
    for (const existing of existingOccupancy) {
      rememberPersistedTeacher(existing.teacher_id, existing.teacher_name_snapshot)
      const alternate = alternateTeacherForCell.get(existing)
      if (alternate) rememberPersistedTeacher(alternate.teacherId, alternate.teacherName)
    }
    const candidateToPersistedIds = new Map()
    for (const teacher of staff) {
      if (!teacher?.id) continue
      if (persistedIds.has(teacher.id)) {
        candidateToPersistedIds.set(teacher.id, teacher.id)
        continue
      }
      const matchingPersistedIds = persistedIdsByName.get(comparableTeacherIdentity(teacher.canonicalName ?? teacher.name))
      // Formatting-only name variations may bridge to one occupied identity.
      // Ambiguous active names are deliberately not merged.
      if (matchingPersistedIds?.size === 1) candidateToPersistedIds.set(teacher.id, matchingPersistedIds.values().next().value)
    }
    const candidateIdsByPersistedId = new Map()
    for (const [candidateId, persistedId] of candidateToPersistedIds) {
      const ids = candidateIdsByPersistedId.get(persistedId) ?? new Set()
      ids.add(candidateId)
      candidateIdsByPersistedId.set(persistedId, ids)
    }
    const persistedIdFor = (teacherId, teacherName) => {
      if (!teacherId) return undefined
      if (persistedIds.has(teacherId)) return teacherId
      const matchingPersistedIds = persistedIdsByName.get(comparableTeacherIdentity(teacherName))
      return matchingPersistedIds?.size === 1 ? matchingPersistedIds.values().next().value : undefined
    }
    const addUnavailable = (target, existing, persistedTeacherId) => {
      const candidateIds = candidateIdsByPersistedId.get(persistedTeacherId)
      if (!candidateIds) return
      for (const teacherId of candidateIds) {
        const key = `${teacherId}|${existing.day}|${existing.period}`
        if (target.has(key)) continue
        target.set(key, {
          teacherId,
          day: existing.day,
          period: existing.period,
          teacherName: candidateNames.get(teacherId) ?? existing.teacher_name_snapshot ?? teacherId,
          existing: {
            department: existing.configured_department,
            year: existing.configured_year,
            semester: existing.configured_semester,
            section: existing.section_name,
            subject: existing.subject,
          },
        })
      }
    }
    for (const existing of existingOccupancy) {
      if (!existing.teacher_id) continue
      const snapshot = snapshotFor(existing)
      addUnavailable(unavailable, existing, persistedIdFor(existing.teacher_id, existing.teacher_name_snapshot))
      const alternate = alternateTeacherForCell.get(existing)
      const alternateName = alternate?.teacherName
        ?? snapshot.staff?.find((teacher) => teacher.id === existing.teacher_id)?.name
        ?? existing.teacher_name_snapshot
      addUnavailable(alternateWeekUnavailable, existing,
        persistedIdFor(alternate?.teacherId ?? existing.teacher_id, alternateName))
    }
    return {
      unavailableSlots: [...unavailable.values()],
      alternateWeekUnavailableSlots: [...alternateWeekUnavailable.values()],
    }
  }

  async getTimetableById(timetableId) {
    const row = await this.database.prepare(`
      SELECT timetables.*, sections.section_name
      FROM generated_timetables timetables
      JOIN sections ON sections.id = timetables.section_id
      WHERE timetables.id = ?
    `).get(timetableId)
    if (!row) return null
    const timetable = timetableRow(row)
    return { ...timetable, activeVersion: await this.getActiveVersion(timetableId) }
  }

  async getTimetableVersions(timetableId) {
    return (await this.database.prepare(`
      SELECT versions.*, (SELECT COUNT(*) FROM timetable_cells cells WHERE cells.timetable_version_id = versions.id) AS cell_count
      FROM timetable_versions versions WHERE versions.timetable_id = ?
      ORDER BY versions.version_number DESC
    `).all(timetableId)).map(versionRow)
  }

  async getSavedTimetableNavigation() {
    return (await this.database.prepare(`
      SELECT versions.id AS version_id, versions.generation_id, versions.version_number, versions.status,
        versions.created_at, versions.locked_at, configurations.department,
        configurations.year, configurations.semester, configurations.academic_year,
        sections.section_name,
        CASE WHEN timetables.active_version_id = versions.id THEN 1 ELSE 0 END AS is_active,
        (SELECT COUNT(*) FROM timetable_cells cells WHERE cells.timetable_version_id = versions.id) AS cell_count
      FROM timetable_versions versions
      JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
      JOIN sections ON sections.id = timetables.section_id
      JOIN timetable_configurations configurations ON configurations.id = timetables.configuration_id
      WHERE versions.status IN ('SAVED', 'LOCKED')
      ORDER BY configurations.department, configurations.year,
        configurations.semester, sections.section_name, versions.version_number DESC,
        versions.created_at DESC
    `).all()).map((row) => ({
      versionId: row.version_id,
      generationId: row.generation_id,
      versionNumber: row.version_number,
      status: row.status,
      createdAt: row.created_at,
      lockedAt: row.locked_at,
      sectionCount: 1,
      cellCount: row.cell_count,
      department: row.department,
      year: row.year,
      semester: row.semester,
      academicYear: row.academic_year,
      sectionName: row.section_name,
      isActive: Boolean(row.is_active),
    }))
  }

  async deleteSavedTimetableVersion({ versionId }) {
    return withTransaction(this.database, async () => {
      const version = await this.database.prepare(`
        SELECT versions.id, versions.timetable_id, versions.generation_id,
          versions.version_number, versions.status,
          sections.section_name, timetables.active_version_id
        FROM timetable_versions versions
        JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
        JOIN sections ON sections.id = timetables.section_id
        WHERE versions.id = ?
      `).get(versionId)
      if (!version) throw new Error('That saved timetable version was not found.')
      if (version.status === 'LOCKED') throw new Error('Locked timetable versions cannot be deleted. Unlock the version first.')
      if (version.status !== 'SAVED') throw new Error('Only SAVED timetable versions can be deleted.')

      const cellCount = await this.database.prepare(
        'SELECT COUNT(*) AS count FROM timetable_cells WHERE timetable_version_id = ?',
      ).get(versionId).count
      let activeVersionId = version.active_version_id
      if (version.active_version_id === versionId) {
        const fallback = await this.database.prepare(`
          SELECT id, generation_id FROM timetable_versions
          WHERE timetable_id = ? AND id <> ? AND status IN ('SAVED', 'LOCKED')
          ORDER BY version_number DESC, created_at DESC, id DESC LIMIT 1
        `).get(version.timetable_id, versionId)
        activeVersionId = fallback?.id ?? null
        await this.database.prepare(`
          UPDATE generated_timetables
          SET active_version_id = ?, generation_id = COALESCE(?, generation_id), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(activeVersionId, fallback?.generation_id ?? null, version.timetable_id)
      }

      await this.database.prepare('DELETE FROM timetable_versions WHERE id = ?').run(versionId)
      return {
        versionId,
        generationId: version.generation_id,
        versionNumber: version.version_number,
        sectionName: version.section_name,
        deletedCellCount: cellCount,
        activeVersionId,
      }
    })
  }

  async getSavedGenerationSummaries({ department, year, semester, academicYear }) {
    const rows = await this.database.prepare(`
      SELECT versions.generation_id, MAX(versions.version_number) AS version_number,
        MIN(versions.created_at) AS created_at, MAX(versions.status) AS status,
        MAX(versions.locked_at) AS locked_at,
        COUNT(DISTINCT timetables.section_id) AS section_count,
        SUM((SELECT COUNT(*) FROM timetable_cells cells WHERE cells.timetable_version_id = versions.id)) AS cell_count,
        MAX(CASE WHEN timetables.active_version_id = versions.id THEN 1 ELSE 0 END) AS is_active
      FROM timetable_versions versions
      JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
      JOIN timetable_configurations configurations ON configurations.id = timetables.configuration_id
      WHERE configurations.department = ? AND configurations.year = ?
        AND configurations.semester = ? AND configurations.academic_year = ?
      GROUP BY versions.generation_id
      ORDER BY MAX(versions.version_number) DESC, MIN(versions.created_at) DESC, versions.generation_id DESC
    `).all(department, year, semester, academicYear)
    return rows.map((row) => ({
      generationId: row.generation_id,
      versionNumber: row.version_number,
      createdAt: row.created_at,
      status: row.status,
      lockedAt: row.locked_at,
      sectionCount: row.section_count,
      cellCount: row.cell_count,
      isActive: Boolean(row.is_active),
    }))
  }

  async setSavedTimetableVersionStatus({ versionId, status }) {
    if (!['SAVED', 'LOCKED'].includes(status)) throw new Error('A saved timetable can only be locked or explicitly unlocked.')
    return withTransaction(this.database, async () => {
      const version = await this.database.prepare(`
        SELECT versions.id, versions.status
        FROM timetable_versions versions
        JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
        WHERE versions.id = ?
        FOR UPDATE OF versions
      `).get(versionId)
      if (!version) throw new Error(`Saved timetable version ${versionId} was not found.`)
      const currentStatus = version.status
      if (currentStatus === status) return this.getSavedTimetableVersion(versionId)
      if (status === 'LOCKED' && currentStatus !== 'SAVED') throw new Error('Only a SAVED timetable version can be locked.')
      if (status === 'SAVED' && currentStatus !== 'LOCKED') throw new Error('Only a LOCKED timetable version can be explicitly unlocked.')

      const updatedRows = await this.database.prepare(`
        UPDATE timetable_versions
        SET status = ?, locked_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, status === 'LOCKED' ? new Date().toISOString() : null, versionId)
      if (updatedRows.changes !== 1) throw new Error(`Saved timetable version ${versionId} was not updated.`)
      const updatedVersion = await this.getSavedTimetableVersion(versionId)
      if (updatedVersion?.versionId !== versionId) throw new Error('The updated timetable version did not match the requested database version ID.')
      return updatedVersion
    })
  }

  async getSavedTimetableVersion(versionId) {
    const version = await this.database.prepare(`
      SELECT versions.*, timetables.configuration_id, timetables.section_id,
        sections.source_id AS section_source_id, sections.section_name,
        configurations.department, configurations.year, configurations.semester, configurations.academic_year
      FROM timetable_versions versions
      JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
      JOIN sections ON sections.id = timetables.section_id
      JOIN timetable_configurations configurations ON configurations.id = timetables.configuration_id
      WHERE versions.id = ?
    `).get(versionId)
    if (!version) return null
    return {
      versionId: version.id,
      generationId: version.generation_id,
      configurationId: version.configuration_id,
      sectionName: version.section_name,
      validation: JSON.parse(version.validation_json || '{}'),
      setupSnapshot: JSON.parse(version.setup_snapshot_json || '{}'),
      sections: [await this.savedVersionSection(version)],
      versions: [versionRow(version)],
    }
  }

  async savedVersionSection(version) {
    const rows = await this.database.prepare(`
      SELECT * FROM timetable_cells WHERE timetable_version_id = ?
      ORDER BY CASE day
        WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
        WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 END,
        period
    `).all(version.id)
    const setupSnapshot = JSON.parse(version.setup_snapshot_json || '{}')
    const placementException = setupSnapshot.placementException
    const placementPositions = new Map()
    const schedule = Object.fromEntries([...supportedDays].map((day) => [day, {}]))
    for (const row of rows) {
      const cell = cellRow(row)
      const kind = cell.cellType === 'SUBJECT' ? 'core'
        : cell.cellType === 'OTHER_SUBJECT' ? 'other'
          : cell.cellType === 'LAB' ? 'lab' : 'activity'
      const scheduledCell = {
        itemId: cell.sourceItemKey ?? cell.configurationItemId ?? '',
        ...(cell.blockId ? { blockId: cell.blockId } : {}),
        code: cell.subjectCode ?? '',
        abbreviation: cell.abbreviation ?? '',
        name: cell.activityName ?? cell.subjectName ?? '',
        teacherId: cell.teacherId ?? '',
        kind,
        ...(cell.isTest ? { isCoreTest: true } : {}),
      }
      if (cell.cellType === 'PLACEMENT' && placementException?.enabled === true) {
        const blockKey = `${cell.day}|${cell.blockId || 'unblocked-placement'}`
        const placementPosition = (placementPositions.get(blockKey) ?? 0) + 1
        placementPositions.set(blockKey, placementPosition)
        const alternate = placementException.alternateSubjects?.find((candidate) => candidate.placementPosition === placementPosition)
        const assignment = alternate?.teacherAssignments?.find((candidate) => candidate.sectionId === version.section_source_id)
        if (alternate && assignment?.teacherId) {
          const subjectRows = alternate.subjectKind === 'core'
            ? setupSnapshot.coreSubjects
            : setupSnapshot.otherSubjects
          const subject = subjectRows?.find((candidate) => candidate.id === alternate.subjectId)
          scheduledCell.alternateSubject = {
            placementPosition,
            subjectId: alternate.subjectId,
            subjectKind: alternate.subjectKind,
            code: subject?.code ?? '',
            abbreviation: subject?.abbreviation?.trim() || subject?.code?.trim() || alternate.subjectNameSnapshot,
            name: alternate.subjectNameSnapshot,
            teacherId: assignment.teacherId,
            teacherNameSnapshot: assignment.teacherNameSnapshot
              || setupSnapshot.staff?.find((teacher) => teacher.id === assignment.teacherId)?.name
              || assignment.teacherId,
          }
        }
      }
      schedule[cell.day][cell.period] = scheduledCell
    }
    return {
      sectionId: version.section_source_id,
      profileId: version.configuration_id,
      department: version.department,
      academicYear: version.academic_year,
      year: version.year,
      semester: version.semester,
      schedule,
    }
  }

  async getSavedGeneration(generationId, configurationId) {
    const versions = await this.database.prepare(`
      SELECT versions.*, timetables.configuration_id, timetables.section_id,
        sections.source_id AS section_source_id, sections.section_name,
        configurations.department, configurations.year, configurations.semester, configurations.academic_year
      FROM timetable_versions versions
      JOIN generated_timetables timetables ON timetables.id = versions.timetable_id
      JOIN sections ON sections.id = timetables.section_id
      JOIN timetable_configurations configurations ON configurations.id = timetables.configuration_id
      WHERE versions.generation_id = ? AND timetables.configuration_id = ?
      ORDER BY sections.section_name
    `).all(generationId, configurationId)
    if (versions.length === 0) return null

    const first = versions[0]
    const scheduleSections = await Promise.all(versions.map((version) => this.savedVersionSection(version)))
    return {
      generationId,
      configurationId,
      validation: JSON.parse(first.validation_json || '{}'),
      setupSnapshot: JSON.parse(first.setup_snapshot_json || '{}'),
      sections: scheduleSections,
      versions: versions.map(versionRow),
    }
  }

  async getActiveVersion(timetableId) {
    const row = await this.database.prepare(`
      SELECT versions.* FROM generated_timetables timetables
      JOIN timetable_versions versions ON versions.id = timetables.active_version_id
      WHERE timetables.id = ?
    `).get(timetableId)
    if (!row) return null
    const cells = (await this.database.prepare(`
      SELECT * FROM timetable_cells WHERE timetable_version_id = ?
      ORDER BY CASE day
        WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
        WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 END,
        period
    `).all(row.id)).map(cellRow)
    return { ...versionRow(row), cells }
  }
}
