import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openTimetableRepository } from '../backend/timetable-repository.mjs'
import { generateGenericTimetable } from '../src/generic-scheduler.ts'

test('SQLite repository persists generic configuration, versions, cells and identities across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-timetable-db-'))
  const filename = join(directory, 'timetable.sqlite')
  let repository

  try {
    repository = openTimetableRepository({ filename })
    const configuration = {
      department: 'Future Department',
      academicYear: '2027-2028',
      year: '4th Year',
      semester: 'Even',
      configurationVersion: 2,
      sections: [
        { id: 'A', name: 'Section A', classAdvisorId: 'teacher-core' },
        { id: 'B', name: 'Section B', classAdvisorId: 'teacher-b' },
      ],
      staff: [
        { id: 'teacher-core', name: 'Core Teacher' },
        { id: 'teacher-lab', name: 'Lab Teacher' },
        { id: 'teacher-placement', name: 'Placement Teacher' },
        { id: 'teacher-activity', name: 'Activity Teacher' },
        { id: 'teacher-other', name: 'Professor Alex Lee' },
        { id: 'teacher-b', name: 'Professor Alex Lee' },
      ],
      subjects: [
        { id: 'core-course', code: 'FUT401', abbreviation: 'FC', name: 'Future Core', weeklyHours: 10,
          teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-core' }, { sectionId: 'B', teacherId: 'teacher-core' }] },
        { id: 'core-course-2', code: 'FUT404', abbreviation: 'FC2', name: 'Future Core 2', weeklyHours: 10,
          teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-core' }, { sectionId: 'B', teacherId: 'teacher-core' }] },
        { id: 'core-course-3', code: 'FUT405', abbreviation: 'FC3', name: 'Future Core 3', weeklyHours: 10,
          teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-core' }, { sectionId: 'B', teacherId: 'teacher-core' }] },
      ],
      otherSubjects: [{ id: 'other-course', code: 'FUT402', name: 'Other Subject', weeklyHours: 6,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-other' }, { sectionId: 'B', teacherId: 'teacher-b' }] },
      { id: 'unconfigured-other', name: 'Unconfigured Other', weeklyHours: null, enabled: false, teacherAssignments: [] }],
      labs: [{ id: 'lab-course', code: 'FUT403L', name: 'Future Lab', weeklyPeriods: 6, blockDuration: 3,
        allowedStartPeriods: [2, 6], teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-lab' }, { sectionId: 'B', teacherId: 'teacher-lab' }] },
      { id: 'unconfigured-lab', name: 'Unconfigured Lab', weeklyPeriods: null, blockDuration: null, enabled: false, teacherAssignments: [] }],
      placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-placement' }, { sectionId: 'B', teacherId: 'teacher-placement' }] },
      specialActivities: [{ id: 'activity', name: 'Special Activity', enabled: true, weeklyPeriods: 2, blockDuration: 2,
        allowedStartPeriods: [2, 6], teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-activity' }, { sectionId: 'B', teacherId: 'teacher-activity' }] },
      { id: 'unconfigured-activity', name: 'Unconfigured Activity', weeklyPeriods: null, enabled: false, teacherAssignments: [] }],
      rules: { p1Tests: { enabled: true, subjectIds: ['core-course'], testsPerSubject: 1 }, coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
      candidateCount: 2,
    }

    const configurationId = repository.createTimetableConfiguration(configuration)
    const restoredConfiguration = repository.getTimetableConfiguration(configurationId)
    assert.equal(restoredConfiguration.department, 'Future Department')
    assert.equal(restoredConfiguration.year, '4th Year')
    assert.equal(restoredConfiguration.semester, 'Even')
    assert.deepEqual(restoredConfiguration.sections.map(({ id }) => id), ['A', 'B'])
    assert.equal(restoredConfiguration.subjects.reduce((total, subject) => total + subject.weeklyHours, 0), 30)
    assert.equal(restoredConfiguration.labs[0].blockDuration, 3)
    assert.equal(restoredConfiguration.otherSubjects[1].weeklyHours, null)
    assert.equal(restoredConfiguration.specialActivities[1].enabled, false)
    assert.equal(restoredConfiguration.placement.weeklyPeriods, 4)
    assert.deepEqual(restoredConfiguration.specialActivities[0].allowedStartPeriods, [2, 6])

    const teachers = repository.getTeachers(configurationId)
    assert.equal(teachers.length, 6)
    assert.equal(teachers.filter(({ canonicalName }) => canonicalName === 'Professor Alex Lee').length, 2,
      'separate stable teacher IDs with equal or similar names must not be merged')
    assert.equal(teachers.find(({ id }) => id === 'teacher-core').normalizedName, 'core teacher')

    // Generate Section A through the existing generic engine; persistence receives its result and never runs the scheduler.
    const sectionA = configuration.sections[0]
    const sectionAConfiguration = {
      ...configuration,
      sections: [sectionA],
      subjects: configuration.subjects.map((item) => ({ ...item, teacherAssignments: item.teacherAssignments.filter(({ sectionId }) => sectionId === 'A') })),
      otherSubjects: configuration.otherSubjects.map((item) => ({ ...item, teacherAssignments: item.teacherAssignments.filter(({ sectionId }) => sectionId === 'A') })),
      labs: configuration.labs.map((item) => ({ ...item, teacherAssignments: item.teacherAssignments.filter(({ sectionId }) => sectionId === 'A') })),
      placement: { ...configuration.placement, teacherAssignments: configuration.placement.teacherAssignments.filter(({ sectionId }) => sectionId === 'A') },
      specialActivities: configuration.specialActivities.map((item) => ({ ...item, teacherAssignments: item.teacherAssignments.filter(({ sectionId }) => sectionId === 'A') })),
    }
    const generated = generateGenericTimetable(sectionAConfiguration)
    assert.equal(generated.ok, true, generated.ok ? '' : generated.blockingConstraints.join('\n'))
    if (!generated.ok) return
    const firstWrite = repository.saveGeneratedTimetableData({
      configurationId,
      generationId: 'generation-1',
      sections: generated.sections,
      validation: generated.validation,
      setupSnapshot: {
        academic: { department: 'Future Department', year: '4th Year', semester: 'Even', academicYear: '2027-2028' },
        sections: configuration.sections,
      },
    })
    assert.equal(firstWrite.length, 1)
    assert.equal(firstWrite[0].status, 'SAVED')
    assert.equal(firstWrite[0].cells.length, 48)
    assert.equal(firstWrite[0].cells.filter(({ isTest }) => isTest).length, 1)
    assert.equal(firstWrite[0].cells.filter(({ cellType }) => cellType === 'LAB').length, 6)
    assert.equal(firstWrite[0].cells.filter(({ cellType }) => cellType === 'PLACEMENT').length, 4)
    assert.equal(firstWrite[0].cells.filter(({ cellType }) => cellType === 'SPECIAL_ACTIVITY').length, 2)
    assert.equal(firstWrite[0].cells.filter(({ cellType }) => cellType === 'OTHER_SUBJECT').length, 6)
    assert.ok(firstWrite[0].cells.every((cell) => cell.teacherNameSnapshot))
    assert.equal(firstWrite[0].cells.find(({ isTest }) => isTest).subjectName, 'Future Core')
    assert.equal(firstWrite[0].cells.find(({ cellType }) => cellType === 'PLACEMENT').activityName, 'Placement')
    assert.equal(firstWrite[0].cells.find(({ isTest }) => isTest).abbreviation, 'FC (T)')
    assert.ok(firstWrite[0].cells.filter(({ cellType }) => cellType === 'LAB').every(({ blockId }) => blockId))

    const timetableId = firstWrite[0].timetableId
    const timetable = repository.getTimetableById(timetableId)
    assert.equal(timetable.sectionName, 'Section A')
    assert.equal(timetable.activeVersion.id, firstWrite[0].id)
    assert.equal(timetable.activeVersion.cells.length, 48)
    assert.equal(repository.getTimetableVersions(timetableId)[0].versionNumber, 1)

    const secondWrite = repository.saveGeneratedTimetableData({
      configurationId,
      generationId: 'generation-2',
      sections: generated.sections,
      validation: generated.validation,
      setupSnapshot: { academic: { department: 'Future Department', year: '4th Year', semester: 'Even', academicYear: '2027-2028' } },
    })
    assert.equal(secondWrite[0].versionNumber, 2)
    assert.equal(repository.getTimetableVersions(timetableId).length, 2)
    const firstSavedGeneration = repository.getSavedGeneration('generation-1', configurationId)
    const originalTestCell = firstWrite[0].cells.find(({ isTest }) => isTest)
    const restoredTestCell = firstSavedGeneration.sections[0].schedule[originalTestCell.day][originalTestCell.period]
    assert.equal(restoredTestCell.kind, 'core')
    assert.equal(restoredTestCell.abbreviation, 'FC (T)')
    assert.equal(firstSavedGeneration.validation.sections[0].periodsFilled, 48)
    assert.equal(firstSavedGeneration.setupSnapshot.academic.department, 'Future Department')
    assert.deepEqual(firstSavedGeneration.sections[0].schedule, generated.sections[0].schedule,
      'loading a saved generic timetable restores all 48 generated periods without running the scheduler')
    assert.deepEqual(firstSavedGeneration.sections[0].schedule, generated.sections[0].schedule,
      'loading a saved generic timetable restores every period, subject, teacher, block, test marker, and alternate-week subject exactly')
    assert.deepEqual(repository.getSavedGenerationSummaries({
      department: configuration.department,
      year: configuration.year,
      semester: configuration.semester,
      academicYear: configuration.academicYear,
    }).map(({ generationId, versionNumber, isActive }) => ({ generationId, versionNumber, isActive })), [
      { generationId: 'generation-2', versionNumber: 2, isActive: true },
      { generationId: 'generation-1', versionNumber: 1, isActive: false },
    ])
    repository.close()
    repository = null

    const repositoryModuleUrl = new URL('../backend/timetable-repository.mjs', import.meta.url).href
    const restartProbe = `
      import { openTimetableRepository } from ${JSON.stringify(repositoryModuleUrl)}
      const repository = openTimetableRepository({ filename: process.env.TIMETABLE_DATABASE_PATH })
      const timetable = repository.getTimetableById(${JSON.stringify(timetableId)})
      const result = {
        configuration: repository.getTimetableConfiguration(${JSON.stringify(configurationId)})?.id,
        sections: repository.getSections(${JSON.stringify(configurationId)}).map(({ id }) => id),
        activeGeneration: timetable?.activeVersion?.generationId,
        activeCellCount: timetable?.activeVersion?.cells.length,
        teacherSnapshot: timetable?.activeVersion?.cells[0]?.teacherNameSnapshot,
      }
      console.log(JSON.stringify(result))
      repository.close()
    `
    const restartedProcess = spawnSync(process.execPath, ['--input-type=module', '-e', restartProbe], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, TIMETABLE_DATABASE_PATH: filename },
    })
    assert.equal(restartedProcess.status, 0, restartedProcess.stderr)
    const restartResult = JSON.parse(restartedProcess.stdout.trim())
    assert.equal(restartResult.configuration, configurationId)
    assert.deepEqual(restartResult.sections, ['A', 'B'])
    assert.equal(restartResult.activeGeneration, 'generation-2')
    assert.equal(restartResult.activeCellCount, 48)

    repository = openTimetableRepository({ filename })
    const reopenedConfiguration = repository.getTimetableConfiguration(configurationId)
    const reopenedTimetable = repository.getTimetableById(timetableId)
    assert.equal(reopenedConfiguration.id, configurationId)
    assert.deepEqual(repository.getSections(configurationId).map(({ id }) => id), ['A', 'B'])
    assert.equal(reopenedTimetable.activeVersion.generationId, 'generation-2')
    assert.equal(reopenedTimetable.activeVersion.versionNumber, 2)
    assert.equal(reopenedTimetable.activeVersion.cells.length, 48)
    const firstCellTeacher = repository.getTeachers().find(({ id }) => id === reopenedTimetable.activeVersion.cells[0].teacherId)
    assert.equal(reopenedTimetable.activeVersion.cells[0].teacherNameSnapshot, firstCellTeacher.canonicalName)
    assert.deepEqual(repository.getTimetableVersions(timetableId).map(({ versionNumber }) => versionNumber), [2, 1])
  } finally {
    repository?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('existing Phase 7 database upgrades in place for saved-version snapshots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-timetable-migration-'))
  const filename = join(directory, 'phase-7.sqlite')
  let repository

  try {
    const database = new DatabaseSync(filename)
    database.exec(readFileSync(new URL('../backend/migrations/001_initial_schema.sql', import.meta.url), 'utf8'))
    database.exec('PRAGMA user_version = 1')
    database.close()

    repository = openTimetableRepository({ filename })
    assert.equal(repository.database.prepare('PRAGMA user_version').get().user_version, 3)
    assert.ok(repository.database.prepare('PRAGMA table_info(timetable_cells)').all().some(({ name }) => name === 'abbreviation'))
    assert.ok(repository.database.prepare('PRAGMA table_info(timetable_cells)').all().some(({ name }) => name === 'block_id'))
    assert.ok(repository.database.prepare('PRAGMA table_info(timetable_versions)').all().some(({ name }) => name === 'setup_snapshot_json'))
    assert.ok(repository.database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_locked_timetable_cell_update'").get())
  } finally {
    repository?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
