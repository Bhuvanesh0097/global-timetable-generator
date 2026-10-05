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
    assert.deepEqual(migrations.map(({ version }) => Number(version)), [1, 2, 3])
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
