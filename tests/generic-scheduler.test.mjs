import test from 'node:test'
import assert from 'node:assert/strict'
import { generateGenericTimetable, validateGenericScheduleConfig } from '../src/generic-scheduler.ts'

const identity = { department: 'Example', academicYear: '2026-2027', year: 'III / 3rd Year', semester: 'Odd' }

function coreRows(total, idPrefix, codePrefix, namePrefix, teacherAssignments) {
  const count = Math.ceil(total / 12)
  const base = Math.floor(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}-${index + 1}`, code: `${codePrefix}${index + 1}`, name: `${namePrefix} ${index + 1}`,
    weeklyHours: base + (index < remainder ? 1 : 0), teacherAssignments,
  }))
}

function oneSectionConfig(coreHours, { labs = [], placement, specialActivities = [], otherSubjects = [], rules = {}, candidateCount = 2 } = {}) {
  const assignments = [{ sectionId: 'A', teacherId: 'core-teacher' }]
  const extraStaff = [
    ...labs.map((row) => row.teacherAssignments?.[0]?.teacherId),
    placement?.teacherAssignments?.[0]?.teacherId,
    ...specialActivities.map((row) => row.teacherAssignments?.[0]?.teacherId),
    ...otherSubjects.map((row) => row.teacherAssignments?.[0]?.teacherId),
  ].filter(Boolean).filter((id, index, all) => all.indexOf(id) === index && id !== 'core-teacher')
  return {
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'core-teacher', name: 'Core Teacher' }, ...extraStaff.map((id) => ({ id, name: `${id} Teacher` }))],
    subjects: coreRows(coreHours, 'core-subject', 'C', 'Core Subject', assignments),
    ...(labs.length ? { labs } : {}),
    ...(placement ? { placement } : {}),
    ...(specialActivities.length ? { specialActivities } : {}),
    ...(otherSubjects.length ? { otherSubjects } : {}),
    rules,
    candidateCount,
  }
}

function placementExceptionConfig(duration, { startPeriod = 5, otherAlternates = false, rules = {} } = {}) {
  const config = oneSectionConfig(48 - duration - (otherAlternates ? 1 : 0), {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: duration, blockDuration: duration,
      allowedStartPeriods: [startPeriod], teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
    rules,
  })
  config.placementException = {
    enabled: true,
    alternateSubjects: Array.from({ length: duration }, (_, index) => {
      const subject = config.subjects[index % config.subjects.length]
      const useOtherSubject = otherAlternates && index === 0
      const subjectKind = useOtherSubject ? 'other' : 'core'
      const resolvedSubject = useOtherSubject ? { id: 'alternate-other-1', name: 'Alternate Other 1' } : subject
      if (useOtherSubject) {
        config.otherSubjects = [{ id: resolvedSubject.id, code: `O${index + 1}`, abbreviation: `O${index + 1}`, name: resolvedSubject.name, weeklyHours: 1,
          teacherAssignments: [{ sectionId: 'A', teacherId: 'other-teacher' }] }]
        config.staff.push({ id: 'other-teacher', name: 'Other Teacher' })
      }
      const teacherId = useOtherSubject
        ? 'other-teacher'
        : subject.teacherAssignments[0].teacherId
      return {
        placementPosition: index + 1,
        subjectId: resolvedSubject.id,
        subjectKind,
        subjectNameSnapshot: resolvedSubject.name,
        teacherAssignments: [{ sectionId: 'A', teacherId, teacherNameSnapshot: config.staff.find((teacher) => teacher.id === teacherId).name }],
      }
    }),
  }
  return config
}

function reservedTeacherSchedule(teacherId, period, alternateTeacherId) {
  const schedule = Object.fromEntries(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => [day, {}]))
  for (const day of Object.keys(schedule)) {
    schedule[day][period] = {
      itemId: `reserved:${day}`,
      code: 'R', abbreviation: 'RESERVED', name: 'Reserved',
      teacherId: teacherId ?? 'reserved-primary', kind: 'core',
      ...(alternateTeacherId ? { alternateSubject: {
        placementPosition: 1, subjectId: 'reserved-alternate', subjectKind: 'core',
        code: 'RA', abbreviation: 'RA', name: 'Reserved Alternate',
        teacherId: alternateTeacherId, teacherNameSnapshot: 'Alternate Teacher',
      } } : {}),
    }
  }
  return { sectionId: 'Reserved', profileId: 'reserved', department: 'Reserved', academicYear: '2026-2027', year: 'III', semester: 'Odd', schedule }
}

function scheduleEntries(result, sectionId = 'A') {
  const section = result.sections.find((candidate) => candidate.sectionId === sectionId)
  return Object.entries(section.schedule).flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => ({ day, period: Number(period), cell })))
}

function collectBlocks(entries, predicate) {
  const blocks = new Map()
  for (const entry of entries.filter(predicate)) {
    blocks.set(entry.cell.blockId, [...(blocks.get(entry.cell.blockId) ?? []), entry])
  }
  return [...blocks.values()]
}

function assertEverySectionIsComplete(result, expectedSectionCount) {
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return false
  assert.equal(result.sections.length, expectedSectionCount)
  assert.equal(result.validation.globalTeacherClashes, 0)
  for (const section of result.sections) {
    const cells = Object.values(section.schedule).flatMap((day) => Object.values(day))
    assert.equal(cells.length, 48)
    assert.ok(cells.every((cell) => cell?.teacherId && cell.abbreviation.trim()))
    assert.equal(result.validation.sections.find((summary) => summary.sectionId === section.sectionId)?.periodsFilled, 48)
  }
  const signatures = result.sections.map((section) => Object.entries(section.schedule)
    .flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => `${day}:P${period}:${cell.code}`)).join('|'))
  assert.equal(new Set(signatures).size, signatures.length, 'sections must not have identical complete grids')
  return true
}

test('generic engine fills multiple sections without requiring any optional curriculum category', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }, { id: 'B' }],
    staff: [
      { id: 'teacher-shared', name: 'Shared Teacher' },
      { id: 'teacher-a', name: 'Teacher A' },
      { id: 'teacher-b', name: 'Teacher B' },
    ],
    subjects: [{
      id: 'shared-subject', code: 'SH', name: 'Shared Subject', weeklyHours: 6,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-shared' }, { sectionId: 'B', teacherId: 'teacher-shared' }],
    }, ...coreRows(42, 'section-subject', 'S', 'Section Subject', [
      { sectionId: 'A', teacherId: 'teacher-a' }, { sectionId: 'B', teacherId: 'teacher-b' },
    ])],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })

  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.deepEqual(result.sections.map(({ sectionId }) => sectionId), ['A', 'B'])
  for (const section of result.sections) {
    const cells = Object.values(section.schedule).flatMap((day) => Object.values(day))
    assert.equal(cells.length, 48)
    assert.equal(cells.filter((cell) => cell.itemId === `core:${section.sectionId}:shared-subject`).length, 6)
    assert.equal(cells.filter((cell) => cell.itemId.startsWith(`core:${section.sectionId}:section-subject-`)).length, 42)
  }
  const sharedTeacherSlots = result.sections.map((section) => new Set(
    Object.entries(section.schedule).flatMap(([day, slots]) => Object.entries(slots)
      .filter(([, cell]) => cell.teacherId === 'teacher-shared')
      .map(([period]) => `${day}:P${period}`)),
  ))
  assert.equal([...sharedTeacherSlots[0]].filter((slot) => sharedTeacherSlots[1].has(slot)).length, 0)
  assert.equal(result.validation.globalTeacherClashes, 0)
})

test('normal subjects stay within two consecutive periods unless configured as an explicit block', () => {
  const normal = generateGenericTimetable(oneSectionConfig(48))
  assertEverySectionIsComplete(normal, 1)
  if (normal.ok) {
    for (const day of Object.values(normal.sections[0].schedule)) {
      let previousItem = ''
      let run = 0
      for (let period = 1; period <= 8; period += 1) {
        const cell = day[period]
        run = cell.itemId === previousItem ? run + 1 : 1
        previousItem = cell.itemId
        assert.ok(run <= 2, `${cell.name} has ${run} consecutive periods`)
      }
    }
  }

  const explicitBlock = oneSectionConfig(48)
  explicitBlock.subjects[0].weeklyHours = 3
  explicitBlock.subjects[0].blockDuration = 3
  explicitBlock.subjects[1].weeklyHours = 21
  const blocked = generateGenericTimetable(explicitBlock)
  assertEverySectionIsComplete(blocked, 1)
  if (blocked.ok) {
    const block = scheduleEntries(blocked).filter(({ cell }) => cell.itemId === 'core:A:core-subject-1')
    assert.equal(block.length, 3)
    assert.equal(new Set(block.map(({ day }) => day)).size, 1)
    assert.deepEqual(block.map(({ period }) => period).sort((a, b) => a - b), Array.from({ length: 3 }, (_, index) => Math.min(...block.map(({ period }) => period)) + index))
  }
})

test('fail-first single-period search completes a valid full-week workload without broad backtracking', () => {
  const config = { ...oneSectionConfig(48), randomSeed: 12345 }
  const result = generateGenericTimetable(config)
  assertEverySectionIsComplete(result, 1)
  if (result.ok) assert.ok(result.searchNodes < 1_000, `Expected bounded search, received ${result.searchNodes} nodes.`)
})

test('generic engine applies 3-first lab blocks and counts P1 tests inside subject hours', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A', classAdvisorId: 'teacher-core' }],
    staff: [
      { id: 'teacher-core', name: 'Core Teacher' },
      { id: 'teacher-lab', name: 'Lab Teacher' },
      { id: 'teacher-placement', name: 'Placement Teacher' },
      { id: 'teacher-activity', name: 'Activity Teacher' },
      { id: 'teacher-other', name: 'Other Teacher' },
    ],
    subjects: [{
      id: 'core-1', code: 'C1', name: 'Core Subject', weeklyHours: 24,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-core' }],
    }],
    otherSubjects: [{
      id: 'other-1', code: 'O1', name: 'Other Subject', weeklyHours: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-other' }],
    }],
    labs: [{
      id: 'lab-1', code: 'L1', name: 'Configured Lab', weeklyPeriods: 8, blockDuration: 3,
      allowedStartPeriods: [2, 6],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-lab' }],
    }],
    placement: {
      id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
      allowedStartPeriods: [5],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-placement' }],
    },
    specialActivities: [{
      id: 'activity-1', name: 'Disabled Activity', enabled: false, weeklyPeriods: 100,
      teacherAssignments: [],
    }, {
      id: 'activity-2', name: 'Configured Activity', enabled: true, weeklyPeriods: 8, blockDuration: 2,
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
  })

  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  const section = result.sections[0]
  const cells = Object.entries(section.schedule).flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => ({ day, period: Number(period), cell })))
  assert.equal(cells.length, 48)
  assert.equal(cells.filter(({ cell }) => cell.itemId === 'core:A:core-1').length, 24)
  assert.equal(cells.filter(({ cell }) => cell.isCoreTest).length, 1)
  assert.equal(cells.find(({ cell }) => cell.isCoreTest)?.period, 1)

  const labCells = cells.filter(({ cell }) => cell.itemId === 'lab:A:lab-1')
  assert.equal(labCells.length, 8)
  const labBlocks = new Map()
  for (const entry of labCells) {
    const block = entry.cell.blockId
    labBlocks.set(block, [...(labBlocks.get(block) ?? []), entry])
  }
  assert.deepEqual([...labBlocks.values()].map((block) => block.length).sort((a, b) => a - b), [2, 3, 3])
  for (const block of labBlocks.values()) {
    const labPeriods = block.map(({ period }) => period).sort((a, b) => a - b)
    assert.equal(new Set(block.map(({ day }) => day)).size, 1)
    labPeriods.sort((a, b) => a - b)
    for (let index = 1; index < labPeriods.length; index += 1) assert.ok(labPeriods[index] === labPeriods[index - 1] + 1)
    assert.ok([2, 6].includes(labPeriods[0]))
    assert.ok(!(labPeriods[0] <= 4 && labPeriods.at(-1) >= 5))
  }

  const placementCells = cells.filter(({ cell }) => cell.itemId === 'activity:A:placement')
  assert.deepEqual(placementCells.map(({ period }) => period).sort((a, b) => a - b), [5, 6, 7, 8])
  assert.equal(cells.filter(({ cell }) => cell.itemId === 'activity:A:activity-1').length, 0)
  assert.equal(cells.filter(({ cell }) => cell.itemId === 'activity:A:activity-2').length, 8)
})

test('repeated continuous blocks are searched without exploring equivalent permutations', () => {
  const config = oneSectionConfig(24, {
    labs: [{
      id: 'full-week-lab',
      name: 'Full Week Lab',
      weeklyPeriods: 24,
      blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-teacher' }],
    }],
    candidateCount: 2,
  })
  config.randomSeed = 8112026

  const result = generateGenericTimetable(config)

  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  assert.equal(result.searchNodes < 200, true, `expected symmetry-pruned search, got ${result.searchNodes} nodes`)
  const labBlocks = collectBlocks(scheduleEntries(result), ({ cell }) => cell.kind === 'lab')
  assert.equal(labBlocks.length, 6)
  assert.ok(labBlocks.every((block) => block.length === 4))
  assert.equal(new Set(labBlocks.map((block) => block[0].day)).size, 6)
})

test('generic lab weekly totals split into 3-first continuous blocks, including remainder blocks', () => {
  for (const weeklyPeriods of [6, 3, 2, 4, 5]) {
    const result = generateGenericTimetable({
      ...identity,
      sections: [{ id: 'A' }],
      staff: [{ id: 'core', name: 'Core' }, { id: 'lab', name: 'Lab' }],
      subjects: coreRows(48 - weeklyPeriods, 'core-subject', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
      labs: [{ id: 'lab-item', code: 'L', name: `Lab ${weeklyPeriods}`, weeklyPeriods, blockDuration: 3,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'lab' }] }],
      candidateCount: 2,
      rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
    })
    assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
    if (!result.ok) continue
    const labCells = Object.values(result.sections[0].schedule).flatMap((day) => Object.values(day))
      .filter((cell) => cell.itemId === 'lab:A:lab-item')
    const blocks = new Map()
    for (const cell of labCells) blocks.set(cell.blockId, [...(blocks.get(cell.blockId) ?? []), cell])
    const expected = Array.from({ length: Math.floor(weeklyPeriods / 3) }, () => 3)
    if (weeklyPeriods % 3) expected.push(weeklyPeriods % 3)
    assert.deepEqual([...blocks.values()].map((block) => block.length).sort((a, b) => a - b), expected.sort((a, b) => a - b))
  }
})

test('generic labs use the configured block duration instead of a department-wide fixed duration', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'core', name: 'Core' }, { id: 'lab', name: 'Lab' }],
    subjects: coreRows(42, 'core-subject', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
    labs: [{ id: 'two-period-lab', code: 'L2', name: 'Configured Two-Period Lab', weeklyPeriods: 6, blockDuration: 2,
      allowedStartPeriods: [2, 6], teacherAssignments: [{ sectionId: 'A', teacherId: 'lab' }] }],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const labCells = Object.values(result.sections[0].schedule).flatMap((day) => Object.values(day))
    .filter((cell) => cell.itemId === 'lab:A:two-period-lab')
  const blocks = new Map()
  for (const cell of labCells) blocks.set(cell.blockId, [...(blocks.get(cell.blockId) ?? []), cell])
  assert.deepEqual([...blocks.values()].map((block) => block.length).sort(), [2, 2, 2])
})

test('generic P1 tests consume configured subject workload and the optional Placement can be disabled', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'teacher', name: 'Teacher' }, { id: 'other', name: 'Other' }],
    subjects: coreRows(47, 'core', 'C', 'Core', [{ sectionId: 'A', teacherId: 'teacher' }]),
    otherSubjects: [{ id: 'other', name: 'Other', weeklyHours: 1, teacherAssignments: [{ sectionId: 'A', teacherId: 'other' }] }],
    placement: { id: 'placement', name: 'Placement', enabled: false, weeklyPeriods: 4, blockDuration: 4, teacherAssignments: [] },
    rules: { p1Tests: { enabled: true, subjectIds: ['core-1'] }, coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  const cells = Object.values(result.sections[0].schedule).flatMap((day) => Object.values(day))
  assert.equal(cells.filter((cell) => cell.itemId.startsWith('core:A:core-')).length, 47)
  assert.equal(cells.filter((cell) => cell.isCoreTest).length, 1)
  assert.ok(cells.every((cell) => cell.itemId !== 'activity:A:placement'))
})

test('generic group generation checks shared teacher occupancy across departments and returns distinct grids', () => {
  const profile = (department, fillerTeacher) => ({
    ...identity,
    configurationId: `${department}-third-odd`,
    department,
    sections: [{ id: 'A' }],
    staff: [
      { id: 'globally-shared-teacher', name: 'Shared Teacher' },
      { id: fillerTeacher, name: `${department} Teacher` },
    ],
    subjects: [{
      id: 'shared-course', code: 'SH', name: 'Shared Course', weeklyHours: 6,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'globally-shared-teacher' }],
    }, ...coreRows(42, 'filler-course', `${department}-F`, `${department} Course`, [{ sectionId: 'A', teacherId: fillerTeacher }])],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  const result = generateGenericTimetable({
    schedules: [profile('ECE', 'ece-teacher'), profile('FT', 'ft-teacher')],
    candidateCount: 2,
  })

  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.deepEqual(result.sections.map((section) => section.department), ['ECE', 'FT'])
  assert.equal(result.validation.globalTeacherClashes, 0)
  const sharedTeacherSlots = result.sections.map((section) => new Set(
    Object.entries(section.schedule).flatMap(([day, slots]) => Object.entries(slots)
      .filter(([, cell]) => cell.teacherId === 'globally-shared-teacher')
      .map(([period]) => `${day}:P${period}`)),
  ))
  assert.equal([...sharedTeacherSlots[0]].filter((slot) => sharedTeacherSlots[1].has(slot)).length, 0)
  const signatures = result.sections.map((section) => Object.entries(section.schedule)
    .flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => `${day}:P${period}:${cell.code}`)).join('|'))
  assert.notEqual(signatures[0], signatures[1])
})

test('generic three-section profile handles the same subjects with shared teachers globally', () => {
  const subjects = [
    { id: 'shared-one', code: 'S1', name: 'Shared One', weeklyHours: 16 },
    { id: 'shared-two', code: 'S2', name: 'Shared Two', weeklyHours: 16 },
    { id: 'shared-three', code: 'S3', name: 'Shared Three', weeklyHours: 16 },
  ].map((subject) => ({
    ...subject,
    teacherAssignments: ['A', 'B', 'C'].map((sectionId) => ({ sectionId, teacherId: `teacher-${subject.id}` })),
  }))
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    staff: subjects.map((subject) => ({ id: `teacher-${subject.id}`, name: `${subject.name} Teacher` })),
    subjects,
    candidateCount: 2,
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assertEverySectionIsComplete(result, 3)
  if (!result.ok) return
  for (const section of result.sections) {
    const cells = Object.values(section.schedule).flatMap((day) => Object.values(day))
    for (const subject of subjects) assert.equal(cells.filter((cell) => cell.itemId === `core:${section.sectionId}:${subject.id}`).length, 16)
  }
})

test('generic subjects plus Placement generate four continuous occupied Placement periods', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'core', name: 'Core' }, { id: 'placement', name: 'Placement' }],
    subjects: coreRows(44, 'core', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement' }] },
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const cells = Object.entries(result.sections[0].schedule).flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => ({ day, period: Number(period), cell })))
  const placement = cells.filter(({ cell }) => cell.itemId === 'activity:A:placement')
  assert.equal(placement.length, 4)
  assert.equal(new Set(placement.map(({ day }) => day)).size, 1)
  assert.deepEqual(placement.map(({ period }) => period).sort((a, b) => a - b).map((period, index, all) => index ? period - all[index - 1] : 0).slice(1), [1, 1, 1])
})

test('generic subjects plus special activities use only configured activities and hours', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'core', name: 'Core' }, { id: 'activity', name: 'Activity' }],
    subjects: coreRows(46, 'core', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
    specialActivities: [{ id: 'activity', name: 'Configured Activity', enabled: true, weeklyPeriods: 2, blockDuration: 2,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'activity' }] }],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const cells = Object.values(result.sections[0].schedule).flatMap((day) => Object.values(day))
  assert.equal(cells.filter((cell) => cell.itemId === 'activity:A:activity').length, 2)
  assert.ok(cells.every((cell) => cell.name.startsWith('Core ') || cell.name === 'Configured Activity'))
})

test('generic subjects plus Other Subjects satisfy their configured independent workload', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'core', name: 'Core' }, { id: 'other', name: 'Other' }],
    subjects: coreRows(44, 'core', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
    otherSubjects: [{ id: 'other', code: 'O', name: 'Other Subject', weeklyHours: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'other' }] }],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const cells = Object.values(result.sections[0].schedule).flatMap((day) => Object.values(day))
  assert.equal(cells.filter((cell) => cell.itemId === 'other:A:other').length, 4)
})

test('generic combined configuration fills 48 slots from exactly its configured categories', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: ['core', 'lab', 'placement', 'activity', 'other'].map((id) => ({ id, name: `${id} teacher` })),
    subjects: coreRows(30, 'core', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
    labs: [{ id: 'lab', code: 'L', name: 'Lab', weeklyPeriods: 6, blockDuration: 3,
      allowedStartPeriods: [2, 6], teacherAssignments: [{ sectionId: 'A', teacherId: 'lab' }] }],
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement' }] },
    specialActivities: [{ id: 'activity', name: 'Activity', enabled: true, weeklyPeriods: 2, blockDuration: 2,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'activity' }] }],
    otherSubjects: [{ id: 'other', code: 'O', name: 'Other', weeklyHours: 6,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'other' }] }],
    candidateCount: 2,
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const cells = Object.values(result.sections[0].schedule).flatMap((day) => Object.values(day))
  const expected = new Map([
    ['lab:A:lab', 6], ['activity:A:placement', 4],
    ['activity:A:activity', 2], ['other:A:other', 6],
  ])
  for (const [itemId, periods] of expected) assert.equal(cells.filter((cell) => cell.itemId === itemId).length, periods)
  assert.equal(cells.filter((cell) => cell.itemId.startsWith('core:A:core-')).length, 30)
  assert.ok(cells.every((cell) => expected.has(cell.itemId) || cell.itemId.startsWith('core:A:core-')), 'generation must not invent curricular items')
})

test('new department candidates avoid teacher slots and complete-grid duplicates from prior active schedules', () => {
  const profile = (department, fillerTeacher) => ({
    ...identity,
    department,
    sections: [{ id: 'A' }],
    staff: [
      { id: 'global-teacher', name: 'Global Teacher' },
      { id: fillerTeacher, name: `${department} Filler` },
    ],
    subjects: [
      { id: 'shared', code: 'SH', name: 'Shared Subject', weeklyHours: 6,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'global-teacher' }] },
      ...coreRows(42, 'filler', 'F', 'Filler Subject', [{ sectionId: 'A', teacherId: fillerTeacher }]),
    ],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
    candidateCount: 2,
  })
  const first = generateGenericTimetable(profile('IT', 'it-filler'))
  assert.equal(first.ok, true, first.ok ? '' : first.blockingConstraints.join('\n'))
  if (!first.ok) return

  const second = generateGenericTimetable({
    schedules: [profile('EEE', 'eee-filler')],
    reservedSections: first.sections,
    candidateCount: 2,
  })
  assert.equal(second.ok, true, second.ok ? '' : second.blockingConstraints.join('\n'))
  if (!second.ok) return

  const firstSharedSlots = new Set(Object.entries(first.sections[0].schedule).flatMap(([day, slots]) => Object.entries(slots)
    .filter(([, cell]) => cell.teacherId === 'global-teacher').map(([period]) => `${day}:P${period}`)))
  const secondSharedSlots = Object.entries(second.sections[0].schedule).flatMap(([day, slots]) => Object.entries(slots)
    .filter(([, cell]) => cell.teacherId === 'global-teacher').map(([period]) => `${day}:P${period}`))
  assert.equal(secondSharedSlots.filter((slot) => firstSharedSlots.has(slot)).length, 0)

  const signature = (section) => Object.entries(section.schedule)
    .flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => `${day}:P${period}:${cell.code}`)).join('|')
  assert.notEqual(signature(first.sections[0]), signature(second.sections[0]))
  assert.equal(second.validation.globalTeacherClashes, 0)
})

test('generic generation rejects an impossible clash with a previously accepted timetable', () => {
  const base = {
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'only-teacher', name: 'Only Teacher' }],
    subjects: coreRows(48, 'full-load', 'ALL', 'Full Load', [{ sectionId: 'A', teacherId: 'only-teacher' }]),
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
    candidateCount: 2,
  }
  const first = generateGenericTimetable(base)
  assert.equal(first.ok, true, first.ok ? '' : first.blockingConstraints.join('\n'))
  if (!first.ok) return
  const next = generateGenericTimetable({
    schedules: [{ ...base, department: 'EEE' }],
    reservedSections: first.sections,
    candidateCount: 2,
  })
  assert.equal(next.ok, false)
  if (next.ok) return
  assert.ok(next.blockingConstraints.some((message) => message.includes('previously generated active section')))
  assert.ok(next.blockingConstraints.includes('No partial timetable was returned.'))
})

test('saved global teacher occupancy rejects one slot and routes the new timetable to another', () => {
  const restrictedTeacher = 'global-teacher'
  const availableTeacher = 'available-teacher'
  const config = {
    ...identity,
    department: 'IOT',
    sections: [{ id: 'A' }],
    staff: [
      { id: restrictedTeacher, name: 'Global Teacher' },
      { id: availableTeacher, name: 'Available Teacher' },
    ],
    subjects: [
      ...coreRows(46, 'restricted', 'R', 'Restricted Subject', [{ sectionId: 'A', teacherId: restrictedTeacher }]),
      ...coreRows(2, 'available', 'A', 'Available Subject', [{ sectionId: 'A', teacherId: availableTeacher }]),
    ],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
    candidateCount: 1,
    randomSeed: 31,
  }

  const result = generateGenericTimetable({
    schedules: [config],
    unavailableTeacherSlots: [{ teacherId: restrictedTeacher, day: 'Monday', period: 3 }],
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  assert.notEqual(result.sections[0].schedule.Monday[3].teacherId, restrictedTeacher)
  assert.equal(result.validation.globalTeacherClashes, 0)
})

test('fixed global teacher occupancy removes blocked candidates before search while retaining a legal alternative', () => {
  const sharedTeacher = 'global-teacher'
  const replacementTeacher = 'replacement-teacher'
  const config = {
    ...identity,
    department: 'IOT',
    sections: [{ id: 'A' }],
    staff: [
      { id: sharedTeacher, name: 'Global Teacher' },
      { id: replacementTeacher, name: 'Replacement Teacher' },
    ],
    subjects: [
      ...coreRows(47, 'restricted', 'R', 'Restricted Subject', [{ sectionId: 'A', teacherId: sharedTeacher }]),
      { id: 'replacement', code: 'A1', name: 'Replacement Subject', weeklyHours: 1,
        teacherAssignments: [{ sectionId: 'A', teacherId: replacementTeacher }] },
    ],
    rules: { coreDailyMaximum: 8, coreConsecutiveMaximum: 8 },
    candidateCount: 2,
    randomSeed: 31,
  }

  const result = generateGenericTimetable({
    schedules: [config],
    unavailableTeacherSlots: [{ teacherId: sharedTeacher, day: 'Monday', period: 3 }],
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  assert.equal(result.sections[0].schedule.Monday[3].teacherId, replacementTeacher)
  assert.equal(result.validation.globalTeacherClashes, 0)
})

test('Placement block routing rejects the full block when its alternate teacher is occupied in one period', () => {
  const config = placementExceptionConfig(2, { startPeriod: 5, otherAlternates: true })
  const result = generateGenericTimetable({
    schedules: [config],
    alternateWeekUnavailableTeacherSlots: [{ teacherId: 'core-teacher', day: 'Monday', period: 6 }],
  })
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const placement = scheduleEntries(result).filter(({ cell }) => cell.kind === 'activity' && cell.name === 'Placement')
  assert.equal(placement.length, 2)
  assert.equal(new Set(placement.map(({ day }) => day)).size, 1)
  assert.notEqual(placement[0].day, 'Monday')
})

test('sections with separate teachers still receive different subject-grid arrangements', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }, { id: 'B' }],
    staff: [
      { id: 'a-cn', name: 'A CN Teacher' }, { id: 'a-os', name: 'A OS Teacher' },
      { id: 'b-cn', name: 'B CN Teacher' }, { id: 'b-os', name: 'B OS Teacher' },
    ],
    subjects: [{ id: 'cn', code: 'CN', name: 'Computer Networks', weeklyHours: 24,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'a-cn' }, { sectionId: 'B', teacherId: 'b-cn' }] },
    { id: 'os', code: 'OS', name: 'Operating Systems', weeklyHours: 24,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'a-os' }, { sectionId: 'B', teacherId: 'b-os' }] }],
    candidateCount: 2,
  })
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  const subjectGrid = (section) => Object.entries(section.schedule)
    .flatMap(([day, slots]) => Object.entries(slots).map(([period, cell]) => `${day}:P${period}:${cell.code}`)).join('|')
  assert.notEqual(subjectGrid(result.sections[0]), subjectGrid(result.sections[1]))
})

test('generic configuration rejects an impossible 49-period workload before search', () => {
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }],
    staff: [{ id: 'teacher', name: 'Teacher' }],
    subjects: [{ id: 'core', name: 'Core', weeklyHours: 49, teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher' }] }],
    candidateCount: 2,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'INVALID_INPUT')
  assert.ok(result.blockingConstraints.some((message) => message.includes('Configured workload is 49 periods')))
})

for (const [duration, startPeriod] of [[1, 2], [2, 2], [3, 2], [4, 1], [4, 5]]) {
  test(`configured ${duration}-period lab blocks are continuous at the valid P${startPeriod} position`, () => {
    const result = generateGenericTimetable(oneSectionConfig(48 - duration, {
      labs: [{ id: 'lab', name: 'Configured Lab', weeklyPeriods: duration, blockDuration: duration,
        allowedStartPeriods: [startPeriod], teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-teacher' }] }],
    }))
    assertEverySectionIsComplete(result, 1)
    if (!result.ok) return
    const labBlocks = collectBlocks(scheduleEntries(result), ({ cell }) => cell.kind === 'lab')
    assert.deepEqual(labBlocks.map((block) => block.length), [duration])
    assert.equal(Math.min(...labBlocks[0].map(({ period }) => period)), startPeriod)
    assert.equal(new Set(labBlocks[0].map(({ day }) => day)).size, 1)
    const blockPeriods = labBlocks[0].map(({ period }) => period).sort((a, b) => a - b)
    for (let index = 1; index < blockPeriods.length; index += 1) assert.equal(blockPeriods[index], blockPeriods[index - 1] + 1)
  })
}

test('labs of duration 1–3 reject P1 and P5, and all labs reject lunch-crossing starts', () => {
  for (const duration of [1, 2, 3]) {
    for (const forbiddenStart of [1, 5]) {
      const issues = validateGenericScheduleConfig(oneSectionConfig(48 - duration, {
        labs: [{ id: `lab-${duration}-${forbiddenStart}`, name: 'Restricted Lab', weeklyPeriods: duration, blockDuration: duration,
          allowedStartPeriods: [forbiddenStart], teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-teacher' }] }],
      }))
      assert.ok(issues.some((issue) => issue.includes('has no valid start')), issues.join('\n'))
    }
  }
  const labLunch = validateGenericScheduleConfig(oneSectionConfig(46, {
    labs: [{ id: 'lab', name: 'Lunch Lab', weeklyPeriods: 2, blockDuration: 2, allowedStartPeriods: [4],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-teacher' }] }],
  }))
  assert.ok(labLunch.some((issue) => issue.includes('has no valid start')))
  const tooLong = validateGenericScheduleConfig(oneSectionConfig(42, {
    labs: [{ id: 'lab', name: 'Too Long Lab', weeklyPeriods: 6, blockDuration: 5,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-teacher' }] }],
  }))
  assert.ok(tooLong.some((issue) => issue.includes('maximum 4-period continuous lab block')))
})

for (const [duration, startPeriod] of [[1, 1], [2, 1], [3, 2], [4, 5]]) {
  test(`configured ${duration}-period Placement blocks are continuous at P${startPeriod}`, () => {
    const result = generateGenericTimetable(oneSectionConfig(48 - duration, {
      placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: duration, blockDuration: duration,
        allowedStartPeriods: [startPeriod], teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
    }))
    assertEverySectionIsComplete(result, 1)
    if (!result.ok) return
    const placementBlocks = collectBlocks(scheduleEntries(result), ({ cell }) => cell.itemId === 'activity:A:placement')
    assert.equal(placementBlocks.length, 1)
    assert.equal(placementBlocks[0].length, duration)
    assert.equal(Math.min(...placementBlocks[0].map(({ period }) => period)), startPeriod)
    assert.equal(new Set(placementBlocks[0].map(({ day }) => day)).size, 1)
  })
}

test('Placement may start in P1, while neither Placement nor labs may cross lunch', () => {
  const placement = generateGenericTimetable(oneSectionConfig(46, {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 2, blockDuration: 2,
      allowedStartPeriods: [1], teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  }))
  assertEverySectionIsComplete(placement, 1)
  if (placement.ok) assert.equal(Math.min(...scheduleEntries(placement).filter(({ cell }) => cell.itemId === 'activity:A:placement').map(({ period }) => period)), 1)

  const placementLunch = validateGenericScheduleConfig(oneSectionConfig(46, {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 2, blockDuration: 2, allowedStartPeriods: [4],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  }))
  assert.ok(placementLunch.some((issue) => issue.includes('has no valid start')))
})

test('Placement and a Lab are scheduled on different days', () => {
  const result = generateGenericTimetable(oneSectionConfig(42, {
    labs: [{ id: 'lab', name: 'Lab', weeklyPeriods: 3, blockDuration: 3,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-teacher' }] }],
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 3, blockDuration: 3,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  }))
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const entries = scheduleEntries(result)
  const labDays = new Set(entries.filter(({ cell }) => cell.kind === 'lab').map(({ day }) => day))
  const placementDays = new Set(entries.filter(({ cell }) => cell.itemId === 'activity:A:placement').map(({ day }) => day))
  assert.ok([...labDays].every((day) => !placementDays.has(day)))
})

test('different configured labs prefer separate days when a valid spread is available', () => {
  const result = generateGenericTimetable(oneSectionConfig(44, {
    candidateCount: 12,
    labs: [
      { id: 'lab-one', name: 'Lab One', weeklyPeriods: 2, blockDuration: 2, allowedStartPeriods: [2],
        teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-one-teacher' }] },
      { id: 'lab-two', name: 'Lab Two', weeklyPeriods: 2, blockDuration: 2, allowedStartPeriods: [6],
        teacherAssignments: [{ sectionId: 'A', teacherId: 'lab-two-teacher' }] },
    ],
  }))
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const labDays = ['lab-one', 'lab-two'].map((id) => scheduleEntries(result).find(({ cell }) => cell.itemId === `lab:A:${id}`).day)
  assert.notEqual(labDays[0], labDays[1])
})

test('three-period Placement may share its day with one normal Special Activity', () => {
  const originalRandom = Math.random
  Math.random = () => 0
  let result
  try {
    result = generateGenericTimetable({
      ...identity,
      sections: [{ id: 'A' }],
      staff: [{ id: 'core', name: 'Core' }, { id: 'placement', name: 'Placement' }, { id: 'activity', name: 'Activity' }, { id: 'lab', name: 'Lab' }],
      subjects: coreRows(24, 'core', 'C', 'Core', [{ sectionId: 'A', teacherId: 'core' }]),
      labs: [1, 2, 3, 4, 5].map((index) => ({ id: `lab-${index}`, name: `Lab ${index}`, weeklyPeriods: 4, blockDuration: 4,
        allowedStartPeriods: [1], teacherAssignments: [{ sectionId: 'A', teacherId: 'lab' }] })),
      placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 3, blockDuration: 3,
        allowedStartPeriods: [1], teacherAssignments: [{ sectionId: 'A', teacherId: 'placement' }] },
      specialActivities: [{ id: 'activity', name: 'Activity', enabled: true, weeklyPeriods: 1, allowedStartPeriods: [4],
        teacherAssignments: [{ sectionId: 'A', teacherId: 'activity' }] }],
      rules: { labsPerDayMaximum: 1 },
    })
  } finally {
    Math.random = originalRandom
  }
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const entries = scheduleEntries(result)
  const placementDay = entries.find(({ cell }) => cell.itemId === 'activity:A:placement').day
  const activityDay = entries.find(({ cell }) => cell.itemId === 'activity:A:activity').day
  assert.equal(placementDay, activityDay)
})

test('four-period Placement days exclude Special Activities; shorter Placement can coexist with an activity', () => {
  const longPlacement = generateGenericTimetable(oneSectionConfig(42, {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
    specialActivities: [{ id: 'activity', name: 'Activity', enabled: true, weeklyPeriods: 2, blockDuration: 2,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'activity-teacher' }] }],
  }))
  assertEverySectionIsComplete(longPlacement, 1)
  if (longPlacement.ok) {
    const entries = scheduleEntries(longPlacement)
    const placementDays = new Set(entries.filter(({ cell }) => cell.itemId === 'activity:A:placement').map(({ day }) => day))
    assert.ok(entries.filter(({ cell }) => cell.itemId === 'activity:A:activity').every(({ day }) => !placementDays.has(day)))
  }

  for (const duration of [2, 3]) {
    const shortPlacement = generateGenericTimetable(oneSectionConfig(48 - duration - 2, {
      placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: duration, blockDuration: duration,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
      specialActivities: [{ id: 'activity', name: 'Activity', enabled: true, weeklyPeriods: 2, blockDuration: 2,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'activity-teacher' }] }],
    }))
    assertEverySectionIsComplete(shortPlacement, 1)
  }
})

test('at most one normal Special Activity block is placed per day', () => {
  const result = generateGenericTimetable(oneSectionConfig(44, {
    specialActivities: [1, 2].map((number) => ({ id: `activity-${number}`, name: `Activity ${number}`, enabled: true, weeklyPeriods: 2, blockDuration: 2,
      teacherAssignments: [{ sectionId: 'A', teacherId: `activity-teacher-${number}` }] })),
  }))
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const activitiesByDay = new Map()
  for (const { day, cell } of scheduleEntries(result).filter(({ cell }) => cell.kind === 'activity' && cell.itemId !== 'activity:A:placement')) {
    const blocks = activitiesByDay.get(day) ?? new Set()
    blocks.add(cell.blockId ?? `${cell.itemId}:${day}`)
    activitiesByDay.set(day, blocks)
  }
  assert.ok([...activitiesByDay.values()].every((blocks) => blocks.size <= 1))
})

test('normal Special Activities cannot use P1 even when only P1 is configured', () => {
  const result = generateGenericTimetable(oneSectionConfig(47, {
    specialActivities: [{ id: 'activity', name: 'Activity', enabled: true, weeklyPeriods: 1, allowedStartPeriods: [1],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'activity-teacher' }] }],
  }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'INVALID_INPUT')
})

test('six weekly activity periods can use consecutive days because the default avoidance is only a preference', () => {
  const result = generateGenericTimetable(oneSectionConfig(42, {
    specialActivities: [{ id: 'activity', name: 'Activity', enabled: true, weeklyPeriods: 6,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'activity-teacher' }] }],
  }))
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const days = new Set(scheduleEntries(result).filter(({ cell }) => cell.itemId === 'activity:A:activity').map(({ day }) => day))
  assert.equal(days.size, 6)
})

test('P1 policies support Core, Other Subjects, selected tests, and Test OFF', () => {
  const otherInP1 = generateGenericTimetable(oneSectionConfig(42, {
    otherSubjects: [{ id: 'other', name: 'Other', weeklyHours: 6, teacherAssignments: [{ sectionId: 'A', teacherId: 'other-teacher' }] }],
    rules: { allowCoreSubjectsInP1: false },
  }))
  assertEverySectionIsComplete(otherInP1, 1)
  if (otherInP1.ok) assert.ok(Object.values(otherInP1.sections[0].schedule).every((day) => day[1].kind === 'other'))

  const otherDenied = generateGenericTimetable(oneSectionConfig(42, {
    otherSubjects: [{ id: 'other', name: 'Other', weeklyHours: 6, teacherAssignments: [{ sectionId: 'A', teacherId: 'other-teacher' }] }],
    rules: { allowOtherSubjectsInP1: false },
  }))
  assertEverySectionIsComplete(otherDenied, 1)
  if (otherDenied.ok) assert.ok(Object.values(otherDenied.sections[0].schedule).every((day) => day[1].kind === 'core'))

  const testOverride = generateGenericTimetable(oneSectionConfig(42, {
    otherSubjects: [{ id: 'other', name: 'Other', weeklyHours: 6, teacherAssignments: [{ sectionId: 'A', teacherId: 'other-teacher' }] }],
    rules: { allowCoreSubjectsInP1: false, p1Tests: { enabled: true, subjectIds: ['core-subject-1'] } },
  }))
  assertEverySectionIsComplete(testOverride, 1)
  if (testOverride.ok) assert.equal(scheduleEntries(testOverride).filter(({ cell }) => cell.isCoreTest).length, 1)

  const testOff = generateGenericTimetable(oneSectionConfig(48, { rules: { allowCoreSubjectsInP1: true, p1Tests: { enabled: false } } }))
  assertEverySectionIsComplete(testOff, 1)
  if (testOff.ok) {
    const firstPeriods = Object.values(testOff.sections[0].schedule).map((day) => day[1])
    assert.ok(firstPeriods.every((cell) => cell.kind === 'core' && !cell.isCoreTest))
  }
})

test('46- and 50-period workloads return exact capacity guidance', () => {
  const short = generateGenericTimetable(oneSectionConfig(46))
  assert.equal(short.ok, false)
  if (!short.ok) assert.ok(short.blockingConstraints.some((message) => message.includes('46 periods') && message.includes('2 periods remain unconfigured') && message.includes('capacity is fixed at 48')))

  const excess = generateGenericTimetable(oneSectionConfig(50))
  assert.equal(excess.ok, false)
  if (!excess.ok) assert.ok(excess.blockingConstraints.some((message) => message.includes('50 periods') && message.includes('capacity is fixed at 48') && message.includes('reduce the configured workload by 2 periods')))
})

test('realistic mixed curriculum generation preserves exact workload and every configured placement rule', () => {
  const coreHours = [8, 8, 6, 6, 4]
  const coreStaff = coreHours.map((_, index) => ({ id: `real-core-teacher-${index + 1}`, name: `Core Teacher ${index + 1}` }))
  const alternateStaff = [1, 2, 3, 4].map((index) => ({ id: `real-alternate-teacher-${index}`, name: `Alternate Teacher ${index}` }))
  const config = {
    ...identity,
    sections: [{ id: 'A' }],
    staff: [
      ...coreStaff,
      ...alternateStaff,
      { id: 'real-other-teacher', name: 'Other Teacher' },
      { id: 'real-lab-teacher', name: 'Lab Teacher' },
      { id: 'real-placement-teacher', name: 'Placement Teacher' },
      { id: 'real-activity-teacher', name: 'Activity Teacher' },
    ],
    subjects: coreHours.map((weeklyHours, index) => ({
      id: `real-core-${index + 1}`, code: `R${index + 1}`, name: `Core ${index + 1}`, weeklyHours,
      teacherAssignments: [{ sectionId: 'A', teacherId: coreStaff[index].id }],
    })),
    otherSubjects: [{ id: 'real-other', code: 'RO', name: 'Other Subject', weeklyHours: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'real-other-teacher' }] }],
    labs: [{ id: 'real-lab', code: 'RL', name: 'Configured Lab', weeklyPeriods: 4, blockDuration: 4, allowedStartPeriods: [5],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'real-lab-teacher' }] }],
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 4, blockDuration: 4, allowedStartPeriods: [1],
      teacherAssignments: [{ sectionId: 'A', teacherId: 'real-placement-teacher' }] },
    placementException: {
      enabled: true,
      alternateSubjects: [1, 2, 3, 4].map((placementPosition) => ({
        placementPosition, subjectId: `real-core-${placementPosition}`, subjectKind: 'core',
        subjectNameSnapshot: `Core ${placementPosition}`,
        teacherAssignments: [{ sectionId: 'A', teacherId: alternateStaff[placementPosition - 1].id,
          teacherNameSnapshot: alternateStaff[placementPosition - 1].name }],
      })),
    },
    specialActivities: [{ id: 'real-activity', name: 'Configured Activity', enabled: true, weeklyPeriods: 4, blockDuration: 2,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'real-activity-teacher' }] }],
    rules: { p1Tests: { enabled: true, subjectIds: ['real-core-1'] }, allowOtherSubjectsInP1: false },
    candidateCount: 2,
  }
  const result = generateGenericTimetable(config)
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return

  const entries = scheduleEntries(result)
  const counts = new Map()
  for (const { cell } of entries) counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1)
  for (const [index, weeklyHours] of coreHours.entries()) assert.equal(counts.get(`core:A:real-core-${index + 1}`), weeklyHours)
  assert.equal(counts.get('other:A:real-other'), 4)
  assert.equal(counts.get('lab:A:real-lab'), 4)
  assert.equal(counts.get('activity:A:placement'), 4)
  assert.equal(counts.get('activity:A:real-activity'), 4)
  assert.equal(entries.filter(({ cell }) => cell.isCoreTest).length, 1)
  assert.ok(entries.filter(({ cell }) => cell.isCoreTest).every(({ cell }) => cell.itemId === 'core:A:real-core-1' && cell.kind === 'core'))
  assert.ok(entries.filter(({ cell }) => cell.kind === 'other').every(({ cell }) => !cell.isCoreTest))

  const lab = entries.filter(({ cell }) => cell.itemId === 'lab:A:real-lab')
  const placement = entries.filter(({ cell }) => cell.itemId === 'activity:A:placement')
  assert.equal(new Set(lab.map(({ day }) => day)).size, 1)
  assert.equal(new Set(placement.map(({ day }) => day)).size, 1)
  assert.notEqual(lab[0].day, placement[0].day)
  for (const block of [lab, placement]) {
    const periods = block.map(({ period }) => period).sort((left, right) => left - right)
    assert.deepEqual(periods, Array.from({ length: 4 }, (_, index) => periods[0] + index))
    assert.equal(periods[0] <= 4 && periods.at(-1) >= 5, false, 'lunch must not split a continuous block')
  }
  assert.deepEqual(placement.map(({ cell }) => cell.alternateSubject.placementPosition), [1, 2, 3, 4])
  assert.ok(entries.filter(({ cell }) => cell.kind === 'activity' && cell.itemId !== 'activity:A:placement')
    .every(({ period }) => period !== 1))
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
    const dayActivities = entries.filter((entry) => entry.day === day && entry.cell.kind === 'activity' && entry.cell.itemId !== 'activity:A:placement')
    assert.ok(dayActivities.length <= 2)
  }
  assert.equal(result.validation.globalTeacherClashes, 0)
})

test('different teachers may teach separate sections at the same time', () => {
  const sectionAssignments = [
    { sectionId: 'A', teacherId: 'teacher-A' },
    { sectionId: 'B', teacherId: 'teacher-B' },
  ]
  const result = generateGenericTimetable({
    ...identity,
    sections: [{ id: 'A' }, { id: 'B' }],
    staff: [{ id: 'teacher-A', name: 'Teacher A' }, { id: 'teacher-B', name: 'Teacher B' }],
    subjects: coreRows(48, 'core', 'C', 'Core', sectionAssignments),
    candidateCount: 2,
  })
  assertEverySectionIsComplete(result, 2)
  if (!result.ok) return
  const sectionA = result.sections.find(({ sectionId }) => sectionId === 'A')
  const sectionB = result.sections.find(({ sectionId }) => sectionId === 'B')
  const overlap = Object.keys(sectionA.schedule).flatMap((day) => Object.keys(sectionA.schedule[day])
    .filter((period) => sectionA.schedule[day][period].teacherId !== sectionB.schedule[day][period].teacherId))
  assert.ok(overlap.length > 0)
})

test('Placement Exception maps each configured block position for 1–4 periods without extra workload', () => {
  for (const duration of [1, 2, 3, 4]) {
    const config = placementExceptionConfig(duration)
    assert.deepEqual(validateGenericScheduleConfig(config), [])
    const result = generateGenericTimetable(config)
    assertEverySectionIsComplete(result, 1)
    if (!result.ok) continue
    const entries = scheduleEntries(result)
    const placements = entries.filter(({ cell }) => cell.itemId === 'activity:A:placement')
    assert.equal(placements.length, duration)
    assert.equal(entries.length, 48)
    assert.equal(result.validation.sections[0].periodsFilled, 48)
    assert.equal(entries.filter(({ cell }) => cell.alternateSubject).length, duration)
    const ordered = [...placements].sort((left, right) => left.period - right.period)
    assert.deepEqual(ordered.map(({ cell }) => cell.alternateSubject.placementPosition), Array.from({ length: duration }, (_, index) => index + 1))
    for (const { cell } of ordered) {
      const alternate = config.placementException.alternateSubjects[cell.alternateSubject.placementPosition - 1]
      assert.equal(cell.kind, 'activity')
      assert.equal(cell.alternateSubject.subjectId, alternate.subjectId)
      assert.equal(cell.alternateSubject.name, alternate.subjectNameSnapshot)
      assert.equal(cell.alternateSubject.teacherId, alternate.teacherAssignments[0].teacherId)
      assert.equal(cell.itemId, 'activity:A:placement')
    }
    for (const subject of config.subjects) {
      assert.equal(entries.filter(({ cell }) => cell.itemId === `core:A:${subject.id}`).length, subject.weeklyHours)
    }
  }
})

test('section-specific Placement alternates use each section teacher and avoid global alternate-week clashes', () => {
  const config = oneSectionConfig(46, {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 2, blockDuration: 2,
      allowedStartPeriods: [5], teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  })
  config.sections.push({ id: 'B' })
  config.staff.push({ id: 'placement-teacher-b', name: 'Placement Teacher B' }, { id: 'shared-alternate-teacher', name: 'Shared Alternate Teacher' })
  config.subjects.forEach((subject, index) => {
    const teacherA = index === 0 ? 'shared-alternate-teacher' : `section-a-teacher-${index}`
    const teacherB = index === 0 ? 'shared-alternate-teacher' : `section-b-teacher-${index}`
    for (const teacherId of new Set([teacherA, teacherB])) {
      if (!config.staff.some((staff) => staff.id === teacherId)) config.staff.push({ id: teacherId, name: teacherId })
    }
    subject.teacherAssignments = [{ sectionId: 'A', teacherId: teacherA }, { sectionId: 'B', teacherId: teacherB }]
  })
  config.placement.teacherAssignments.push({ sectionId: 'B', teacherId: 'placement-teacher-b' })
  config.placementException = {
    enabled: true,
    allocationMode: 'custom',
    alternateSubjects: config.sections.flatMap((section) => [1, 2].map((placementPosition) => {
      const subject = config.subjects[placementPosition - 1]
      const assignment = subject.teacherAssignments.find((entry) => entry.sectionId === section.id)
      return {
        placementPosition,
        sectionId: section.id,
        subjectId: subject.id,
        subjectKind: 'core',
        subjectNameSnapshot: subject.name,
        teacherAssignments: [{ ...assignment, teacherNameSnapshot: config.staff.find((staff) => staff.id === assignment.teacherId).name }],
      }
    })),
  }
  assert.deepEqual(validateGenericScheduleConfig(config), [])

  const result = generateGenericTimetable(config)
  assert.equal(result.ok, true, result.ok ? '' : result.blockingConstraints.join('\n'))
  if (!result.ok) return
  assert.equal(result.validation.globalTeacherClashes, 0)
  const alternates = result.sections.flatMap((section) => Object.entries(section.schedule).flatMap(([day, slots]) => Object.entries(slots)
    .filter(([, cell]) => cell.alternateSubject)
    .map(([period, cell]) => ({ sectionId: section.sectionId, day, period, ...cell.alternateSubject }))))
  assert.equal(alternates.length, 4)
  const sharedTeacherSlots = alternates.filter((alternate) => alternate.teacherId === 'shared-alternate-teacher')
  assert.equal(sharedTeacherSlots.length, 2)
  assert.notDeepEqual(
    [sharedTeacherSlots[0].day, sharedTeacherSlots[0].period],
    [sharedTeacherSlots[1].day, sharedTeacherSlots[1].period],
  )
})

test('disabled Placement Exception and enabled Placement without an exception preserve normal generation', () => {
  const disabled = oneSectionConfig(48, {
    placement: { id: 'placement', name: 'Placement', enabled: false, weeklyPeriods: 4, blockDuration: 4,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  })
  disabled.placementException = { enabled: false, alternateSubjects: [] }
  assert.deepEqual(validateGenericScheduleConfig(disabled), [])
  const result = generateGenericTimetable(disabled)
  assertEverySectionIsComplete(result, 1)
  if (result.ok) assert.ok(scheduleEntries(result).every(({ cell }) => !cell.alternateSubject))

  const ordinaryPlacement = generateGenericTimetable(oneSectionConfig(46, {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 2, blockDuration: 2,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  }))
  assertEverySectionIsComplete(ordinaryPlacement, 1)
  if (ordinaryPlacement.ok) assert.ok(scheduleEntries(ordinaryPlacement).every(({ cell }) => !cell.alternateSubject))
})

test('Placement Exception requires Placement, one valid configured subject and teacher per position and section', () => {
  const noPlacement = oneSectionConfig(48)
  noPlacement.placementException = { enabled: true, alternateSubjects: [] }
  assert.ok(validateGenericScheduleConfig(noPlacement).some((issue) => issue.includes('requires an enabled Placement')))

  const incomplete = placementExceptionConfig(2)
  incomplete.placementException.alternateSubjects.pop()
  assert.ok(validateGenericScheduleConfig(incomplete).some((issue) => issue.includes('exactly 2 alternate subject entries')))

  const excessive = placementExceptionConfig(2)
  excessive.placementException.alternateSubjects.push({
    ...structuredClone(excessive.placementException.alternateSubjects[0]), placementPosition: 3,
  })
  assert.ok(validateGenericScheduleConfig(excessive).some((issue) => issue.includes('exactly 2 alternate subject entries')))

  const duplicatePosition = placementExceptionConfig(2)
  duplicatePosition.placementException.alternateSubjects[1].placementPosition = 1
  assert.ok(validateGenericScheduleConfig(duplicatePosition).some((issue) => issue.includes('repeats Placement position 1')))

  const invalidSubject = placementExceptionConfig(2)
  invalidSubject.placementException.alternateSubjects[0].subjectId = 'not-configured'
  assert.ok(validateGenericScheduleConfig(invalidSubject).some((issue) => issue.includes('existing configured')))

  const invalidTeacher = placementExceptionConfig(2)
  invalidTeacher.placementException.alternateSubjects[0].teacherAssignments[0].teacherId = 'not-staff'
  assert.ok(validateGenericScheduleConfig(invalidTeacher).some((issue) => issue.includes('valid alternate teacher')))
})

test('alternate Core and Other Subjects follow their P1 policy and remain normal teaching occurrences', () => {
  const allowedCore = placementExceptionConfig(2, { startPeriod: 1, rules: { allowCoreSubjectsInP1: true } })
  const coreResult = generateGenericTimetable(allowedCore)
  assertEverySectionIsComplete(coreResult, 1)
  if (coreResult.ok) {
    const firstPeriodPlacement = scheduleEntries(coreResult).find(({ period, cell }) => period === 1 && cell.itemId === 'activity:A:placement')
    assert.equal(firstPeriodPlacement.cell.alternateSubject.subjectKind, 'core')
    assert.equal(firstPeriodPlacement.cell.isCoreTest, undefined)
  }

  const allowedOther = placementExceptionConfig(2, { startPeriod: 1, otherAlternates: true, rules: { allowOtherSubjectsInP1: true } })
  const otherResult = generateGenericTimetable(allowedOther)
  assertEverySectionIsComplete(otherResult, 1)
  if (otherResult.ok) {
    const firstPeriodPlacement = scheduleEntries(otherResult).find(({ period, cell }) => period === 1 && cell.itemId === 'activity:A:placement')
    assert.equal(firstPeriodPlacement.cell.alternateSubject.subjectKind, 'other')
    assert.equal(firstPeriodPlacement.cell.alternateSubject.subjectId, 'alternate-other-1')
    assert.equal(firstPeriodPlacement.cell.isCoreTest, undefined)
  }

  const deniedCore = placementExceptionConfig(2, { startPeriod: 1, rules: { allowCoreSubjectsInP1: false } })
  const deniedCoreResult = generateGenericTimetable(deniedCore)
  assert.equal(deniedCoreResult.ok, false)
  if (!deniedCoreResult.ok) assert.equal(deniedCoreResult.code, 'UNSATISFIABLE')

  const deniedOther = placementExceptionConfig(2, { startPeriod: 1, otherAlternates: true, rules: { allowOtherSubjectsInP1: false } })
  const deniedOtherResult = generateGenericTimetable(deniedOther)
  assert.equal(deniedOtherResult.ok, false)
  if (!deniedOtherResult.ok) assert.equal(deniedOtherResult.code, 'UNSATISFIABLE')
})

test('Placement-week and alternate-week teacher occupancy are checked independently against reserved timetables', () => {
  const placementTeacherConflict = placementExceptionConfig(2, { startPeriod: 3 })
  const placementConflict = generateGenericTimetable({
    schedules: [placementTeacherConflict],
    reservedSections: [reservedTeacherSchedule('placement-teacher', 3)],
  })
  assert.equal(placementConflict.ok, false)

  const alternateTeacherConflict = placementExceptionConfig(2, { startPeriod: 3 })
  alternateTeacherConflict.staff.push({ id: 'alternate-teacher', name: 'Alternate Teacher' })
  alternateTeacherConflict.placementException.alternateSubjects[0].teacherAssignments[0] = {
    sectionId: 'A', teacherId: 'alternate-teacher', teacherNameSnapshot: 'Alternate Teacher',
  }
  const alternateConflict = generateGenericTimetable({
    schedules: [alternateTeacherConflict],
    reservedSections: [reservedTeacherSchedule('reserved-primary', 3, 'alternate-teacher')],
  })
  assert.equal(alternateConflict.ok, false)
})

test('saved normal and alternate-week teacher occupancy constrains candidates before generation', () => {
  const placementTeacherConflict = placementExceptionConfig(2, { startPeriod: 3 })
  const normalUnavailable = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => ({
    teacherId: 'placement-teacher', day, period: 3,
    existing: { department: 'Reserved', year: 'III', semester: 'Odd', section: 'A', subject: 'Saved Class' },
  }))
  const normalConflict = generateGenericTimetable({
    schedules: [placementTeacherConflict],
    unavailableTeacherSlots: normalUnavailable,
  })
  assert.equal(normalConflict.ok, false)
  if (!normalConflict.ok) {
    assert.equal(normalConflict.code, 'UNSATISFIABLE')
    assert.ok(normalConflict.blockingConstraints.some((constraint) => constraint.includes('saved normal-week teacher-slot restriction')))
  }

  const alternateTeacherConflict = placementExceptionConfig(2, { startPeriod: 3 })
  alternateTeacherConflict.staff.push({ id: 'alternate-teacher', name: 'Alternate Teacher' })
  alternateTeacherConflict.placementException.alternateSubjects[0].teacherAssignments[0] = {
    sectionId: 'A', teacherId: 'alternate-teacher', teacherNameSnapshot: 'Alternate Teacher',
  }
  const alternateUnavailable = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => ({
    teacherId: 'alternate-teacher', day, period: 3,
  }))
  const alternateConflict = generateGenericTimetable({
    schedules: [alternateTeacherConflict],
    alternateWeekUnavailableTeacherSlots: alternateUnavailable,
  })
  assert.equal(alternateConflict.ok, false)
  if (!alternateConflict.ok) {
    assert.equal(alternateConflict.code, 'UNSATISFIABLE')
    assert.ok(alternateConflict.blockingConstraints.some((constraint) => constraint.includes('saved alternate-week teacher-slot restriction')))
    assert.ok(alternateConflict.blockingConstraints.some((constraint) => constraint.includes('Section A alternate subject Core Subject 1 assigned to Alternate Teacher (alternate-teacher)')
      && constraint.includes('Monday P3')))
  }

  const oneDayUnavailable = generateGenericTimetable({
    schedules: [placementExceptionConfig(2, { startPeriod: 3 })],
    unavailableTeacherSlots: [{ teacherId: 'placement-teacher', day: 'Monday', period: 3 }],
  })
  assertEverySectionIsComplete(oneDayUnavailable, 1)
  if (oneDayUnavailable.ok) {
    assert.notEqual(oneDayUnavailable.sections[0].schedule.Monday[3].itemId, 'activity:A:placement')
    assert.notEqual(oneDayUnavailable.sections[0].schedule.Monday[3].teacherId, 'placement-teacher')
  }
})

test('saved teacher occupancy input rejects malformed slots before searching', () => {
  const result = generateGenericTimetable({
    schedules: [oneSectionConfig(48)],
    unavailableTeacherSlots: [{ teacherId: 'teacher', day: 'Sunday', period: 9 }],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_INPUT')
    assert.ok(result.blockingConstraints.some((constraint) => constraint.includes('unsupported day')))
    assert.ok(result.blockingConstraints.some((constraint) => constraint.includes('invalid period')))
  }
})

test('P1 Tests ON with no eligible Core subject fails with a direct configuration error', () => {
  const config = oneSectionConfig(48, { rules: { p1Tests: { enabled: true, subjectIds: [] } } })
  const before = structuredClone(config)
  const issues = validateGenericScheduleConfig(config)
  const result = generateGenericTimetable(config)
  assert.ok(issues.some((issue) => issue.includes('no eligible Core subjects are selected')), issues.join('\n'))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_INPUT')
    assert.ok(result.blockingConstraints.some((issue) => issue.includes('no eligible Core subjects are selected')))
  }
  assert.deepEqual(config, before, 'validation and failed generation must not mutate configured workload')
})

test('multiple configured P1 Tests stay on eligible Core subjects and consume exact subject hours', () => {
  const config = oneSectionConfig(48, {
    rules: { p1Tests: { enabled: true, subjectIds: ['core-subject-1', 'core-subject-2'] } },
  })
  const result = generateGenericTimetable(config)
  assertEverySectionIsComplete(result, 1)
  if (!result.ok) return
  const tests = scheduleEntries(result).filter(({ cell }) => cell.isCoreTest)
  assert.equal(tests.length, 2)
  assert.ok(tests.every(({ period, cell }) => period === 1 && cell.kind === 'core'))
  assert.deepEqual(new Set(tests.map(({ cell }) => cell.itemId)), new Set(['core:A:core-subject-1', 'core:A:core-subject-2']))
  for (const subject of config.subjects) {
    assert.equal(scheduleEntries(result).filter(({ cell }) => cell.itemId === `core:A:${subject.id}`).length, subject.weeklyHours)
  }
})

test('more than six mandatory normal activity blocks fail before timetable search', () => {
  const activities = Array.from({ length: 7 }, (_, index) => ({
    id: `mandatory-activity-${index + 1}`, name: `Mandatory Activity ${index + 1}`, enabled: true, weeklyPeriods: 1,
    teacherAssignments: [{ sectionId: 'A', teacherId: `activity-teacher-${index + 1}` }],
  }))
  const config = oneSectionConfig(41, { specialActivities: activities })
  const issues = validateGenericScheduleConfig(config)
  const result = generateGenericTimetable(config)
  assert.ok(issues.some((issue) => issue.includes('7 normal Special Activity blocks') && issue.includes('maximum is 6')), issues.join('\n'))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'INVALID_INPUT')
})

test('a seeded generation is repeatable and a different seed can produce another valid grid', () => {
  const firstConfig = { ...oneSectionConfig(48), randomSeed: 123456 }
  const replayConfig = structuredClone(firstConfig)
  const alternateConfig = { ...structuredClone(firstConfig), randomSeed: 654321 }
  const first = generateGenericTimetable(firstConfig)
  const replay = generateGenericTimetable(replayConfig)
  const alternate = generateGenericTimetable(alternateConfig)
  assertEverySectionIsComplete(first, 1)
  assertEverySectionIsComplete(replay, 1)
  assertEverySectionIsComplete(alternate, 1)
  assert.deepEqual(replay, first)
  if (first.ok && alternate.ok) {
    assert.notDeepEqual(alternate.sections[0].schedule, first.sections[0].schedule)
  }
  assert.deepEqual(firstConfig, replayConfig, 'seeded generation must not modify its input')
  assert.ok(validateGenericScheduleConfig({ ...firstConfig, randomSeed: 1.5 }).some((issue) => issue.includes('Random seed must be a safe whole number')))
})

test('five configured sections generate together with exact hours and distinct complete grids', () => {
  const sectionIds = ['Orchid', 'Cobalt', 'Cedar', 'Quartz', 'Willow']
  const subjects = Array.from({ length: 4 }, (_, subjectIndex) => ({
    id: `shared-course-${subjectIndex + 1}`,
    code: `S${subjectIndex + 1}`,
    name: `Shared Course ${subjectIndex + 1}`,
    weeklyHours: 12,
    teacherAssignments: sectionIds.map((sectionId) => ({
      sectionId,
      teacherId: `teacher-${subjectIndex + 1}-${sectionId}`,
    })),
  }))
  const config = {
    ...identity,
    sections: sectionIds.map((id) => ({ id })),
    staff: subjects.flatMap((subject) => subject.teacherAssignments.map(({ teacherId }) => ({ id: teacherId, name: teacherId }))),
    subjects,
    candidateCount: 3,
    randomSeed: 20260929,
  }
  const result = generateGenericTimetable(config)
  assertEverySectionIsComplete(result, sectionIds.length)
  if (!result.ok) return
  for (const section of result.sections) {
    const cells = Object.values(section.schedule).flatMap((day) => Object.values(day))
    for (const subject of subjects) {
      assert.equal(cells.filter((cell) => cell.itemId === `core:${section.sectionId}:${subject.id}`).length, 12)
    }
  }
})

test('an explicit low search-node limit returns a bounded failure without partial cells', () => {
  const result = generateGenericTimetable(oneSectionConfig(48, { rules: { searchNodeLimit: 1 } }))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'SEARCH_LIMIT')
    assert.ok(result.blockingConstraints.some((issue) => issue.includes('1-node limit')))
    assert.equal('sections' in result, false, 'failed searches must not return partial timetables')
  }
  assert.ok(validateGenericScheduleConfig({ ...oneSectionConfig(48), candidateCount: 21 })
    .some((issue) => issue.includes('Candidate count cannot exceed 20')))
  assert.ok(validateGenericScheduleConfig(oneSectionConfig(48, { rules: { searchNodeLimit: 1_000_001 } }))
    .some((issue) => issue.includes('Search node limit cannot exceed')))
})

test('Placement duration above four periods is rejected instead of normalized', () => {
  const config = oneSectionConfig(40, {
    placement: { id: 'placement', name: 'Placement', enabled: true, weeklyPeriods: 8, blockDuration: 5,
      teacherAssignments: [{ sectionId: 'A', teacherId: 'placement-teacher' }] },
  })
  const before = structuredClone(config)
  const issues = validateGenericScheduleConfig(config)
  const result = generateGenericTimetable(config)
  assert.ok(issues.some((issue) => issue.includes('maximum 4-period continuous Placement block')), issues.join('\n'))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'INVALID_INPUT')
  assert.deepEqual(config, before)
})
