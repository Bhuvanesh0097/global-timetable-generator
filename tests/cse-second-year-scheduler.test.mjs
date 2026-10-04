import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTimetables, validateGeneratedTimetables } from '../src/scheduler.ts'
import { findTeacherTimetableClashes } from '../src/teacher-timetable.ts'

const sections = ['A', 'B', 'C', 'D']
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const coreSubjects = [
  { id: 'fsps', code: '25UMAT31', abbreviation: 'FSPS', name: 'Fourier Series, Probability and Statistics', hoursPerWeek: 6 },
  { id: 'dsa', code: '25UCST31', abbreviation: 'DSA', name: 'Data Structures and Algorithms', hoursPerWeek: 5 },
  { id: 'oops', code: '25UCST32', abbreviation: 'OOPS', name: 'Object Oriented Programming using Java', hoursPerWeek: 5 },
  { id: 'mpmc', code: '25UCST33', abbreviation: 'MPMC', name: 'Microprocessor and Microcontroller', hoursPerWeek: 5 },
  { id: 'hrm', code: '25UHST31', abbreviation: 'HRM', name: 'Human Resource Management', hoursPerWeek: 5 },
  { id: 'fds', code: '25UCSI33', abbreviation: 'FDS', name: 'Fundamentals of Data Science', hoursPerWeek: 8 },
]
const labs = [
  { id: 'dsa-lab', code: '25UCSP31', abbreviation: 'DSA LAB', name: 'Data Structures and Algorithms Lab', weeklyPeriods: 3 },
  { id: 'oops-lab', code: '25UCSP32', abbreviation: 'OOPS LAB', name: 'Object Oriented Programming using Java Lab', weeklyPeriods: 3 },
  { id: 'mpmc-lab', code: '25UCSP33', abbreviation: 'MPMC LAB', name: 'Microprocessor and Microcontroller Lab', weeklyPeriods: 3 },
]
const activities = [
  { id: 'library-mentoring', name: 'Library / Mentoring', hoursPerWeek: 1 },
  { id: 'spl-gate', name: 'SPL LECT / GATE', hoursPerWeek: 1 },
  { id: 'pet', name: 'PET', hoursPerWeek: 1 },
]
const staff = []
const addStaff = (id) => {
  if (!staff.some((member) => member.id === id)) staff.push({ id, name: id })
}
const coreAssignments = sections.flatMap((sectionId) => coreSubjects.map((subject) => {
  const teacherId = subject.id === 'fsps' && ['A', 'B'].includes(sectionId)
    ? 'shared-fsps-teacher'
    : `${sectionId}-${subject.id}-teacher`
  addStaff(teacherId)
  return { sectionId, subjectId: subject.id, teacherId }
}))
const labAssignments = sections.flatMap((sectionId) => labs.map((lab) => {
  const teacherId = `${sectionId}-${lab.id}-teacher`
  addStaff(teacherId)
  return { sectionId, labId: lab.id, teacherId }
}))
const specialActivityAssignments = sections.flatMap((sectionId) => activities.map((activity) => {
  const teacherId = `shared-${activity.id}-teacher`
  addStaff(teacherId)
  return { sectionId, activityId: activity.id, teacherId }
}))
const otherSubjects = [
  { id: 'pds', code: '25UPCE31', abbreviation: 'PDS', name: 'Personality Development Skills', hoursPerWeek: 0 },
  { id: 'ce2', code: '25UCCCII', abbreviation: 'CE-II', name: 'Certification Courses-II (Python with Data Science)', hoursPerWeek: 0 },
  { id: 'ichr', code: '25UMCC31', abbreviation: 'ICHR', name: 'Indian Constitution and Human Rights', hoursPerWeek: 2 },
]
const setup = {
  academic: { department: 'CSE', academicYear: '2026 - 2027', year: 'II / 2nd Year', semester: 'V / 5th Semester' },
  schedulerProfile: { placement: 'not-used', p1CoreTests: true },
  staff,
  sections: sections.map((id) => ({ id, classAdvisorId: '', studentCount: 60 })),
  coreSubjects,
  otherSubjectMaster: otherSubjects,
  otherSubjects,
  labMaster: labs,
  labAssignments,
  specialActivities: activities,
  sectionSubjectAssignments: [
    ...coreAssignments,
    ...sections.map((sectionId) => ({ sectionId, subjectId: 'ichr', teacherId: `${sectionId}-ichr-teacher` })),
  ],
  specialActivityAssignments,
}
for (const assignment of setup.sectionSubjectAssignments) addStaff(assignment.teacherId)

test('CSE 2nd Year Odd generates four full sections without Placement and marks each P1 core test', () => {
  assert.equal(setup.coreSubjects.reduce((sum, item) => sum + item.hoursPerWeek, 0)
    + setup.labMaster.reduce((sum, item) => sum + item.weeklyPeriods, 0)
    + setup.otherSubjects.reduce((sum, item) => sum + item.hoursPerWeek, 0)
    + setup.specialActivities.reduce((sum, item) => sum + item.hoursPerWeek, 0), 48)
  assert.equal(setup.specialActivities.some((item) => item.id === 'placement'), false)

  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return

  assert.deepEqual(result.sections.map(({ sectionId }) => sectionId), sections)
  assert.deepEqual(result.validation.sections.map(({ periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid }) => ({
    periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid,
  })), sections.map(() => ({ periodsFilled: 48, coreHoursValid: true, otherSubjectHoursValid: true, labAllocationValid: true })))
  assert.equal(result.validation.globalTeacherClashes, 0)
  assert.deepEqual(findTeacherTimetableClashes(result.sections), [])

  for (const generated of result.sections) {
    const cells = days.flatMap((day) => Array.from({ length: 8 }, (_, index) => generated.schedule[day][index + 1]))
    assert.equal(cells.filter((cell) => !cell).length, 0)
    assert.equal(cells.filter((cell) => !cell.teacherId || !cell.abbreviation).length, 0)
    const p1 = days.map((day) => generated.schedule[day][1])
    assert.ok(p1.every((cell) => cell.kind === 'core' && cell.isCoreTest))
    assert.deepEqual(new Set(p1.map((cell) => cell.itemId)).size, coreSubjects.length)
    for (const subject of coreSubjects) {
      assert.equal(cells.filter((cell) => cell.itemId === `core:${generated.sectionId}:${subject.id}`).length, subject.hoursPerWeek)
    }
    for (const lab of labs) {
      const labCells = days.flatMap((day) => Array.from({ length: 8 }, (_, index) => ({ day, period: index + 1, cell: generated.schedule[day][index + 1] })))
        .filter(({ cell }) => cell.itemId === `lab:${generated.sectionId}:${lab.id}`)
      assert.equal(labCells.length, 3)
      assert.equal(new Set(labCells.map(({ day }) => day)).size, 1)
      const labPeriods = labCells.map(({ period }) => period).sort((left, right) => left - right)
      assert.ok([2, 6].includes(labPeriods[0]))
      assert.deepEqual(labPeriods, [labPeriods[0], labPeriods[0] + 1, labPeriods[0] + 2])
    }
  }
})

test('CSE 2nd Year rejects cross-section teacher conflicts across A/B/C/D', () => {
  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return

  const invalidSections = structuredClone(result.sections)
  const sectionA = invalidSections.find((section) => section.sectionId === 'A')
  const sectionB = invalidSections.find((section) => section.sectionId === 'B')
  assert.ok(sectionA && sectionB)
  sectionB.schedule.Monday[1].teacherId = sectionA.schedule.Monday[1].teacherId

  const validation = validateGeneratedTimetables(setup, invalidSections)
  assert.ok(validation.summary.globalTeacherClashes > 0)
  assert.ok(validation.issues.some((issue) => issue.includes('Section A') && issue.includes('Section B') && issue.includes('Monday P1')))
})

test('CSE 2nd Year schedules around saved teacher occupancy across all four sections', () => {
  const blockedSlot = { teacherId: 'shared-fsps-teacher', day: 'Monday', period: 2 }
  const result = generateTimetables(setup, { unavailableTeacherSlots: [blockedSlot] })
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return

  assert.deepEqual(result.sections.map(({ sectionId }) => sectionId), sections)
  for (const generated of result.sections) {
    assert.equal(generated.schedule.Monday[2].teacherId === blockedSlot.teacherId, false,
      `Section ${generated.sectionId} must avoid the saved teacher assignment at Monday P2`)
  }
  assert.equal(result.validation.sections.every(({ periodsFilled }) => periodsFilled === 48), true)
  assert.equal(result.validation.globalTeacherClashes, 0)
})

test('CSE 2nd Year reports the blocking saved assignment when no teacher slot is available', () => {
  const unavailableTeacherSlots = staff.flatMap(({ id: teacherId }) => days.flatMap((day) =>
    Array.from({ length: 8 }, (_, index) => ({ teacherId, day, period: index + 1 }))))
  const result = generateTimetables(setup, { unavailableTeacherSlots })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'UNSATISFIABLE')
  assert.ok(result.blockingConstraints.some((detail) => detail.includes('Saved timetable teacher occupancy')))
  assert.ok(result.blockingConstraints.some((detail) => detail.includes('unavailable at')))
})
