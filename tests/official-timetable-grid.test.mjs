import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildOfficialTimetableGrid, getOfficialGridDayRowHeight } from '../src/official-timetable-grid.ts'
import { getDefaultCollegeTimings } from '../src/college-timings.ts'

test('the default official timetable grid retains its existing six-day, eight-period labels and timings', () => {
  const { days, rows } = buildOfficialTimetableGrid()

  assert.deepEqual(days, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
  assert.deepEqual(buildOfficialTimetableGrid(getDefaultCollegeTimings()), { days, rows })
  assert.deepEqual(rows.map(({ kind, label, time }) => ({ kind, label, time })), [
    { kind: 'period', label: 'P1', time: '8:50 AM – 9:40 AM' },
    { kind: 'period', label: 'P2', time: '9:40 AM – 10:30 AM' },
    { kind: 'break', label: 'Break', time: '10:30 AM – 10:45 AM' },
    { kind: 'period', label: 'P3', time: '10:45 AM – 11:35 AM' },
    { kind: 'period', label: 'P4', time: '11:35 AM – 12:25 PM' },
    { kind: 'break', label: 'Lunch', time: '12:25 PM – 1:10 PM' },
    { kind: 'period', label: 'P5', time: '1:10 PM – 2:00 PM' },
    { kind: 'period', label: 'P6', time: '2:00 PM – 2:50 PM' },
    { kind: 'break', label: 'Tea Break', time: '2:50 PM – 3:00 PM' },
    { kind: 'period', label: 'P7', time: '3:00 PM – 3:50 PM' },
    { kind: 'period', label: 'P8', time: '3:50 PM – 4:40 PM' },
  ])
  assert.deepEqual(rows.filter(({ kind }) => kind === 'period').map(({ period }) => period), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('the official grid renders configured weekdays, period count, breaks, lunch, and automatic timing labels', () => {
  const timings = {
    ...getDefaultCollegeTimings(),
    workingWeekdays: ['Monday', 'Wednesday', 'Friday', 'Sunday'],
    periodsPerDay: 4,
    periodDurationMinutes: 45,
    collegeStartTime: '09:00',
    breaks: [
      { kind: 'break', name: 'Morning Break', afterPeriod: 1, durationMinutes: 10 },
      { kind: 'lunch', name: 'Lunch', afterPeriod: 2, durationMinutes: 30 },
    ],
  }
  const { days, rows } = buildOfficialTimetableGrid(timings)

  assert.deepEqual(days, timings.workingWeekdays)
  assert.deepEqual(rows.map(({ kind, label, time }) => ({ kind, label, time })), [
    { kind: 'period', label: 'P1', time: '9:00 AM – 9:45 AM' },
    { kind: 'break', label: 'Morning Break', time: '9:45 AM – 9:55 AM' },
    { kind: 'period', label: 'P2', time: '9:55 AM – 10:40 AM' },
    { kind: 'break', label: 'Lunch', time: '10:40 AM – 11:10 AM' },
    { kind: 'period', label: 'P3', time: '11:10 AM – 11:55 AM' },
    { kind: 'period', label: 'P4', time: '11:55 AM – 12:40 PM' },
  ])
})

test('custom period labels and the configured lunch boundary are rendered from custom timings', () => {
  const timings = {
    ...getDefaultCollegeTimings(),
    periodsPerDay: 3,
    collegeStartTime: '09:00',
    timingMode: 'custom',
    breaks: [{ kind: 'lunch', name: 'Lunch', afterPeriod: 2, durationMinutes: 30 }],
    customPeriodTimings: [
      { period: 1, startTime: '09:00', endTime: '09:45' },
      { period: 2, startTime: '09:45', endTime: '10:30' },
      { period: 3, startTime: '11:00', endTime: '11:45' },
    ],
  }
  const { rows } = buildOfficialTimetableGrid(timings)

  assert.deepEqual(rows.map(({ kind, label, time }) => ({ kind, label, time })), [
    { kind: 'period', label: 'P1', time: '9:00 AM – 9:45 AM' },
    { kind: 'period', label: 'P2', time: '9:45 AM – 10:30 AM' },
    { kind: 'break', label: 'Lunch', time: '10:30 AM – 11:00 AM' },
    { kind: 'period', label: 'P3', time: '11:00 AM – 11:45 AM' },
  ])
})

test('export day-row sizing preserves the six-day formula and fills configured day counts', () => {
  for (const gridHeightMm of [100, 142.5, 205]) {
    assert.equal(getOfficialGridDayRowHeight(gridHeightMm, 36.4, 6), (gridHeightMm - 36.4) / 6)
    assert.equal(getOfficialGridDayRowHeight(gridHeightMm, 21, 6), (gridHeightMm - 21) / 6)
  }

  const fiveDayRow = getOfficialGridDayRowHeight(142.5, 36.4, 5)
  const sixDayRow = getOfficialGridDayRowHeight(142.5, 36.4, 6)
  const sevenDayRow = getOfficialGridDayRowHeight(142.5, 36.4, 7)
  assert.ok(fiveDayRow > sixDayRow)
  assert.ok(sixDayRow > sevenDayRow)
})

test('section PDF, PNG, JPG, and print exports use the same A4 landscape layout without changing the preview', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

  assert.match(app, /window\.print\(\)/)
  assert.match(app, /format: 'a4'/)
  assert.match(app, /canvas\.toDataURL\('image\/png'\)/)
  assert.match(app, /canvas\.toDataURL\('image\/jpeg', 0\.95\)/)
  assert.match(app, /querySelectorAll\('\.official-grid tbody tr'\)\.length/)
  assert.match(app, /clone\.style\.setProperty\('--export-day-row-height', `\$\{pdfSizing\.dayRowHeight\}mm`\)/)
  assert.match(app, /element\.style\.setProperty\('--export-day-row-height', `\$\{pdfSizing\.dayRowHeight\}mm`\)/)
  assert.match(styles, /\.official-grid tbody tr[^\n]*height:var\(--document-day-row-height\)/)
  assert.match(styles, /data-pdf-layout="true"\] \.official-grid tbody tr\{height:var\(--export-day-row-height\)/)
  assert.ok(styles.includes('width:297mm!important'))
  assert.ok(styles.includes('writing-mode:horizontal-tb!important'))
  assert.ok(styles.includes('@page{size:A4 landscape;margin:0}'))
})
