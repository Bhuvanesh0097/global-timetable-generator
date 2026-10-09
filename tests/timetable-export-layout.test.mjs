import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [app, teacher, overall, styles] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/TeacherTimetable.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/OverallStaffTimetable.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
])

test('student timetable PDF, PNG, JPG, and print use an A4 landscape export copy', () => {
  assert.match(app, /format: 'a4'/)
  assert.match(app, /pdf\.addImage\(canvas\.toDataURL\('image\/png'\), 'PNG', 0, 0, 297, 210/)
  assert.match(app, /clone\.dataset\.exportLayout = 'true'/)
  assert.match(app, /clone\.dataset\.pdfLayout = 'true'/)
  assert.match(app, /window\.addEventListener\('beforeprint', applyPrintLayout/)
  assert.match(app, /windowWidth: Math\.ceil\(297 \* 96 \/ 25\.4\)/)
  assert.match(app, /windowHeight: Math\.ceil\(210 \* 96 \/ 25\.4\)/)
})

test('teacher-wise exports keep the live sheet unmarked and use the A4 landscape clone', () => {
  assert.match(teacher, /clone\.dataset\.teacherExport = 'true'/)
  assert.doesNotMatch(teacher, /element\.dataset\.teacherExport = 'true'/)
  assert.match(teacher, /format: 'a4'/)
  assert.match(teacher, /pdf\.addImage\(canvas\.toDataURL\('image\/png'\), 'PNG', 0, 0, 297, 210/)
  assert.match(teacher, /canvasBlob\(canvas, 'image\/png'\)/)
  assert.match(teacher, /canvasBlob\(canvas, 'image\/jpeg', 0\.95\)/)
  assert.match(styles, /\.teacher-timetable-sheet\[data-teacher-export="true"\] \.teacher-structure-cell strong[\s\S]*?writing-mode:horizontal-tb!important[\s\S]*?transform:none!important/)
  assert.match(styles, /\.teacher-timetable-sheet\[data-teacher-print="true"\] \.teacher-structure-cell strong[\s\S]*?writing-mode:horizontal-tb!important[\s\S]*?transform:none!important/)
})

test('Overall Staff exports fill the A4 landscape page without a second shrink-to-fit margin', () => {
  assert.match(overall, /clone\.dataset\.overallExport = 'true'/)
  assert.match(overall, /format: 'a4'/)
  assert.match(overall, /pdf\.addImage\(canvas\.toDataURL\('image\/png'\), 'PNG', 0, 0, 297, 210/)
  assert.match(overall, /canvasBlob\(canvas, 'image\/png'\)/)
  assert.match(overall, /canvasBlob\(canvas, 'image\/jpeg', 0\.95\)/)
  assert.match(styles, /\.overall-staff-export-source\[data-overall-export="true"\]\{width:297mm!important;height:210mm!important/)
  assert.match(styles, /\.overall-staff-export-source\[data-overall-print="true"\]/)
})

test('student export-only break labels are horizontal and print uses A4 landscape', () => {
  assert.match(styles, /\.official-timetable\[data-pdf-layout="true"\] \.official-break-content strong[\s\S]*?writing-mode:horizontal-tb!important[\s\S]*?transform:none!important/)
  assert.match(styles, /\.official-timetable\[data-pdf-layout="true"\] \.official-break-heading-content small[\s\S]*?writing-mode:horizontal-tb!important[\s\S]*?transform:none!important/)
  assert.match(styles, /@page\{size:A4 landscape;margin:0\}/)
})
