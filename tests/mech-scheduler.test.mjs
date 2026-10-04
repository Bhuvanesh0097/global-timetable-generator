import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTimetables, validateGeneratedTimetables } from '../src/scheduler.ts'
import { buildTeacherTimetable, findTeacherTimetableClashes } from '../src/teacher-timetable.ts'
import { globalStaffIds } from '../src/staff-identities.ts'

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const staff = [
  ['mech-staff-vasanth', 'Mr. B.Vasanth'],
  ['mech-staff-thiagarajan', 'Mr. A.Thiagarajan'],
  [globalStaffIds.drAMathiarasu, 'Dr. A.Mathiarasu'],
  [globalStaffIds.drPNatarajan, 'Dr. P.Natarajan'],
  ['mech-staff-deeba', 'Mrs. G.Deeba'],
  ['mech-staff-selvam', 'Mr. K.Selvam'],
  ['mech-staff-rajalakshmi', 'Dr.R.Rajalakshmi'],
].map(([id, name]) => ({ id, name }))
const coreSubjects = [
  { id: 'met51', code: 'MET51', abbreviation: 'DME', name: 'Design of Machine Elements', hoursPerWeek: 6 },
  { id: 'met52', code: 'MET52', abbreviation: 'HMT', name: 'Heat and Mass Transfer', hoursPerWeek: 6 },
  { id: 'met53', code: 'MET53', abbreviation: 'MMM', name: 'Metrology and Mechanical Measurements', hoursPerWeek: 6 },
  { id: 'met54', code: 'MET54', abbreviation: 'MRC', name: 'Mechatronics, Robotics & Control', hoursPerWeek: 5 },
  { id: 'met55', code: 'MET55', abbreviation: 'PIE', name: 'Product Innovation & Entrepreneurship', hoursPerWeek: 5 },
]
const labs = [
  { id: 'mep51', code: 'MEP51', abbreviation: 'MMM L', name: 'Metrology and Mechanical Measurements Lab', weeklyPeriods: 3 },
  { id: 'mep52', code: 'MEP52', abbreviation: 'TE L', name: 'Thermal Engineering Lab', weeklyPeriods: 3 },
]
const ict = { id: 'other-mep53', code: 'MEP53', abbreviation: 'ICT', name: 'Indian Constitution & Tradition', hoursPerWeek: 3 }
const activities = [
  { id: 'mech-library', name: 'LIBRARY', hoursPerWeek: 1 },
  { id: 'mech-mentoring', name: 'MENTORING', hoursPerWeek: 1 },
  { id: 'mech-placement', name: 'PLACEMENT', hoursPerWeek: 4 },
  { id: 'mech-mini-project', name: 'MINI PROJECT', hoursPerWeek: 5 },
]
const teacherByItem = {
  met51: 'mech-staff-vasanth', met52: 'mech-staff-thiagarajan', met53: globalStaffIds.drAMathiarasu,
  met54: globalStaffIds.drPNatarajan, met55: 'mech-staff-deeba', other: 'mech-staff-rajalakshmi',
  mep51: globalStaffIds.drAMathiarasu, mep52: 'mech-staff-selvam',
  'mech-library': globalStaffIds.drPNatarajan, 'mech-mentoring': globalStaffIds.drPNatarajan,
  'mech-placement': globalStaffIds.drAMathiarasu, 'mech-mini-project': globalStaffIds.drPNatarajan,
}

function makeSetup(sectionCount = 1) {
  const sectionIds = Array.from({ length: sectionCount }, (_, index) => String.fromCharCode(65 + index))
  return {
    academic: { department: 'MECH', academicYear: '2026 - 2027', year: 'III / 3rd Year', semester: 'V / 5th Semester' },
    staff,
    sections: sectionIds.map((id) => ({ id, classAdvisorId: globalStaffIds.drPNatarajan, studentCount: 0 })),
    coreSubjects,
    otherSubjectMaster: [{ code: ict.code, abbreviation: ict.abbreviation, name: ict.name, hoursPerWeek: ict.hoursPerWeek }],
    otherSubjects: [ict],
    labMaster: labs,
    labAssignments: sectionIds.flatMap((sectionId) => labs.map((lab) => ({ sectionId, labId: lab.id, teacherId: teacherByItem[lab.id] }))),
    specialActivities: activities,
    sectionSubjectAssignments: sectionIds.flatMap((sectionId) => [
      ...coreSubjects.map((subject) => ({ sectionId, subjectId: subject.id, teacherId: teacherByItem[subject.id] })),
      { sectionId, subjectId: ict.id, teacherId: teacherByItem.other },
    ]),
    specialActivityAssignments: sectionIds.flatMap((sectionId) => activities.map((activity) => ({ sectionId, activityId: activity.id, teacherId: teacherByItem[activity.id] }))),
  }
}

function cellsFor(section, itemId) {
  return days.flatMap((day) => Array.from({ length: 8 }, (_, index) => {
    const period = index + 1
    const cell = section.schedule[day][period]
    return cell?.itemId === itemId ? { day, period, cell } : []
  }).flat())
}

function assertMechRules(setup, result) {
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.deepEqual(result.sections.map((section) => section.sectionId), setup.sections.map((section) => section.id))
  assert.equal(result.validation.globalTeacherClashes, 0)
  assert.equal(result.validation.sections.length, setup.sections.length)
  for (const section of result.sections) {
    assert.equal(days.flatMap((day) => Array.from({ length: 8 }, (_, index) => section.schedule[day][index + 1])).filter(Boolean).length, 48)
    const testCells = days.map((day) => section.schedule[day][1]).filter((cell) => cell.kind === 'core' && cell.abbreviation.endsWith(' (T)'))
    assert.equal(testCells.length, 5)
    assert.equal(new Set(testCells.map((cell) => cell.itemId)).size, 5)
    assert.equal(new Set(days.filter((day) => section.schedule[day][1].kind === 'core').map((day) => day)).size, 5)

    for (const subject of coreSubjects) assert.equal(cellsFor(section, `core:${section.sectionId}:${subject.id}`).length, subject.hoursPerWeek)
    assert.equal(cellsFor(section, `other:${section.sectionId}:${ict.id}`).length, 3)
    const ictDays = new Set(cellsFor(section, `other:${section.sectionId}:${ict.id}`).map((cell) => cell.day))
    assert.equal(ictDays.size, 3)

    const sectionLabDays = []
    for (const lab of labs) {
      const cells = cellsFor(section, `lab:${section.sectionId}:${lab.id}`)
      assert.equal(cells.length, 3)
      const periods = cells.map((cell) => cell.period).sort((a, b) => a - b).join(',')
      assert.ok(periods === '2,3,4' || periods === '6,7,8')
      assert.equal(new Set(cells.map((cell) => cell.day)).size, 1)
      sectionLabDays.push(cells[0].day)
    }
    assert.equal(new Set(sectionLabDays).size, 2)

    const placement = cellsFor(section, `activity:${section.sectionId}:mech-placement`)
    assert.equal(placement.length, 4)
    const placementSlots = placement.map((cell) => cell.period).sort((a, b) => a - b).join(',')
    assert.ok(placementSlots === '1,2,3,4' || placementSlots === '5,6,7,8')
    assert.equal(new Set(placement.map((cell) => cell.day)).size, 1)

    const project = cellsFor(section, `activity:${section.sectionId}:mech-mini-project`)
    assert.equal(project.length, 5)
    const blockDays = days.filter((day) => [5, 6, 7, 8].every((period) => section.schedule[day][period].itemId === `activity:${section.sectionId}:mech-mini-project`))
    assert.equal(blockDays.length, 1)
    const standalone = project.filter((cell) => cell.day !== blockDays[0])
    assert.equal(standalone.length, 1)
    assert.notEqual(standalone[0].period, 1)
    assert.equal(cellsFor(section, `activity:${section.sectionId}:mech-library`).length, 1)
    assert.equal(cellsFor(section, `activity:${section.sectionId}:mech-mentoring`).length, 1)
  }
  const validation = validateGeneratedTimetables(setup, result.sections)
  assert.deepEqual(validation.issues, [])
  assert.deepEqual(findTeacherTimetableClashes(result.sections), [])

  const totalTeachingSlots = 48
  for (const person of setup.staff) {
    const teacherView = buildTeacherTimetable(result.sections, person.id)
    let generatedAssignments = 0
    let displayedAssignments = 0
    let freeSlots = 0
    for (const section of result.sections) {
      for (const day of days) {
        for (let period = 1; period <= 8; period += 1) {
          const cell = section.schedule[day][period]
          const entries = teacherView[day][period]
          if (cell.teacherId === person.id) {
            generatedAssignments += 1
            assert.deepEqual(entries, [{ sectionId: section.sectionId, cell }])
          }
        }
      }
    }
    for (const day of days) {
      for (let period = 1; period <= 8; period += 1) {
        const entries = teacherView[day][period]
        displayedAssignments += entries.length
        if (entries.length === 0) freeSlots += 1
      }
    }
    assert.equal(displayedAssignments, generatedAssignments)
    assert.equal(freeSlots, totalTeachingSlots - generatedAssignments)
  }
}

test('generates MECH Section A with all configured hours and required blocks', () => {
  const setup = makeSetup(1)
  assertMechRules(setup, generateTimetables(setup))
})

test('generates two selected MECH sections together with global teacher clash protection', () => {
  const setup = makeSetup(2)
  const result = generateTimetables(setup)
  assertMechRules(setup, result)
  if (result.ok) {
    assert.deepEqual(result.sections.map((section) => section.sectionId), ['A', 'B'])
    assert.notDeepEqual(result.sections[0].schedule, result.sections[1].schedule)
  }
})

test('generates selected MECH sections together without teacher clashes or duplicate arrangements', () => {
  const setup = makeSetup(3)
  const result = generateTimetables(setup)
  assertMechRules(setup, result)
  if (result.ok) {
    const signatures = result.sections.map((section) => days.flatMap((day) => Array.from({ length: 8 }, (_, index) => {
      const cell = section.schedule[day][index + 1]
      return `${cell.code}:${cell.name}`
    })).join('|'))
    assert.equal(new Set(signatures).size, 3)
  }
})

test('MECH schedules use the configured section teacher assignment', () => {
  const setup = makeSetup(1)
  const changedTeacherId = 'mech-staff-new-faculty'
  setup.staff.push({ id: changedTeacherId, name: 'Dr. New Faculty' })
  setup.sectionSubjectAssignments = setup.sectionSubjectAssignments.map((assignment) => assignment.subjectId === 'met51' ? { ...assignment, teacherId: changedTeacherId } : assignment)
  const result = generateTimetables(setup)
  assertMechRules(setup, result)
  if (result.ok) {
    assert.ok(cellsFor(result.sections[0], 'core:A:met51').every(({ cell }) => cell.teacherId === changedTeacherId))
    const teacherView = buildTeacherTimetable(result.sections, changedTeacherId)
    assert.ok(days.some((day) => Object.values(teacherView[day]).flat().some(({ sectionId, cell }) => sectionId === 'A' && cell.itemId === 'core:A:met51')))
  }
})
