import test from 'node:test'
import assert from 'node:assert/strict'
import { generateGenericTimetable, validateGenericScheduleEdit } from '../src/generic-scheduler.ts'
import { exchangeGeneratedTimetableCells, getEditableTimetableChoices } from '../src/timetable-edit.ts'

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const periods = Array.from({ length: 8 }, (_, index) => index + 1)

function editConfig() {
  const subjects = Array.from({ length: 8 }, (_, index) => ({
    id: `subject-${index + 1}`,
    code: `S${index + 1}`,
    abbreviation: `S${index + 1}`,
    name: `Subject ${index + 1}`,
    weeklyHours: 6,
    teacherAssignments: [{ sectionId: 'A', teacherId: `teacher-${index + 1}` }],
  }))
  return {
    department: 'Example',
    academicYear: '2026-2027',
    year: 'III / 3rd Year',
    semester: 'Odd',
    sections: [{ id: 'A' }],
    staff: subjects.map((subject, index) => ({ id: `teacher-${index + 1}`, name: `Teacher ${index + 1}` })),
    subjects,
    rules: { coreDailyMaximum: 2, coreConsecutiveMaximum: 2, allowCoreSubjectsInP1: true },
    candidateCount: 2,
  }
}

function cells(section) {
  return days.flatMap((day) => periods.map((period) => ({ day, period, cell: section.schedule[day][period] })))
}

test('edit validation ignores configured subject totals while validating the full candidate', () => {
  const config = editConfig()
  const generated = generateGenericTimetable(config)
  assert.equal(generated.ok, true, generated.ok ? '' : generated.blockingConstraints.join('\n'))
  if (!generated.ok) return

  let accepted
  for (const { day, period, cell } of cells(generated.sections[0])) {
    if (cell.itemId !== 'core:A:subject-1') continue
    const candidate = generated.sections.map((section) => ({
      ...section,
      schedule: Object.fromEntries(Object.entries(section.schedule).map(([scheduleDay, slots]) => [scheduleDay, { ...slots }])),
    }))
    const target = config.subjects[1]
    candidate[0].schedule[day][period] = {
      ...cell,
      itemId: 'core:A:subject-2',
      code: target.code,
      abbreviation: target.abbreviation,
      name: target.name,
      teacherId: 'teacher-2',
      kind: 'core',
    }
    if (validateGenericScheduleEdit(config, candidate).issues.length === 0) {
      accepted = { candidate, day, period }
      break
    }
  }

  assert.ok(accepted, 'a structurally valid one-cell replacement should be accepted despite changing weekly subject counts')
  assert.equal(cells(accepted.candidate[0]).filter(({ cell }) => cell.itemId === 'core:A:subject-1').length, 5)
  assert.equal(cells(accepted.candidate[0]).filter(({ cell }) => cell.itemId === 'core:A:subject-2').length, 7)
  assert.equal(cells(generated.sections[0]).filter(({ cell }) => cell.itemId === 'core:A:subject-1').length, 6)
})

test('cell exchange is same-section and leaves the source schedule unchanged', () => {
  const first = { sectionId: 'A', schedule: Object.fromEntries(days.map((day) => [day, Object.fromEntries(periods.map((period) => [period, {
    itemId: `${day}-${period}`, code: '', abbreviation: `${day}-${period}`, name: `${day}-${period}`, teacherId: 'teacher', kind: 'core',
  }]))])) }
  const originalFirstCell = first.schedule.Monday[1]
  const originalSecondCell = first.schedule.Tuesday[2]
  const source = [first]
  const exchanged = exchangeGeneratedTimetableCells(source, 'A', { day: 'Monday', period: 1 }, { day: 'Tuesday', period: 2 })

  assert.notEqual(exchanged, source)
  assert.deepEqual(exchanged[0].schedule.Monday[1], originalSecondCell)
  assert.deepEqual(exchanged[0].schedule.Tuesday[2], originalFirstCell)
  assert.equal(first.schedule.Monday[1], originalFirstCell)
  assert.equal(first.schedule.Tuesday[2], originalSecondCell)
})

test('edit choices keep zero-hour configured subjects available and exclude Placement', () => {
  const setup = {
    staff: [{ id: 'teacher', name: 'Teacher' }],
    sections: [{ id: 'A', classAdvisorId: '', studentCount: 0 }],
    coreSubjects: [{ id: 'core', code: 'C1', abbreviation: 'C1', name: 'Core', hoursPerWeek: 6 }],
    otherSubjects: [{ id: 'other', code: 'O1', abbreviation: 'O1', name: 'Other', hoursPerWeek: 0 }],
    specialActivities: [
      { id: 'generated-placement-id', name: 'Placement', hoursPerWeek: 4 },
      { id: 'activity-zero', name: 'Activity', hoursPerWeek: 0 },
    ],
    sectionSubjectAssignments: [
      { sectionId: 'A', subjectId: 'core', teacherId: 'teacher' },
      { sectionId: 'A', subjectId: 'other', teacherId: 'teacher' },
    ],
    specialActivityAssignments: [
      { sectionId: 'A', activityId: 'generated-placement-id', teacherId: 'teacher' },
      { sectionId: 'A', activityId: 'activity-zero', teacherId: 'teacher' },
    ],
  }
  const choices = getEditableTimetableChoices(setup, 'A')
  assert.ok(choices.some((choice) => choice.itemId === 'other:A:other'))
  assert.ok(choices.some((choice) => choice.itemId === 'activity:A:activity-zero'))
  assert.ok(choices.every((choice) => !choice.itemId.includes('placement')))
})