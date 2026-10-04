import test from 'node:test'
import assert from 'node:assert/strict'
import { randomizeGenericPlacementAlternates, toGenericScheduleConfig } from '../src/generic-schedule-adapter.ts'
import { generateGenericTimetable, validateGenericScheduleConfig } from '../src/generic-scheduler.ts'

const academic = { department: 'Example', academicYear: '2026-2027', year: 'III / 3rd Year', semester: 'V / 5th Semester' }

function baseSetup() {
  return {
    academic,
    staff: Array.from({ length: 8 }, (_, index) => ({ id: `staff-${index + 1}`, name: `Teacher ${index + 1}` })),
    sections: [{ id: 'A', classAdvisorId: '', studentCount: 40 }],
    coreSubjects: Array.from({ length: 4 }, (_, index) => ({
      id: `core-${index + 1}`, code: `C${index + 1}`, abbreviation: `C${index + 1}`,
      name: `Core ${index + 1}`, hoursPerWeek: 12,
    })),
    otherSubjectMaster: [],
    otherSubjects: [],
    labMaster: [],
    labAssignments: [],
    specialActivities: [],
    sectionSubjectAssignments: Array.from({ length: 4 }, (_, index) => ({
      sectionId: 'A', subjectId: `core-${index + 1}`, teacherId: `staff-${index + 1}`,
    })),
    specialActivityAssignments: [],
  }
}

function sectionCells(section) {
  return Object.values(section.schedule).flatMap((day) => Object.values(day))
}

test('existing subjects-only configuration is ready and generates 48 periods without Placement', () => {
  const converted = toGenericScheduleConfig(baseSetup())
  assert.deepEqual(converted.issues, [])
  assert.equal(converted.config.placement, undefined)
  assert.deepEqual(converted.config.specialActivities, [])
  assert.deepEqual(validateGenericScheduleConfig(converted.config), [])

  const result = generateGenericTimetable(converted.config)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.equal(sectionCells(result.sections[0]).length, 48)
  assert.equal(result.validation.globalTeacherClashes, 0)
})

test('configured section identities and explicit consecutive-day policy reach the generic configuration', () => {
  const setup = baseSetup()
  setup.sections = ['A', 'B', 'C'].map((id) => ({ id, classAdvisorId: '', studentCount: 0 }))
  setup.genericScheduling = { allowConsecutiveSpecialActivityDays: false }

  const converted = toGenericScheduleConfig(setup)
  assert.deepEqual(converted.config.sections.map(({ id }) => id), ['A', 'B', 'C'])
  assert.equal(converted.config.rules.allowConsecutiveSpecialActivityDays, false)
})

test('existing tables adapt multiple sections, labs, Placement and ordinary activities into one global schedule', () => {
  const setup = baseSetup()
  setup.sections.push({ id: 'B', classAdvisorId: '', studentCount: 40 })
  setup.coreSubjects = Array.from({ length: 6 }, (_, index) => ({
    id: `core-${index + 1}`, code: `C${index + 1}`, abbreviation: `C${index + 1}`,
    name: `Core ${index + 1}`, hoursPerWeek: 6,
  }))
  setup.sectionSubjectAssignments = setup.sections.flatMap(({ id: sectionId }) => setup.coreSubjects.map((subject, index) => ({
    sectionId, subjectId: subject.id, teacherId: `staff-${index + 1}`,
  })))
  setup.labMaster = [{ id: 'lab-six', code: 'L6', name: 'Six Period Lab', abbreviation: 'L6', weeklyPeriods: 6, blockDuration: 3 }]
  setup.labAssignments = setup.sections.map(({ id: sectionId }) => ({ labId: 'lab-six', sectionId, teacherId: 'staff-7' }))
  setup.specialActivities = [
    { id: 'placement-row', name: '  pLaCeMeNt TrAiNiNg  ', hoursPerWeek: 4, blockDuration: 4 },
    { id: 'library-row', name: 'Library / Mentoring', hoursPerWeek: 2 },
  ]
  setup.specialActivityAssignments = setup.sections.flatMap(({ id: sectionId }) => [
    { sectionId, activityId: 'placement-row', teacherId: 'staff-8' },
    { sectionId, activityId: 'library-row', teacherId: 'staff-6' },
  ])

  const converted = toGenericScheduleConfig(setup)
  assert.deepEqual(converted.issues, [])
  assert.equal(converted.config.placement.name, '  pLaCeMeNt TrAiNiNg  ')
  assert.equal(converted.config.placement.allowedStartPeriods, undefined)
  assert.deepEqual(converted.config.specialActivities.map(({ name }) => name), ['Library / Mentoring'])
  assert.deepEqual(validateGenericScheduleConfig(converted.config), [])

  const result = generateGenericTimetable(converted.config)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.deepEqual(result.sections.map(({ sectionId }) => sectionId), ['A', 'B'])
  assert.equal(result.validation.globalTeacherClashes, 0)

  for (const section of result.sections) {
    const cells = sectionCells(section)
    assert.equal(cells.length, 48)
    assert.ok(cells.every((cell) => cell?.teacherId && cell.abbreviation))
    const labBlocks = new Map()
    const placementBlocks = new Map()
    for (const [day, periods] of Object.entries(section.schedule)) {
      for (const [period, cell] of Object.entries(periods)) {
        const group = cell.kind === 'lab' ? labBlocks : cell.itemId.endsWith(':placement') ? placementBlocks : null
        if (group) group.set(cell.blockId, [...(group.get(cell.blockId) ?? []), { day, period: Number(period) }])
      }
    }
    assert.deepEqual([...labBlocks.values()].map((block) => block.length).sort(), [3, 3])
    assert.deepEqual([...placementBlocks.values()].map((block) => block.length), [4])
    for (const block of [...labBlocks.values(), ...placementBlocks.values()]) {
      assert.equal(new Set(block.map(({ day }) => day)).size, 1)
      const periods = block.map(({ period }) => period).sort((a, b) => a - b)
      for (let index = 1; index < periods.length; index += 1) assert.equal(periods[index], periods[index - 1] + 1)
      assert.ok(!(periods[0] <= 4 && periods.at(-1) >= 5))
    }
    assert.ok([...placementBlocks.values()].every((block) => [1, 2, 3, 5, 6, 7].includes(Math.min(...block.map(({ period }) => period)))))
  }
})

test('Placement aliases are normalized and duplicate Placement rows keep the configuration unready', () => {
  const setup = baseSetup()
  setup.specialActivities = [
    { id: 'placement-one', name: 'Placement', hoursPerWeek: 4 },
    { id: 'placement-two', name: ' placement training ', hoursPerWeek: 4 },
  ]
  const converted = toGenericScheduleConfig(setup)
  assert.equal(converted.issues.length, 1)
  assert.ok(converted.issues[0].includes('Only one'))
})

test('generic UI settings map Placement, P1 policies, and the activity-day preference into the scheduler config', () => {
  const setup = baseSetup()
  setup.specialActivities = [
    { id: 'placement-row', name: 'Placement', hoursPerWeek: 4 },
    { id: 'library-row', name: 'Library', hoursPerWeek: 0 },
  ]
  setup.specialActivityAssignments = [
    { sectionId: 'A', activityId: 'placement-row', teacherId: 'staff-5' },
  ]
  setup.genericScheduling = {
    placementEnabled: false,
    placementWeeklyPeriods: 3,
    testPolicy: 'on',
    p1TestSubjectIds: ['core-1', 'core-3'],
    allowCoreSubjectsInP1: false,
    allowOtherSubjectsInP1: false,
    allowConsecutiveSpecialActivityDays: true,
  }

  const converted = toGenericScheduleConfig(setup)
  assert.deepEqual(converted.issues, [])
  assert.equal(converted.config.placement.enabled, false)
  assert.equal(converted.config.placement.weeklyPeriods, 3)
  assert.deepEqual(converted.config.specialActivities.map(({ name }) => name), ['Library'])
  assert.deepEqual(converted.config.rules.p1Tests, { enabled: true, subjectIds: ['core-1', 'core-3'] })
  assert.equal(converted.config.rules.allowOtherSubjectsInP1, false)
  assert.equal(converted.config.rules.allowConsecutiveSpecialActivityDays, true)
  assert.equal(converted.config.rules.allowCoreSubjectsInP1, false)
})

test('Test ON without a selected Core / Main Subject is a configuration error', () => {
  const setup = baseSetup()
  setup.genericScheduling = { testPolicy: 'on', p1TestSubjectIds: [] }
  const converted = toGenericScheduleConfig(setup)
  assert.ok(converted.issues.some((issue) => issue.includes('Select at least one Core / Main Subject')))
})

test('Test OFF maps Core and Other Subject P1 allow/deny choices and does not create tests', () => {
  const setup = baseSetup()
  setup.genericScheduling = {
    testPolicy: 'off',
    allowCoreSubjectsInP1: false,
    allowOtherSubjectsInP1: true,
  }
  const converted = toGenericScheduleConfig(setup)
  assert.equal(converted.config.rules.p1Tests.enabled, false)
  assert.equal(converted.config.rules.allowCoreSubjectsInP1, false)
  assert.equal(converted.config.rules.allowOtherSubjectsInP1, true)
})

test('Placement weekly periods 2, 3, and 4 are configurable without a department default', () => {
  for (const weeklyPeriods of [2, 3, 4]) {
    const setup = baseSetup()
    setup.coreSubjects[0].hoursPerWeek -= weeklyPeriods
    setup.specialActivities = [{ id: 'placement-row', name: 'Placement Training', hoursPerWeek: 4 }]
    setup.specialActivityAssignments = [{ sectionId: 'A', activityId: 'placement-row', teacherId: 'staff-5' }]
    setup.genericScheduling = { placementEnabled: true, placementWeeklyPeriods: weeklyPeriods }

    const converted = toGenericScheduleConfig(setup)
    assert.equal(converted.config.placement.weeklyPeriods, weeklyPeriods)
    assert.equal(converted.config.placement.blockDuration, weeklyPeriods)
    assert.deepEqual(validateGenericScheduleConfig(converted.config), [])
  }
})

test('Placement block duration is passed from the existing Special Activity input for each supported size', () => {
  for (const blockDuration of [1, 2, 3, 4]) {
    const setup = baseSetup()
    setup.coreSubjects[0].hoursPerWeek -= 4
    setup.specialActivities = [{ id: 'placement-row', name: 'Placement', hoursPerWeek: 4, blockDuration }]
    setup.specialActivityAssignments = [{ sectionId: 'A', activityId: 'placement-row', teacherId: 'staff-5' }]
    setup.genericScheduling = { placementEnabled: true, placementWeeklyPeriods: 4 }
    setup.placementException = {
      enabled: true,
      alternateSubjects: Array.from({ length: blockDuration }, (_, index) => ({
        placementPosition: index + 1,
        subjectId: 'core-1',
        subjectKind: 'core',
        subjectNameSnapshot: 'Core 1',
        teacherAssignments: [{ sectionId: 'A', teacherId: 'staff-1', teacherNameSnapshot: 'Teacher 1' }],
      })),
    }

    const converted = toGenericScheduleConfig(setup)
    assert.equal(converted.config.placement.blockDuration, blockDuration)
    assert.equal(converted.config.placementException.alternateSubjects.length, blockDuration)
    assert.deepEqual(validateGenericScheduleConfig(converted.config), [])
  }
})

test('Placement Exception snapshots adapt into the generic config without changing configured workload', () => {
  const setup = baseSetup()
  setup.coreSubjects[0].hoursPerWeek -= 2
  setup.specialActivities = [{ id: 'placement-row', name: 'Placement', hoursPerWeek: 2 }]
  setup.specialActivityAssignments = [{ sectionId: 'A', activityId: 'placement-row', teacherId: 'staff-5' }]
  setup.placementException = {
    enabled: true,
    alternateSubjects: [1, 2].map((placementPosition) => ({
      placementPosition,
      subjectId: 'core-1',
      subjectKind: 'core',
      subjectNameSnapshot: 'Saved Core 1',
      teacherAssignments: [{
        sectionId: 'A', teacherId: 'staff-1', teacherNameSnapshot: 'Saved Teacher 1',
      }],
    })),
  }

  const converted = toGenericScheduleConfig(setup)
  assert.deepEqual(converted.issues, [])
  assert.equal(converted.config.placementException.enabled, true)
  assert.deepEqual(converted.config.placementException.alternateSubjects.map(({ placementPosition, subjectId, subjectNameSnapshot }) => ({ placementPosition, subjectId, subjectNameSnapshot })), [
    { placementPosition: 1, subjectId: 'core-1', subjectNameSnapshot: 'Saved Core 1' },
    { placementPosition: 2, subjectId: 'core-1', subjectNameSnapshot: 'Saved Core 1' },
  ])
  assert.deepEqual(validateGenericScheduleConfig(converted.config), [])

  const result = generateGenericTimetable(converted.config)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.equal(sectionCells(result.sections[0]).length, 48)
  assert.equal(sectionCells(result.sections[0]).filter((cell) => cell.alternateSubject).length, 2)
  assert.equal(sectionCells(result.sections[0]).filter((cell) => cell.itemId === 'activity:A:placement').length, 2)
})

test('an enabled Placement Exception without a Placement activity is reported for correction', () => {
  const setup = baseSetup()
  setup.placementException = { enabled: true, alternateSubjects: [] }
  const converted = toGenericScheduleConfig(setup)
  assert.equal(converted.config.placement, undefined)
  assert.equal(converted.config.placementException.enabled, true)
  assert.ok(validateGenericScheduleConfig(converted.config).some((issue) => issue.includes('requires an enabled Placement activity')))
})

test('random Placement allocation creates one assigned subject per position for every configured section and round-trips', () => {
  const setup = baseSetup()
  setup.coreSubjects[0].hoursPerWeek -= 4
  setup.sections = ['A', 'B', 'C', 'D'].map((id) => ({ id, classAdvisorId: '', studentCount: 40 }))
  setup.sectionSubjectAssignments = setup.sections.flatMap(({ id: sectionId }) => setup.coreSubjects.map((subject, index) => ({
    sectionId, subjectId: subject.id, teacherId: `${sectionId}-staff-${index + 1}`,
  })))
  setup.staff.push(...[...new Set(setup.sectionSubjectAssignments.map((assignment) => assignment.teacherId))]
    .filter((teacherId) => !setup.staff.some((staff) => staff.id === teacherId))
    .map((id) => ({ id, name: id })))
  setup.specialActivities = [{ id: 'placement-row', name: 'Placement', hoursPerWeek: 4 }]
  setup.specialActivityAssignments = setup.sections.map(({ id: sectionId }) => ({ sectionId, activityId: 'placement-row', teacherId: `placement-${sectionId}` }))
  setup.staff.push(...setup.sections.map(({ id }) => ({ id: `placement-${id}`, name: `Placement Teacher ${id}` })))
  setup.genericScheduling = { placementEnabled: true, placementWeeklyPeriods: 4 }
  setup.placementException = { enabled: true, allocationMode: 'random', alternateSubjects: [] }

  const converted = toGenericScheduleConfig(setup)
  assert.deepEqual(validateGenericScheduleConfig(converted.config), [])
  const allocated = randomizeGenericPlacementAlternates(converted.config, () => 0)
  assert.deepEqual(allocated.issues, [])
  const alternates = allocated.config.placementException.alternateSubjects
  assert.equal(alternates.length, 16)
  for (const section of setup.sections) {
    const sectionAlternates = alternates.filter((alternate) => alternate.sectionId === section.id)
    assert.deepEqual(sectionAlternates.map((alternate) => alternate.placementPosition), [1, 2, 3, 4])
    assert.ok(sectionAlternates.every((alternate) => alternate.teacherAssignments.length === 1
      && alternate.teacherAssignments[0].sectionId === section.id
      && alternate.teacherAssignments[0].teacherId === setup.sectionSubjectAssignments.find((assignment) =>
        assignment.sectionId === section.id && assignment.subjectId === alternate.subjectId)?.teacherId))
  }
  assert.deepEqual(validateGenericScheduleConfig(allocated.config), [])

  const savedSetup = {
    ...setup,
    placementException: { enabled: true, allocationMode: 'random', alternateSubjects: alternates },
  }
  const reloaded = toGenericScheduleConfig(savedSetup).config
  assert.deepEqual(reloaded.placementException.alternateSubjects.map(({ sectionId, placementPosition, subjectId }) => ({ sectionId, placementPosition, subjectId })),
    alternates.map(({ sectionId, placementPosition, subjectId }) => ({ sectionId, placementPosition, subjectId })))
})
