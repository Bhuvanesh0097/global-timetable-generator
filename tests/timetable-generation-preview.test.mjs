import assert from 'node:assert/strict'
import test from 'node:test'
import { preview } from 'vite'
import { createTimetableApiPlugin } from '../vite.config.ts'

function generationConfiguration(sectionIds) {
  const sections = sectionIds.map((id) => ({ id, classAdvisorId: 'teacher-8' }))
  const staff = Array.from({ length: 8 }, (_, index) => ({
    id: `teacher-${index + 1}`,
    name: `Teacher ${index + 1}`,
  }))
  const coreSubjects = Array.from({ length: 4 }, (_, index) => ({
    id: `subject-${index + 1}`,
    code: `SUB${index + 1}`,
    abbreviation: `S${index + 1}`,
    name: `Subject ${index + 1}`,
    weeklyHours: 8,
    teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: `teacher-${index + 1}` })),
  }))
  const otherSubjects = [{
    id: 'other-1',
    code: 'OTH1',
    abbreviation: 'O1',
    name: 'Other Subject',
    weeklyHours: 4,
    teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'teacher-5' })),
  }]
  const labs = [{
    id: 'lab-1',
    code: 'LAB1',
    abbreviation: 'L1',
    name: 'Systems Lab',
    weeklyPeriods: 8,
    blockDuration: 4,
    teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'teacher-6' })),
  }]
  const placementAlternates = [1, 2].map((placementPosition) => ({
    placementPosition,
    subjectId: `subject-${placementPosition}`,
    subjectKind: 'core',
    subjectNameSnapshot: `Subject ${placementPosition}`,
    teacherAssignments: sectionIds.map((sectionId) => ({
      sectionId,
      teacherId: `teacher-${placementPosition}`,
      teacherNameSnapshot: `Teacher ${placementPosition}`,
    })),
  }))
  return {
    department: 'IOT',
    academicYear: '2026 - 2027',
    year: 'III / 3rd Year',
    semester: 'V / 5th Semester',
    sections,
    staff,
    subjects: coreSubjects,
    otherSubjects,
    labs,
    placement: {
      id: 'placement',
      code: '',
      abbreviation: 'Placement',
      name: 'Placement',
      enabled: true,
      weeklyPeriods: 2,
      blockDuration: 2,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'teacher-7' })),
    },
    placementException: { enabled: true, allocationMode: 'custom', alternateSubjects: placementAlternates },
    specialActivities: [{
      id: 'activity-1',
      code: 'ACT1',
      abbreviation: 'A1',
      name: 'Library / Mentoring',
      enabled: true,
      weeklyPeriods: 2,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'teacher-8' })),
    }],
    rules: {
      coreDailyMaximum: 2,
      coreConsecutiveMaximum: 2,
      subjectConsecutiveMaximum: 2,
      allowCoreSubjectsInP1: true,
      allowOtherSubjectsInP1: false,
      preventConcurrentUseOfSameLab: true,
      p1Tests: { enabled: true, subjectIds: ['subject-1', 'subject-2'] },
    },
    candidateCount: 2,
    randomSeed: 73,
  }
}

function constrainedGenerationConfiguration() {
  return {
    department: 'IOT',
    academicYear: '2026 - 2027',
    year: 'III / 3rd Year',
    semester: 'V / 5th Semester',
    sections: [{ id: 'A' }],
    staff: [
      { id: 'teacher-core', name: 'Core Teacher' },
      { id: 'teacher-lab', name: 'Lab Teacher' },
      { id: 'teacher-placement', name: 'Placement Teacher' },
      { id: 'teacher-activity', name: 'Activity Teacher' },
      { id: 'teacher-other', name: 'Other Teacher' },
    ],
    subjects: [{
      id: 'core-1',
      code: 'C1',
      name: 'Core Subject',
      weeklyHours: 24,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-core' }],
    }],
    otherSubjects: [{
      id: 'other-1',
      code: 'O1',
      name: 'Other Subject',
      weeklyHours: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-other' }],
    }],
    labs: [{
      id: 'lab-1',
      code: 'L1',
      name: 'Configured Lab',
      weeklyPeriods: 8,
      blockDuration: 3,
      allowedStartPeriods: [2, 6],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-lab' }],
    }],
    placement: {
      id: 'placement',
      name: 'Placement',
      enabled: true,
      weeklyPeriods: 4,
      blockDuration: 4,
      allowedStartPeriods: [5],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-placement' }],
    },
    specialActivities: [{
      id: 'activity-1',
      name: 'Configured Activity',
      enabled: true,
      weeklyPeriods: 8,
      blockDuration: 2,
      allowedStartPeriods: [2, 6],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-activity' }],
    }],
    rules: {
      p1Tests: { enabled: true, subjectIds: ['core-1'], testsPerSubject: 1 },
      coreDailyMaximum: 8,
      coreConsecutiveMaximum: 8,
      labsPerDayMaximum: 1,
      labsOnDistinctDays: true,
    },
    candidateCount: 2,
    randomSeed: 73,
  }
}

async function waitForGeneration(origin, jobId) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/timetable/generation-jobs/${jobId}`)
    assert.equal(response.status, 200)
    const job = await response.json()
    if (job.status === 'completed') return job.value
    if (job.status === 'failed') throw new Error(`${job.code ?? 'GENERATION_FAILED'}: ${job.error}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`Generation job ${jobId} did not finish within 60 seconds.`)
}

test('Vite preview serves real one- and two-section generation through HTTP and the worker thread', async (t) => {
  const repository = {
    async getTeacherUnavailableOccupancy() {
      return { unavailableSlots: [], alternateWeekUnavailableSlots: [] }
    },
    async getTeacherGenerationOccupancyConflicts() {
      return []
    },
    async close() {},
  }
  const server = await preview({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    plugins: [createTimetableApiPlugin({
      repository,
      schedulerWorkerCount: '1',
      schedulerQueueSize: '2',
      schedulerTimeoutMs: '60000',
      schedulerQueueWaitTimeoutMs: '60000',
    })],
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`

  try {
    for (const sectionIds of [['A'], ['A', 'B']]) {
      await t.test(`${sectionIds.length}-section configuration completes at the preview API`, async () => {
        const configuration = generationConfiguration(sectionIds)
        const response = await fetch(`${origin}/api/timetable/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ configuration, reservedSections: [] }),
        })
        assert.equal(response.status, 202)
        const { jobId } = await response.json()
        assert.match(jobId, /^[0-9a-f-]{36}$/i)

        const { result } = await waitForGeneration(origin, jobId)
        assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
        const acknowledgement = await fetch(`${origin}/api/timetable/generation-jobs/${jobId}/accepted`, { method: 'POST' })
        assert.equal(acknowledgement.status, 200)
        assert.equal((await acknowledgement.json()).accepted, true)
        assert.deepEqual(result.sections.map(({ sectionId }) => sectionId).sort(), sectionIds)
        assert.equal(result.validation.globalTeacherClashes, 0)

        const occupiedTeacherSlots = new Set()
        for (const section of result.sections) {
          const cells = Object.values(section.schedule).flatMap((day) => Object.values(day))
          assert.equal(cells.length, 48, `section ${section.sectionId} must have 48 occupied periods`)
          for (const subject of configuration.subjects) {
            assert.equal(
              cells.filter((cell) => cell.itemId === `core:${section.sectionId}:${subject.id}`).length,
              subject.weeklyHours,
              `${section.sectionId} must preserve ${subject.id}'s weekly workload`,
            )
          }
          assert.equal(cells.filter((cell) => cell.kind === 'other').length, 4)
          assert.equal(cells.filter((cell) => cell.kind === 'lab').length, 8)
          assert.equal(cells.filter((cell) => cell.name === 'Placement').length, 2)
          assert.equal(cells.filter((cell) => cell.name === 'Library / Mentoring').length, 2)
          assert.equal(
            cells.filter((cell) => cell.isCoreTest).length,
            2,
            'configured P1 tests remain part of core weekly workload',
          )
          for (const [day, periods] of Object.entries(section.schedule)) {
            for (const [period, cell] of Object.entries(periods)) {
              assert.ok(configuration.staff.some((teacher) => teacher.id === cell.teacherId))
              const slot = `${day}:${period}:${cell.teacherId}`
              assert.equal(occupiedTeacherSlots.has(slot), false, `teacher clash at ${slot}`)
              occupiedTeacherSlots.add(slot)
            }
          }
        }
        assert.deepEqual(
          result.validation.sections.map(({ sectionId, periodsFilled }) => ({ sectionId, periodsFilled }))
            .sort((left, right) => left.sectionId.localeCompare(right.sectionId)),
          sectionIds.map((sectionId) => ({ sectionId, periodsFilled: 48 })),
        )
      })
    }
    await t.test('valid mixed workload beyond the former search limit completes without partial output', async () => {
      const configuration = constrainedGenerationConfiguration()
      const response = await fetch(`${origin}/api/timetable/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configuration, reservedSections: [] }),
      })
      assert.equal(response.status, 202)
      const { jobId } = await response.json()
      const { result } = await waitForGeneration(origin, jobId)
      assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
      assert.equal(result.sections.length, 1)
      assert.equal(
        Object.values(result.sections[0].schedule).reduce((count, day) => count + Object.keys(day).length, 0),
        48,
      )
      assert.equal(result.validation.globalTeacherClashes, 0)
      assert.equal(result.validation.sections[0].periodsFilled, 48)
    })
  } finally {
    await server.close()
  }
})
