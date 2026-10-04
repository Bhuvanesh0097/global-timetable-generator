import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTimetableApiMiddleware } from '../backend/timetable-api.mjs'
import { openTimetableRepository } from '../backend/timetable-repository.mjs'

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const identity = {
  department: 'API Test',
  year: '3rd Year',
  semester: 'Odd',
  academicYear: '2026 - 2027',
}

function makeSection(sectionId, generationName, teacherId, sectionIdentity = identity) {
  const schedule = Object.fromEntries(days.map((day) => [day, {}]))
  for (const day of days) {
    for (let period = 1; period <= 8; period += 1) {
      schedule[day][period] = {
        itemId: `core:${sectionId}:networking`,
        code: 'API501',
        abbreviation: 'NET',
        name: generationName,
        teacherId,
        kind: 'core',
        ...(period === 1 && day === 'Monday' ? { isCoreTest: true } : {}),
      }
    }
  }
  return { sectionId, ...sectionIdentity, schedule }
}

function makeSetupSnapshot(sectionIdentity, sections, staff = [], overrides = {}) {
  return {
    academic: { ...sectionIdentity },
    staff,
    sections: sections.map((section) => ({
      id: section.id,
      name: section.name ?? `Section ${section.id}`,
      classAdvisorId: section.classAdvisorId ?? '',
      studentCount: section.studentCount ?? 1,
    })),
    coreSubjects: [],
    otherSubjectMaster: [],
    otherSubjects: [],
    labMaster: [],
    labAssignments: [],
    specialActivities: [],
    sectionSubjectAssignments: [],
    specialActivityAssignments: [],
    ...overrides,
  }
}

async function postJson(origin, path, payload) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { response, body: await response.json() }
}

test('version API saves immutable generations, reopens an older snapshot and lists history after repository restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-version-api-'))
  const filename = join(directory, 'timetable.sqlite')
  let repository = openTimetableRepository({ filename })
  const middleware = createTimetableApiMiddleware(repository)
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })

  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    const address = server.address()
    const origin = `http://127.0.0.1:${address.port}`
    const configuration = {
      ...identity,
      sections: [{ id: 'A', classAdvisorId: 'teacher-a' }, { id: 'B', classAdvisorId: 'teacher-b' }],
      staff: [{ id: 'teacher-a', name: 'Teacher A' }, { id: 'teacher-b', name: 'Teacher B' }],
      subjects: [{
        id: 'networking', code: 'API501', abbreviation: 'NET', name: 'Computer Networks', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-a' }, { sectionId: 'B', teacherId: 'teacher-b' }],
      }],
    }
    const setupSnapshot = {
      academic: { department: identity.department, academicYear: identity.academicYear, year: identity.year, semester: identity.semester },
      sections: [{ id: 'A', classAdvisorId: 'teacher-a', studentCount: 1 }, { id: 'B', classAdvisorId: 'teacher-b', studentCount: 1 }],
      staff: configuration.staff,
      coreSubjects: [{ id: 'networking', code: 'API501', abbreviation: 'NET', name: 'Computer Networks', hoursPerWeek: 48 }],
      otherSubjectMaster: [], otherSubjects: [], labMaster: [], labAssignments: [],
      specialActivities: [], sectionSubjectAssignments: [], specialActivityAssignments: [],
    }
    const validation = {
      globalTeacherClashes: 0,
      sections: ['A', 'B'].map((sectionId) => ({
        sectionId, periodsFilled: 48, coreHoursValid: true, otherSubjectHoursValid: true, labAllocationValid: true,
      })),
    }
    const save = async (generationId, subjectName, currentConfiguration = configuration, currentSnapshot = setupSnapshot, sectionATeacherId = 'teacher-a') => postJson(origin, '/api/timetable-versions', {
      configuration: currentConfiguration,
      generationId,
      sections: [makeSection('A', subjectName, sectionATeacherId), makeSection('B', subjectName, 'teacher-b')],
      setupSnapshot: currentSnapshot,
      validation,
    })

    const incompleteSection = makeSection('A', 'Incomplete', 'teacher-a')
    delete incompleteSection.schedule.Monday[8]
    const incompleteSave = await postJson(origin, '/api/timetable-versions', {
      configuration,
      generationId: 'invalid-missing-period',
      sections: [incompleteSection, makeSection('B', 'Incomplete', 'teacher-b')],
      setupSnapshot,
      validation,
    })
    assert.equal(incompleteSave.response.status, 400)
    assert.match(incompleteSave.body.error, /periods 1 through 8/i)
    assert.equal(repository.getTimetableConfigurationByIdentity(identity), null,
      'malformed timetable data does not create a partial configuration record')

    const first = await save('version-api-generation-1', 'Networks - version 1')
    assert.equal(first.response.status, 201, first.body.error)
    assert.equal(first.body.savedVersion.versionNumber, 1)
    assert.equal(first.body.savedVersion.status, 'SAVED')
    assert.equal(first.body.savedVersion.cellCount, 96)

    const firstA = first.body.timetableVersions.find(({ sectionName }) => sectionName === 'A')
    const lockResponse = await fetch(`${origin}/api/timetable-versions/${firstA.versionId}/lock`, { method: 'POST' })
    assert.equal(lockResponse.status, 200)
    const locked = await lockResponse.json()
    assert.equal(locked.versionId, firstA.versionId)
    assert.equal(locked.savedVersion.versionId, firstA.versionId)
    assert.equal(locked.savedVersion.status, 'LOCKED')
    assert.ok(locked.savedVersion.lockedAt)
    const firstSnapshot = repository.getSavedGeneration('version-api-generation-1', first.body.configurationId)
    const lockedCell = repository.database.prepare('SELECT * FROM timetable_cells WHERE timetable_version_id = ? LIMIT 1')
      .get(firstA.versionId)
    assert.throws(() => repository.database.prepare('UPDATE timetable_cells SET subject_name = ? WHERE id = ?')
      .run('tampered', lockedCell.id), /Locked timetable cells cannot be changed/)
    assert.throws(() => repository.database.prepare('DELETE FROM timetable_versions WHERE id = ?')
      .run(firstA.versionId), /Locked timetable versions cannot be deleted/)

    const overwritten = await save('version-api-generation-1', 'Attempted replacement')
    assert.equal(overwritten.response.status, 409)
    assert.match(overwritten.body.error, /locked.*cannot be overwritten/i)
    assert.equal(repository.getSavedGeneration('version-api-generation-1', first.body.configurationId).sections[0].schedule.Monday[1].name, 'Networks - version 1')

    const updatedConfiguration = {
      ...configuration,
      staff: [...configuration.staff, { id: 'teacher-c', name: 'Teacher C' }],
      subjects: [{ ...configuration.subjects[0], teacherAssignments: [
        { sectionId: 'A', teacherId: 'teacher-c' }, { sectionId: 'B', teacherId: 'teacher-b' },
      ] }],
    }
    const updatedSnapshot = {
      ...setupSnapshot,
      staff: updatedConfiguration.staff,
      sectionSubjectAssignments: [{ sectionId: 'A', subjectId: 'networking', teacherId: 'teacher-c' }],
    }
    const second = await save('version-api-generation-2', 'Networks - version 2', updatedConfiguration, updatedSnapshot, 'teacher-c')
    assert.equal(second.response.status, 201, second.body.error)
    assert.equal(second.body.savedVersion.versionNumber, 2)
    assert.equal(second.body.versions.length, 2)
    assert.deepEqual(second.body.versions.map(({ versionNumber }) => versionNumber), [2, 1])
    assert.equal(second.body.timetableVersions.length, 4, 'the history response retains every section version with its database ID')
    assert.equal(new Set(second.body.timetableVersions.map(({ versionId }) => versionId)).size, 4)
    const version2A = second.body.timetableVersions.find(({ generationId, sectionName }) => generationId === 'version-api-generation-2' && sectionName === 'A')
    assert.equal(repository.getSavedTimetableVersion(version2A.versionId).sections[0].schedule.Monday[1].teacherId, 'teacher-c',
      'a later saved revision preserves a newly configured stable teacher ID')

    const futureIdentity = {
      department: 'Future Department', year: '6th Year', semester: 'Alternate Semester', academicYear: '2042 - 2043',
    }
    const futureConfiguration = {
      ...configuration,
      ...futureIdentity,
      sections: [{ id: 'Omega' }],
      staff: [{ id: 'future-teacher', name: 'Future Teacher' }],
      subjects: [{ id: 'future-course', code: 'FUT501', abbreviation: 'FUT', name: 'Future Course', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'Omega', teacherId: 'future-teacher' }] }],
    }
    const futureSetupSnapshot = {
      ...setupSnapshot,
      academic: futureIdentity,
      sections: [{ id: 'Omega', classAdvisorId: 'future-teacher', studentCount: 1 }],
      staff: futureConfiguration.staff,
      coreSubjects: [{ id: 'future-course', code: 'FUT501', abbreviation: 'FUT', name: 'Future Course', hoursPerWeek: 48 }],
    }
    const futureSaved = await postJson(origin, '/api/timetable-versions', {
      configuration: futureConfiguration,
      generationId: 'future-configuration-generation',
      sections: [makeSection('Omega', 'Future Course', 'future-teacher', futureIdentity)],
      setupSnapshot: futureSetupSnapshot,
      validation: { globalTeacherClashes: 0, sections: [{ sectionId: 'Omega', periodsFilled: 48, coreHoursValid: true, otherSubjectHoursValid: true, labAllocationValid: true }] },
    })
    assert.equal(futureSaved.response.status, 201, futureSaved.body.error)

    const navigationResponse = await fetch(`${origin}/api/saved-timetables`)
    assert.equal(navigationResponse.status, 200)
    const navigation = await navigationResponse.json()
    assert.equal(navigation.timetables.length, 5, 'navigation exposes every saved version and section')
    assert.ok(navigation.timetables.some((entry) => entry.department === futureIdentity.department
      && entry.year === futureIdentity.year && entry.semester === futureIdentity.semester
      && entry.academicYear === futureIdentity.academicYear && entry.sectionName === 'Omega'),
    'the listing supports future departments, years, semesters, academic years and section names without presets')
    const apiEntries = navigation.timetables.filter(({ department }) => department === identity.department)
    assert.equal(apiEntries.length, 4)
    assert.deepEqual(new Set(apiEntries.map(({ year }) => year)), new Set([identity.year]))
    assert.deepEqual(new Set(apiEntries.map(({ semester }) => semester)), new Set([identity.semester]))
    assert.deepEqual(new Set(apiEntries.map(({ academicYear }) => academicYear)), new Set([identity.academicYear]))
    assert.deepEqual(new Set(apiEntries.map(({ sectionName }) => sectionName)), new Set(['A', 'B']))
    assert.deepEqual(new Set(apiEntries.map(({ status }) => status)), new Set(['SAVED', 'LOCKED']))
    assert.equal(navigation.timetables.find(({ versionId }) => versionId === firstA.versionId).status, 'LOCKED')
    const firstB = navigation.timetables.find(({ generationId, sectionName }) => generationId === 'version-api-generation-1' && sectionName === 'B')
    assert.equal(firstB.status, 'SAVED', 'the other section version remains SAVED')
    assert.equal(navigation.timetables.find(({ generationId }) => generationId === 'version-api-generation-2').status, 'SAVED')

    const reopenedResponse = await fetch(`${origin}/api/timetable-versions/${firstA.versionId}`)
    assert.equal(reopenedResponse.status, 200)
    const reopened = await reopenedResponse.json()
    assert.deepEqual(reopened.sections.map(({ sectionId }) => sectionId), ['A'])
    assert.equal(reopened.sections[0].schedule.Monday[1].name, 'Networks - version 1')
    assert.deepEqual(reopened.sections[0].schedule, makeSection('A', 'Networks - version 1', 'teacher-a').schedule,
      'loading restores every saved day, period, subject, test marker and teacher without regeneration')
    assert.equal(reopened.sections[0].schedule.Monday[1].isCoreTest, true)
    assert.equal(reopened.validation.sections[0].periodsFilled, 48)
    assert.equal(reopened.setupSnapshot.academic.department, identity.department)
    assert.equal(reopened.versions[0].status, 'LOCKED')
    assert.equal(reopened.versions[0].lockedAt, locked.savedVersion.lockedAt)
    assert.equal(repository.getSavedGenerationSummaries(identity).find(({ generationId }) => generationId === 'version-api-generation-1').isActive, false,
      'opening an older version is read-only and does not change the active pointers')

    const unlockResponse = await fetch(`${origin}/api/timetable-versions/${firstA.versionId}/unlock`, { method: 'POST' })
    assert.equal(unlockResponse.status, 200)
    const unlocked = await unlockResponse.json()
    assert.equal(unlocked.versionId, firstA.versionId)
    assert.equal(unlocked.savedVersion.status, 'SAVED')
    assert.equal(unlocked.savedVersion.lockedAt, null)
    const relockResponse = await fetch(`${origin}/api/timetable-versions/${firstA.versionId}/lock`, { method: 'POST' })
    assert.equal(relockResponse.status, 200)
    const relocked = await relockResponse.json()
    assert.equal(relocked.savedVersion.status, 'LOCKED')

    await new Promise((resolve) => server.close(resolve))
    repository.close()
    repository = openTimetableRepository({ filename })
    const persistedHistory = repository.getSavedGenerationSummaries(identity)
    assert.deepEqual(persistedHistory.map(({ versionNumber }) => versionNumber), [2, 1])
    const persistedA = repository.getSavedTimetableNavigation().find(({ versionId }) => versionId === firstA.versionId)
    const persistedB = repository.getSavedTimetableNavigation().find(({ generationId, sectionName }) => generationId === 'version-api-generation-1' && sectionName === 'B')
    assert.equal(persistedA.status, 'LOCKED')
    assert.equal(persistedA.lockedAt, relocked.savedVersion.lockedAt)
    assert.equal(persistedB.status, 'SAVED')
    assert.equal(repository.getSavedTimetableNavigation().length, 5, 'navigation remains backed by persisted versions after repository restart')
    assert.equal(repository.getSavedGeneration('version-api-generation-1', first.body.configurationId).sections[1].schedule.Saturday[8].name, 'Networks - version 1')

    assert.equal(repository.getSavedGeneration('version-api-generation-1', first.body.configurationId).sections[0].schedule.Monday[1].name, 'Networks - version 1')
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    repository?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saved timetable occupancy rejects a cross-year teacher collision by stable ID and permits another teacher', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-global-occupancy-'))
  const filename = join(directory, 'timetable.sqlite')
  const repository = openTimetableRepository({ filename })
  const middleware = createTimetableApiMiddleware(repository)
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    const origin = `http://127.0.0.1:${server.address().port}`
    const academicYear = '2026 - 2027'
    const thirdYearIdentity = { department: 'CSE', year: 'III / 3rd Year', semester: 'V / 5th Semester', academicYear }
    const secondYearIdentity = { department: 'CSE', year: 'II / 2nd Year', semester: 'V / 5th Semester', academicYear }
    const thirdStaff = [
      { id: 'staff-indumathi', name: 'Mrs. R. Indumathi' },
      { id: 'staff-subashree', name: 'Mrs. M. Subashree' },
      { id: 'staff-mohanapriya', name: 'Mrs. D. Mohanapriya' },
      { id: 'staff-sharmila', name: 'Mrs. G. Sharmila' },
      { id: 'staff-kishor', name: 'Mr. Kishor' },
    ]
    const thirdConfiguration = {
      ...thirdYearIdentity,
      sections: [{ id: 'A', name: 'Section Alpha' }],
      staff: thirdStaff,
      subjects: [{ id: 'se', code: 'CSE301', name: 'Software Engineering', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'staff-indumathi' }] }],
      placement: { id: 'placement', code: '', abbreviation: 'PLAC', name: 'Placement', enabled: true, weeklyPeriods: 2, blockDuration: 2,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'staff-subashree' }] },
    }
    const thirdSchedule = makeSection('A', 'Software Engineering', 'staff-indumathi', thirdYearIdentity)
    thirdSchedule.schedule.Monday[1].teacherId = 'staff-subashree'
    thirdSchedule.schedule.Monday[2].teacherId = 'staff-mohanapriya'
    thirdSchedule.schedule.Monday[3].teacherId = 'staff-sharmila'
    thirdSchedule.schedule.Monday[4].teacherId = 'staff-kishor'
    for (const period of [5, 6]) {
      thirdSchedule.schedule.Monday[period] = {
        itemId: 'activity:A:placement', blockId: 'saved-placement-block', code: '',
        abbreviation: 'PLAC', name: 'Placement', teacherId: 'staff-subashree', kind: 'activity',
        alternateSubject: {
          placementPosition: period - 4,
          subjectId: 'se',
          subjectKind: 'core',
          code: 'CSE301',
          abbreviation: 'SE',
          name: 'Software Engineering',
          teacherId: 'staff-mohanapriya',
          teacherNameSnapshot: 'Mrs. D. Mohanapriya',
        },
      }
    }
    const thirdSetupSnapshot = makeSetupSnapshot(thirdYearIdentity, thirdConfiguration.sections, thirdStaff, {
      coreSubjects: [{ id: 'se', code: 'CSE301', abbreviation: 'SE', name: 'Software Engineering', hoursPerWeek: 48 }],
      specialActivities: [{ id: 'placement', code: '', abbreviation: 'PLAC', name: 'Placement', hoursPerWeek: 2, blockDuration: 2 }],
      placementException: {
        enabled: true,
        alternateSubjects: [1, 2].map((placementPosition) => ({
          placementPosition, subjectId: 'se', subjectKind: 'core', subjectNameSnapshot: 'Software Engineering',
          teacherAssignments: [{ sectionId: 'A', teacherId: 'staff-mohanapriya', teacherNameSnapshot: 'Mrs. D. Mohanapriya' }],
        })),
      },
    })
    const thirdSave = await postJson(origin, '/api/timetable-versions', {
      configuration: thirdConfiguration,
      generationId: 'cse-third-year-saved',
      sections: [thirdSchedule],
      setupSnapshot: thirdSetupSnapshot,
      validation: {},
    })
    assert.equal(thirdSave.response.status, 201, thirdSave.body.error)
    const thirdVersionId = thirdSave.body.timetableVersions.find(({ sectionName }) => sectionName === 'Section Alpha').versionId
    const reopenedThird = await fetch(`${origin}/api/timetable-versions/${thirdVersionId}`)
    assert.equal(reopenedThird.status, 200)
    const reopenedThirdBody = await reopenedThird.json()
    assert.deepEqual([5, 6].map((period) => reopenedThirdBody.sections[0].schedule.Monday[period].alternateSubject), [1, 2].map((placementPosition) => ({
      placementPosition,
      subjectId: 'se',
      subjectKind: 'core',
      code: 'CSE301',
      abbreviation: 'SE',
      name: 'Software Engineering',
      teacherId: 'staff-mohanapriya',
      teacherNameSnapshot: 'Mrs. D. Mohanapriya',
    })))
    assert.deepEqual(reopenedThirdBody.sections[0].schedule, thirdSchedule.schedule,
      'loading the saved version restores its full schedule and alternate-week subject data without regeneration')
    assert.deepEqual({
      sectionId: reopenedThirdBody.sections[0].sectionId,
      department: reopenedThirdBody.sections[0].department,
      year: reopenedThirdBody.sections[0].year,
      semester: reopenedThirdBody.sections[0].semester,
      academicYear: reopenedThirdBody.sections[0].academicYear,
    }, { sectionId: 'A', ...thirdYearIdentity })

    const unavailable = await postJson(origin, '/api/timetable-teacher-occupancy', {
      identity: secondYearIdentity,
      staff: [
        { id: 'staff-indumathi', name: 'Mrs R Indumathi' },
        { id: 'cse2-subashree-format', name: 'Mrs M Subashree' },
        { id: 'cse2-mohanapriya-format', name: 'Mrs.D.Mohanapriya' },
        { id: 'staff-sharmila', name: 'Mrs. G. Sharmila' },
        { id: 'cse2-kishor-format', name: 'Mr Kishor' },
        { id: 'different-kishore', name: 'Mr. Kishore' },
      ],
    })
    assert.equal(unavailable.response.status, 200, unavailable.body.error)
    const unavailableSlots = unavailable.body.unavailableSlots
    const alternateWeekUnavailableSlots = unavailable.body.alternateWeekUnavailableSlots
    assert.ok(unavailableSlots.some(({ teacherId, day, period }) => teacherId === 'cse2-subashree-format' && day === 'Monday' && period === 1))
    assert.ok(unavailableSlots.some(({ teacherId, day, period }) => teacherId === 'cse2-mohanapriya-format' && day === 'Monday' && period === 2))
    assert.ok(unavailableSlots.some(({ teacherId, day, period }) => teacherId === 'staff-sharmila' && day === 'Monday' && period === 3))
    assert.ok(unavailableSlots.some(({ teacherId, day, period }) => teacherId === 'cse2-kishor-format' && day === 'Monday' && period === 4))
    assert.ok(unavailableSlots.some(({ teacherId, day, period }) => teacherId === 'staff-indumathi' && day === 'Friday' && period === 4))
    assert.equal(unavailableSlots.some(({ teacherId }) => teacherId === 'different-kishore'), false,
      'similar but different full names must not be merged')
    assert.ok(alternateWeekUnavailableSlots.some(({ teacherId, day, period }) => teacherId === 'cse2-mohanapriya-format' && day === 'Monday' && period === 5),
      'saved Placement alternates occupy their assigned teacher in the alternate week')
    const otherSemesterOccupancy = await postJson(origin, '/api/timetable-teacher-occupancy', {
      identity: { ...secondYearIdentity, semester: 'VI / 6th Semester' },
      staff: [{ id: 'staff-indumathi', name: 'Mrs. R. Indumathi' }],
    })
    assert.ok(otherSemesterOccupancy.body.unavailableSlots.some(({ teacherId, day, period }) =>
      teacherId === 'staff-indumathi' && day === 'Friday' && period === 4),
    'active saved teacher occupancy applies across semesters')
    const otherAcademicYearOccupancy = await postJson(origin, '/api/timetable-teacher-occupancy', {
      identity: { ...secondYearIdentity, academicYear: '2027 - 2028' },
      staff: [{ id: 'staff-indumathi', name: 'Mrs. R. Indumathi' }],
    })
    assert.ok(otherAcademicYearOccupancy.body.unavailableSlots.some(({ teacherId, day, period }) =>
      teacherId === 'staff-indumathi' && day === 'Friday' && period === 4),
    'active saved teacher occupancy applies across academic years')

    const candidateStaff = [
      { id: 'staff-indumathi', name: 'Mrs. R. Indumathi' },
      { id: 'cse2-other-teacher', name: 'Second-Year Teacher' },
    ]
    const candidate = makeSection('A', 'OOPS', 'cse2-other-teacher', secondYearIdentity)
    candidate.schedule.Friday[4].teacherId = 'staff-indumathi'
    const savedOccupancy = await postJson(origin, '/api/timetable-conflicts', {
      identity: secondYearIdentity,
      staff: candidateStaff,
      sections: [candidate],
    })
    assert.equal(savedOccupancy.body.conflicts.length, 1, 'active SAVED timetable occupancy blocks the same stable staff slot')
    const alternateCandidate = makeSection('A', 'Alternate Week Candidate', 'cse2-other-teacher', secondYearIdentity)
    alternateCandidate.schedule.Monday[5].alternateSubject = {
      placementPosition: 1, subjectId: 'candidate-alternate', subjectKind: 'core',
      code: 'ALT', abbreviation: 'ALT', name: 'Alternate Candidate', teacherId: 'cse2-mohanapriya-format',
      teacherNameSnapshot: 'Mrs D Mohanapriya',
    }
    const alternateCandidateStaff = [...candidateStaff, { id: 'cse2-mohanapriya-format', name: 'Mrs D Mohanapriya' }]
    const alternateCheck = await postJson(origin, '/api/timetable-conflicts', {
      identity: secondYearIdentity,
      staff: alternateCandidateStaff,
      sections: [alternateCandidate],
    })
    assert.equal(alternateCheck.response.status, 200, alternateCheck.body.error)
    assert.ok(alternateCheck.body.conflicts.some(({ teacherId, day, period, week }) =>
      teacherId === 'cse2-mohanapriya-format' && day === 'Monday' && period === 5 && week === 'alternate'),
    `alternate-week candidate teachers are checked against saved Placement alternate occupancy: ${JSON.stringify(alternateCheck.body)}`)
    const alternateSaveIdentity = { ...secondYearIdentity, department: 'Alternate Candidate Department' }
    const alternateSaveConfiguration = {
      ...alternateSaveIdentity,
      sections: [{ id: 'A' }],
      staff: alternateCandidateStaff,
      subjects: [{ id: 'se', code: 'CSE301', name: 'Software Engineering', weeklyHours: 46,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'cse2-other-teacher' }] }],
      placement: { id: 'placement', code: '', abbreviation: 'PLAC', name: 'Placement', enabled: true, weeklyPeriods: 2, blockDuration: 2,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'cse2-other-teacher' }] },
    }
    alternateSaveConfiguration.placementException = {
      enabled: true,
      alternateSubjects: [1, 2].map((placementPosition) => ({
        placementPosition, subjectId: 'se', subjectKind: 'core', subjectNameSnapshot: 'Software Engineering',
        teacherAssignments: [{ sectionId: 'A', teacherId: 'cse2-mohanapriya-format', teacherNameSnapshot: 'Mrs D Mohanapriya' }],
      })),
    }
    const alternateSaveSection = makeSection('A', 'Software Engineering', 'cse2-other-teacher', alternateSaveIdentity)
    for (const [index, period] of [5, 6].entries()) {
      alternateSaveSection.schedule.Monday[period] = {
        itemId: 'activity:A:placement', blockId: 'alternate-save-placement', code: '', abbreviation: 'PLAC',
        name: 'Placement', teacherId: 'cse2-other-teacher', kind: 'activity',
        alternateSubject: {
          placementPosition: index + 1, subjectId: 'se', subjectKind: 'core', code: 'CSE301',
          abbreviation: 'SE', name: 'Software Engineering', teacherId: 'cse2-mohanapriya-format',
          teacherNameSnapshot: 'Mrs D Mohanapriya',
        },
      }
    }
    const alternateSaveSnapshot = makeSetupSnapshot(alternateSaveIdentity, alternateSaveConfiguration.sections, alternateCandidateStaff, {
      coreSubjects: [{ id: 'se', code: 'CSE301', abbreviation: 'SE', name: 'Software Engineering', hoursPerWeek: 46 }],
      specialActivities: [{ id: 'placement', code: '', abbreviation: 'PLAC', name: 'Placement', hoursPerWeek: 2, blockDuration: 2 }],
      placementException: {
        enabled: true,
        alternateSubjects: alternateSaveConfiguration.placementException.alternateSubjects.map((alternate) => ({
          ...alternate, teacherAssignments: alternate.teacherAssignments.map((assignment) => ({
            ...assignment, teacherNameSnapshot: 'Mrs D Mohanapriya',
          })),
        })),
      },
    })
    const alternateSave = await postJson(origin, '/api/timetable-versions', {
      configuration: alternateSaveConfiguration,
      generationId: 'alternate-save-conflict',
      sections: [alternateSaveSection],
      setupSnapshot: alternateSaveSnapshot,
      validation: {},
    })
    assert.equal(alternateSave.response.status, 409)
    assert.match(alternateSave.body.error, /alternate week.*Monday P5/s)
    const thirdLock = await fetch(`${origin}/api/timetable-versions/${thirdVersionId}/lock`, { method: 'POST' })
    assert.equal(thirdLock.status, 200)
    assert.equal((await thirdLock.json()).savedVersion.status, 'LOCKED')

    const check = await postJson(origin, '/api/timetable-conflicts', {
      identity: secondYearIdentity,
      staff: candidateStaff,
      sections: [candidate],
    })
    assert.equal(check.response.status, 200, check.body.error)
    assert.equal(check.body.conflicts.length, 1)
    assert.deepEqual(check.body.conflicts[0], {
      teacherId: 'staff-indumathi',
      teacherName: 'Mrs. R. Indumathi',
      day: 'Friday',
      period: 4,
      existing: {
        department: 'CSE', year: 'III / 3rd Year', semester: 'V / 5th Semester',
        section: 'Section Alpha', subject: 'Software Engineering',
      },
      candidate: {
        department: 'CSE', year: 'II / 2nd Year', semester: 'V / 5th Semester',
        section: 'A', subject: 'OOPS',
      },
    })

    const secondConfiguration = {
      ...secondYearIdentity,
      sections: [{ id: 'A' }],
      staff: candidateStaff,
      subjects: [{ id: 'oops', code: 'CSE201', name: 'OOPS', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'cse2-other-teacher' }] }],
    }
    const rejected = await postJson(origin, '/api/timetable-versions', {
      configuration: secondConfiguration,
      generationId: 'cse-second-year-conflicting',
      sections: [candidate],
      setupSnapshot: makeSetupSnapshot(secondYearIdentity, secondConfiguration.sections, candidateStaff, {
        coreSubjects: [{ id: 'oops', code: 'CSE201', abbreviation: 'OOPS', name: 'OOPS', hoursPerWeek: 48 }],
      }),
      validation: {},
    })
    assert.equal(rejected.response.status, 409, rejected.body.error)
    assert.match(rejected.body.error, /Mrs\. R\. Indumathi.*Friday P4/s)
    assert.match(rejected.body.error, /Existing: CSE, III \/ 3rd Year.*Software Engineering/s)
    assert.match(rejected.body.error, /Candidate: CSE, II \/ 2nd Year.*OOPS/s)

    candidate.schedule.Friday[4].teacherId = 'cse2-other-teacher'
    const conflictFree = await postJson(origin, '/api/timetable-conflicts', {
      identity: secondYearIdentity,
      staff: candidateStaff,
      sections: [candidate],
    })
    assert.deepEqual(conflictFree.body.conflicts, [], 'different stable staff IDs at one day and period are allowed')
    const accepted = await postJson(origin, '/api/timetable-versions', {
      configuration: secondConfiguration,
      generationId: 'cse-second-year-conflict-free',
      sections: [candidate],
      setupSnapshot: makeSetupSnapshot(secondYearIdentity, secondConfiguration.sections, candidateStaff, {
        coreSubjects: [{ id: 'oops', code: 'CSE201', abbreviation: 'OOPS', name: 'OOPS', hoursPerWeek: 48 }],
      }),
      validation: {},
    })
    assert.equal(accepted.response.status, 201, accepted.body.error)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('same stable teacher conflicts across departments and deleting the saved version frees its slots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-cross-department-occupancy-'))
  const filename = join(directory, 'timetable.sqlite')
  const repository = openTimetableRepository({ filename })
  const middleware = createTimetableApiMiddleware(repository)
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    const origin = `http://127.0.0.1:${server.address().port}`
    const sharedStaff = [{ id: 'globally-shared-teacher', name: 'Dr. Shared Person' }]
    const identityFor = (department) => ({
      department, year: '3rd Year', semester: 'Odd', academicYear: '2026 - 2027',
    })
    const configurationFor = (academic) => ({
      ...academic,
      sections: [{ id: 'A' }],
      staff: sharedStaff,
      subjects: [{ id: 'networks', code: 'NET301', name: `${academic.department} Networks`, weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'globally-shared-teacher' }] }],
    })
    const deptA = identityFor('Department A')
    const deptAConfiguration = configurationFor(deptA)
    const deptASave = await postJson(origin, '/api/timetable-versions', {
      configuration: deptAConfiguration,
      generationId: 'department-a-version-1',
      sections: [makeSection('A', 'Department A Networks', 'globally-shared-teacher', deptA)],
      setupSnapshot: makeSetupSnapshot(deptA, deptAConfiguration.sections, sharedStaff, {
        coreSubjects: [{ id: 'networks', code: 'NET301', abbreviation: 'NET', name: 'Department A Networks', hoursPerWeek: 48 }],
      }),
      validation: {},
    })
    assert.equal(deptASave.response.status, 201, deptASave.body.error)
    const deptAVersion = deptASave.body.timetableVersions.find(({ sectionName }) => sectionName === 'A')
    assert.equal(deptAVersion.versionNumber, 1)

    const deptB = identityFor('Department B')
    const deptBConfiguration = configurationFor(deptB)
    const mismatchedSection = makeSection('A', 'Department B Networks', 'globally-shared-teacher', deptB)
    mismatchedSection.year = '2nd Year'
    const badIdentitySave = await postJson(origin, '/api/timetable-versions', {
      configuration: deptBConfiguration,
      generationId: 'department-b-wrong-year',
      sections: [mismatchedSection],
      setupSnapshot: makeSetupSnapshot(deptB, deptBConfiguration.sections, sharedStaff),
      validation: {},
    })
    assert.equal(badIdentitySave.response.status, 400)
    assert.match(badIdentitySave.body.error, /mismatched year/i)
    assert.equal(repository.getTimetableConfigurationByIdentity(deptB), null,
      'identity mismatches are rejected before creating a department configuration')

    const occupancy = await postJson(origin, '/api/timetable-teacher-occupancy', {
      identity: deptB,
      staff: sharedStaff,
    })
    assert.ok(occupancy.body.unavailableSlots.some(({ teacherId, day, period }) =>
      teacherId === 'globally-shared-teacher' && day === 'Monday' && period === 1))
    const conflictingSave = await postJson(origin, '/api/timetable-versions', {
      configuration: deptBConfiguration,
      generationId: 'department-b-conflict',
      sections: [makeSection('A', 'Department B Networks', 'globally-shared-teacher', deptB)],
      setupSnapshot: makeSetupSnapshot(deptB, deptBConfiguration.sections, sharedStaff),
      validation: {},
    })
    assert.equal(conflictingSave.response.status, 409)
    assert.match(conflictingSave.body.error, /Dr\. Shared Person.*Monday P1/s)

    const deleted = await fetch(`${origin}/api/timetable-versions/${deptAVersion.versionId}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200)
    const afterDelete = await postJson(origin, '/api/timetable-teacher-occupancy', {
      identity: deptB,
      staff: sharedStaff,
    })
    assert.deepEqual(afterDelete.body.unavailableSlots, [])
    assert.deepEqual((await (await fetch(`${origin}/api/saved-timetables`)).json()).timetables, [])

    const availableSave = await postJson(origin, '/api/timetable-versions', {
      configuration: deptBConfiguration,
      generationId: 'department-b-after-delete',
      sections: [makeSection('A', 'Department B Networks', 'globally-shared-teacher', deptB)],
      setupSnapshot: makeSetupSnapshot(deptB, deptBConfiguration.sections, sharedStaff),
      validation: {},
    })
    assert.equal(availableSave.response.status, 201, availableSave.body.error)
    const deptBVersion = availableSave.body.timetableVersions.find(({ sectionName }) => sectionName === 'A')
    assert.equal(deptBVersion.versionNumber, 1)
    assert.equal(deptBVersion.department, 'Department B')
    assert.equal(deptBVersion.sectionName, 'A')
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lock, unlock, open and delete target the exact database version ID across departments and sections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-version-id-scope-'))
  const filename = join(directory, 'timetable.sqlite')
  const repository = openTimetableRepository({ filename })
  const middleware = createTimetableApiMiddleware(repository)
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    const origin = `http://127.0.0.1:${server.address().port}`
    const cseIdentity = { department: 'CSE', year: '3rd Year', semester: 'Odd', academicYear: '2026 - 2027' }
    const mechIdentity = { department: 'MECH', year: '3rd Year', semester: 'Odd', academicYear: '2026 - 2027' }
    const configure = (academic, sectionIds, teacherId) => {
      const staff = [{ id: teacherId, name: teacherId }]
      const configuration = {
        ...academic,
        sections: sectionIds.map((id) => ({ id })),
        staff,
        subjects: [{ id: 'subject', code: 'TST501', name: 'Version identity test', weeklyHours: 48,
          teacherAssignments: sectionIds.map((sectionId) => ({ sectionId, teacherId })) }],
      }
      const setupSnapshot = {
        academic,
        sections: sectionIds.map((id) => ({ id })),
        staff,
        coreSubjects: [{ id: 'subject', code: 'TST501', name: 'Version identity test', hoursPerWeek: 48 }],
        otherSubjectMaster: [], otherSubjects: [], labMaster: [], labAssignments: [],
        specialActivities: [], sectionSubjectAssignments: [], specialActivityAssignments: [],
      }
      return { configuration, setupSnapshot }
    }
    const saveGeneration = async (academic, sectionIds, teacherId, generationId, label) => {
      const { configuration, setupSnapshot } = configure(academic, sectionIds, teacherId)
      const saved = await postJson(origin, '/api/timetable-versions', {
        configuration,
        generationId,
        sections: sectionIds.map((sectionId) => makeSection(sectionId, `${label} ${sectionId}`, teacherId, academic)),
        setupSnapshot,
        validation: {},
      })
      assert.equal(saved.response.status, 201, saved.body.error)
      return saved.body
    }

    await saveGeneration(cseIdentity, ['A', 'B'], 'teacher-cse', 'cse-id-generation-1', 'CSE version 1')
    await saveGeneration(cseIdentity, ['A', 'B'], 'teacher-cse', 'cse-id-generation-2', 'CSE version 2')
    await saveGeneration(mechIdentity, ['A'], 'teacher-mech', 'mech-id-generation-1', 'MECH version 1')
    await saveGeneration(mechIdentity, ['A'], 'teacher-mech', 'mech-id-generation-2', 'MECH version 2')

    const allVersions = repository.getSavedTimetableNavigation()
    const cseA2 = allVersions.find((entry) => entry.department === 'CSE' && entry.sectionName === 'A' && entry.versionNumber === 2)
    const cseB2 = allVersions.find((entry) => entry.department === 'CSE' && entry.sectionName === 'B' && entry.versionNumber === 2)
    const mechA2 = allVersions.find((entry) => entry.department === 'MECH' && entry.sectionName === 'A' && entry.versionNumber === 2)
    assert.ok(cseA2 && cseB2 && mechA2)
    assert.equal(new Set([cseA2.versionId, cseB2.versionId, mechA2.versionId]).size, 3,
      'same-numbered versions have independent database IDs')

    const lockMech = await fetch(`${origin}/api/timetable-versions/${mechA2.versionId}/lock`, { method: 'POST' })
    assert.equal(lockMech.status, 200)
    assert.equal((await lockMech.json()).savedVersion.versionId, mechA2.versionId)
    let persisted = repository.getSavedTimetableNavigation()
    assert.equal(persisted.find(({ versionId }) => versionId === mechA2.versionId).status, 'LOCKED')
    assert.equal(persisted.find(({ versionId }) => versionId === cseA2.versionId).status, 'SAVED')
    assert.equal(persisted.find(({ versionId }) => versionId === cseB2.versionId).status, 'SAVED')

    const lockCseA = await fetch(`${origin}/api/timetable-versions/${cseA2.versionId}/lock`, { method: 'POST' })
    assert.equal(lockCseA.status, 200)
    persisted = repository.getSavedTimetableNavigation()
    assert.equal(persisted.find(({ versionId }) => versionId === cseA2.versionId).status, 'LOCKED')
    assert.equal(persisted.find(({ versionId }) => versionId === cseB2.versionId).status, 'SAVED')
    assert.equal(persisted.find(({ versionId }) => versionId === mechA2.versionId).status, 'LOCKED')

    const cseRefresh = await fetch(`${origin}/api/timetable-versions?${new URLSearchParams(cseIdentity)}`)
    const mechRefresh = await fetch(`${origin}/api/timetable-versions?${new URLSearchParams(mechIdentity)}`)
    const cseRows = (await cseRefresh.json()).versions
    const mechRows = (await mechRefresh.json()).versions
    assert.equal(cseRows.find(({ versionId }) => versionId === cseA2.versionId).status, 'LOCKED')
    assert.equal(cseRows.find(({ versionId }) => versionId === cseB2.versionId).status, 'SAVED')
    assert.equal(mechRows.find(({ versionId }) => versionId === mechA2.versionId).status, 'LOCKED')

    const reopenedCse = await (await fetch(`${origin}/api/timetable-versions/${cseA2.versionId}`)).json()
    const reopenedMech = await (await fetch(`${origin}/api/timetable-versions/${mechA2.versionId}`)).json()
    const reopenedCseB = await (await fetch(`${origin}/api/timetable-versions/${cseB2.versionId}`)).json()
    assert.equal(reopenedCse.sections[0].department, 'CSE')
    assert.equal(reopenedCse.sections[0].schedule.Monday[1].name, 'CSE version 2 A')
    assert.equal(reopenedCseB.sections[0].sectionId, 'B')
    assert.equal(reopenedMech.sections[0].department, 'MECH')
    assert.equal(reopenedMech.sections[0].schedule.Monday[1].name, 'MECH version 2 A')

    const unlockMech = await fetch(`${origin}/api/timetable-versions/${mechA2.versionId}/unlock`, { method: 'POST' })
    assert.equal(unlockMech.status, 200)
    assert.equal((await unlockMech.json()).savedVersion.versionId, mechA2.versionId)
    const deleteCseB = await fetch(`${origin}/api/timetable-versions/${cseB2.versionId}`, { method: 'DELETE' })
    assert.equal(deleteCseB.status, 200)
    persisted = repository.getSavedTimetableNavigation()
    assert.equal(persisted.some(({ versionId }) => versionId === cseB2.versionId), false)
    assert.equal(persisted.find(({ versionId }) => versionId === cseA2.versionId).status, 'LOCKED')
    assert.equal(persisted.find(({ versionId }) => versionId === mechA2.versionId).status, 'SAVED')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saved version deletion removes only selected section cells, protects locked versions and repairs active pointers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mvit-version-delete-'))
  const filename = join(directory, 'timetable.sqlite')
  let repository = openTimetableRepository({ filename })
  const middleware = createTimetableApiMiddleware(repository)
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
    const origin = `http://127.0.0.1:${server.address().port}`
    const configuration = {
      ...identity,
      sections: [{ id: 'A' }, { id: 'B' }],
      staff: [{ id: 'teacher-a', name: 'Teacher A' }, { id: 'teacher-b', name: 'Teacher B' }],
      subjects: [{ id: 'networking', code: 'API501', abbreviation: 'NET', name: 'Computer Networks', weeklyHours: 48,
        teacherAssignments: [{ sectionId: 'A', teacherId: 'teacher-a' }, { sectionId: 'B', teacherId: 'teacher-b' }] }],
    }
    const setupSnapshot = {
      academic: { department: identity.department, academicYear: identity.academicYear, year: identity.year, semester: identity.semester },
      sections: [{ id: 'A', classAdvisorId: 'teacher-a' }, { id: 'B', classAdvisorId: 'teacher-b' }],
      staff: configuration.staff,
      coreSubjects: [{ id: 'networking', code: 'API501', abbreviation: 'NET', name: 'Computer Networks', hoursPerWeek: 48 }],
      otherSubjectMaster: [], otherSubjects: [], labMaster: [], labAssignments: [],
      specialActivities: [], sectionSubjectAssignments: [], specialActivityAssignments: [],
    }
    const save = async (generationId, subjectName) => postJson(origin, '/api/timetable-versions', {
      configuration,
      generationId,
      sections: [makeSection('A', subjectName, 'teacher-a'), makeSection('B', subjectName, 'teacher-b')],
      setupSnapshot,
      validation: { sections: [{ sectionId: 'A', periodsFilled: 48 }, { sectionId: 'B', periodsFilled: 48 }] },
    })
    const first = await save('delete-generation-1', 'Version 1')
    assert.equal(first.response.status, 201, first.body.error)
    const second = await save('delete-generation-2', 'Version 2')
    assert.equal(second.response.status, 201, second.body.error)
    const secondRetry = await save('delete-generation-2', 'Version 2')
    assert.equal(secondRetry.response.status, 200, secondRetry.body.error)
    assert.equal(repository.getSavedTimetableNavigation().length, 4, 'retrying a complete save does not create duplicate versions')
    const navigationUrl = `${origin}/api/saved-timetables`
    const readNavigation = async () => (await (await fetch(navigationUrl)).json()).timetables
    const initialNavigation = await readNavigation()
    const generationOneA = initialNavigation.find(({ generationId, sectionName }) => generationId === 'delete-generation-1' && sectionName === 'A')
    const generationOneB = initialNavigation.find(({ generationId, sectionName }) => generationId === 'delete-generation-1' && sectionName === 'B')
    const generationTwoA = initialNavigation.find(({ generationId, sectionName }) => generationId === 'delete-generation-2' && sectionName === 'A')
    const generationTwoB = initialNavigation.find(({ generationId, sectionName }) => generationId === 'delete-generation-2' && sectionName === 'B')
    assert.ok(generationOneA?.versionId && generationOneB?.versionId && generationTwoA?.versionId && generationTwoB?.versionId)

    const lockResponse = await fetch(`${origin}/api/timetable-versions/${generationOneA.versionId}/lock`, { method: 'POST' })
    assert.equal(lockResponse.status, 200)
    const lockedDelete = await fetch(`${origin}/api/timetable-versions/${generationOneA.versionId}`, { method: 'DELETE' })
    assert.equal(lockedDelete.status, 409, 'locked versions cannot be deleted through the API')
    assert.match((await lockedDelete.json()).error, /unlock the version first/i)
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_cells WHERE timetable_version_id = ?')
      .get(generationOneA.versionId).count, 48)

    const deleteSecondA = await fetch(`${origin}/api/timetable-versions/${generationTwoA.versionId}`, { method: 'DELETE' })
    assert.equal(deleteSecondA.status, 200)
    const deleteResult = (await deleteSecondA.json()).deletedVersion
    assert.equal(deleteResult.deletedCellCount, 48)
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_versions WHERE id = ?')
      .get(generationTwoA.versionId).count, 0)
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_cells WHERE timetable_version_id = ?')
      .get(generationTwoA.versionId).count, 0, 'cells cascade with the selected version')
    const partialGenerationRetry = await save('delete-generation-2', 'Version 2')
    assert.equal(partialGenerationRetry.response.status, 409)
    assert.match(partialGenerationRetry.body.error, /only some sections/i)
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_cells WHERE timetable_version_id = ?')
      .get(generationTwoB.versionId).count, 48, 'other section cells are preserved')
    const reopenedTwoResponse = await fetch(`${origin}/api/timetable-versions/${generationTwoB.versionId}`)
    assert.equal(reopenedTwoResponse.status, 200)
    const reopenedTwo = await reopenedTwoResponse.json()
    assert.deepEqual(reopenedTwo.sections.map(({ sectionId }) => sectionId), ['B'], 'remaining version opens without regeneration')
    const timetableAId = repository.database.prepare(`
      SELECT timetables.id FROM generated_timetables timetables
      JOIN sections ON sections.id = timetables.section_id
      WHERE timetables.configuration_id = ? AND sections.source_id = 'A'
    `).get(first.body.configurationId).id
    assert.equal(repository.getTimetableById(timetableAId).activeVersionId, generationOneA.versionId,
      'the newest remaining saved/locked section version becomes active')

    const unlockResponse = await fetch(`${origin}/api/timetable-versions/${generationOneA.versionId}/unlock`, { method: 'POST' })
    assert.equal(unlockResponse.status, 200)
    const deleteFirstA = await fetch(`${origin}/api/timetable-versions/${generationOneA.versionId}`, { method: 'DELETE' })
    assert.equal(deleteFirstA.status, 200)
    assert.equal(repository.getTimetableById(timetableAId).activeVersionId, null, 'deleting the final version leaves no active version')
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_versions WHERE id = ?')
      .get(generationOneB.versionId).count, 1, 'the other section version from the same generation remains')
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_cells WHERE timetable_version_id = ?')
      .get(generationOneB.versionId).count, 48)
    const remainingNavigation = await readNavigation()
    assert.deepEqual(new Set(remainingNavigation.map(({ versionId }) => versionId)), new Set([generationOneB.versionId, generationTwoB.versionId]))
    assert.equal(repository.getTimetableConfigurationByIdentity(identity), first.body.configurationId,
      'deleting versions does not remove the configuration or master data')

    await new Promise((resolve) => server.close(resolve))
    repository.close()
    repository = openTimetableRepository({ filename })
    assert.deepEqual(new Set(repository.getSavedTimetableNavigation().map(({ versionId }) => versionId)),
      new Set([generationOneB.versionId, generationTwoB.versionId]), 'the deletion persists after repository restart')
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS count FROM timetable_cells WHERE timetable_version_id = ?')
      .get(generationTwoB.versionId).count, 48)
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    repository?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
