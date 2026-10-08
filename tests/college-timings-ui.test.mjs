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
  assert.match(app, /<CollegeTimingsPanel value=\{collegeTimings\} onChange=\{updateCollegeTimings\}/)
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

test('break count is editable and resizes the existing break definitions', () => {
  const panel = readFileSync(new URL('../src/CollegeTimingsSection.tsx', import.meta.url), 'utf8')

  assert.match(panel, /aria-label="Break Count" type="number"[^>]*onChange=\{\(event\) => updateBreakCount\(/)
  assert.doesNotMatch(panel, /aria-label="Break Count"[^>]*readOnly/)
  assert.match(panel, /const updateBreakCount = \(requestedCount: number\)/)
  assert.match(panel, /const maximumCount = Math\.max\(0, value\.periodsPerDay - 2\)/)
  assert.match(panel, /kind: 'break', name: `Break \$\{index \+ 1\}`, afterPeriod, durationMinutes: 10/)
  assert.match(panel, /onChange\(\{ \.\.\.value, breaks: nextBreaks \}\)/)
})

test('working days is a native number input backed by weekday selection', () => {
  const panel = readFileSync(new URL('../src/CollegeTimingsSection.tsx', import.meta.url), 'utf8')

  assert.match(panel, /aria-label="Working Days" type="number" min=\{1\} max=\{collegeWeekdays\.length\} step=\{1\} value=\{value\.workingWeekdays\.length\} onChange=\{\(event\) => updateWorkingDayCount\(/)
  assert.match(panel, /const updateWorkingDayCount = \(requestedCount: number\)/)
  assert.match(panel, /const count = Math\.max\(1, Math\.min\(collegeWeekdays\.length, Math\.trunc\(requestedCount\)\)\)/)
  assert.match(panel, /onChange\(\{ \.\.\.value, workingWeekdays: nextWorkingWeekdays \}\)/)
  assert.match(panel, /checked=\{value\.workingWeekdays\.includes\(day\)\}/)
})

test('College Timings input controls remain connected to the existing state', () => {
  const panel = readFileSync(new URL('../src/CollegeTimingsSection.tsx', import.meta.url), 'utf8')
  const controlledUpdates = [
    'updatePeriodCount(numberInputValue(event.target.value))',
    'periodDurationMinutes: numberInputValue(event.target.value)',
    'collegeStartTime: event.target.value',
    'updateTimingMode(event.target.value as CollegeTimingMode)',
    'teacherMaximumWeeklyPeriods: numberInputValue(event.target.value)',
    'workingWeekdays: collegeWeekdays.filter((weekday) => selected.has(weekday))',
    'updateBreak(entry, { name: event.target.value })',
    'updateBreak(entry, { afterPeriod: numberInputValue(event.target.value) })',
    'updateBreak(entry, { durationMinutes: numberInputValue(event.target.value) })',
    'updateLunch({ afterPeriod: numberInputValue(event.target.value) })',
    'updateLunch({ durationMinutes: numberInputValue(event.target.value) })',
    'updateCustomPeriod(period.period, { startTime: event.target.value })',
    'updateCustomPeriod(period.period, { endTime: event.target.value })',
  ]
  for (const update of controlledUpdates) assert.ok(panel.includes(update), `missing controlled update: ${update}`)
  assert.match(panel, /aria-label="Weekly Timetable Capacity" value=\{weeklyCapacity\} readOnly/)
  assert.match(panel, /aria-label="Daily College Duration" value=\{formatDuration\(dailyDuration\)\} readOnly/)
  assert.match(panel, /aria-label="Weekly College Duration" value=\{formatDuration\(weeklyDuration\)\} readOnly/)
})
