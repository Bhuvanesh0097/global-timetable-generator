import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { createServer } from 'node:http'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'
import { getDefaultCollegeTimings } from '../src/college-timings.ts'
import { buildOfficialTimetableGrid } from '../src/official-timetable-grid.ts'
import { createTestPostgresRepository, hasPostgresTestDatabase } from './postgres-test-helpers.mjs'

const test = hasPostgresTestDatabase ? nodeTest : nodeTest.skip
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

nodeTest('version API accepts a valid non-default College Timings domain when saving', async () => {
  const identity = {
    department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academicYear: '2026 - 2027',
  }
  const collegeTimings = {
    workingWeekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    periodsPerDay: 7,
    periodDurationMinutes: 50,
    collegeStartTime: '08:50',
    breaks: [
      { kind: 'break', name: 'Morning Break', afterPeriod: 2, durationMinutes: 15 },
      { kind: 'lunch', name: 'Lunch', afterPeriod: 3, durationMinutes: 45 },
    ],
    timingMode: 'automatic',
    teacherMaximumWeeklyPeriods: 40,
  }
  const staff = [{ id: 'teacher-domain', name: 'Teacher Domain' }]
  const schedules = Object.fromEntries(collegeTimings.workingWeekdays.map((day) => [day,
    Object.fromEntries(Array.from({ length: collegeTimings.periodsPerDay }, (_, index) => [index + 1, {
      itemId: 'subject-domain', name: 'Configured Subject', abbreviation: 'CS', teacherId: staff[0].id, kind: 'core',
    }]))]))
  let persisted
  const repository = {
    async getTimetableConfigurationByIdentity() { return 'configuration-domain' },
    async withSaveTransaction(work) { return work() },
    async getSavedGeneration() { return null },
    async saveGeneratedTimetableData(input) { persisted = input },
    async getSavedGenerationSummaries() { return [{ generationId: 'generation-domain', versionNumber: 1 }] },
    async getSavedTimetableNavigation() { return [] },
  }
  const middleware = createTimetableApiMiddleware(repository)
  const server = createServer((request, response) => {
    void middleware(request, response, () => { response.statusCode = 404; response.end() })
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  try {
    const setupSnapshot = {
      academic: identity, collegeTimings, staff, sections: [{ id: 'A' }], coreSubjects: [], otherSubjectMaster: [],
      otherSubjects: [], labMaster: [], labAssignments: [], specialActivities: [], sectionSubjectAssignments: [],
      specialActivityAssignments: [],
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/timetable-versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configuration: { ...identity, collegeTimings, sections: [{ id: 'A' }], staff, subjects: [] },
        generationId: 'generation-domain', sections: [{ sectionId: 'A', ...identity, schedule: schedules }],
        setupSnapshot, validation: { periodsFilled: 35 },
      }),
    })
    const payload = await response.json()
    assert.equal(response.status, 201, payload.error)
    assert.equal(persisted.setupSnapshot.collegeTimings.periodsPerDay, 7)
    assert.deepEqual(persisted.setupSnapshot.collegeTimings, collegeTimings)
    assert.deepEqual(Object.keys(persisted.sections[0].schedule), collegeTimings.workingWeekdays)
    assert.equal(Object.values(persisted.sections[0].schedule).reduce((total, day) => total + Object.keys(day).length, 0), 35)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('version API persists, locks, reloads, unlocks, and deletes a PostgreSQL timetable', async () => {
  const testDatabase = await createTestPostgresRepository()
  let repository = testDatabase.repository
  let server
  const startServer = async () => {
    const middleware = createTimetableApiMiddleware(repository)
    server = createServer((request, response) => {
      void middleware(request, response, () => {
        response.statusCode = 404
        response.end()
      })
    })
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    return `http://127.0.0.1:${server.address().port}`
  }
  const stopServer = async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
  }

  try {
    let origin = await startServer()
    const identity = {
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academicYear: '2026 - 2027',
    }
    const collegeTimings = getDefaultCollegeTimings()
    const staff = [
      { id: 'teacher-1', name: 'Teacher One' },
      { id: 'teacher-2', name: 'Teacher Two' },
    ]
    const sections = [{ id: 'A', classAdvisorId: 'teacher-1' }]
    const configuration = {
      ...identity, collegeTimings, sections, staff,
      subjects: [{ id: 'subject-1', code: 'CSE201', abbreviation: 'ALG', name: 'Algorithms', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-1' }] }],
    }
    const schedule = Object.fromEntries(days.map((day) => [day, Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [index + 1, {
        itemId: 'subject-1', name: 'Algorithms', abbreviation: 'ALG',
        teacherId: 'teacher-1', teacherName: 'Teacher One', kind: 'core',
      }]),
    )]))
    const setupSnapshot = {
      academic: identity, collegeTimings, staff, sections, coreSubjects: [], otherSubjectMaster: [], otherSubjects: [],
      labMaster: [], labAssignments: [], specialActivities: [], sectionSubjectAssignments: [],
      specialActivityAssignments: [],
    }
    const save = await fetch(`${origin}/api/timetable-versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configuration, generationId: 'postgres-api-generation-1',
        sections: [{ sectionId: 'A', ...identity, schedule }], setupSnapshot, validation: { valid: true },
      }),
    })
    const saved = await save.json()
    assert.equal(save.status, 201, saved.error)
    assert.equal(saved.savedVersion.status, 'SAVED')
    assert.equal(saved.savedVersion.versionNumber, 1)
    const savedWorkload = await repository.getActiveTeacherWeeklyWorkloadSections()
    assert.equal(savedWorkload.length, 1)
    assert.equal(savedWorkload[0].normal.length, 48)
    assert.ok(savedWorkload[0].normal.every(({ teacherId }) => teacherId === 'teacher-1'))

    const version = saved.timetableVersions.find(({ sectionName }) => sectionName === 'A')
    const lock = await fetch(`${origin}/api/timetable-versions/${version.versionId}/lock`, { method: 'POST' })
    assert.equal(lock.status, 200)
    const locked = await lock.json()
    assert.equal(locked.savedVersion.status, 'LOCKED')
    assert.deepEqual(locked.savedTimetableVersion.setupSnapshot.collegeTimings, collegeTimings)
    await stopServer()
    await testDatabase.close(repository)
    repository = await testDatabase.open()
    origin = await startServer()

    const loadedResponse = await fetch(`${origin}/api/timetable-versions/${version.versionId}`)
    const loaded = await loadedResponse.json()
    assert.equal(loadedResponse.status, 200)
    assert.deepEqual(loaded.sections[0].schedule, schedule)
    assert.deepEqual(loaded.setupSnapshot, setupSnapshot)
    assert.equal(loaded.versions[0].status, 'LOCKED')
    assert.deepEqual(loaded.setupSnapshot.collegeTimings, collegeTimings)
    const lockedWorkload = await repository.getActiveTeacherWeeklyWorkloadSections()
    assert.equal(lockedWorkload[0].normal.length, 48)
    assert.ok(lockedWorkload[0].normal.every(({ teacherId }) => teacherId === 'teacher-1'))

    const futureCollegeTimings = {
      ...collegeTimings,
      workingWeekdays: days.slice(0, 5),
      periodsPerDay: 7,
      teacherMaximumWeeklyPeriods: 40,
    }
    const replacementSchedule = Object.fromEntries(futureCollegeTimings.workingWeekdays.map((day) => [day, Object.fromEntries(
      Array.from({ length: futureCollegeTimings.periodsPerDay }, (_, index) => [index + 1, {
        itemId: 'subject-1', name: 'Algorithms', abbreviation: 'ALG',
        teacherId: 'teacher-2', teacherName: 'Teacher Two', kind: 'core',
      }]),
    )]))
    const futureSetupSnapshot = { ...setupSnapshot, collegeTimings: futureCollegeTimings }
    const [futureVersion] = await repository.saveGeneratedTimetableData({
      configurationId: saved.configurationId,
      generationId: 'postgres-api-generation-2',
      sections: [{ sectionId: 'A', ...identity, schedule: replacementSchedule }],
      validation: { valid: true },
      setupSnapshot: futureSetupSnapshot,
      staff,
    })
    const futureLoadResponse = await fetch(`${origin}/api/timetable-versions/${futureVersion.id}`)
    const futureLoaded = await futureLoadResponse.json()
    assert.equal(futureLoadResponse.status, 200)
    assert.deepEqual(futureLoaded.setupSnapshot.collegeTimings, futureCollegeTimings)
    assert.deepEqual(futureLoaded.sections[0].schedule, replacementSchedule)
    const reopenedGrid = buildOfficialTimetableGrid(futureLoaded.setupSnapshot.collegeTimings)
    assert.deepEqual(reopenedGrid.days, futureCollegeTimings.workingWeekdays)
    assert.equal(reopenedGrid.rows.filter(({ kind }) => kind === 'period').length, 7)
    assert.ok(reopenedGrid.rows.some(({ kind, label }) => kind === 'break' && label === 'Lunch'))

    const versionHistory = await repository.getTimetableVersions(loaded.versions[0].timetableId)
    assert.deepEqual(versionHistory.map(({ versionNumber, setupSnapshot: snapshot }) => ({
      versionNumber, collegeTimings: snapshot.collegeTimings,
    })), [
      { versionNumber: 2, collegeTimings: futureCollegeTimings },
      { versionNumber: 1, collegeTimings },
    ])
    const replacementWorkload = await repository.getActiveTeacherWeeklyWorkloadSections()
    assert.equal(replacementWorkload.length, 1)
    assert.equal(replacementWorkload[0].normal.length, 35)
    assert.ok(replacementWorkload[0].normal.every(({ teacherId }) => teacherId === 'teacher-2'))
    const staffTimetable = await repository.getOverallStaffTimetable('teacher-2')
    assert.equal(staffTimetable.days.Monday[1].assignments.length, 1)
    assert.equal(staffTimetable.days.Monday[1].assignments[0].versionId, futureVersion.id)

    const blockedDelete = await fetch(`${origin}/api/timetable-versions/${version.versionId}`, { method: 'DELETE' })
    assert.equal(blockedDelete.status, 409)
    const unlock = await fetch(`${origin}/api/timetable-versions/${version.versionId}/unlock`, { method: 'POST' })
    assert.equal(unlock.status, 200)
    const unlocked = await unlock.json()
    assert.equal(unlocked.savedVersion.status, 'SAVED')
    assert.deepEqual(unlocked.savedTimetableVersion.setupSnapshot.collegeTimings, collegeTimings)
    const deletion = await fetch(`${origin}/api/timetable-versions/${version.versionId}`, { method: 'DELETE' })
    assert.equal(deletion.status, 200)
    assert.equal((await repository.getSavedTimetableNavigation()).length, 1)
    assert.equal((await repository.getSavedTimetableNavigation())[0].versionId, futureVersion.id)
    const afterInactiveDelete = await repository.getActiveTeacherWeeklyWorkloadSections()
    assert.equal(afterInactiveDelete.length, 1)
    assert.ok(afterInactiveDelete[0].normal.every(({ teacherId }) => teacherId === 'teacher-2'))
  } finally {
    await stopServer()
    await testDatabase.cleanup()
  }
})
