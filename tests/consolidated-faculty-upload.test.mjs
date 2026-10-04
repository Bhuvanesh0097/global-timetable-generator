import test from 'node:test'
import assert from 'node:assert/strict'
import { jsPDF } from 'jspdf'
import { buildTeacherTimetable } from '../src/teacher-timetable.ts'
import {
  buildTeacherExportPayload,
  createTeacherExportXmp,
  embedTeacherMetadataInJpeg,
  embedTeacherMetadataInPng,
  validateTeacherExportPayload,
} from '../src/teacher-export-metadata.ts'
import {
  canGenerateTogether,
  createConsolidatedUploadItem,
  getConsolidatedUploadType,
  removeConsolidatedUploadItem,
  validateConsolidatedUpload,
  validateConsolidationScope,
} from '../src/consolidated-faculty-upload.ts'
import { combineValidatedTeacherTimetables } from '../src/consolidated-faculty-timetable.ts'

const file = (name, type = '') => ({ name, type })
const validScopePayload = (year, overrides = {}) => ({
  teacherId: 'teacher-1',
  teacherName: 'Mrs. R. Indumathi',
  departmentId: 'CSE',
  departmentName: 'Computer Science & Engineering',
  academicYear: '2026-2027',
  year,
  ...overrides,
})
const item = (name, id, status = 'pending') => ({
  id,
  file: { ...file(name), arrayBuffer: async () => new ArrayBuffer(0) },
  fileType: getConsolidatedUploadType(file(name)),
  status,
})

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const minimalPng = () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])

async function exportPayload({
  department = 'CSE', academicYear = '2026 - 2027', year = 'III / 3rd Year', semester = 'V / 5th Semester', section = 'A', teacherId = 'teacher-1', teacherName = 'Mrs. R. Indumathi',
  assignmentDay = 'Monday', assignmentPeriod = 2, subjectOrActivity = 'Computer Networks', abbreviation = 'CN', code = 'CSE501', kind = 'core',
} = {}) {
  const teacher = { id: teacherId, name: teacherName }
  const setup = {
    academic: { department, academicYear, year, semester },
    staff: [teacher],
  }
  const generated = [{
    sectionId: section,
    schedule: Object.fromEntries(days.map((day) => [day, day === assignmentDay ? {
      [assignmentPeriod]: { teacherId, itemId: `${kind}:${code}`, code, abbreviation, name: subjectOrActivity, kind },
    } : {}])),
  }]
  return buildTeacherExportPayload({
    setup,
    teacher,
    generatedSections: generated,
    timetable: buildTeacherTimetable(generated, teacherId),
    exportedAt: '2026-09-27T00:00:00.000Z',
    exportId: `${department}-${year}-${teacherId}`,
  })
}

function uploadedFile(name, type, bytes) {
  const copy = bytes.slice()
  return { name, type, arrayBuffer: async () => copy.buffer }
}

async function pdfBytes(payload) {
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  pdf.addMetadata(createTeacherExportXmp(payload), true)
  return new Uint8Array(await pdf.output('arraybuffer'))
}

test('accepts only PDF, PNG and JPG/JPEG uploads, case-insensitively', () => {
  assert.equal(getConsolidatedUploadType(file('faculty.PDF', 'application/pdf')), 'PDF')
  assert.equal(getConsolidatedUploadType(file('year.png', 'image/png')), 'PNG')
  assert.equal(getConsolidatedUploadType(file('teacher.jpg', 'image/jpeg')), 'JPG')
  assert.equal(getConsolidatedUploadType(file('teacher.JPEG', 'image/jpeg')), 'JPG')
  assert.equal(getConsolidatedUploadType(file('teacher.jpg', 'image/png')), null)
  assert.equal(getConsolidatedUploadType(file('notes.docx')), null)
})

test('queues one or any number of supported files pending validation and gates generation', () => {
  const one = createConsolidatedUploadItem(file('one.pdf'), 'one')
  assert.equal(one.status, 'pending')
  assert.equal(canGenerateTogether([one]), false)

  const many = [one, createConsolidatedUploadItem(file('two.png'), 'two'), createConsolidatedUploadItem(file('three.jpeg'), 'three')]
  assert.equal(many.length, 3)
  assert.equal(canGenerateTogether(many), false)
  assert.equal(canGenerateTogether(many.map((upload, index) => ({ ...upload, status: 'valid', payload: validScopePayload(`${index + 1}st Year`) }))), true)
  assert.equal(canGenerateTogether(many.map((upload, index) => ({ ...upload, status: index === 1 ? 'rejected' : 'valid', payload: validScopePayload(`${index + 1}st Year`) }))), false)
  assert.equal(canGenerateTogether(many.slice(0, 2).map((upload) => ({ ...upload, status: 'valid', payload: validScopePayload('2nd Year') }))), false, 'duplicate timetable sources keep generation disabled even if item statuses are stale')
  assert.equal(canGenerateTogether(many.map((upload, index) => ({ ...upload, status: 'valid', payload: validScopePayload(`${index + 1}st Year`, index === 1 ? { teacherId: 'teacher-2', teacherName: 'Mrs. G. Sharmila' } : {}) }))), false, 'teacher mismatch keeps generation disabled')
  assert.equal(canGenerateTogether(many.map((upload, index) => ({ ...upload, status: 'valid', payload: validScopePayload(`${index + 1}st Year`, index === 1 ? { departmentId: 'ECE', departmentName: 'Electronics & Communication Engineering' } : {}) }))), true, 'a stable teacher ID may span departments')
  assert.equal(canGenerateTogether(many.map((upload, index) => ({ ...upload, status: 'valid', payload: validScopePayload(`${index + 1}st Year`, index === 1 ? { academicYear: '2025-2026' } : {}) }))), true, 'a stable teacher ID may span academic years')
})

test('removes only the selected queued file and permits re-upload as a fresh item', () => {
  const first = item('first.pdf', 'first')
  const second = item('second.jpg', 'second')
  const remaining = removeConsolidatedUploadItem([first, second], 'first')
  assert.deepEqual(remaining.map(({ id }) => id), ['second'])
  const reuploaded = createConsolidatedUploadItem(first.file, 'first-again')
  assert.equal(reuploaded.id, 'first-again')
  assert.equal(reuploaded.file, first.file)
  assert.deepEqual(removeConsolidatedUploadItem([...remaining, reuploaded], 'second').map(({ id }) => id), ['first-again'])
})

test('accepts verified teacher exports in PDF, PNG and JPG, including multiple formats', async () => {
  const payload = await exportPayload()
  const nextYearPayload = await exportPayload({ year: 'II / 2nd Year', section: 'B' })
  const thirdYearPayload = await exportPayload({ year: 'IV / 4th Year' })
  const pdf = createConsolidatedUploadItem(uploadedFile('teacher.pdf', 'application/pdf', await pdfBytes(payload)), 'pdf')
  const pngData = embedTeacherMetadataInPng(minimalPng(), nextYearPayload)
  const png = createConsolidatedUploadItem(uploadedFile('teacher.png', 'image/png', pngData), 'png')
  const jpegData = embedTeacherMetadataInJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), thirdYearPayload)
  const jpeg = createConsolidatedUploadItem(uploadedFile('teacher.jpg', 'image/jpeg', jpegData), 'jpeg')

  const validPdf = await validateConsolidatedUpload(pdf)
  const validPng = await validateConsolidatedUpload(png)
  const validJpeg = await validateConsolidatedUpload(jpeg)
  assert.equal(validPdf.status, 'valid')
  assert.equal(validPng.status, 'valid')
  assert.equal(validJpeg.status, 'valid')
  assert.equal(validPdf.payload.teacherId, 'teacher-1')
  assert.equal(validPng.payload.year, '2nd Year')
  assert.equal(validJpeg.payload.year, '4th Year')
  const acceptedPng = validateConsolidationScope(validPng, [validPdf])
  const acceptedJpeg = validateConsolidationScope(validJpeg, [validPdf, acceptedPng])
  assert.equal(acceptedPng.status, 'valid', 'a different section does not make the academic year a duplicate')
  assert.equal(acceptedJpeg.status, 'valid')
  assert.equal(canGenerateTogether([validPdf, acceptedPng]), true, 'PDF + PNG')
  assert.equal(canGenerateTogether([validPdf, acceptedJpeg]), true, 'PDF + JPG')
  assert.equal(canGenerateTogether([acceptedPng, acceptedJpeg]), true, 'PNG + JPG')
  assert.equal(canGenerateTogether([validPdf, acceptedPng, acceptedJpeg]), true, 'three unique years')
})

test('rejects unsupported, unreadable and ordinary external files with visible reasons', async () => {
  const unsupported = createConsolidatedUploadItem(uploadedFile('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Uint8Array()), 'docx')
  assert.equal(unsupported.status, 'rejected')
  assert.match(unsupported.rejectionReason, /Unsupported file format/)

  const unreadable = await validateConsolidatedUpload(createConsolidatedUploadItem(uploadedFile('broken.pdf', 'application/pdf', Uint8Array.from([1, 2, 3])), 'broken'))
  assert.equal(unreadable.status, 'rejected')
  assert.match(unreadable.rejectionReason, /PDF could not be read/)

  const ordinaryPdf = new jsPDF()
  const external = createConsolidatedUploadItem(uploadedFile('student-timetable.pdf', 'application/pdf', new Uint8Array(await ordinaryPdf.output('arraybuffer'))), 'external')
  const rejectedExternal = await validateConsolidatedUpload(external)
  assert.equal(rejectedExternal.status, 'rejected')
  assert.match(rejectedExternal.rejectionReason, /not a Teacher-wise Timetable/)

  const validExport = createConsolidatedUploadItem(
    uploadedFile('teacher.png', 'image/png', embedTeacherMetadataInPng(minimalPng(), await exportPayload())),
    'valid-teacher',
  )
  const validatedExport = await validateConsolidatedUpload(validExport)
  assert.equal(validatedExport.status, 'valid')
  assert.equal(validateConsolidationScope(validatedExport, [unsupported]).status, 'valid', 'a rejected upload does not establish or contaminate the teacher context')
  assert.equal(canGenerateTogether([unsupported, validatedExport]), false, 'a rejected file is never eligible for generation')
})

test('accepts global teacher scopes and rejects teacher or duplicate-source mismatches', async () => {
  const base = await exportPayload()
  const secondYear = await exportPayload({ year: 'II / 2nd Year' })
  const otherTeacher = await exportPayload({ year: 'II / 2nd Year', teacherId: 'teacher-2', teacherName: 'Mrs. G. Sharmila' })
  const conflictingName = await exportPayload({ year: 'II / 2nd Year', teacherName: 'Mrs. G. Sharmila' })
  const otherDepartment = await exportPayload({ department: 'ECE', year: 'II / 2nd Year' })
  const duplicateYear = await exportPayload({ year: 'III / 3rd Year' })

  const first = await validateConsolidatedUpload(createConsolidatedUploadItem(uploadedFile('year-3.pdf', 'application/pdf', await pdfBytes(base)), 'first'))
  assert.equal(first.status, 'valid')

  const validOtherYear = await validateConsolidatedUpload(createConsolidatedUploadItem(uploadedFile('year-2.png', 'image/png', embedTeacherMetadataInPng(minimalPng(), secondYear)), 'second'))
  const acceptedOtherYear = validateConsolidationScope(validOtherYear, [first])
  assert.equal(acceptedOtherYear.status, 'valid')
  assert.equal(canGenerateTogether([first, acceptedOtherYear]), true)

  const other = async (payload, id) => validateConsolidatedUpload(createConsolidatedUploadItem(
    uploadedFile(`${id}.pdf`, 'application/pdf', await pdfBytes(payload)), id,
  ))
  const mismatchTeacher = validateConsolidationScope(await other(otherTeacher, 'teacher-2'), [first])
  assert.equal(mismatchTeacher.status, 'rejected')
  assert.match(mismatchTeacher.rejectionReason, /Teacher mismatch/)

  const formattingVariant = validateConsolidationScope(await other(conflictingName, 'conflicting-name'), [first])
  assert.equal(formattingVariant.status, 'valid', 'the stable teacher ID is authoritative across display-name variations')

  const crossDepartment = validateConsolidationScope(await other(otherDepartment, 'department-ece'), [first])
  assert.equal(crossDepartment.status, 'valid')
  const crossAcademicYear = validateConsolidationScope(await other(await exportPayload({ academicYear: '2027 - 2028' }), 'academic-year'), [first])
  assert.equal(crossAcademicYear.status, 'valid')

  const duplicate = validateConsolidationScope(await other(duplicateYear, 'duplicate-year'), [first])
  assert.equal(duplicate.status, 'rejected')
  assert.equal(duplicate.rejectionReason, 'Upload rejected: This timetable source is already included.')
  assert.equal(canGenerateTogether([first, duplicate]), false)

  const duplicateSecondYear = validateConsolidationScope(await other(secondYear, 'duplicate-second-year'), [
    validateConsolidationScope(await other(secondYear, 'included-second-year'), [first]),
  ])
  assert.equal(duplicateSecondYear.status, 'rejected')
  assert.equal(duplicateSecondYear.rejectionReason, 'Upload rejected: This timetable source is already included.')
})

test('removal clears stale scope rejections and the II + III remove III + IV queue remains valid', async () => {
  const iiPayload = await exportPayload({ year: 'II / 2nd Year' })
  const iiiPayload = await exportPayload({ year: 'III / 3rd Year' })
  const ivPayload = await exportPayload({ year: 'IV / 4th Year' })
  const validate = async (payload, id) => validateConsolidatedUpload(createConsolidatedUploadItem(
    uploadedFile(`${id}.png`, 'image/png', embedTeacherMetadataInPng(minimalPng(), payload)), id,
  ))

  const ii = await validate(iiPayload, 'ii')
  const iii = validateConsolidationScope(await validate(iiiPayload, 'iii'), [ii])
  const iv = await validate(ivPayload, 'iv')
  const remaining = removeConsolidatedUploadItem([ii, iii], 'iii')
  const scopedIv = validateConsolidationScope(iv, remaining)
  assert.equal(scopedIv.status, 'valid')
  assert.equal(canGenerateTogether([...remaining, scopedIv]), true)
  assert.deepEqual([...remaining, scopedIv].map(({ payload }) => payload.year), ['2nd Year', '4th Year'])

  const wrongTeacher = validateConsolidationScope(
    await validate(await exportPayload({ year: 'III / 3rd Year', teacherId: 'teacher-2', teacherName: 'Mrs. G. Sharmila' }), 'wrong-teacher'),
    [ii],
  )
  assert.equal(wrongTeacher.status, 'rejected')
  const promoted = removeConsolidatedUploadItem([ii, wrongTeacher], 'ii')
  assert.equal(promoted[0].status, 'valid', 'removing the old teacher context rechecks an otherwise valid export')
  assert.equal(canGenerateTogether([promoted[0], iv]), false, 'different teachers still cannot be combined')
})

test('accepts future academic years and levels, and rejects malformed scope or inconsistent identity metadata', async () => {
  const payload = await exportPayload()
  assert.equal((await validateTeacherExportPayload(await exportPayload({ academicYear: '2025 - 2026' }))).valid, true)
  assert.equal((await validateTeacherExportPayload(await exportPayload({ year: 'V / 5th Year' }))).valid, true)
  const malformedAcademicYear = await validateTeacherExportPayload({ ...payload, academicYear: '2025' })
  assert.equal(malformedAcademicYear.valid, false)
  assert.match(malformedAcademicYear.reason, /Academic year metadata is missing or invalid/)

  const studentSchedule = await validateTeacherExportPayload({ ...payload, sourceType: 'Section Timetable' })
  assert.equal(studentSchedule.valid, false)
  assert.match(studentSchedule.reason, /not a Teacher-wise Timetable/)

  const inconsistentAssignment = await validateTeacherExportPayload({
    ...payload,
    assignments: payload.assignments.map((assignment) => ({ ...assignment, teacherName: 'Another Teacher' })),
  })
  assert.equal(inconsistentAssignment.valid, false)
  assert.match(inconsistentAssignment.reason, /malformed or inconsistent/)
})

test('combines two validated year payloads without changing their source assignments and marks empty periods FREE', async () => {
  const thirdYear = await exportPayload({ abbreviation: 'DME (T)', subjectOrActivity: 'Design of Machine Elements' })
  const secondYear = await exportPayload({
    year: 'II / 2nd Year', section: 'B', assignmentDay: 'Tuesday', assignmentPeriod: 4,
    abbreviation: 'JAVA', subjectOrActivity: 'Java Programming', code: 'CSE201',
  })

  const merged = combineValidatedTeacherTimetables([thirdYear, secondYear])

  assert.equal(merged.valid, true)
  assert.equal(merged.conflicts.length, 0)
  assert.deepEqual(merged.yearsIncluded, ['2nd Year', '3rd Year'])
  assert.deepEqual(merged.timetable.Monday[2], { status: 'assigned', assignment: thirdYear.assignments[0] })
  assert.equal(merged.timetable.Monday[2].assignment.abbreviation, 'DME (T)')
  assert.equal(merged.timetable.Tuesday[4].assignment.subjectOrActivity, 'Java Programming')
  assert.equal(merged.timetable.Tuesday[4].assignment.section, 'B')
  assert.equal(merged.timetable.Tuesday[4].assignment.year, '2nd Year')
  assert.equal(merged.timetable.Tuesday[4].assignment.departmentId, 'CSE')
  assert.deepEqual(merged.timetable.Monday[1], { status: 'free' })
  assert.equal(thirdYear.assignments[0].abbreviation, 'DME (T)', 'merging does not alter the source payload')
})

test('combines three or more years dynamically and reports a complete multi-year collision', async () => {
  const thirdYear = await exportPayload()
  const secondYear = await exportPayload({ year: 'II / 2nd Year', section: 'B' })
  const fourthYear = await exportPayload({
    year: 'IV / 4th Year', section: 'C', abbreviation: 'SE', subjectOrActivity: 'Software Engineering', code: 'CSE401',
  })
  const validMany = combineValidatedTeacherTimetables([
    await exportPayload({ year: 'IV / 4th Year', assignmentDay: 'Saturday', assignmentPeriod: 8 }),
    await exportPayload({ year: 'II / 2nd Year', assignmentDay: 'Tuesday', assignmentPeriod: 3 }),
    await exportPayload({ year: 'III / 3rd Year', assignmentDay: 'Wednesday', assignmentPeriod: 6 }),
  ])
  assert.equal(validMany.valid, true)
  assert.equal(validMany.yearsIncluded.length, 3)

  const merged = combineValidatedTeacherTimetables([secondYear, thirdYear, fourthYear])
  assert.equal(merged.valid, false)
  assert.equal(merged.conflicts.length, 1)
  assert.deepEqual(merged.conflicts[0], {
    day: 'Monday',
    period: 2,
    assignments: [secondYear.assignments[0], thirdYear.assignments[0], fourthYear.assignments[0]],
  })
  assert.equal(merged.timetable.Monday[2].status, 'conflict')
  assert.equal(merged.timetable.Monday[2].assignments.length, 3)
})

test('combines one stable teacher across departments, years, semesters, and academic years', async () => {
  const cse = await exportPayload({ year: 'III / 3rd Year', assignmentDay: 'Monday', assignmentPeriod: 2 })
  const ece = await exportPayload({
    department: 'ECE', year: 'II / 2nd Year', semester: 'VI / 6th Semester', section: 'B',
    teacherName: 'R. Indumathi', assignmentDay: 'Tuesday', assignmentPeriod: 4,
  })
  const it = await exportPayload({
    department: 'IT', academicYear: '2027 - 2028', year: 'III / 3rd Year', semester: 'V / 5th Semester', section: 'C',
    assignmentDay: 'Wednesday', assignmentPeriod: 6,
  })
  const merged = combineValidatedTeacherTimetables([cse, ece, it])

  assert.equal(merged.valid, true)
  assert.deepEqual(merged.yearsIncluded, ['2nd Year', '3rd Year'])
  assert.deepEqual(merged.departmentId.split(', '), ['CSE', 'ECE', 'IT'])
  assert.deepEqual(merged.academicYear.split(', '), ['2026-2027', '2027-2028'])
  assert.equal(merged.timetable.Tuesday[4].assignment.departmentId, 'ECE')
  assert.equal(merged.timetable.Tuesday[4].assignment.semester, 'Even')
  assert.equal(merged.timetable.Wednesday[6].assignment.year, '3rd Year')
})

test('blocks combining fewer than two payloads, teacher mismatch, and duplicate sources', async () => {
  const base = await exportPayload()
  const otherTeacher = await exportPayload({ year: 'II / 2nd Year', teacherId: 'teacher-2', teacherName: 'Another Teacher' })
  const otherDepartment = await exportPayload({ department: 'ECE', year: 'II / 2nd Year' })
  const duplicateYear = await exportPayload()
  assert.throws(() => combineValidatedTeacherTimetables([base]), /at least two/)
  assert.throws(() => combineValidatedTeacherTimetables([base, otherTeacher]), /Teacher mismatch/)
  assert.equal(combineValidatedTeacherTimetables([base, otherDepartment]).valid, false, 'cross-department same-slot use is reported as a conflict rather than a scope mismatch')
  assert.throws(() => combineValidatedTeacherTimetables([base, duplicateYear]), /Duplicate timetable source/)
})
