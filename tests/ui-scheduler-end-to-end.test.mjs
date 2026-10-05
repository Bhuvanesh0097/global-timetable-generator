import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'
import { createTestPostgresRepository, hasPostgresTestDatabase } from './postgres-test-helpers.mjs'
import { toGenericScheduleConfig } from '../src/generic-schedule-adapter.ts'
import { generateGenericTimetable, validateGenericScheduleConfig } from '../src/generic-scheduler.ts'

const test = hasPostgresTestDatabase ? nodeTest : nodeTest.skip
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function uiSetup(otherHours = 4) {
  const sections = ['A', 'B'].map((id) => ({ id, classAdvisorId: 'staff-8', studentCount: 40 }))
  const staff = Array.from({ length: 8 }, (_, index) => ({ id: `staff-${index + 1}`, name: `Teacher ${index + 1}` }))
  const coreSubjects = Array.from({ length: 4 }, (_, index) => ({
    id: `core-${index + 1}`,
    code: `IOT${index + 1}01`,
    abbreviation: `C${index + 1}`,
    name: `Core Subject ${index + 1}`,
    hoursPerWeek: 8,
  }))
  const sectionSubjectAssignments = sections.flatMap(({ id: sectionId }) => coreSubjects.map((subject, index) => ({
    sectionId, subjectId: subject.id, teacherId: `staff-${index + 1}`,
  })).concat({ sectionId, subjectId: 'other-1', teacherId: 'staff-5' }))
  const specialActivities = [
    { id: 'placement-row', name: 'Placement', hoursPerWeek: 2, blockDuration: 2 },
    { id: 'library-row', name: 'Library / Mentoring', hoursPerWeek: 2 },
  ]

  return {
    academic: { department: 'IOT', academicYear: '2026 - 2027', year: 'III / 3rd Year', semester: 'V / 5th Semester' },
    staff,
    sections,
    coreSubjects,
    otherSubjectMaster: [],
    otherSubjects: [{ id: 'other-1', code: 'IOT401', abbreviation: 'OS', name: 'Other Subject', hoursPerWeek: otherHours }],
    labMaster: [{ id: 'lab-1', code: 'IOTL1', abbreviation: 'L1', name: 'Systems Lab', weeklyPeriods: 8, blockDuration: 4 }],
    labAssignments: sections.map(({ id: sectionId }) => ({ labId: 'lab-1', sectionId, teacherId: 'staff-6' })),
    specialActivities,
    sectionSubjectAssignments,
    specialActivityAssignments: sections.flatMap(({ id: sectionId }) => [
      { sectionId, activityId: 'placement-row', teacherId: 'staff-7' },
      { sectionId, activityId: 'library-row', teacherId: 'staff-8' },
    ]),
    genericScheduling: {
      placementEnabled: true,
      placementWeeklyPeriods: 2,
      testPolicy: 'on',
      p1TestSubjectIds: ['core-1', 'core-2'],
      allowCoreSubjectsInP1: true,
      allowOtherSubjectsInP1: false,
      avoidConsecutiveSpecialActivityDays: false,
    },
    placementException: {
      enabled: true,
      alternateSubjects: [1, 2].map((placementPosition) => ({
        placementPosition,
        subjectId: `core-${placementPosition}`,
        subjectKind: 'core',
        subjectNameSnapshot: `Core Subject ${placementPosition}`,
        teacherAssignments: sections.map(({ id: sectionId }) => ({
          sectionId,
          teacherId: `staff-${placementPosition}`,
          teacherNameSnapshot: `Teacher ${placementPosition}`,
        })),
      })),
    },
  }
}

function cellsFor(section) {
  return days.flatMap((day) => Object.values(section.schedule[day]))
}

function verifyContinuousBlock(positions, expectedDuration) {
  assert.equal(positions.length, expectedDuration)
  assert.equal(new Set(positions.map(({ day }) => day)).size, 1)
  const periods = positions.map(({ period }) => period).sort((left, right) => left - right)
  assert.deepEqual(periods, Array.from({ length: expectedDuration }, (_, index) => periods[0] + index))
  assert.ok(!(periods[0] <= 4 && periods.at(-1) >= 5), 'the block does not cross lunch')
}

async function startApi(repository) {
  const server = createServer((request, response) => {
    void createTimetableApiMiddleware(repository)(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

test('UI setup adapts through generation and saves/reloads the exact global timetable', async () => {
  const setup = uiSetup()
  const converted = toGenericScheduleConfig(setup)
  assert.deepEqual(converted.issues, [])
  assert.deepEqual(validateGenericScheduleConfig(converted.config), [])

  const config = converted.config
  assert.deepEqual([config.department, config.academicYear, config.year, config.semester], [
    'IOT', '2026 - 2027', 'III / 3rd Year', 'V / 5th Semester',
  ])
  assert.deepEqual(config.sections.map(({ id }) => id), ['A', 'B'])
  assert.deepEqual(config.subjects.map(({ id, code, name, weeklyHours }) => ({ id, code, name, weeklyHours })), setup.coreSubjects.map(({ id, code, name, hoursPerWeek }) => ({ id, code, name, weeklyHours: hoursPerWeek })))
  assert.deepEqual(config.subjects[0].teacherAssignments, [
    { sectionId: 'A', teacherId: 'staff-1' }, { sectionId: 'B', teacherId: 'staff-1' },
  ])
  assert.deepEqual(config.otherSubjects.map(({ id, code, name, weeklyHours }) => ({ id, code, name, weeklyHours })), [
    { id: 'other-1', code: 'IOT401', name: 'Other Subject', weeklyHours: 4 },
  ])
  assert.deepEqual(config.labs.map(({ id, weeklyPeriods, blockDuration }) => ({ id, weeklyPeriods, blockDuration })), [
    { id: 'lab-1', weeklyPeriods: 8, blockDuration: 4 },
  ])
  assert.deepEqual(config.placement, {
    id: 'placement', code: '', abbreviation: 'Placement', name: 'Placement', enabled: true, weeklyPeriods: 2,
    blockDuration: 2, teacherAssignments: [
      { sectionId: 'A', teacherId: 'staff-7' }, { sectionId: 'B', teacherId: 'staff-7' },
    ],
  })
  assert.deepEqual(config.placementException.alternateSubjects.map(({ placementPosition, subjectId, subjectNameSnapshot }) => ({ placementPosition, subjectId, subjectNameSnapshot })), [
    { placementPosition: 1, subjectId: 'core-1', subjectNameSnapshot: 'Core Subject 1' },
    { placementPosition: 2, subjectId: 'core-2', subjectNameSnapshot: 'Core Subject 2' },
  ])
  assert.deepEqual(config.specialActivities.map(({ id, name, weeklyPeriods }) => ({ id, name, weeklyPeriods })), [
    { id: 'library-row', name: 'Library / Mentoring', weeklyPeriods: 2 },
  ])
  assert.deepEqual(config.rules, {
    coreDailyMaximum: 2,
    coreConsecutiveMaximum: 2,
    subjectConsecutiveMaximum: 2,
    allowCoreSubjectsInP1: true,
    allowOtherSubjectsInP1: false,
    allowConsecutiveSpecialActivityDays: false,
    p1Tests: { enabled: true, subjectIds: ['core-1', 'core-2'] },
  })

  const workload = () => config.subjects.reduce((sum, subject) => sum + subject.weeklyHours, 0)
    + config.otherSubjects.reduce((sum, subject) => sum + subject.weeklyHours, 0)
    + config.labs.reduce((sum, lab) => sum + lab.weeklyPeriods, 0)
    + config.placement.weeklyPeriods
    + config.specialActivities.reduce((sum, activity) => sum + activity.weeklyPeriods, 0)
  assert.equal(workload(), 48)
  assert.equal(workload(), 48)

  for (const invalidHours of [3, 5]) {
    const invalidConfig = toGenericScheduleConfig(uiSetup(invalidHours)).config
    const invalidGeneration = generateGenericTimetable(invalidConfig)
    assert.equal(invalidGeneration.ok, false)
    assert.ok(invalidGeneration.blockingConstraints.some((message) => message.includes(`Configured workload is ${48 + invalidHours - 4} periods`)))
  }

  const result = generateGenericTimetable(config)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.deepEqual(result.sections.map(({ sectionId }) => sectionId), ['A', 'B'])
  assert.equal(result.validation.globalTeacherClashes, 0)
  for (const section of result.sections) {
    const cells = cellsFor(section)
    assert.equal(cells.length, 48)
    for (const subject of setup.coreSubjects) {
      assert.equal(cells.filter((cell) => cell.kind === 'core' && cell.itemId === `core:${section.sectionId}:${subject.id}`).length, 8)
    }
    assert.equal(cells.filter((cell) => cell.kind === 'other').length, 4)
    assert.equal(cells.filter((cell) => cell.kind === 'lab').length, 8)
    assert.equal(cells.filter((cell) => cell.name === 'Placement').length, 2)
    assert.equal(cells.filter((cell) => cell.name === 'Library / Mentoring').length, 2)
    assert.ok(cells.filter((cell) => cell.isCoreTest).every((cell) => ['core:A:core-1', 'core:A:core-2', 'core:B:core-1', 'core:B:core-2'].includes(cell.itemId)))
    assert.ok(cells.every((cell) => cell.kind !== 'other' || !cell.isCoreTest))
    const p1Tests = days.map((day) => section.schedule[day][1]).filter((cell) => cell.isCoreTest)
    assert.equal(p1Tests.length, 2)
    assert.ok(p1Tests.every((cell) => ['core-1', 'core-2'].some((id) => cell.itemId === `core:${section.sectionId}:${id}`)))

    const placements = []
    const labBlocks = new Map()
    for (const day of days) for (const [period, cell] of Object.entries(section.schedule[day])) {
      if (cell.name === 'Placement') placements.push({ day, period: Number(period), cell })
      if (cell.kind === 'lab') labBlocks.set(cell.blockId, [...(labBlocks.get(cell.blockId) ?? []), { day, period: Number(period), cell }])
    }
    verifyContinuousBlock(placements, 2)
    assert.deepEqual(placements.map(({ cell }) => cell.alternateSubject.placementPosition).sort(), [1, 2])
    assert.ok(placements.every(({ cell }) => cell.alternateSubject.teacherId === `staff-${cell.alternateSubject.placementPosition}`))
    assert.equal(labBlocks.size, 2)
    for (const block of labBlocks.values()) {
      verifyContinuousBlock(block, 4)
      assert.ok(block.every(({ cell }) => cell.teacherId === 'staff-6'))
    }
  }

  const testDatabase = await createTestPostgresRepository()
  let repository = testDatabase.repository
  let { server, origin } = await startApi(repository)
  try {
    const saveResponse = await fetch(`${origin}/api/timetable-versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configuration: config,
        generationId: 'ui-scheduler-e2e-generation',
        sections: result.sections,
        setupSnapshot: setup,
        validation: result.validation,
      }),
    })
    const saved = await saveResponse.json()
    assert.equal(saveResponse.status, 201, saved.error)
    assert.equal(saved.savedVersion.versionNumber, 1)
    assert.equal(saved.timetableVersions.length, 2)

    await new Promise((resolve) => server.close(resolve))
    await testDatabase.close(repository)
    repository = await testDatabase.open()
    ;({ server, origin } = await startApi(repository))
    const versionA = saved.timetableVersions.find(({ sectionName }) => sectionName === 'A')
    const loadResponse = await fetch(`${origin}/api/timetable-versions/${encodeURIComponent(versionA.versionId)}`)
    const loaded = await loadResponse.json()
    assert.equal(loadResponse.status, 200)
    assert.deepEqual(loaded.sections[0].schedule, result.sections[0].schedule)
    assert.deepEqual(loaded.setupSnapshot, setup)
    assert.equal(cellsFor(loaded.sections[0]).filter((cell) => cell.alternateSubject).length, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await testDatabase.cleanup()
  }
})
