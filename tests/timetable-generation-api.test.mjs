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

async function withApi(repository, runGeneration, callback, options = {}) {
  const middleware = createTimetableApiMiddleware(repository, { ...options, runGeneration })
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

async function waitForGeneration(origin, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${origin}/api/timetable/generation-jobs/${jobId}`)
    assert.equal(response.status, 200)
    const job = await response.json()
    if (job.status === 'completed') return job.value
    if (job.status === 'failed') throw new Error(job.error)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('The generation job did not finish.')
}

async function postGeneration(origin, body) {
  const response = await fetch(`${origin}/api/timetable/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 202)
  const { jobId } = await response.json()
  assert.match(jobId, /^[0-9a-f-]{36}$/i)
  return { response, jobId }
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
    const { jobId } = await postGeneration(origin, {
      configuration,
      reservedSections: [{ sectionId: 'B', schedule: {} }],
    })
    assert.deepEqual((await waitForGeneration(origin, jobId)).result, result)
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
    const { jobId } = await postGeneration(origin, { configuration, reservedSections: [] })
    assert.equal((await waitForGeneration(origin, jobId)).result.ok, true)
  })

  assert.equal(generationCalls, 2)
  assert.equal(occupancyLookups, 2)
})

test('generation requests return immediately while the worker continues and can be polled', async () => {
  let releaseGeneration
  let workerStarted = false
  const workerResult = new Promise((resolve) => { releaseGeneration = resolve })
  const repository = {
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return []
    },
  }
  const result = {
    ok: true,
    sections: [],
    searchNodes: 1,
    validation: { sections: [], globalTeacherClashes: 0 },
  }

  await withApi(repository, async () => {
    workerStarted = true
    return workerResult
  }, async (origin) => {
    const { jobId } = await postGeneration(origin, { configuration, reservedSections: [] })
    for (let attempt = 0; attempt < 100 && !workerStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(workerStarted, true)
    releaseGeneration({ result })
    assert.deepEqual((await waitForGeneration(origin, jobId)).result, result)
  })
})

test('deduplicates identical in-flight requests but keeps different reserved sections separate', async () => {
  const releases = []
  let generationCalls = 0
  const repository = {
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return []
    },
  }

  await withApi(repository, () => {
    generationCalls += 1
    return new Promise((resolve) => releases.push(resolve))
  }, async (origin) => {
    const reversedConfiguration = Object.fromEntries(Object.entries(configuration).reverse())
    const [first, duplicate, different] = await Promise.all([
      postGeneration(origin, { configuration, reservedSections: [] }),
      postGeneration(origin, { configuration: reversedConfiguration, reservedSections: [] }),
      postGeneration(origin, { configuration, reservedSections: [{ sectionId: 'B', schedule: {} }] }),
    ])

    assert.equal(first.jobId, duplicate.jobId)
    assert.notEqual(first.jobId, different.jobId)
    for (let attempt = 0; attempt < 100 && generationCalls < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(generationCalls, 2)

    const result = {
      result: { ok: false, code: 'UNSATISFIABLE', message: 'No valid timetable.', blockingConstraints: [] },
    }
    releases.forEach((release) => release(result))
    await Promise.all([waitForGeneration(origin, first.jobId), waitForGeneration(origin, different.jobId)])
  })
})

test('does not reuse completed results and prunes completed jobs after the configured retention', async () => {
  let generationCalls = 0
  const middleware = createTimetableApiMiddleware({
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return []
    },
  }, {
    generationJobRetentionMs: 20,
    runGeneration: async () => {
      generationCalls += 1
      return {
        result: { ok: false, code: 'UNSATISFIABLE', message: 'No valid timetable.', blockingConstraints: [] },
      }
    },
  })
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const first = await postGeneration(origin, { configuration, reservedSections: [] })
    await waitForGeneration(origin, first.jobId)
    await new Promise((resolve) => setTimeout(resolve, 30))

    const second = await postGeneration(origin, { configuration, reservedSections: [] })
    assert.notEqual(first.jobId, second.jobId)
    await waitForGeneration(origin, second.jobId)
    assert.equal(generationCalls, 2)
    assert.equal((await fetch(`${origin}/api/timetable/generation-jobs/${first.jobId}`)).status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('keeps an unobserved completed job until its first poll', async () => {
  const repository = {
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return []
    },
  }
  const result = {
    result: { ok: false, code: 'UNSATISFIABLE', message: 'No valid timetable.', blockingConstraints: [] },
  }

  await withApi(repository, async () => result, async (origin) => {
    const { jobId } = await postGeneration(origin, { configuration, reservedSections: [] })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const response = await fetch(`${origin}/api/timetable/generation-jobs/${jobId}`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'completed')
  }, { generationJobRetentionMs: 20 })
})

test('generation worker failures are returned as structured job errors', async () => {
  await withApi({
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
  }, async () => {
    throw Object.assign(new Error('worker unavailable'), { code: 'SCHEDULER_UNAVAILABLE' })
  }, async (origin) => {
    const { jobId } = await postGeneration(origin, { configuration, reservedSections: [] })
    let job
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${origin}/api/timetable/generation-jobs/${jobId}`)
      job = await response.json()
      if (job.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(job.status, 'failed')
    assert.equal(job.error, 'worker unavailable')
    assert.equal(job.code, 'SCHEDULER_UNAVAILABLE')
  })
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
