import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTimetables, validateGeneratedTimetables } from '../src/scheduler.ts'

const staff = [
  { id: 'sudha', name: 'Mrs. T. Sudha' },
  { id: 'natarajan', name: 'Dr. P. Natarajan' },
  { id: 'dharani', name: 'Mrs. D. Dharani' },
  { id: 'ramya', name: 'Mrs. S. Ramya' },
  { id: 'baskaran', name: 'Mr. A. Baskaran' },
  { id: 'mba', name: 'New Staff (MBA)' },
  { id: 'new', name: 'New Staff' },
]

function raSetup() {
  const coreSubjects = [
    { id: 'ss', code: 'RAT-301', abbreviation: 'SS', name: 'Signals and Systems', hoursPerWeek: 6, teacherId: 'sudha' },
    { id: 'kdm', code: 'RAT-302', abbreviation: 'KDM', name: 'Kinematics and Dynamics of Machines', hoursPerWeek: 6, teacherId: 'natarajan' },
    { id: 'de', code: 'RAT-303', abbreviation: 'DE', name: 'Digital Electronics', hoursPerWeek: 6, teacherId: 'dharani' },
    { id: 'mes', code: 'RAT-305', abbreviation: 'M&ES', name: 'Microcontroller and Embedded Systems', hoursPerWeek: 6, teacherId: 'ramya' },
    { id: 'plc', code: 'RAT-307', abbreviation: 'PLC', name: 'Programmable Logic Controller', hoursPerWeek: 6, teacherId: 'baskaran' },
  ]
  const otherSubjects = [
    { id: 'hi', code: 'HSMC-301', abbreviation: 'H-I', name: 'Humanities-I', hoursPerWeek: 5, teacherId: 'mba' },
    { id: 'pe', code: 'AU-301', abbreviation: 'PE', name: 'Professional Ethics', hoursPerWeek: 2, teacherId: 'new' },
  ]
  const labMaster = [
    { id: 'de-lab', code: 'RAP-304', abbreviation: 'DE LAB', name: 'Digital Electronics Lab', weeklyPeriods: 2, teacherId: 'dharani' },
    { id: 'mes-lab', code: 'RAP-306', abbreviation: 'M&ES LAB', name: 'Microcontroller and Embedded Systems Lab', weeklyPeriods: 2, teacherId: 'ramya' },
    { id: 'plc-lab', code: 'RAP-308', abbreviation: 'PLC LAB', name: 'Programmable Logic Controller Lab', weeklyPeriods: 2, teacherId: 'baskaran' },
  ]
  const specialActivities = [
    { id: 'ra-placement', name: 'Placement', hoursPerWeek: 4, teacherId: 'ramya' },
    { id: 'nptel-foss', name: 'NPTEL/FOSS', hoursPerWeek: 2, teacherId: 'dharani' },
    { id: 'activity-hour', name: 'Activity Hour', hoursPerWeek: 2, teacherId: 'ramya' },
    { id: 'mentoring-lib', name: 'Mentoring/LIB', hoursPerWeek: 1, teacherId: 'ramya' },
  ]
  return {
    academic: { department: 'RA', academicYear: '2026 - 2027', year: 'III / 3rd Year', semester: 'V / 5th Semester' },
    staff,
    sections: [{ id: 'A', classAdvisorId: 'ramya', studentCount: 0 }],
    coreSubjects: coreSubjects.map(({ teacherId, ...subject }) => subject),
    otherSubjectMaster: otherSubjects.map(({ teacherId, ...subject }) => subject),
    otherSubjects: otherSubjects.map(({ teacherId, ...subject }) => subject),
    labMaster: labMaster.map(({ teacherId, ...lab }) => lab),
    labAssignments: labMaster.map((lab) => ({ labId: lab.id, sectionId: 'A', teacherId: lab.teacherId })),
    specialActivities: specialActivities.map(({ teacherId, ...activity }) => activity),
    sectionSubjectAssignments: [...coreSubjects, ...otherSubjects].map((subject) => ({ sectionId: 'A', subjectId: subject.id, teacherId: subject.teacherId })),
    specialActivityAssignments: specialActivities.map((activity) => ({ sectionId: 'A', activityId: activity.id, teacherId: activity.teacherId })),
  }
}

test('RA accepts its configured 2-period Lab duration and reports the supplied 52-period workload', () => {
  const result = generateTimetables(raSetup())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INVALID_INPUT')
  assert.ok(result.blockingConstraints.some((issue) => issue.includes('52 configured weekly periods')))
  assert.equal(result.blockingConstraints.some((issue) => issue.includes('exactly 3 weekly periods')), false)
})

test('RA generation places configured Labs as 2-period blocks while preserving the 3-period rules elsewhere', () => {
  const setup = raSetup()
  setup.otherSubjects.find((subject) => subject.id === 'hi').hoursPerWeek = 1
  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  const generated = result.sections[0]
  const summary = validateGeneratedTimetables(setup, result.sections)
  assert.deepEqual(summary.issues, [])
  assert.equal(result.validation.sections[0].periodsFilled, 48)
  for (const lab of setup.labMaster) {
    const assigned = Object.entries(generated.schedule).flatMap(([day, schedule]) => Object.entries(schedule)
      .filter(([, cell]) => cell.itemId === `lab:A:${lab.id}`).map(([period]) => ({ day, period: Number(period) })))
    assert.equal(assigned.length, 2)
    assert.equal(new Set(assigned.map(({ day }) => day)).size, 1)
    assert.ok([2, 3, 6, 7].includes(Math.min(...assigned.map(({ period }) => period))))
    assert.equal(Math.max(...assigned.map(({ period }) => period)) - Math.min(...assigned.map(({ period }) => period)), 1)
  }
})
