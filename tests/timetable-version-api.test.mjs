import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { createServer } from 'node:http'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'
import { createTestPostgresRepository, hasPostgresTestDatabase } from './postgres-test-helpers.mjs'

const test = hasPostgresTestDatabase ? nodeTest : nodeTest.skip
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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
    const staff = [{ id: 'teacher-1', name: 'Teacher One' }]
    const sections = [{ id: 'A', classAdvisorId: 'teacher-1' }]
    const configuration = {
      ...identity, sections, staff,
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
      academic: identity, staff, sections, coreSubjects: [], otherSubjectMaster: [], otherSubjects: [],
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

    const version = saved.timetableVersions.find(({ sectionName }) => sectionName === 'A')
    const lock = await fetch(`${origin}/api/timetable-versions/${version.versionId}/lock`, { method: 'POST' })
    assert.equal(lock.status, 200)
    assert.equal((await lock.json()).savedVersion.status, 'LOCKED')
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

    const blockedDelete = await fetch(`${origin}/api/timetable-versions/${version.versionId}`, { method: 'DELETE' })
    assert.equal(blockedDelete.status, 409)
    const unlock = await fetch(`${origin}/api/timetable-versions/${version.versionId}/unlock`, { method: 'POST' })
    assert.equal(unlock.status, 200)
    assert.equal((await unlock.json()).savedVersion.status, 'SAVED')
    const deletion = await fetch(`${origin}/api/timetable-versions/${version.versionId}`, { method: 'DELETE' })
    assert.equal(deletion.status, 200)
    assert.equal((await repository.getSavedTimetableNavigation()).length, 0)
  } finally {
    await stopServer()
    await testDatabase.cleanup()
  }
})
