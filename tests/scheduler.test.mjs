import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTimetables, validateGeneratedTimetables } from '../src/scheduler.ts'
import { getEditableTimetableChoices, updateGeneratedTimetableCell } from '../src/timetable-edit.ts'

const sections = ['A', 'B', 'C']
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const coreSubjects = [
  ['cspc501', 'CSPC501', 'Computer Networks', 'CN'],
  ['cspc502', 'CSPC502', 'Database Systems', 'DBS'],
  ['cspc503', 'CSPC503', 'Theory of Computation', 'TOC'],
  ['cspc504', 'CSPC504', 'Operating Systems', 'OS'],
  ['cspe101', 'CSPE101', 'Software Engineering', 'SE'],
].map(([id, code, name, abbreviation]) => ({ id, code, name, abbreviation, hoursPerWeek: 6 }))
const staff = []
const addStaff = (id, name = id) => {
  staff.push({ id, name })
  return id
}
const placementTeacherId = addStaff('staff-jayapradha', 'Mrs. J. Jayapradha')
const fossTeacherId = addStaff('staff-ur-padma', 'Mrs. U. R. Padma')
const splTeacherId = addStaff('staff-devaki', 'Mrs. D. Devaki')
const sectionsConfig = sections.map((sectionId) => ({
  id: sectionId,
  classAdvisorId: addStaff(`advisor-${sectionId}`, `Advisor ${sectionId}`),
  studentCount: 60,
}))
const sectionSubjectAssignments = []
const otherSubjects = [{ id: 'other-csmc505', code: 'CSMC505', name: 'Constitution of India', abbreviation: 'COI', hoursPerWeek: 2 }]
const labMaster = [
  { id: 'cspl501', code: 'CSPL501', name: 'Computer Networks Lab', abbreviation: 'CN LAB', weeklyPeriods: 3 },
  { id: 'cspl502', code: 'CSPL502', name: 'Database Systems Lab', abbreviation: 'DBS LAB', weeklyPeriods: 3 },
  { id: 'cspl503', code: 'CSPL503', name: 'Operating Systems Lab', abbreviation: 'OS LAB', weeklyPeriods: 3 },
]
const labAssignments = []
for (const sectionId of sections) {
  for (const subject of coreSubjects) {
    const teacherId = addStaff(`core-${sectionId}-${subject.id}`)
    sectionSubjectAssignments.push({ sectionId, subjectId: subject.id, teacherId })
  }
  sectionSubjectAssignments.push({ sectionId, subjectId: otherSubjects[0].id, teacherId: addStaff(`other-${sectionId}`) })
  for (const lab of labMaster) {
    labAssignments.push({ labId: lab.id, sectionId, teacherId: addStaff(`lab-${sectionId}-${lab.id}`) })
  }
}

const specialActivities = [
  { id: 'placement', name: 'Placement', hoursPerWeek: 4 },
  { id: 'foss-nptel', name: 'FOSS / NPTEL', hoursPerWeek: 1 },
  { id: 'library-mentoring', name: 'Library / Mentoring', hoursPerWeek: 1 },
  { id: 'spl-lecture-gate', name: 'SPL Lecture / GATE', hoursPerWeek: 1 },
]
const specialActivityAssignments = sections.flatMap((sectionId) => [
  { sectionId, activityId: 'placement', teacherId: placementTeacherId },
  { sectionId, activityId: 'foss-nptel', teacherId: fossTeacherId },
  { sectionId, activityId: 'library-mentoring', teacherId: sectionsConfig.find((section) => section.id === sectionId).classAdvisorId },
  { sectionId, activityId: 'spl-lecture-gate', teacherId: splTeacherId },
])

const setup = {
  academic: { department: 'CSE', academicYear: '2026 - 2027', year: 'III / 3rd Year', semester: 'V / 5th Semester' },
  staff,
  sections: sectionsConfig,
  coreSubjects,
  otherSubjectMaster: [{ code: 'CSMC505', name: 'Constitution of India', abbreviation: 'COI', hoursPerWeek: 2 }],
  otherSubjects,
  labMaster,
  labAssignments,
  specialActivities,
  sectionSubjectAssignments,
  specialActivityAssignments,
}

test('generates complete, validated A/B/C schedules and one global Placement block per section', () => {
  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return

  assert.deepEqual(result.sections.map((section) => section.sectionId), sections)
  assert.deepEqual(result.validation.sections.map(({ periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid }) => ({ periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid })), sections.map(() => ({ periodsFilled: 48, coreHoursValid: true, otherSubjectHoursValid: true, labAllocationValid: true })))
  assert.equal(result.validation.globalTeacherClashes, 0)

  const globalLabDays = new Set()
  const labDaySetsBySection = []
  const activityTypesByDay = new Map(days.map((day) => [day, new Set()]))
  for (const section of result.sections) {
    const p1Assignments = days.map((day) => section.schedule[day][1].itemId)
    assert.equal(new Set(p1Assignments).size, days.length, `Section ${section.sectionId} must have a different P1 assignment each day`)
    for (const day of days) {
      const dayCells = Object.values(section.schedule[day])
      for (const subject of coreSubjects) {
        const occurrences = dayCells.filter((cell) => cell.itemId === `core:${section.sectionId}:${subject.id}`).length
        const dailyMaximum = subject.abbreviation === 'TOC' ? 3 : 2
        assert.ok(occurrences <= dailyMaximum, `${section.sectionId} ${subject.abbreviation} must not exceed ${dailyMaximum} periods on ${day}`)
      }
      for (let index = 0; index < dayCells.length - 2; index += 1) {
        const [first, middle, last] = dayCells.slice(index, index + 3)
        assert.ok(!(first?.kind === 'core' && middle?.kind === 'core' && last?.kind === 'core' && first.itemId === last.itemId && middle.itemId !== first.itemId), `${section.sectionId} must avoid alternating core subjects on ${day}`)
      }
      if (dayCells.some((cell) => cell?.kind === 'lab')) globalLabDays.add(day)
      for (const cell of dayCells.filter((candidate) => candidate?.kind === 'activity')) {
        activityTypesByDay.get(day).add(cell.itemId.split(':').at(-1))
      }
    }
  }
  assert.ok(globalLabDays.size <= 4, 'At least two days must remain lab-free for three global Placement blocks')
  for (const day of days) assert.ok(activityTypesByDay.get(day).size <= 1, `${day} must not contain conflicting special activity types`)

  const jayapradhaSlots = new Set()
  for (const section of result.sections) {
    const cells = days.flatMap((day) => Array.from({ length: 8 }, (_, index) => ({ day, period: index + 1, cell: section.schedule[day][index + 1] })))
    assert.equal(cells.filter(({ cell }) => !cell?.abbreviation || !cell.teacherId).length, 0)

    const placement = cells.filter(({ cell }) => cell.itemId === `activity:${section.sectionId}:placement`)
    assert.equal(placement.length, 4)
    assert.equal(new Set(placement.map(({ day }) => day)).size, 1)
    const periods = placement.map(({ period }) => period).sort((left, right) => left - right)
    assert.deepEqual(periods, [periods[0], periods[0] + 1, periods[0] + 2, periods[0] + 3])
    assert.ok(periods[0] === 1 || periods[0] === 5, 'Placement block must not cross lunch')
    assert.ok(placement.every(({ cell }) => cell.teacherId === placementTeacherId))
    assert.ok(!globalLabDays.has(placement[0].day), `Section ${section.sectionId} Placement must avoid every section's lab days`)
    for (const { day, period } of placement) {
      const key = `${day}:P${period}`
      assert.equal(jayapradhaSlots.has(key), false, `Jayapradya clash at ${key}`)
      jayapradhaSlots.add(key)
    }

    for (const lab of labMaster) {
      const labCells = cells.filter(({ cell }) => cell.itemId === `lab:${section.sectionId}:${lab.id}`)
      assert.equal(labCells.length, 3)
      assert.equal(new Set(labCells.map(({ day }) => day)).size, 1)
      const labPeriods = labCells.map(({ period }) => period).sort((left, right) => left - right)
      assert.deepEqual(labPeriods, [labPeriods[0], labPeriods[0] + 1, labPeriods[0] + 2])
      assert.ok([1, 2, 5, 6].includes(labPeriods[0]), 'A lab crossing lunch is invalid')
    }
    const labDays = labMaster.map((lab) => cells.find(({ cell }) => cell.itemId === `lab:${section.sectionId}:${lab.id}`).day)
    assert.equal(new Set(labDays).size, labMaster.length, 'Each section must schedule its labs on different days')
    labDaySetsBySection.push(new Set(labDays))
    assert.ok(labMaster.some((lab) => {
      const labCells = cells.filter(({ cell }) => cell.itemId === `lab:${section.sectionId}:${lab.id}`)
      return Math.min(...labCells.map(({ period }) => period)) >= 5
    }), `Section ${section.sectionId} should consider afternoon lab blocks`)

    for (const subject of coreSubjects) {
      const subjectDays = new Set()
      for (const day of days) {
        const periodsForSubject = cells.filter(({ cell, day: cellDay }) => cellDay === day && cell.itemId === `core:${section.sectionId}:${subject.id}`).map(({ period }) => period)
        assert.ok(periodsForSubject.length <= (subject.abbreviation === 'TOC' ? 3 : 2))
        if (periodsForSubject.length) subjectDays.add(day)
        assert.ok(!periodsForSubject.some((period, index) => index > 0 && period === periodsForSubject[index - 1] + 1 && periodsForSubject[index + 1] === period + 1))
      }
      assert.ok(subjectDays.size >= 4, `${section.sectionId} ${subject.abbreviation} should be spread across at least four weekdays`)
    }
  }
  for (let left = 0; left < labDaySetsBySection.length; left += 1) {
    for (let right = left + 1; right < labDaySetsBySection.length; right += 1) {
      assert.notDeepEqual([...labDaySetsBySection[left]].sort(), [...labDaySetsBySection[right]].sort(), 'Sections should not receive identical lab-day patterns')
    }
  }
  const consecutivePatterns = labDaySetsBySection.filter((daySet) => {
    const ordered = [...daySet].map((day) => days.indexOf(day)).sort((a, b) => a - b)
    return ordered.length === 3 && ordered[1] === ordered[0] + 1 && ordered[2] === ordered[1] + 1
  })
  assert.ok(consecutivePatterns.length <= 1, 'Prefer only one fully consecutive 3-day lab pattern')
})

test('validator reports global lab/Placement and special-activity day conflicts', () => {
  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return

  const invalidSections = structuredClone(result.sections)
  const sectionA = invalidSections.find((section) => section.sectionId === 'A')
  const sectionB = invalidSections.find((section) => section.sectionId === 'B')
  const labDay = days.find((day) => Object.values(sectionB.schedule[day]).some((cell) => cell?.kind === 'lab'))
  assert.ok(sectionA && labDay)
  const originalPlacement = days.flatMap((day) => Object.entries(sectionA.schedule[day]).map(([period, cell]) => ({ day, period: Number(period), cell })))
    .filter(({ cell }) => cell.itemId === 'activity:A:placement')
  const targetPeriods = originalPlacement.map(({ period }) => period)
  for (const { day, period } of originalPlacement) sectionA.schedule[day][period] = null
  for (const { period, cell } of originalPlacement) sectionA.schedule[labDay][period] = cell

  const fossCell = days.flatMap((day) => Object.values(sectionB.schedule[day])).find((cell) => cell.itemId === 'activity:B:foss-nptel')
  assert.ok(fossCell)
  sectionB.schedule[labDay][1] = fossCell

  const validation = validateGeneratedTimetables(setup, invalidSections)
  assert.ok(validation.issues.some((issue) => issue.includes('global lab/Placement day constraint') && issue.includes('conflicts with')))
  assert.ok(validation.warnings.some((issue) => issue.includes('stacks special-activity types') && issue.includes('Entries')))
  assert.ok(targetPeriods.length === 4)
})

test('randomizes the core distribution between valid timetable generations', () => {
  const first = generateTimetables(setup)
  const second = generateTimetables(setup)
  assert.equal(first.ok, true, first.ok ? '' : first.blockingConstraints.join('\n'))
  assert.equal(second.ok, true, second.ok ? '' : second.blockingConstraints.join('\n'))
  if (!first.ok || !second.ok) return
  const signature = (result) => JSON.stringify(result.sections.map((section) => days.map((day) =>
    Object.values(section.schedule[day]).map((cell) => cell.kind === 'core' ? cell.itemId : null),
  )))
  assert.notEqual(signature(first), signature(second), 'Equivalent valid schedules should not always use the same daily subject distribution')
})

test('validator detects simultaneous use of one physical lab resource across sections', () => {
  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return

  const invalidSections = structuredClone(result.sections)
  const sectionA = invalidSections.find((section) => section.sectionId === 'A')
  const sectionB = invalidSections.find((section) => section.sectionId === 'B')
  assert.ok(sectionA && sectionB)
  const lab = labMaster[0]
  const aBlock = days.flatMap((day) => Array.from({ length: 8 }, (_, index) => ({ day, period: index + 1, cell: sectionA.schedule[day][index + 1] })))
    .filter(({ cell }) => cell.itemId === `lab:A:${lab.id}`)
  assert.equal(aBlock.length, 3)
  for (const { day, period, cell } of aBlock) sectionB.schedule[day][period] = { ...cell, itemId: `lab:B:${lab.id}` }

  const validation = validateGeneratedTimetables(setup, invalidSections)
  assert.ok(validation.issues.some((issue) => issue.includes('lab resource') && issue.includes('Section A') && issue.includes('Section B') && issue.includes('P')))
})

test('returns specific assignment blockers and no partial sections for incomplete inputs', () => {
  const invalid = {
    ...setup,
    sectionSubjectAssignments: setup.sectionSubjectAssignments.filter((assignment) => !(assignment.sectionId === 'B' && assignment.subjectId === 'cspc501')),
  }
  const result = generateTimetables(invalid)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.message, 'Timetable could not be generated with the current constraints.')
  assert.ok(result.blockingConstraints.includes('Section B: assign a valid Staff Master teacher to Computer Networks.'))
  assert.equal('sections' in result, false)
})

test('rejects Placement when it is not assigned to the fixed teacher', () => {
  const invalid = {
    ...setup,
    specialActivityAssignments: setup.specialActivityAssignments.map((assignment) => assignment.sectionId === 'C' && assignment.activityId === 'placement'
      ? { ...assignment, teacherId: fossTeacherId }
      : assignment),
  }
  const result = generateTimetables(invalid)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.blockingConstraints.includes('Section C: Placement must be assigned to Mrs. J. Jayapradha.'))
  assert.equal('sections' in result, false)
})

test('rejects assigning one teacher to multiple Labs within a section', () => {
  const cnTeacherId = setup.labAssignments.find((assignment) => assignment.sectionId === 'A' && assignment.labId === 'cspl501').teacherId
  const invalid = {
    ...setup,
    labAssignments: setup.labAssignments.map((assignment) => assignment.sectionId === 'A' && assignment.labId === 'cspl502'
      ? { ...assignment, teacherId: cnTeacherId }
      : assignment),
  }
  const result = generateTimetables(invalid)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.blockingConstraints.some((message) => message.includes('Each teacher may teach only one Lab per section') && message.includes('Section A')))
  assert.equal('sections' in result, false)
})

test('timetable edit choices resolve approved section-specific subjects and exclude locked items', () => {
  const cnChoice = getEditableTimetableChoices(setup, 'A').find((choice) => choice.itemId === 'core:A:cspc501')
  assert.ok(cnChoice)
  assert.equal(cnChoice.code, 'CSPC501')
  assert.equal(cnChoice.abbreviation, 'CN')
  assert.equal(cnChoice.teacherId, setup.sectionSubjectAssignments.find((assignment) => assignment.sectionId === 'A' && assignment.subjectId === 'cspc501').teacherId)

  const choices = getEditableTimetableChoices(setup, 'A')
  assert.ok(choices.some((choice) => choice.itemId === 'other:A:other-csmc505'))
  assert.ok(choices.some((choice) => choice.itemId === 'activity:A:foss-nptel'))
  assert.ok(choices.every((choice) => choice.kind !== 'lab' && choice.itemId !== 'activity:A:placement'))
})

test('cell edit clones the generated result and existing validation rejects weekly-hour and teacher clashes', () => {
  const generated = generateTimetables(setup)
  assert.equal(generated.ok, true, generated.ok ? '' : generated.blockingConstraints.join('\n'))
  if (!generated.ok) return

  const sectionA = generated.sections.find((section) => section.sectionId === 'A')
  assert.ok(sectionA)
  const originalMondayP1 = sectionA.schedule.Monday[1]
  const choicesA = getEditableTimetableChoices(setup, 'A')
  const cnChoice = choicesA.find((choice) => choice.itemId === 'core:A:cspc501')
  assert.ok(cnChoice)

  const unchangedCopy = updateGeneratedTimetableCell(generated.sections, 'A', 'Monday', 1, originalMondayP1)
  assert.notEqual(unchangedCopy, generated.sections)
  assert.notEqual(unchangedCopy.find((section) => section.sectionId === 'A')?.schedule.Monday, sectionA.schedule.Monday)
  assert.deepEqual(validateGeneratedTimetables(setup, unchangedCopy).issues, [])

  const differentCoreCell = days.flatMap((day) => Array.from({ length: 8 }, (_, index) => ({ day, period: index + 1, cell: sectionA.schedule[day][index + 1] })))
    .find(({ cell }) => cell.kind === 'core' && cell.itemId !== cnChoice.itemId)
  assert.ok(differentCoreCell)
  const invalidHours = updateGeneratedTimetableCell(generated.sections, 'A', differentCoreCell.day, differentCoreCell.period, cnChoice)
  assert.ok(validateGeneratedTimetables(setup, invalidHours).issues.some((issue) => issue.includes('periods.')))
  assert.equal(sectionA.schedule.Monday[1], originalMondayP1, 'staging an edit must not mutate the generated schedule')

  const cnTeacherId = setup.sectionSubjectAssignments.find((assignment) => assignment.sectionId === 'A' && assignment.subjectId === 'cspc501').teacherId
  const clashSetup = {
    ...setup,
    sectionSubjectAssignments: setup.sectionSubjectAssignments.map((assignment) => assignment.sectionId === 'B' && assignment.subjectId === 'cspc502'
      ? { ...assignment, teacherId: cnTeacherId }
      : assignment),
  }
  const crossSectionChoice = getEditableTimetableChoices(clashSetup, 'B').find((choice) => choice.itemId === 'core:B:cspc502')
  assert.ok(crossSectionChoice)
  assert.equal(crossSectionChoice.teacherId, cnTeacherId)
  const cnTime = days.flatMap((day) => Array.from({ length: 8 }, (_, index) => ({ day, period: index + 1, cell: sectionA.schedule[day][index + 1] })))
    .find(({ cell }) => cell.itemId === 'core:A:cspc501')
  assert.ok(cnTime)
  const teacherClash = updateGeneratedTimetableCell(generated.sections, 'B', cnTime.day, cnTime.period, crossSectionChoice)
  assert.ok(validateGeneratedTimetables(clashSetup, teacherClash).issues.some((issue) => issue.includes('conflicts with Section A') && issue.includes(cnTime.day) && issue.includes(`P${cnTime.period}`)))
})
