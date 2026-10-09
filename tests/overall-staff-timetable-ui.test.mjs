import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodeTest from 'node:test'
import { listOverallStaffDirectory, loadOverallStaffTimetable } from '../src/timetable-version-client.ts'

nodeTest('overall staff UI client loads the global directory and switches by exact teacher ID', async (context) => {
  const requests = []
  const responseForTeacher = (teacherId) => ({
    teacher: { id: teacherId, canonicalName: teacherId === 'staff-1' ? 'Mrs. G. Sharmila' : 'Dr. Different Teacher' },
    days: { Monday: { 1: { conflict: false, conflictWeeks: [], assignments: [] } } },
  })
  context.mock.method(globalThis, 'fetch', async (path) => {
    const requestPath = String(path)
    requests.push(requestPath)
    const url = new URL(requestPath, 'http://localhost')
    if (url.pathname === '/api/overall-staff-timetable' && !url.searchParams.has('teacherId')) {
      return new Response(JSON.stringify({ teachers: [
        { id: 'staff-1', canonicalName: 'Mrs. G. Sharmila', normalizedName: 'mrs. g. sharmila', createdAt: '', updatedAt: '' },
        { id: 'staff-2', canonicalName: 'Dr. Different Teacher', normalizedName: 'dr. different teacher', createdAt: '', updatedAt: '' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify(responseForTeacher(url.searchParams.get('teacherId') ?? '')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  const { teachers } = await listOverallStaffDirectory()
  assert.deepEqual(teachers.map(({ id }) => id), ['staff-1', 'staff-2'])
  assert.equal(teachers.find(({ canonicalName }) => canonicalName.includes('Sharmila'))?.id, 'staff-1')

  const firstTeacherTimetable = await loadOverallStaffTimetable('staff-1')
  const secondTeacherTimetable = await loadOverallStaffTimetable('staff-2')
  assert.equal(firstTeacherTimetable.teacher.id, 'staff-1')
  assert.equal(secondTeacherTimetable.teacher.id, 'staff-2')
  assert.deepEqual(requests, [
    '/api/overall-staff-timetable',
    '/api/overall-staff-timetable?teacherId=staff-1',
    '/api/overall-staff-timetable?teacherId=staff-2',
  ])
})

nodeTest('overall staff view is additive and renders the active timetable fields and empty/conflict states', () => {
  const component = readFileSync(new URL('../src/OverallStaffTimetable.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.match(app, /<OverallStaffTimetableFeature\s*\/>/)
  assert.match(app, /<TeacherTimetableFeature\b/)
  assert.doesNotMatch(app, /ConsolidatedFacultyTimetable|consolidated-faculty/)
  assert.match(component, /<TeacherSelector/)
  assert.match(component, /value=\{teacherId\}/)
  assert.match(component, /loadOverallStaffTimetable\(teacherId\)/)
  assert.match(component, /data-teacher-id=\{selectedTeacher\.id\}/)
  assert.match(component, /teacherTimetableDays\.map/)
  assert.match(component, />P\{period\}</)
  assert.match(component, /Department: \{assignment\.department\}/)
  assert.match(component, /Year: \{assignment\.year\} · Semester:/)
  assert.match(component, /Section: \{assignment\.sectionName\}/)
  assert.match(component, /: 'FREE'/)
  assert.match(component, /slot\?\.conflict/)
  assert.match(component, /role="alert"/)
})

nodeTest('overall staff exports the currently selected saved timetable in all four formats', () => {
  const component = readFileSync(new URL('../src/OverallStaffTimetable.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

  assert.match(component, /<button type="button" onClick=\{print\}[^>]*>Print<\/button>/)
  assert.match(component, /<button type="button" onClick=\{downloadPdf\}[^>]*>\{exporting \? 'Preparing…' : 'Download PDF'\}<\/button>/)
  assert.match(component, /<button type="button" onClick=\{downloadPng\}[^>]*>\{exporting \? 'Preparing…' : 'Download PNG'\}<\/button>/)
  assert.match(component, /<button type="button" onClick=\{downloadJpg\}[^>]*>\{exporting \? 'Preparing…' : 'Download JPG'\}<\/button>/)
  assert.match(component, /data-teacher-id=\{selectedTeacher\.id\}/)
  assert.match(component, /if \(!element \|\| !selectedTeacher \|\| !timetable \|\| element\.dataset\.teacherId !== selectedTeacher\.id\)/)
  assert.match(component, /clone\.dataset\.overallExport = 'true'/)
  assert.match(component, /clone\.dataset\.teacherId !== selectedTeacher\.id/)
  assert.match(component, /return html2canvas\(element/)
  assert.match(component, /canvasBlob\(canvas, 'image\/png'\)/)
  assert.match(component, /canvasBlob\(canvas, 'image\/jpeg', 0\.95\)/)
  assert.match(component, /new jsPDF\(\{ orientation: 'landscape', unit: 'mm', format: 'a4'/)
  assert.match(component, /pdf\.save\(`MVIT-Overall-Staff-Timetable-/)
  assert.match(component, /window\.print\(\)/)
  assert.match(component, /Selected: \{selectedTeacher\.name\} · \{selectedTeacher\.id\}/)
  assert.match(component, /Department: \{assignment\.department\}/)
  assert.match(component, /Year: \{assignment\.year\} · Semester: \{assignment\.semester\}/)
  assert.match(component, /Section: \{assignment\.sectionName\}/)
  assert.match(styles, /\.overall-staff-export-source\[data-overall-print="true"\]/)
})
