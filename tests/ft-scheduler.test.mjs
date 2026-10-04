import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTimetables, validateGeneratedTimetables } from '../src/scheduler.ts'
import { findTeacherTimetableClashes } from '../src/teacher-timetable.ts'
import { globalStaffIds } from '../src/staff-identities.ts'

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const staff = [
  ['ft-staff-baghya-nisha', 'Dr. R. Baghya Nisha'],
  ['ft-staff-bargavi', 'Dr. A. Bargavi @ Meanachi'],
  [globalStaffIds.drAMathiarasu, 'Dr. A. Mathiarasu'],
  ['ft-staff-radhika', 'Dr. T. Radhika'],
  ['ft-staff-meenambigai', 'Ms. S. Meenambigai'],
  ['ft-staff-vimal', 'Mr. Vimal H'],
  ['ft-staff-tiroutchelvame', 'Dr. D. Tiroutchelvame'],
].map(([id, name]) => ({ id, name }))
const coreSubjects = [
  ['ft-core-fa', 'FT T51', 'Food Additives', 'FA', 5],
  ['ft-core-eft', 'FT T52', 'Enzyme and Fermentation Technology', 'EFT', 5],
  ['ft-core-rccm', 'FT T53', 'Refrigeration and Cold Chain Management', 'RCCM', 6],
  ['ft-core-fpp', 'FT T54', 'Food Processing and Preservation', 'FPP', 5],
  ['ft-core-post', 'FT E02', 'Pulse and Oil Seed Technology', 'POST', 5],
  ['ft-core-spt', 'FT E05', 'Spices and Plantation Technology', 'SPT', 5],
].map(([id, code, name, abbreviation, hours]) => ({ id, code, name, abbreviation, hoursPerWeek: Number(hours) }))
const labMaster = [
  { id: 'ft-lab-fpp', code: 'FT P51', name: 'Food Processing and Preservation Lab', abbreviation: 'FPP LAB', weeklyPeriods: 3 },
  { id: 'ft-lab-eft', code: 'FT P52', name: 'Enzyme and Fermentation Technology Lab', abbreviation: 'EFT LAB', weeklyPeriods: 3 },
]
const otherSubject = { id: 'ft-other-gp1', code: 'HS P53', name: 'General Proficiency - I', abbreviation: 'GP-I', hoursPerWeek: 2 }
const specialActivities = [
  { id: 'ft-library-mentoring', name: 'LIB/MEN', hoursPerWeek: 1 },
  { id: 'ft-placement', name: 'PLACEMENT TRAINING', hoursPerWeek: 4 },
  { id: 'ft-mini-project', name: 'MINI PROJECT', hoursPerWeek: 4 },
]
const coreTeachers = [
  ['ft-core-fa', ['ft-staff-baghya-nisha']],
  ['ft-core-eft', ['ft-staff-bargavi']],
  ['ft-core-rccm', [globalStaffIds.drAMathiarasu]],
  ['ft-core-fpp', ['ft-staff-radhika']],
  ['ft-core-post', ['ft-staff-meenambigai', 'ft-staff-baghya-nisha']],
  ['ft-core-spt', ['ft-staff-vimal']],
].flatMap(([subjectId, teacherIds]) => teacherIds.map((teacherId) => ({ sectionId: 'A', subjectId, teacherId })))

function makeSetup() {
  return {
    academic: { department: 'FT', academicYear: '2026 - 2027', year: 'III / 3rd Year', semester: 'V / 5th Semester' },
    staff,
    sections: [{ id: 'A', classAdvisorId: 'ft-staff-meenambigai', studentCount: 0 }],
    coreSubjects,
    otherSubjectMaster: [{ code: otherSubject.code, name: otherSubject.name, abbreviation: otherSubject.abbreviation, hoursPerWeek: 2 }],
    otherSubjects: [otherSubject],
    labMaster,
    labAssignments: [
      { sectionId: 'A', labId: 'ft-lab-fpp', teacherId: 'ft-staff-tiroutchelvame' },
      { sectionId: 'A', labId: 'ft-lab-eft', teacherId: 'ft-staff-bargavi' },
    ],
    specialActivities,
    sectionSubjectAssignments: [
      ...coreTeachers,
      { sectionId: 'A', subjectId: 'ft-other-gp1', teacherId: 'ft-staff-tiroutchelvame' },
    ],
    specialActivityAssignments: [
      { sectionId: 'A', activityId: 'ft-library-mentoring', teacherId: 'ft-staff-meenambigai' },
      { sectionId: 'A', activityId: 'ft-placement', teacherId: 'ft-staff-vimal' },
      { sectionId: 'A', activityId: 'ft-mini-project', teacherId: 'ft-staff-meenambigai' },
    ],
  }
}

function cellsFor(section, itemId) {
  return days.flatMap((day) => Array.from({ length: 8 }, (_, index) => {
    const period = index + 1
    const cell = section.schedule[day][period]
    return cell?.itemId === itemId ? { day, period, cell } : []
  }).flat())
}

test('generates FT Section A with exactly 48 validated periods and preserves all supplied assignments', () => {
  const setup = makeSetup()
  const result = generateTimetables(setup)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  assert.deepEqual(result.sections.map((section) => section.sectionId), ['A'])
  assert.equal(result.validation.globalTeacherClashes, 0)
  const section = result.sections[0]
  assert.equal(days.flatMap((day) => Array.from({ length: 8 }, (_, index) => section.schedule[day][index + 1])).filter(Boolean).length, 48)

  const tests = days.map((day) => section.schedule[day][1])
  assert.ok(tests.every((cell) => cell.kind === 'core' && cell.abbreviation.endsWith(' (T)')))
  assert.equal(new Set(tests.map((cell) => cell.itemId)).size, 6)
  for (const subject of coreSubjects) assert.equal(cellsFor(section, `core:A:${subject.id}`).length, subject.hoursPerWeek)

  for (const lab of labMaster) {
    const cells = cellsFor(section, `lab:A:${lab.id}`)
    assert.equal(cells.length, 3)
    const block = cells.map(({ period }) => period).sort((a, b) => a - b).join(',')
    assert.ok(block === '2,3,4' || block === '6,7,8')
    assert.equal(new Set(cells.map(({ day }) => day)).size, 1)
  }
  const fppLab = cellsFor(section, 'lab:A:ft-lab-fpp')
  const eftLab = cellsFor(section, 'lab:A:ft-lab-eft')
  assert.notEqual(fppLab[0].day, eftLab[0].day)

  const placement = cellsFor(section, 'activity:A:ft-placement')
  assert.equal(placement.length, 4)
  assert.equal(placement.map(({ period }) => period).sort((a, b) => a - b).join(','), '5,6,7,8')
  assert.equal(new Set(placement.map(({ day }) => day)).size, 1)
  assert.equal(cellsFor(section, 'activity:A:ft-mini-project').length, 4)
  assert.equal(cellsFor(section, 'activity:A:ft-library-mentoring').length, 1)

  const gpDays = new Set(cellsFor(section, 'other:A:ft-other-gp1').map(({ day }) => day))
  assert.equal(gpDays.size, 2)
  const postTeachers = new Set(cellsFor(section, 'core:A:ft-core-post').map(({ cell }) => cell.teacherId))
  assert.deepEqual(postTeachers, new Set(['ft-staff-meenambigai', 'ft-staff-baghya-nisha']))
  assert.equal(cellsFor(section, 'core:A:ft-core-rccm')[0].cell.teacherId, globalStaffIds.drAMathiarasu)

  const validation = validateGeneratedTimetables(setup, result.sections)
  assert.deepEqual(validation.issues, [])
  assert.equal(findTeacherTimetableClashes(result.sections).length, 0)
})

test('FT generation blocks incomplete or invalid configuration without filling unknowns', () => {
  const setup = makeSetup()
  setup.sections[0].classAdvisorId = ''
  const result = generateTimetables(setup)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INVALID_INPUT')
  assert.ok(result.blockingConstraints.some((issue) => issue.includes('Class Advisor')))
})

test('repeated randomized FT generations remain valid', () => {
  for (let run = 0; run < 5; run += 1) {
    const setup = makeSetup()
    const result = generateTimetables(setup)
    assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
    assert.deepEqual(validateGeneratedTimetables(setup, result.sections).issues, [])
  }
})
