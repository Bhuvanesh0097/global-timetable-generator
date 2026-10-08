import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('College Timings is an additive section above Academic Details', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const collegeSection = app.indexOf('<Accordion id="collegeTimings"')
  const academicSection = app.indexOf('<Accordion id="academic"')

  assert.ok(collegeSection >= 0)
  assert.ok(academicSection > collegeSection)
  assert.match(app, /id="collegeTimings" number="00" title="COLLEGE TIMINGS"/)
  assert.match(app, /<CollegeTimingsPanel value=\{collegeTimings\} onChange=\{setCollegeTimings\}/)
  assert.match(app, /type SectionKey = 'collegeTimings' \| 'academic'/)
})

test('College Timings panel exposes configuration, derived values and pre-save validation only', () => {
  const panel = readFileSync(new URL('../src/CollegeTimingsSection.tsx', import.meta.url), 'utf8')

  for (const label of [
    'Working Days', 'Working Weekday Selection', 'Periods Per Day', 'Period Duration (minutes)',
    'College Start Time', 'Break Count', 'Break Definitions', 'Lunch (exactly one)',
    'Timing Mode', 'Teacher Maximum Weekly Teaching Periods', 'Weekly Timetable Capacity',
    'Daily College Duration', 'Weekly College Duration', 'Automatic Period Timings', 'Custom Period Timings',
  ]) assert.ok(panel.includes(label), `missing UI field: ${label}`)

  assert.match(panel, /validateCollegeTimings\(value\)/)
  assert.match(panel, /calculateCollegeTimings\(value\)/)
  assert.match(panel, /role="alert"/)
  assert.match(panel, /not connected to generation yet/)
  assert.doesNotMatch(panel, /generateGenericTimetable|generateTimetableOnServer|saveTimetableVersion/)
})
