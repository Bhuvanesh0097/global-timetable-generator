import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { createTestPostgresRepository, hasPostgresTestDatabase } from './postgres-test-helpers.mjs'

const test = hasPostgresTestDatabase ? nodeTest : nodeTest.skip

test('PostgreSQL migrations create the timetable schema and preserve locked-version guards', async () => {
  const testDatabase = await createTestPostgresRepository()
  const repository = testDatabase.repository
  try {
    const tables = await repository.database.prepare(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
    `).all()
    const tableNames = tables.map(({ table_name }) => table_name)
    for (const name of [
      'teachers', 'timetable_configurations', 'sections', 'configuration_teachers',
      'configuration_items', 'item_teacher_assignments', 'generated_timetables',
      'timetable_versions', 'timetable_cells', 'schema_migrations',
    ]) assert.ok(tableNames.includes(name), `expected migrated table ${name}`)

    const triggers = await repository.database.prepare(`
      SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema = current_schema()
    `).all()
    assert.ok(triggers.some(({ trigger_name }) => trigger_name.includes('locked')))
    const migrations = await repository.database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    assert.deepEqual(migrations.map(({ version }) => Number(version)), [1, 2, 3, 4])
  } finally {
    await testDatabase.cleanup()
  }
})

test('PostgreSQL repository persists a configured timetable with Sunday and periods above eight', async () => {
  const testDatabase = await createTestPostgresRepository()
  const repository = testDatabase.repository
  try {
    const identity = {
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academicYear: '2026 - 2027',
    }
    const collegeTimings = {
      workingWeekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Sunday'],
      periodsPerDay: 9,
      periodDurationMinutes: 50,
      collegeStartTime: '08:50',
      breaks: [
        { kind: 'break', name: 'Morning Break', afterPeriod: 2, durationMinutes: 15 },
        { kind: 'lunch', name: 'Lunch', afterPeriod: 4, durationMinutes: 45 },
        { kind: 'break', name: 'Tea Break', afterPeriod: 6, durationMinutes: 10 },
      ],
      timingMode: 'automatic',
      teacherMaximumWeeklyPeriods: 48,
    }
    const staff = [{ id: 'teacher-configured-domain', name: 'Configured Domain Teacher' }]
    const configurationId = await repository.createTimetableConfiguration({
      ...identity,
      collegeTimings,
      sections: [{ id: 'A' }],
      staff,
      subjects: [{ id: 'subject-1', code: 'CSE201', name: 'Algorithms', weeklyHours: 54,
        teacherAssignments: [{ sectionId: 'A', teacherId: staff[0].id }] }],
    })
    const schedule = Object.fromEntries(collegeTimings.workingWeekdays.map((day) => [day,
      Object.fromEntries(Array.from({ length: collegeTimings.periodsPerDay }, (_, index) => [index + 1, {
        itemId: 'subject-1', code: 'CSE201', abbreviation: 'ALG', name: 'Algorithms', teacherId: staff[0].id, kind: 'core',
      }]))]))
    await repository.saveGeneratedTimetableData({
      configurationId,
      generationId: 'configured-domain-generation',
      sections: [{ sectionId: 'A', schedule }],
      setupSnapshot: { collegeTimings, staff },
      staff,
    })
    const saved = await repository.getSavedGeneration('configured-domain-generation', configurationId)
    assert.deepEqual(Object.keys(saved.sections[0].schedule), collegeTimings.workingWeekdays)
    assert.equal(saved.sections[0].schedule.Sunday[9].teacherId, staff[0].id)
    assert.equal(Object.values(saved.sections[0].schedule).reduce((count, day) => count + Object.keys(day).length, 0), 54)
  } finally {
    await testDatabase.cleanup()
  }
})

test('PostgreSQL repository persists configuration, versions, snapshots, and lock protection', async () => {
  const testDatabase = await createTestPostgresRepository()
  let repository = testDatabase.repository
  try {
    const identity = {
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academicYear: '2026 - 2027',
    }
    const configuration = {
      ...identity,
      sections: [{ id: 'A', classAdvisorId: 'teacher-1' }],
      staff: [{ id: 'teacher-1', name: 'Teacher One' }],
      subjects: [{
        id: 'subject-1', code: 'CSE201', name: 'Algorithms', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-1' }],
      }],
    }
    const configurationId = await repository.createTimetableConfiguration(configuration)
    const savedConfiguration = await repository.getTimetableConfiguration(configurationId)
    assert.equal(savedConfiguration.sections[0].classAdvisorId, 'teacher-1')
    assert.equal(savedConfiguration.subjects[0].teacherAssignments[0].teacherId, 'teacher-1')

    const schedule = Object.fromEntries(
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => [
        day,
        Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
          itemId: 'subject-1', code: 'CSE201', abbreviation: 'ALG', name: 'Algorithms',
          teacherId: 'teacher-1', kind: 'core',
        }])),
      ]),
    )
    const generation = {
      generationId: 'foundation-generation-1',
      sections: [{
        sectionId: 'A',
        schedule,
      }],
      setupSnapshot: { staff: configuration.staff, alternateSubjects: [{ id: 'placement', code: 'PLC' }] },
      validation: { valid: true },
    }
    const [saved] = await repository.saveGeneratedTimetableData({
      configurationId, ...generation, staff: configuration.staff,
    })
    assert.equal(saved.versionNumber, 1)
    assert.equal(saved.status, 'SAVED')
    const loaded = await repository.getSavedGeneration(generation.generationId, configurationId)
    assert.deepEqual(loaded.setupSnapshot, generation.setupSnapshot)
    assert.deepEqual(loaded.validation, generation.validation)

    await repository.setSavedTimetableVersionStatus({ versionId: saved.id, status: 'LOCKED' })
    await assert.rejects(
      repository.database.prepare(`
        UPDATE timetable_cells SET subject_name = ?
        WHERE timetable_version_id = ?
      `).run('Modified while locked', saved.id),
      /locked/i,
    )
    await assert.rejects(
      repository.deleteSavedTimetableVersion({ versionId: saved.id }),
      /locked/i,
    )
    assert.equal((await repository.getSavedTimetableNavigation())[0].status, 'LOCKED')
  } finally {
    await testDatabase.cleanup()
  }
})

test('global occupancy uses only the authoritative active timetable version and preserves history', async () => {
  const testDatabase = await createTestPostgresRepository()
  const repository = testDatabase.repository
  try {
    const identity = {
      department: 'CSE', year: 'III / 3rd Year', semester: 'V / 5th Semester', academicYear: '2026 - 2027',
    }
    const staff = [
      { id: 'teacher-old', name: 'Historical Teacher' },
      { id: 'teacher-active', name: 'Active Teacher' },
    ]
    const configuration = {
      ...identity,
      sections: [{ id: 'A' }],
      staff,
      subjects: [{
        id: 'subject-1', code: 'CSE501', name: 'Algorithms', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-old' }],
      }],
    }
    const configurationId = await repository.createTimetableConfiguration(configuration)
    const makeSchedule = (teacherId) => Object.fromEntries(
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => [
        day,
        Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
          itemId: 'subject-1', code: 'CSE501', abbreviation: 'ALG', name: 'Algorithms',
          teacherId, kind: 'core',
        }])),
      ]),
    )
    const saveGeneration = (generationId, teacherId) => repository.saveGeneratedTimetableData({
      configurationId,
      generationId,
      sections: [{ sectionId: 'A', schedule: makeSchedule(teacherId) }],
      setupSnapshot: { staff },
      validation: {},
      staff,
    })

    const [historical] = await saveGeneration('generation-historical', 'teacher-old')
    await repository.setSavedTimetableVersionStatus({ versionId: historical.id, status: 'LOCKED' })
    const [active] = await saveGeneration('generation-active', 'teacher-active')

    const occupancy = await repository.getTeacherUnavailableOccupancy({
      identity: { department: 'IOT', year: 'I', semester: 'I', academicYear: identity.academicYear },
      staff,
    })
    assert.deepEqual([...new Set(occupancy.unavailableSlots.map(({ teacherId }) => teacherId))], ['teacher-active'])
    assert.deepEqual([...new Set(occupancy.alternateWeekUnavailableSlots.map(({ teacherId }) => teacherId))], ['teacher-active'])
    assert.equal(occupancy.unavailableSlots.length, 48)

    const candidateSection = (teacherId) => ({
      sectionId: 'B',
      schedule: { Monday: { 3: { teacherId, name: 'Candidate Subject' } } },
    })
    const historicalTeacherConflicts = await repository.getTeacherGenerationOccupancyConflicts({
      identity: { department: 'IOT', year: 'I', semester: 'I', academicYear: identity.academicYear },
      sections: [candidateSection('teacher-old')],
      staff,
    })
    const activeTeacherConflicts = await repository.getTeacherGenerationOccupancyConflicts({
      identity: { department: 'IOT', year: 'I', semester: 'I', academicYear: identity.academicYear },
      sections: [candidateSection('teacher-active')],
      staff,
    })
    assert.equal(historicalTeacherConflicts.length, 0)
    assert.equal(activeTeacherConflicts.length, 1)

    const history = await repository.getSavedTimetableNavigation()
    assert.equal(history.length, 2)
    assert.equal(history.find(({ versionId }) => versionId === historical.id).status, 'LOCKED')
    assert.equal(history.find(({ versionId }) => versionId === historical.id).isActive, false)
    assert.equal(history.find(({ versionId }) => versionId === active.id).isActive, true)
  } finally {
    await testDatabase.cleanup()
  }
})

test('Placement occupancy uses the alternate teacher assigned to the active saved section by stable ID', async () => {
  const testDatabase = await createTestPostgresRepository()
  const repository = testDatabase.repository
  try {
    const identity = {
      department: 'CSE', year: 'III / 3rd Year', semester: 'V / 5th Semester', academicYear: '2026 - 2027',
    }
    const staff = [
      { id: 'placement-teacher', name: 'Placement Teacher' },
      { id: 'teacher-base', name: 'Base Teacher' },
      { id: 'alternate-A', name: 'Alternate A' },
      { id: 'alternate-B', name: 'Alternate B' },
    ]
    const configuration = {
      ...identity,
      sections: [{ id: 'A' }, { id: 'B' }],
      staff,
      subjects: [{
        id: 'subject-1', code: 'CSE501', name: 'Algorithms', weeklyHours: 47,
        teacherAssignments: [
          { sectionId: 'A', teacherId: 'teacher-base' },
          { sectionId: 'B', teacherId: 'teacher-base' },
        ],
      }],
      placement: {
        id: 'placement', code: 'PLC', name: 'Placement', enabled: true, weeklyPeriods: 1,
        teacherAssignments: [
          { sectionId: 'A', teacherId: 'placement-teacher' },
          { sectionId: 'B', teacherId: 'placement-teacher' },
        ],
      },
    }
    const configurationId = await repository.createTimetableConfiguration(configuration)
    const scheduleFor = (sectionId) => Object.fromEntries(
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => [
        day,
        Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
          const period = index + 1
          const isPlacement = day === 'Monday' && period === 1
          return [period, isPlacement
            ? {
              itemId: 'placement', code: 'PLC', abbreviation: 'PLC', name: 'Placement',
              teacherId: 'placement-teacher', kind: 'activity', blockId: `placement-${sectionId}`,
            }
            : {
              itemId: 'subject-1', code: 'CSE501', abbreviation: 'ALG', name: 'Algorithms',
              teacherId: 'teacher-base', kind: 'core',
            }]
        })),
      ]),
    )
    await repository.saveGeneratedTimetableData({
      configurationId,
      generationId: 'placement-occupancy-generation',
      sections: ['A', 'B'].map((sectionId) => ({ sectionId, schedule: scheduleFor(sectionId) })),
      setupSnapshot: {
        staff,
        placementException: {
          enabled: true,
          alternateSubjects: [
            {
              placementPosition: 1, sectionId: 'A', subjectId: 'alternate-subject-A',
              subjectKind: 'core', subjectNameSnapshot: 'Alternate Subject A',
              teacherAssignments: [{ sectionId: 'A', teacherId: 'alternate-A', teacherNameSnapshot: 'Alternate A' }],
            },
            {
              placementPosition: 1, sectionId: 'B', subjectId: 'alternate-subject-B',
              subjectKind: 'core', subjectNameSnapshot: 'Alternate Subject B',
              teacherAssignments: [{ sectionId: 'B', teacherId: 'alternate-B', teacherNameSnapshot: 'Alternate B' }],
            },
          ],
        },
      },
      validation: {},
      staff,
    })

    const occupancy = await repository.getTeacherUnavailableOccupancy({
      identity: { department: 'IOT', year: 'II / 2nd Year', semester: 'V', academicYear: identity.academicYear },
      staff: [staff[2], staff[3]],
    })
    assert.deepEqual(occupancy.alternateWeekUnavailableSlots
      .map(({ teacherId, day, period, existing }) => ({
        teacherId, day, period, section: existing.section,
      }))
      .sort((left, right) => left.teacherId.localeCompare(right.teacherId)), [
      { teacherId: 'alternate-A', day: 'Monday', period: 1, section: 'A' },
      { teacherId: 'alternate-B', day: 'Monday', period: 1, section: 'B' },
    ])

    const sameNameDifferentId = await repository.getTeacherUnavailableOccupancy({
      identity: { department: 'IOT', year: 'II / 2nd Year', semester: 'V', academicYear: identity.academicYear },
      staff: [{ id: 'alternate-A-renamed', name: 'Alternate A' }],
    })
    assert.deepEqual(sameNameDifferentId.alternateWeekUnavailableSlots, [])
  } finally {
    await testDatabase.cleanup()
  }
})
