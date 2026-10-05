import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'

const identity = {
  department: 'IOT',
  academicYear: '2026 - 2027',
  year: 'II / 2nd Year',
  semester: 'V / 5th Semester',
}

const configuration = {
  ...identity,
  sections: [{ id: 'A' }],
  staff: [
    { id: 'ST003', name: 'Teacher Three' },
    { id: 'ST099', name: 'Unused Global Staff Member' },
  ],
  subjects: [{ id: 'subject-1', weeklyHours: 48, teacherAssignments: [{ sectionId: 'A', teacherId: 'ST003' }] }],
  candidateCount: 4,
  randomSeed: 73,
  rules: { searchNodeLimit: 300_000, allowCoreSubjectsInP1: false },
  placementException: { enabled: false, allocationMode: 'custom', alternateSubjects: [] },
}

async function withApi(repository, runGeneration, callback) {
  const middleware = createTimetableApiMiddleware(repository, { runGeneration })
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  try {
    await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('generation API loads global occupancy and passes the complete scheduler input to its worker', async () => {
  const occupied = [{ teacherId: 'ST003', day: 'Monday', period: 3 }]
  let workerInput
  let occupancyLookups = 0
  let persistenceCalls = 0
  const repository = {
    async getTeacherUnavailableOccupancy(input) {
      occupancyLookups += 1
      assert.deepEqual(input.identity, identity)
      assert.deepEqual(input.staff, [configuration.staff[0]])
      return { unavailableSlots: occupied, alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return []
    },
    async saveGeneratedTimetableData() {
      persistenceCalls += 1
    },
  }
  const result = {
    ok: false,
    code: 'SEARCH_LIMIT',
    message: 'Search limit reached.',
    blockingConstraints: ['search limit'],
  }

  await withApi(repository, async (input) => {
    workerInput = input
    return { result }
  }, async (origin) => {
    const response = await fetch(`${origin}/api/timetable/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configuration,
        reservedSections: [{ sectionId: 'B', schedule: {} }],
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).result, result)
  })

  assert.equal(occupancyLookups, 1)
  assert.equal(persistenceCalls, 0)
  assert.deepEqual(workerInput.configuration, configuration)
  assert.deepEqual(workerInput.reservedSections, [{ sectionId: 'B', schedule: {} }])
  assert.deepEqual(workerInput.unavailableTeacherSlots, occupied)
  assert.deepEqual(workerInput.alternateWeekUnavailableTeacherSlots, [])
})

test('generation API refreshes occupancy and retries a conflicting candidate without saving it', async () => {
  let occupancyLookups = 0
  let generationCalls = 0
  const generatedSection = { sectionId: 'A', schedule: { Monday: { 3: { teacherId: 'ST003', name: 'Subject' } } } }
  const repository = {
    async getTeacherUnavailableOccupancy() {
      occupancyLookups += 1
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return generationCalls === 1
        ? [{
          teacherId: 'ST003', teacherName: 'Teacher Three', day: 'Monday', period: 3,
          existing: { department: 'CSE', year: 'III / 3rd Year', semester: 'V', section: 'B', subject: 'Existing' },
          candidate: { department: 'IOT', year: identity.year, semester: identity.semester, section: 'A', subject: 'Subject' },
        }]
        : []
    },
  }

  await withApi(repository, async () => {
    generationCalls += 1
    return { result: { ok: true, sections: [generatedSection], searchNodes: 1, validation: { sections: [], globalTeacherClashes: 0 } } }
  }, async (origin) => {
    const response = await fetch(`${origin}/api/timetable/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration, reservedSections: [] }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).result.ok, true)
  })

  assert.equal(generationCalls, 2)
  assert.equal(occupancyLookups, 2)
})

test('generation API rejects incomplete input before loading occupancy', async () => {
  let occupancyLookups = 0
  await withApi({
    async getTeacherUnavailableOccupancy() {
      occupancyLookups += 1
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
  }, async () => {
    throw new Error('The worker must not be called for invalid input.')
  }, async (origin) => {
    const response = await fetch(`${origin}/api/timetable/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration: { department: 'CSE' }, reservedSections: [] }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /Department, year, semester and academic year are required/)
  })
  assert.equal(occupancyLookups, 0)
})
