import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCollegeTimings,
  deserializeCollegeTimings,
  getDefaultCollegeTimings,
  resolveCollegeTimings,
  serializeCollegeTimings,
  validateCollegeTimings,
} from '../src/college-timings.ts'

test('defaults reproduce the current six-day, eight-period, 48-slot schedule and times', () => {
  const timings = getDefaultCollegeTimings()
  const derived = calculateCollegeTimings(timings)
  assert.equal(derived.workingDayCount, 6)
  assert.equal(timings.periodsPerDay, 8)
  assert.equal(derived.weeklyCapacity, 48)
  assert.deepEqual(derived.periodTimings, [
    { period: 1, startTime: '08:50', endTime: '09:40' },
    { period: 2, startTime: '09:40', endTime: '10:30' },
    { period: 3, startTime: '10:45', endTime: '11:35' },
    { period: 4, startTime: '11:35', endTime: '12:25' },
    { period: 5, startTime: '13:10', endTime: '14:00' },
    { period: 6, startTime: '14:00', endTime: '14:50' },
    { period: 7, startTime: '15:00', endTime: '15:50' },
    { period: 8, startTime: '15:50', endTime: '16:40' },
  ])
  assert.deepEqual(derived.breakTimings.map(({ name, afterPeriod, durationMinutes, startTime, endTime }) => ({
    name, afterPeriod, durationMinutes, startTime, endTime,
  })), [
    { name: 'Morning Break', afterPeriod: 2, durationMinutes: 15, startTime: '10:30', endTime: '10:45' },
    { name: 'Lunch', afterPeriod: 4, durationMinutes: 45, startTime: '12:25', endTime: '13:10' },
    { name: 'Tea Break', afterPeriod: 6, durationMinutes: 10, startTime: '14:50', endTime: '15:00' },
  ])
})

test('missing College Timings resolve to isolated compatibility defaults', () => {
  const first = resolveCollegeTimings(undefined)
  const second = deserializeCollegeTimings(null)
  first.workingWeekdays = ['Monday']
  assert.equal(second.workingWeekdays.length, 6)
  assert.equal(calculateCollegeTimings(second).weeklyCapacity, 48)
})

test('College Timings serialize and deserialize as a validated snapshot', () => {
  const timings = getDefaultCollegeTimings()
  const snapshot = serializeCollegeTimings(timings)
  assert.deepEqual(deserializeCollegeTimings(snapshot), timings)
  assert.deepEqual(deserializeCollegeTimings(undefined), getDefaultCollegeTimings())
  assert.throws(() => deserializeCollegeTimings('{bad json'), /not valid JSON/)
})

test('valid configuration supports multiple breaks and derives weekly capacity', () => {
  const timings = {
    ...getDefaultCollegeTimings(),
    workingWeekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    periodsPerDay: 6,
    breaks: [
      { kind: 'break', name: 'Morning Break', afterPeriod: 2, durationMinutes: 15 },
      { kind: 'lunch', name: 'Lunch', afterPeriod: 4, durationMinutes: 45 },
    ],
  }
  assert.deepEqual(validateCollegeTimings(timings), [])
  const derived = calculateCollegeTimings(timings)
  assert.equal(derived.workingDayCount, 5)
  assert.equal(derived.weeklyCapacity, 30)
  assert.equal(derived.breakTimings.length, 2)
})

test('validation rejects invalid weekdays, capacities, durations, times and break positions', () => {
  const invalid = {
    ...getDefaultCollegeTimings(),
    workingWeekdays: ['Monday', 'Monday', 'Funday'],
    periodsPerDay: 0,
    periodDurationMinutes: 0,
    collegeStartTime: '25:90',
    teacherMaximumWeeklyPeriods: 0,
    breaks: [{ kind: 'break', name: '', afterPeriod: 8, durationMinutes: 0 }],
  }
  const issues = validateCollegeTimings(invalid)
  assert.ok(issues.some((issue) => issue.includes('valid weekdays')))
  assert.ok(issues.some((issue) => issue.includes('duplicates')))
  assert.ok(issues.some((issue) => issue.includes('positive whole number')))
  assert.ok(issues.some((issue) => issue.includes('HH:mm')))
  assert.ok(issues.some((issue) => issue.includes('name')))
  assert.ok(issues.some((issue) => issue.includes('before the end of the day')))
  assert.ok(issues.some((issue) => issue.includes('Exactly one lunch')))
})

test('exactly one lunch is required, with any number of ordinary breaks', () => {
  const timings = getDefaultCollegeTimings()
  const noLunch = { ...timings, breaks: timings.breaks.filter(({ kind }) => kind !== 'lunch') }
  const twoLunches = { ...timings, breaks: [...timings.breaks, { ...timings.breaks[1] }] }
  assert.ok(validateCollegeTimings(noLunch).some((issue) => issue.includes('Exactly one lunch')))
  assert.ok(validateCollegeTimings(twoLunches).some((issue) => issue.includes('Exactly one lunch')))
  assert.deepEqual(validateCollegeTimings(timings), [])
})

test('custom period timings are retained and break gaps are checked against definitions', () => {
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
  assert.deepEqual(validateCollegeTimings(timings), [])
  const derived = calculateCollegeTimings(timings)
  assert.deepEqual(derived.periodTimings, timings.customPeriodTimings)
  assert.deepEqual(derived.breakTimings, [{
    ...timings.breaks[0], startTime: '10:30', endTime: '11:00',
  }])

  const mismatchedBreak = { ...timings, breaks: [{ ...timings.breaks[0], durationMinutes: 25 }] }
  assert.ok(validateCollegeTimings(mismatchedBreak).some((issue) => issue.includes('match its configured break duration')))
})

test('automatic mode does not accept custom timing rows', () => {
  const timings = {
    ...getDefaultCollegeTimings(),
    customPeriodTimings: [{ period: 1, startTime: '08:50', endTime: '09:40' }],
  }
  assert.ok(validateCollegeTimings(timings).some((issue) => issue.includes('only be supplied in custom timing mode')))
})
