import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { createServer } from 'node:http'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'
import { TimetableRepository } from '../backend/timetable-repository.mjs'
import { createTestPostgresRepository, hasPostgresTestDatabase } from './postgres-test-helpers.mjs'

const test = hasPostgresTestDatabase ? nodeTest : nodeTest.skip
const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const identity = (department, year, semester) => ({
  department, year, semester, academicYear: '2026 - 2027',
})
const globalStaff = [
  { id: 'staff-1', name: 'Alexandra Stone' },
  { id: 'staff-other', name: 'Other Teacher' },
  { id: 'staff-similar', name: 'Alexandra Stoner' },
  { id: 'staff-unused', name: 'Unused Global Staff' },
  { id: 'staff-single', name: 'Single Timetable Teacher' },
]

nodeTest('overall staff repository searches global staff and combines active cell records by identity and slot', async () => {
  const timestamp = new Date('2026-10-08T00:00:00Z')
  const teacherRows = globalStaff.map((teacher) => ({
    id: teacher.id,
    canonical_name: teacher.name,
    normalized_name: teacher.name.toLocaleLowerCase(),
    created_at: timestamp,
    updated_at: timestamp,
  }))
  const placementSnapshot = {
    staff: [{ id: 'staff-1', name: 'Alexandra Stone' }],
    coreSubjects: [{ id: 'alternate-core', code: 'ALT101', abbreviation: 'ALT', name: 'Alternate Core' }],
    placementException: {
      enabled: true,
      alternateSubjects: [{
        placementPosition: 1,
        sectionId: 'D',
        subjectId: 'alternate-core',
        subjectKind: 'core',
        subjectNameSnapshot: 'Alternate Core',
        teacherAssignments: [{ sectionId: 'D', teacherId: 'staff-1', teacherNameSnapshot: 'Alex Stone' }],
      }],
    },
  }
  const versions = [
    { id: 'version-a', generation_id: 'generation-a', status: 'LOCKED', section_source_id: 'A', section_name: 'A',
      configuration_id: 'config-a', department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
    { id: 'version-b', generation_id: 'generation-b', status: 'SAVED', section_source_id: 'B', section_name: 'B',
      configuration_id: 'config-b', department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
    { id: 'version-c', generation_id: 'generation-c', status: 'SAVED', section_source_id: 'C', section_name: 'C',
      configuration_id: 'config-c', department: 'EEE', year: 'III / 3rd Year', semester: 'VI / 6th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
    { id: 'version-d', generation_id: 'generation-d', status: 'SAVED', section_source_id: 'D', section_name: 'D',
      configuration_id: 'config-d', department: 'ME', year: 'IV / 4th Year', semester: 'VIII / 8th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: JSON.stringify(placementSnapshot) },
    { id: 'version-e', generation_id: 'generation-e', status: 'SAVED', section_source_id: 'E', section_name: 'E',
      configuration_id: 'config-e', department: 'RA', year: 'III / 3rd Year', semester: 'V / 5th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
    { id: 'version-h-active', generation_id: 'generation-h2', status: 'SAVED', section_source_id: 'H', section_name: 'H',
      configuration_id: 'config-h', department: 'CSE', year: 'I / 1st Year', semester: 'II / 2nd Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
    { id: 'version-single', generation_id: 'generation-single', status: 'SAVED', section_source_id: 'S', section_name: 'S',
      configuration_id: 'config-single', department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
    { id: 'version-other', generation_id: 'generation-other', status: 'SAVED', section_source_id: 'O', section_name: 'O',
      configuration_id: 'config-other', department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester',
      academic_year: '2026 - 2027', setup_snapshot_json: '{}' },
  ]
  const cellsByVersion = new Map([
    ['version-a', [{ id: 'cell-a', timetable_version_id: 'version-a', source_item_key: 'core', cell_type: 'SUBJECT',
      day: 'Monday', period: 1, subject_code: 'C101', subject_name: 'Core Subject', abbreviation: 'CORE (T)',
      is_test: 1, teacher_id: 'staff-1', teacher_name_snapshot: 'Alexandra Stone', section_name: 'A',
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academic_year: '2026 - 2027' }]],
    ['version-b', [{ id: 'cell-b', timetable_version_id: 'version-b', source_item_key: 'lab', cell_type: 'LAB',
      day: 'Monday', period: 1, subject_code: 'L101', subject_name: 'Systems Lab', abbreviation: 'LAB', block_id: 'lab-block-1',
      is_test: 0, teacher_id: 'staff-1', teacher_name_snapshot: 'Alexandra Stone', section_name: 'B',
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academic_year: '2026 - 2027' }]],
    ['version-c', [{ id: 'cell-c', timetable_version_id: 'version-c', source_item_key: 'activity', cell_type: 'SPECIAL_ACTIVITY',
      day: 'Monday', period: 1, activity_name: 'Library Mentoring', abbreviation: 'LIB/MEN',
      is_test: 0, teacher_id: 'staff-1', teacher_name_snapshot: 'Alex Stone', section_name: 'C',
      department: 'EEE', year: 'III / 3rd Year', semester: 'VI / 6th Semester', academic_year: '2026 - 2027' }]],
    ['version-d', [{ id: 'cell-d', timetable_version_id: 'version-d', source_item_key: 'placement', cell_type: 'PLACEMENT',
      day: 'Tuesday', period: 2, subject_code: 'PLC', subject_name: 'Placement', abbreviation: 'PLC', block_id: 'placement-block-1',
      is_test: 0, teacher_id: 'staff-other', teacher_name_snapshot: 'Other Teacher', section_name: 'D',
      department: 'ME', year: 'IV / 4th Year', semester: 'VIII / 8th Semester', academic_year: '2026 - 2027' }]],
    ['version-e', [{ id: 'cell-e', timetable_version_id: 'version-e', source_item_key: 'activity', cell_type: 'SPECIAL_ACTIVITY',
      day: 'Wednesday', period: 3, activity_name: 'Library Mentoring', abbreviation: 'LIB/MEN',
      is_test: 0, teacher_id: 'staff-1', teacher_name_snapshot: 'Alexandra Stone', section_name: 'E',
      department: 'RA', year: 'III / 3rd Year', semester: 'V / 5th Semester', academic_year: '2026 - 2027' }]],
    ['version-h-active', [{ id: 'cell-h', timetable_version_id: 'version-h-active', source_item_key: 'core', cell_type: 'SUBJECT',
      day: 'Friday', period: 8, subject_code: 'C101', subject_name: 'Replacement Core', abbreviation: 'CORE',
      is_test: 0, teacher_id: 'staff-other', teacher_name_snapshot: 'Other Teacher', section_name: 'H',
      department: 'CSE', year: 'I / 1st Year', semester: 'II / 2nd Semester', academic_year: '2026 - 2027' }]],
    ['version-single', [{ id: 'cell-single', timetable_version_id: 'version-single', source_item_key: 'core', cell_type: 'SUBJECT',
      day: 'Thursday', period: 5, subject_code: 'C101', subject_name: 'Single Timetable Subject', abbreviation: 'ONE',
      is_test: 0, teacher_id: 'staff-single', teacher_name_snapshot: 'Single Timetable Teacher', section_name: 'S',
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academic_year: '2026 - 2027' }]],
    ['version-other', [{ id: 'cell-other', timetable_version_id: 'version-other', source_item_key: 'core', cell_type: 'SUBJECT',
      day: 'Monday', period: 1, subject_code: 'C101', subject_name: 'Other Teacher Subject', abbreviation: 'OTHER',
      is_test: 0, teacher_id: 'staff-other', teacher_name_snapshot: 'Other Teacher', section_name: 'O',
      department: 'CSE', year: 'II / 2nd Year', semester: 'IV / 4th Semester', academic_year: '2026 - 2027' }]],
  ])
  let sawActiveVersionQuery = false
  const database = {
    prepare(sql) {
      if (sql.includes('FROM teachers ORDER BY normalized_name, id')) {
        return { all: async () => teacherRows }
      }
      if (sql.includes('FROM generated_timetables timetables')) {
        assert.match(sql, /versions\.id = timetables\.active_version_id/)
        assert.match(sql, /versions\.status IN \('SAVED', 'LOCKED'\)/)
        sawActiveVersionQuery = true
        return { all: async () => versions.flatMap((version) => (cellsByVersion.get(version.id) ?? []).map((cell) => ({
          version_id: version.id,
          version_generation_id: version.generation_id,
          version_status: version.status,
          setup_snapshot_json: version.setup_snapshot_json,
          configuration_id: version.configuration_id,
          section_id: `db-section-${version.section_source_id}`,
          section_source_id: version.section_source_id,
          configured_section_name: version.section_name,
          configured_department: version.department,
          configured_year: version.year,
          configured_semester: version.semester,
          configured_academic_year: version.academic_year,
          ...cell,
        }))) }
      }
      throw new Error(`Unexpected SQL in fake repository test: ${sql}`)
    },
  }
  const repository = new TimetableRepository(database)

  const timetable = await repository.getOverallStaffTimetable('staff-1')
  assert.equal(sawActiveVersionQuery, true)
  assert.equal(timetable.days.Monday[1].assignments.length, 3, 'one teacher is combined across sections and departments')
  assert.equal(timetable.days.Monday[1].conflict, true, 'same-period active assignments are all surfaced')
  assert.deepEqual(timetable.days.Monday[1].conflictWeeks, ['normal'])
  assert.equal(timetable.days.Monday[1].assignments[0].versionStatus, 'LOCKED')
  assert.equal(timetable.days.Monday[1].assignments[0].cell.isCoreTest, true)
  assert.equal(timetable.days.Monday[1].assignments[1].cell.blockId, 'lab-block-1')
  assert.equal(timetable.days.Monday[1].assignments[2].cell.name, 'Library Mentoring')
  assert.equal(timetable.days.Tuesday[2].assignments[0].week, 'alternate')
  assert.equal(timetable.days.Tuesday[2].assignments[0].cell.cellType, 'PLACEMENT')
  assert.equal(timetable.days.Tuesday[2].assignments[0].cell.alternateSubject.teacherId, 'staff-1')
  assert.equal(timetable.days.Wednesday[3].assignments[0].cell.cellType, 'SPECIAL_ACTIVITY')
  assert.equal(timetable.days.Friday[8], undefined, 'inactive historical teacher assignments are excluded')
  const singleTeacher = await repository.getOverallStaffTimetable('staff-single')
  assert.equal(singleTeacher.days.Thursday[5].assignments.length, 1, 'one timetable produces one retained assignment')
  assert.equal(singleTeacher.days.Monday[1], undefined, 'a different teacher at the same time is not included')
  assert.ok(timetable.days.Monday[1].assignments.some(({ teacherNameSnapshot }) => teacherNameSnapshot === 'Alex Stone'))
  assert.ok(timetable.days.Monday[1].assignments.every(({ teacherId }) => teacherId === 'staff-1'))
  assert.ok((await repository.searchGlobalStaff()).some(({ id }) => id === 'staff-unused'))
  assert.deepEqual((await repository.searchGlobalStaff('staff-1')).map(({ id }) => id), ['staff-1'])
  assert.deepEqual((await repository.searchGlobalStaff('Alexandra Stone')).map(({ id }) => id), ['staff-1'])
  assert.deepEqual((await repository.searchGlobalStaff('aLeXaNdRa sToNe')).map(({ id }) => id), ['staff-1'])
  assert.deepEqual((await repository.searchGlobalStaff('alexandra sto')).map(({ id }) => id).sort(), ['staff-1', 'staff-similar'])
  assert.equal(await repository.getOverallStaffTimetable('unknown-teacher'), null)
})

function scheduleFor(sectionId, overrides = []) {
  const schedule = Object.fromEntries(daysOfWeek.map((day) => [day, Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [index + 1, {
      itemId: 'core', code: 'C101', abbreviation: 'CORE', name: 'Core Subject',
      teacherId: 'staff-other', kind: 'core',
    }]),
  )]))
  for (const [day, period, cell] of overrides) schedule[day][period] = cell
  return { sectionId, schedule }
}

function setupSnapshot(staff, placementException = { enabled: false, alternateSubjects: [] }) {
  return {
    staff,
    coreSubjects: [{ id: 'core', code: 'C101', abbreviation: 'CORE', name: 'Core Subject' }],
    otherSubjects: [],
    placementException,
  }
}

function configurationFor(identityFields, sectionIds, staff) {
  return {
    ...identityFields,
    sections: sectionIds.map((id) => ({ id, name: id })),
    staff,
    subjects: [{ id: 'core', code: 'C101', name: 'Core Subject', weeklyHours: 48,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'staff-other' })) }],
    labs: [{ id: 'lab', code: 'L101', name: 'Systems Lab', abbreviation: 'LAB', weeklyPeriods: 2, blockDuration: 2,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'staff-other' })) }],
    specialActivities: [{ id: 'activity', name: 'Library Mentoring', weeklyPeriods: 1,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'staff-other' })) }],
    placement: { id: 'placement', code: 'PLC', name: 'Placement', weeklyPeriods: 1, blockDuration: 1,
      teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId: 'staff-other' })) },
  }
}

test('overall staff lookup combines active saved cells by stable teacher ID and preserves slot conflicts', async () => {
  const testDatabase = await createTestPostgresRepository()
  const repository = testDatabase.repository
  let generationNumber = 0
  const createAndSave = async ({ department, year, semester, sections, teacherName = 'Alexandra Stone', placementException }) => {
    const staff = globalStaff.map((teacher) => ({
      ...teacher,
      ...(teacher.id === 'staff-1' ? { name: teacherName } : {}),
    }))
    const configuration = configurationFor(identity(department, year, semester), sections.map(({ sectionId }) => sectionId), staff)
    const configurationId = await repository.createTimetableConfiguration(configuration)
    const saved = await repository.saveGeneratedTimetableData({
      configurationId,
      generationId: `overall-staff-generation-${++generationNumber}`,
      sections: sections.map(({ sectionId, overrides }) => scheduleFor(sectionId, overrides)),
      staff,
      validation: { valid: true },
      setupSnapshot: setupSnapshot(staff, placementException),
    })
    return { configurationId, saved }
  }

  try {
    const cse = await createAndSave({
      ...identity('CSE', 'II / 2nd Year', 'IV / 4th Semester'),
      sections: [
        { sectionId: 'A', overrides: [['Monday', 1, {
          itemId: 'core', code: 'C101', abbreviation: 'CORE (T)', name: 'Core Subject',
          teacherId: 'staff-1', kind: 'core', isCoreTest: true,
        }]] },
        { sectionId: 'B', overrides: [['Monday', 1, {
          itemId: 'lab', blockId: 'lab-block-1', code: 'L101', abbreviation: 'LAB', name: 'Systems Lab',
          teacherId: 'staff-1', kind: 'lab',
        }]] },
      ],
    })
    await repository.setSavedTimetableVersionStatus({ versionId: cse.saved[0].id, status: 'LOCKED' })

    await createAndSave({
      ...identity('EEE', 'III / 3rd Year', 'VI / 6th Semester'),
      teacherName: 'Alex Stone',
      sections: [{ sectionId: 'C', overrides: [['Monday', 1, {
        itemId: 'activity', code: '', abbreviation: 'LIB/MEN', name: 'Library Mentoring',
        teacherId: 'staff-1', kind: 'activity',
      }]] }],
    })
    await createAndSave({
      ...identity('ME', 'IV / 4th Year', 'VIII / 8th Semester'),
      sections: [{ sectionId: 'D', overrides: [['Tuesday', 2, {
        itemId: 'placement', blockId: 'placement-block-1', code: 'PLC', abbreviation: 'PLC', name: 'Placement',
        teacherId: 'staff-other', kind: 'activity',
      }]] }],
      placementException: {
        enabled: true,
        alternateSubjects: [{
          placementPosition: 1, sectionId: 'D', subjectId: 'core', subjectKind: 'core',
          subjectNameSnapshot: 'Alternate Core Subject',
          teacherAssignments: [{ sectionId: 'D', teacherId: 'staff-1', teacherNameSnapshot: 'Alexandra Stone' }],
        }],
      },
    })
    await createAndSave({
      ...identity('RA', 'III / 3rd Year', 'V / 5th Semester'),
      sections: [{ sectionId: 'E', overrides: [['Wednesday', 3, {
        itemId: 'activity', code: '', abbreviation: 'LIB/MEN', name: 'Library Mentoring',
        teacherId: 'staff-1', kind: 'activity',
      }]] }],
    })
    const history = await createAndSave({
      ...identity('CSE', 'I / 1st Year', 'II / 2nd Semester'),
      sections: [{ sectionId: 'H', overrides: [['Friday', 8, {
        itemId: 'core', code: 'C101', abbreviation: 'CORE', name: 'Historical Core',
        teacherId: 'staff-1', kind: 'core',
      }]] }],
    })
    await repository.saveGeneratedTimetableData({
      configurationId: history.configurationId,
      generationId: `overall-staff-generation-${++generationNumber}`,
      sections: [scheduleFor('H', [['Friday', 8, {
        itemId: 'core', code: 'C101', abbreviation: 'CORE', name: 'Replacement Core',
        teacherId: 'staff-other', kind: 'core',
      }]])],
      staff: globalStaff,
      validation: { valid: true },
      setupSnapshot: setupSnapshot(globalStaff),
    })

    const teacher = await repository.getOverallStaffTimetable('staff-1')
    assert.equal(teacher.teacher.id, 'staff-1')
    assert.deepEqual(teacher.days.Monday[1].assignments.map(({ sectionId, cell }) => [sectionId, cell.cellType]), [
      ['A', 'SUBJECT'], ['B', 'LAB'], ['C', 'SPECIAL_ACTIVITY'],
    ])
    assert.equal(teacher.days.Monday[1].conflict, true)
    assert.deepEqual(teacher.days.Monday[1].conflictWeeks, ['normal'])
    assert.equal(teacher.days.Monday[1].assignments[0].versionStatus, 'LOCKED')
    assert.equal(teacher.days.Monday[1].assignments[0].cell.isCoreTest, true)
    assert.equal(teacher.days.Monday[1].assignments[1].cell.blockId, 'lab-block-1')
    assert.equal(teacher.days.Monday[1].assignments[2].cell.name, 'Library Mentoring')
    assert.equal(teacher.days.Tuesday[2].assignments[0].week, 'alternate')
    assert.equal(teacher.days.Tuesday[2].assignments[0].cell.cellType, 'PLACEMENT')
    assert.equal(teacher.days.Tuesday[2].assignments[0].cell.alternateSubject.teacherId, 'staff-1')
    assert.equal(teacher.days.Wednesday[3].assignments[0].cell.cellType, 'SPECIAL_ACTIVITY')
    assert.equal(teacher.days.Friday[8], undefined, 'inactive historical teacher assignments are excluded')
    assert.equal(teacher.days.Monday[1].assignments.every(({ teacherId }) => teacherId === 'staff-1'), true)
    assert.ok(teacher.days.Monday[1].assignments.some(({ teacherNameSnapshot }) => teacherNameSnapshot === 'Alex Stone'))
    assert.ok(teacher.days.Monday[1].assignments.some(({ teacherNameSnapshot }) => teacherNameSnapshot === 'Alexandra Stone'))

    const allTeachers = await repository.searchGlobalStaff()
    assert.ok(allTeachers.some(({ id }) => id === 'staff-unused'), 'the global Staff Master includes teachers without saved cells')
    assert.deepEqual((await repository.searchGlobalStaff('staff-1')).map(({ id }) => id), ['staff-1'])
    assert.deepEqual((await repository.searchGlobalStaff('Alexandra Stone')).map(({ id }) => id), ['staff-1'])
    assert.deepEqual((await repository.searchGlobalStaff('aLeXaNdRa sToNe')).map(({ id }) => id), ['staff-1'])
    assert.deepEqual((await repository.searchGlobalStaff('alexandra sto')).map(({ id }) => id).sort(), ['staff-1', 'staff-similar'])
    assert.equal(await repository.getOverallStaffTimetable('unknown-teacher'), null)
  } finally {
    await testDatabase.cleanup()
  }
})

nodeTest('overall staff API exposes global search and exact teacher-ID timetable lookup', async () => {
  const calls = []
  const repository = {
    async searchGlobalStaff(search) {
      calls.push(['search', search])
      return [{ id: 'staff-exact', canonicalName: 'Case Sensitive Name' }]
    },
    async getOverallStaffTimetable(teacherId) {
      calls.push(['timetable', teacherId])
      return teacherId === 'staff-exact' ? { teacher: { id: teacherId }, days: { Monday: {} } } : null
    },
  }
  const server = createServer((request, response) => {
    void createTimetableApiMiddleware(repository)(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    const origin = `http://127.0.0.1:${server.address().port}`
    const searchResponse = await fetch(`${origin}/api/overall-staff-timetable?search=case%20sensitive`)
    assert.equal(searchResponse.status, 200)
    assert.equal((await searchResponse.json()).teachers[0].id, 'staff-exact')
    const timetableResponse = await fetch(`${origin}/api/overall-staff-timetable?teacherId=staff-exact`)
    assert.equal(timetableResponse.status, 200)
    assert.deepEqual(await timetableResponse.json(), { teacher: { id: 'staff-exact' }, days: { Monday: {} } })
    assert.deepEqual(calls, [['search', 'case sensitive'], ['timetable', 'staff-exact']])
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
})
