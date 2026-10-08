import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'
import { getDefaultCollegeTimings } from '../src/college-timings.ts'

const identity = {
  department: 'CSE',
  academicYear: '2026 - 2027',
  year: 'II / 2nd Year',
  semester: 'IV / 4th Semester',
}

function configurationFor(teacherPeriods, { teacherId = 'teacher-1', teacherName = 'Teacher One', sectionIds = ['A'] } = {}) {
  return {
    ...identity,
    sections: sectionIds.map((id) => ({ id })),
    staff: [{ id: teacherId, name: teacherName }],
    subjects: [{
      id: 'subject-1',
      name: 'Subject One',
      weeklyHours: teacherPeriods,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId })),
    }],
  }
}

function configurationForTeacherLimit(teacherPeriods, maximum) {
  const config = configurationFor(teacherPeriods)
  const remaining = 48 - teacherPeriods
  if (remaining > 0) {
    config.staff.push({ id: 'teacher-2', name: 'Teacher Two' })
    config.subjects.push({ id: 'subject-2', name: 'Subject Two', weeklyHours: remaining,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-2' }] })
  }
  config.collegeTimings = { ...getDefaultCollegeTimings(), teacherMaximumWeeklyPeriods: maximum }
  return config
}

function persistedSection({
  teacherId = 'teacher-1',
  teacherName = 'Teacher One',
  periods = 1,
  sectionId = 'SAVED',
  department = 'EEE',
  year = 'III / 3rd Year',
  semester = 'VI / 6th Semester',
  academicYear = identity.academicYear,
} = {}) {
  const assignments = Array.from({ length: periods }, () => ({ teacherId, teacherName }))
  return { sectionId, department, year, semester, academicYear, normal: assignments, alternate: assignments }
}

async function withApi({ activeSections = [], runGeneration = async () => ({
  result: { ok: false, code: 'UNSATISFIABLE', message: 'No schedule.', blockingConstraints: [] },
}), callback }) {
  let runGenerationCalls = 0
  const repository = {
    async getActiveTeacherWeeklyWorkloadSections() { return activeSections },
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() { return [] },
  }
  const middleware = createTimetableApiMiddleware(repository, {
    runGeneration: async (input) => {
      runGenerationCalls += 1
      return runGeneration(input)
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
    await callback(`http://127.0.0.1:${server.address().port}`, () => runGenerationCalls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function requestGeneration(origin, configuration, reservedSections = []) {
  return fetch(`${origin}/api/timetable/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configuration, reservedSections }),
  })
}

async function waitForCallCount(getCalls, expected) {
  for (let attempt = 0; attempt < 100 && getCalls() < expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function reservedPeriods(teacherId, count, sectionId = 'B', sectionIdentity = identity) {
  const schedule = { Monday: {} }
  for (let period = 1; period <= count; period += 1) {
    schedule.Monday[period] = { teacherId, name: `Subject ${period}` }
  }
  return [{
    sectionId,
    department: sectionIdentity.department,
    year: sectionIdentity.year,
    semester: sectionIdentity.semester,
    academicYear: sectionIdentity.academicYear,
    schedule,
  }]
}

test('allows an assigned teacher at exactly 48 weekly periods', async () => {
  await withApi({ callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationFor(48))
    assert.equal(response.status, 202)
    await waitForCallCount(getCalls, 1)
    assert.equal(getCalls(), 1)
  } })
})

test('allows 47 configured periods plus one reserved period', async () => {
  await withApi({ callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationFor(47), await reservedPeriods('teacher-1', 1))
    assert.equal(response.status, 202)
    await waitForCallCount(getCalls, 1)
    assert.equal(getCalls(), 1)
  } })
})

test('allows a teacher at the configured non-default weekly maximum', async () => {
  await withApi({ callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationForTeacherLimit(40, 40))
    assert.equal(response.status, 202)
    await waitForCallCount(getCalls, 1)
    assert.equal(getCalls(), 1)
  } })
})

test('rejects a teacher above the configured non-default maximum before scheduler invocation', async () => {
  await withApi({ callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationForTeacherLimit(41, 40))
    assert.equal(response.status, 422)
    const payload = await response.json()
    assert.equal(payload.code, 'TEACHER_WORKLOAD_LIMIT_EXCEEDED')
    assert.deepEqual(payload.workloadViolations, [{
      teacherId: 'teacher-1', teacherName: 'Teacher One', assignedPeriods: 41,
      maximum: 40, exceededAmount: 1, week: 'normal',
    }])
    assert.match(payload.error, /weekly limit of 40 by 1 period/)
    assert.equal(getCalls(), 0)
  } })
})

for (const reservedCount of [1, 10]) {
  test(`rejects 48 configured periods plus ${reservedCount} additional period${reservedCount === 1 ? '' : 's'} before scheduler invocation`, async () => {
    await withApi({ callback: async (origin, getCalls) => {
      const response = await requestGeneration(origin, configurationFor(48), await reservedPeriods('teacher-1', reservedCount))
      assert.equal(response.status, 422)
      const payload = await response.json()
      assert.equal(payload.code, 'TEACHER_WORKLOAD_LIMIT_EXCEEDED')
      assert.match(payload.error, /Teacher Workload Limit Exceeded/)
      assert.deepEqual(payload.workloadViolations, [{
        teacherId: 'teacher-1',
        teacherName: 'Teacher One',
        assignedPeriods: 48 + reservedCount,
        maximum: 48,
        exceededAmount: reservedCount,
        week: 'normal',
      }])
      assert.equal(getCalls(), 0)
    } })
  })
}

test('does not treat two different teachers in the same slot as one workload', async () => {
  const generatedSection = {
    sectionId: 'A', ...identity,
    schedule: { Monday: { 1: { teacherId: 'teacher-1', name: 'Subject One' } } },
  }
  await withApi({
    runGeneration: async () => ({ result: {
      ok: true,
      sections: [generatedSection],
      searchNodes: 1,
      validation: { sections: [], globalTeacherClashes: 0 },
    } }),
    callback: async (origin, getCalls) => {
      const response = await requestGeneration(
        origin,
        configurationFor(48),
        await reservedPeriods('teacher-2', 1),
      )
      assert.equal(response.status, 202)
      await waitForCallCount(getCalls, 1)
      assert.equal(getCalls(), 1)
    },
  })
})

test('counts one teacher across sections, departments, and years', async (t) => {
  await t.test('sections in the current generation', async () => {
    await withApi({ callback: async (origin, getCalls) => {
      const response = await requestGeneration(origin, configurationFor(24, { sectionIds: ['A', 'B'] }), await reservedPeriods('teacher-1', 1, 'C'))
      assert.equal(response.status, 422)
      assert.equal(getCalls(), 0)
      assert.equal((await response.json()).workloadViolations[0].assignedPeriods, 49)
    } })
  })

  await t.test('a different department', async () => {
    await withApi({ activeSections: [persistedSection({
      teacherId: 'teacher-1',
      periods: 1,
      department: 'EEE',
    })], callback: async (origin, getCalls) => {
      const response = await requestGeneration(origin, configurationFor(48))
      assert.equal(response.status, 422)
      assert.equal(getCalls(), 0)
      assert.equal((await response.json()).workloadViolations[0].assignedPeriods, 49)
    } })
  })

  await t.test('a different year', async () => {
    await withApi({ activeSections: [persistedSection({
      teacherId: 'teacher-1',
      periods: 1,
      department: identity.department,
      year: 'III / 3rd Year',
    })], callback: async (origin, getCalls) => {
      const response = await requestGeneration(origin, configurationFor(48))
      assert.equal(response.status, 422)
      assert.equal(getCalls(), 0)
      assert.equal((await response.json()).workloadViolations[0].assignedPeriods, 49)
    } })
  })
})

test('counts active saved occupancy with the new generation', async () => {
  await withApi({ activeSections: [persistedSection({ periods: 1 })], callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationFor(48))
    assert.equal(response.status, 422)
    assert.equal(getCalls(), 0)
    assert.equal((await response.json()).workloadViolations[0].assignedPeriods, 49)
  } })
})

test('replaces the active saved version for a section regenerated by the request', async () => {
  await withApi({ activeSections: [persistedSection({
    teacherId: 'teacher-1',
    periods: 48,
    sectionId: 'A',
    department: identity.department,
    year: identity.year,
    semester: identity.semester,
    academicYear: identity.academicYear,
  })], callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationFor(48))
    assert.equal(response.status, 202)
    await waitForCallCount(getCalls, 1)
    assert.equal(getCalls(), 1)
  } })
})

test('counts current reservedSections with the new generation', async () => {
  await withApi({ callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configurationFor(48), await reservedPeriods('teacher-1', 1))
    assert.equal(response.status, 422)
    assert.equal(getCalls(), 0)
    assert.equal((await response.json()).workloadViolations[0].assignedPeriods, 49)
  } })
})

test('aggregates matching teacher IDs even when saved and request display names differ', async () => {
  await withApi({ activeSections: [persistedSection({ teacherName: 'Older Display Name', periods: 1 })], callback: async (origin) => {
    const response = await requestGeneration(origin, configurationFor(48, { teacherName: 'Current Display Name' }))
    const payload = await response.json()
    assert.equal(response.status, 422)
    assert.equal(payload.workloadViolations.length, 1)
    assert.equal(payload.workloadViolations[0].teacherId, 'teacher-1')
    assert.equal(payload.workloadViolations[0].teacherName, 'Current Display Name')
    assert.equal(payload.workloadViolations[0].assignedPeriods, 49)
  } })
})

test('uses alternate Placement assignments for alternate-week capacity', async () => {
  const configuration = {
    ...identity,
    sections: [{ id: 'A' }],
    staff: [
      { id: 'main-teacher', name: 'Main Teacher' },
      { id: 'placement-teacher', name: 'Placement Teacher' },
    ],
    subjects: [{
      id: 'subject-1', name: 'Subject One', weeklyHours: 44,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'main-teacher' }],
    }],
    placement: {
      id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }],
    },
    placementException: {
      enabled: true,
      allocationMode: 'custom',
      alternateSubjects: [1, 2, 3, 4].map((placementPosition) => ({
        placementPosition,
        sectionId: 'A',
        subjectId: 'subject-1',
        subjectKind: 'core',
        subjectNameSnapshot: 'Subject One',
        teacherAssignments: [{ sectionId: 'A', teacherId: 'main-teacher', teacherNameSnapshot: 'Main Teacher' }],
      })),
    },
  }
  await withApi({ activeSections: [persistedSection({ teacherId: 'main-teacher', periods: 1 })], callback: async (origin, getCalls) => {
    const response = await requestGeneration(origin, configuration)
    assert.equal(response.status, 422)
    assert.equal(getCalls(), 0)
    assert.deepEqual((await response.json()).workloadViolations[0], {
      teacherId: 'main-teacher',
      teacherName: 'Main Teacher',
      assignedPeriods: 49,
      maximum: 48,
      exceededAmount: 1,
      week: 'alternate',
    })
  } })
})

test('preflights random Placement allocation and passes its validated options to the worker', async () => {
  const configuration = {
    ...identity,
    sections: [{ id: 'A' }],
    staff: [
      { id: 'teacher-1', name: 'Teacher One' },
      { id: 'teacher-2', name: 'Teacher Two' },
      { id: 'teacher-3', name: 'Teacher Three' },
    ],
    subjects: [
      {
        id: 'subject-1', name: 'Subject One', weeklyHours: 22,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-1' }],
      },
      {
        id: 'subject-2', name: 'Subject Two', weeklyHours: 22,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-2' }],
      },
    ],
    placement: {
      id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-3' }],
    },
    placementException: { enabled: true, allocationMode: 'random', alternateSubjects: [] },
  }
  let workerAllocations
  await withApi({
    activeSections: [persistedSection({ teacherId: 'teacher-3', periods: 44 })],
    runGeneration: async (input) => {
      workerAllocations = input.placementAllocations
      return { result: { ok: false, code: 'UNSATISFIABLE', message: 'No schedule.', blockingConstraints: [] } }
    },
    callback: async (origin, getCalls) => {
      const response = await requestGeneration(origin, configuration)
      assert.equal(response.status, 202)
      await waitForCallCount(getCalls, 1)
      assert.equal(getCalls(), 1)
      assert.ok(workerAllocations.length > 0 && workerAllocations.length <= 8)
      assert.ok(workerAllocations.every((allocation) => allocation.placementException.allocationMode === 'custom'))
    },
  })
})
