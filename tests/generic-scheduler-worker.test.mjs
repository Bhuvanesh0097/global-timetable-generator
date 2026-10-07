import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenericSchedulerWorkerPool } from '../backend/generic-scheduler-worker-pool.mjs'

test('worker executes the existing TypeScript scheduler and returns its structured validation failure', async () => {
  const pool = createGenericSchedulerWorkerPool({ workerCount: 1 })
  try {
    const response = await pool.run({
      configuration: {
        department: 'CSE',
        academicYear: '2026 - 2027',
        year: 'II / 2nd Year',
        semester: 'V / 5th Semester',
        sections: [{ id: 'A' }],
        staff: [{ id: 'ST001', name: 'Teacher One' }],
        subjects: [],
      },
      reservedSections: [],
      unavailableTeacherSlots: [],
      alternateWeekUnavailableTeacherSlots: [],
    })
    assert.equal(response.result.ok, false)
    assert.equal(response.result.code, 'INVALID_INPUT')
    assert.ok(Array.isArray(response.result.blockingConstraints))
  } finally {
    await pool.close()
  }
})

test('worker escalates a bounded fast-search result to generate a complete timetable', async () => {
  const pool = createGenericSchedulerWorkerPool({ workerCount: 1 })
  try {
    const response = await pool.run({
      configuration: {
        department: 'CSE',
        academicYear: '2026 - 2027',
        year: 'II / 2nd Year',
        semester: 'V / 5th Semester',
        sections: [{ id: 'A' }],
        staff: Array.from({ length: 4 }, (_, index) => ({ id: `ST00${index + 1}`, name: `Teacher ${index + 1}` })),
        subjects: Array.from({ length: 4 }, (_, index) => ({
          id: `subject-${index + 1}`,
          name: `Subject ${index + 1}`,
          weeklyHours: 12,
          teacherAssignments: [{ sectionId: 'A', teacherId: `ST00${index + 1}` }],
        })),
        rules: { searchNodeLimit: 1 },
      },
      reservedSections: [],
      unavailableTeacherSlots: [],
      alternateWeekUnavailableTeacherSlots: [],
    })

    assert.equal(response.result.ok, true)
    if (!response.result.ok) return
    assert.equal(response.result.sections.length, 1)
    assert.equal(Object.values(response.result.sections[0].schedule)
      .reduce((count, day) => count + Object.keys(day).length, 0), 48)
  } finally {
    await pool.close()
  }
})

test('worker preserves random Placement allocation for the existing UI state update', async () => {
  const pool = createGenericSchedulerWorkerPool({ workerCount: 1 })
  try {
    const response = await pool.run({
      configuration: {
        department: 'CSE',
        academicYear: '2026 - 2027',
        year: 'II / 2nd Year',
        semester: 'V / 5th Semester',
        sections: [{ id: 'A' }],
        staff: [
          { id: 'ST001', name: 'Core Teacher' },
          { id: 'ST002', name: 'Placement Teacher' },
        ],
        subjects: [12, 12, 11, 11].map((weeklyHours, index) => ({
          id: `subject-${index + 1}`,
          name: `Subject ${index + 1}`,
          weeklyHours,
          teacherAssignments: [{ sectionId: 'A', teacherId: 'ST001' }],
        })),
        placement: {
          id: 'placement',
          name: 'Placement',
          enabled: true,
          weeklyPeriods: 2,
          blockDuration: 2,
          teacherAssignments: [{ sectionId: 'A', teacherId: 'ST002' }],
        },
        placementException: {
          enabled: true,
          allocationMode: 'random',
          alternateSubjects: [],
        },
      },
      reservedSections: [],
      unavailableTeacherSlots: [],
      alternateWeekUnavailableTeacherSlots: [],
    })

    assert.equal(response.result.ok, true)
    assert.equal(response.placementException?.allocationMode, 'random')
    assert.equal(response.placementException?.alternateSubjects.length, 2)
  } finally {
    await pool.close()
  }
})
