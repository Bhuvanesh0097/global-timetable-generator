/** Weekday choices available to a future institution-level timetable configuration. */
export const collegeWeekdays = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const

export type CollegeWeekday = typeof collegeWeekdays[number]
export type CollegeTimingMode = 'automatic' | 'custom'
export type CollegeBreakKind = 'break' | 'lunch'

export interface CollegeBreakDefinition {
  kind: CollegeBreakKind
  name: string
  /** One-based teaching period after which this break occurs. */
  afterPeriod: number
  durationMinutes: number
}

export interface CollegePeriodTiming {
  /** One-based teaching period number. */
  period: number
  /** Local 24-hour clock time in HH:mm format. */
  startTime: string
  /** Local 24-hour clock time in HH:mm format. */
  endTime: string
}

/**
 * Institution-level timetable layout. Weekly capacity is derived from the
 * selected weekdays and periods per day; it is deliberately not stored here.
 */
export interface CollegeTimings {
  workingWeekdays: readonly CollegeWeekday[]
  periodsPerDay: number
  /** Used to calculate automatic timings; custom timings are authoritative in custom mode. */
  periodDurationMinutes: number
  /** Local HH:mm start; in custom mode this must match the P1 start. */
  collegeStartTime: string
  breaks: readonly CollegeBreakDefinition[]
  timingMode: CollegeTimingMode
  /** Required in custom mode and contains exactly one entry for each period. */
  customPeriodTimings?: readonly CollegePeriodTiming[]
  /** Separate teacher workload policy; the compatibility default is 48. */
  teacherMaximumWeeklyPeriods: number
}

export interface CollegeBreakTiming extends CollegeBreakDefinition {
  startTime: string
  endTime: string
}

export interface CollegeTimingsDerivedValues {
  workingDayCount: number
  weeklyCapacity: number
  periodTimings: CollegePeriodTiming[]
  breakTimings: CollegeBreakTiming[]
}

const defaultCollegeTimings: CollegeTimings = Object.freeze({
  workingWeekdays: Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as CollegeWeekday[]),
  periodsPerDay: 8,
  periodDurationMinutes: 50,
  collegeStartTime: '08:50',
  breaks: Object.freeze([
    Object.freeze({ kind: 'break', name: 'Morning Break', afterPeriod: 2, durationMinutes: 15 }),
    Object.freeze({ kind: 'lunch', name: 'Lunch', afterPeriod: 4, durationMinutes: 45 }),
    Object.freeze({ kind: 'break', name: 'Tea Break', afterPeriod: 6, durationMinutes: 10 }),
  ] as CollegeBreakDefinition[]),
  timingMode: 'automatic',
  teacherMaximumWeeklyPeriods: 48,
})

const weekdaySet = new Set<string>(collegeWeekdays)
const breakKinds = new Set<string>(['break', 'lunch'])
const timingModes = new Set<string>(['automatic', 'custom'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function timeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function minutesToTime(value: number): string {
  const hours = Math.floor(value / 60)
  const minutes = value % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function cloneCollegeTimings(value: CollegeTimings): CollegeTimings {
  return {
    ...value,
    workingWeekdays: [...value.workingWeekdays],
    breaks: value.breaks.map((entry) => ({ ...entry })),
    ...(value.customPeriodTimings ? { customPeriodTimings: value.customPeriodTimings.map((entry) => ({ ...entry })) } : {}),
  }
}

/** Return an isolated copy of the defaults that reproduce the existing 6 x 8 timetable. */
export function getDefaultCollegeTimings(): CollegeTimings {
  return cloneCollegeTimings(defaultCollegeTimings)
}

/** Missing legacy setup values resolve to the current timetable defaults. */
export function resolveCollegeTimings(value?: CollegeTimings | null): CollegeTimings {
  return value == null ? getDefaultCollegeTimings() : cloneCollegeTimings(value)
}

/** Validate a College Timings value before storing or calculating it. */
export function validateCollegeTimings(value: unknown): string[] {
  const issues: string[] = []
  if (!isRecord(value)) return ['College Timings must be an object.']

  const weekdays = value.workingWeekdays
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    issues.push('Select at least one working weekday.')
  } else {
    if (weekdays.some((day) => typeof day !== 'string' || !weekdaySet.has(day))) {
      issues.push('Working weekdays must be valid weekdays from Monday through Sunday.')
    }
    if (new Set(weekdays).size !== weekdays.length) issues.push('Working weekdays must not contain duplicates.')
  }

  const validPeriodsPerDay = positiveInteger(value.periodsPerDay)
  if (!validPeriodsPerDay) issues.push('Periods per day must be a positive whole number.')
  if (!positiveInteger(value.periodDurationMinutes)) issues.push('Period duration must be a positive whole number of minutes.')

  const startTime = timeToMinutes(value.collegeStartTime)
  if (startTime === null) issues.push('College start time must use a valid HH:mm 24-hour time.')

  if (!timingModes.has(String(value.timingMode))) issues.push('Timing mode must be automatic or custom.')
  if (!positiveInteger(value.teacherMaximumWeeklyPeriods)) {
    issues.push('Teacher maximum weekly periods must be a positive whole number.')
  }

  const breaks = value.breaks
  if (!Array.isArray(breaks)) {
    issues.push('Break definitions must be an array.')
  } else {
    const lunchCount = breaks.filter((entry) => isRecord(entry) && entry.kind === 'lunch').length
    if (lunchCount !== 1) issues.push('Exactly one lunch definition is required.')
    const usedPositions = new Set<number>()
    for (const [index, entry] of breaks.entries()) {
      if (!isRecord(entry)) {
        issues.push(`Break definition ${index + 1} must be an object.`)
        continue
      }
      if (!breakKinds.has(String(entry.kind))) issues.push(`Break definition ${index + 1} must be a break or lunch.`)
      if (typeof entry.name !== 'string' || !entry.name.trim()) issues.push(`Break definition ${index + 1} needs a name.`)
      if (!Number.isSafeInteger(entry.afterPeriod)
        || Number(entry.afterPeriod) < 1
        || !validPeriodsPerDay
        || Number(entry.afterPeriod) >= Number(value.periodsPerDay)) {
        issues.push(`Break definition ${index + 1} must follow a period before the end of the day.`)
      } else if (usedPositions.has(Number(entry.afterPeriod))) {
        issues.push('Only one break may follow a given period.')
      } else {
        usedPositions.add(Number(entry.afterPeriod))
      }
      if (!positiveInteger(entry.durationMinutes)) {
        issues.push(`Break definition ${index + 1} duration must be a positive whole number of minutes.`)
      }
    }
  }

  if (value.timingMode === 'automatic') {
    if (value.customPeriodTimings !== undefined) {
      issues.push('Custom period timings may only be supplied in custom timing mode.')
    }
    if (validPeriodsPerDay && positiveInteger(value.periodDurationMinutes) && startTime !== null) {
      let cursor = startTime
      const breaksByPeriod = new Map<number, number>()
      if (Array.isArray(breaks)) {
        for (const entry of breaks) {
          if (isRecord(entry) && Number.isSafeInteger(entry.afterPeriod) && positiveInteger(entry.durationMinutes)) {
            breaksByPeriod.set(Number(entry.afterPeriod), Number(entry.durationMinutes))
          }
        }
      }
      for (let period = 1; period <= Number(value.periodsPerDay); period += 1) {
        cursor += Number(value.periodDurationMinutes)
        const breakDuration = breaksByPeriod.get(period)
        if (breakDuration) cursor += breakDuration
      }
      if (cursor >= 24 * 60) issues.push('Automatic timings must finish before midnight.')
    }
  } else if (value.timingMode === 'custom') {
    const custom = value.customPeriodTimings
    if (!Array.isArray(custom)) {
      issues.push('Custom timing mode requires period timings.')
    } else if (validPeriodsPerDay) {
      if (custom.length !== Number(value.periodsPerDay)) {
        issues.push('Custom timings must define every period exactly once.')
      }
      const byPeriod = new Map<number, { start: number; end: number }>()
      for (const [index, entry] of custom.entries()) {
        if (!isRecord(entry)) {
          issues.push(`Custom period timing ${index + 1} must be an object.`)
          continue
        }
        const period = entry.period
        const start = timeToMinutes(entry.startTime)
        const end = timeToMinutes(entry.endTime)
        if (!Number.isSafeInteger(period) || Number(period) < 1 || Number(period) > Number(value.periodsPerDay)) {
          issues.push(`Custom period timing ${index + 1} has an invalid period number.`)
          continue
        }
        if (byPeriod.has(Number(period))) issues.push(`Custom period P${period} is defined more than once.`)
        if (start === null || end === null || end <= start) {
          issues.push(`Custom period P${period} must have valid start and end times on the same day.`)
          continue
        }
        byPeriod.set(Number(period), { start, end })
      }

      const firstPeriod = byPeriod.get(1)
      if (startTime !== null && firstPeriod && firstPeriod.start !== startTime) {
        issues.push('College start time must match the custom P1 start time.')
      }

      for (let period = 1; period <= Number(value.periodsPerDay); period += 1) {
        if (!byPeriod.has(period)) issues.push(`Custom timing for P${period} is missing.`)
      }
      const breaksAfter = new Map<number, number>()
      if (Array.isArray(breaks)) {
        for (const entry of breaks) {
          if (isRecord(entry) && Number.isSafeInteger(entry.afterPeriod) && positiveInteger(entry.durationMinutes)) {
            breaksAfter.set(Number(entry.afterPeriod), Number(entry.durationMinutes))
          }
        }
      }
      for (let period = 1; period < Number(value.periodsPerDay); period += 1) {
        const current = byPeriod.get(period)
        const next = byPeriod.get(period + 1)
        if (!current || !next) continue
        const gap = next.start - current.end
        if (gap < 0) issues.push(`Custom periods P${period} and P${period + 1} overlap or are out of order.`)
        else if (gap !== (breaksAfter.get(period) ?? 0)) {
          issues.push(`The gap after P${period} must match its configured break duration.`)
        }
      }
    }
  }

  return issues
}

/** Calculate derived day/capacity values and the period/break clock schedule. */
export function calculateCollegeTimings(value: CollegeTimings): CollegeTimingsDerivedValues {
  const issues = validateCollegeTimings(value)
  if (issues.length) throw new Error(`Invalid College Timings configuration:\n${issues.join('\n')}`)

  const periodTimings: CollegePeriodTiming[] = []
  const breakTimings: CollegeBreakTiming[] = []
  const breaksByPeriod = new Map(value.breaks.map((entry) => [entry.afterPeriod, entry]))

  if (value.timingMode === 'custom') {
    const custom = [...(value.customPeriodTimings ?? [])].sort((left, right) => left.period - right.period)
    periodTimings.push(...custom.map((entry) => ({ ...entry })))
    for (const entry of value.breaks) {
      const before = custom.find((period) => period.period === entry.afterPeriod)
      const after = custom.find((period) => period.period === entry.afterPeriod + 1)
      if (before && after) {
        breakTimings.push({
          ...entry,
          startTime: before.endTime,
          endTime: after.startTime,
        })
      }
    }
  } else {
    let cursor = timeToMinutes(value.collegeStartTime)!
    for (let period = 1; period <= value.periodsPerDay; period += 1) {
      const start = cursor
      const end = start + value.periodDurationMinutes
      periodTimings.push({ period, startTime: minutesToTime(start), endTime: minutesToTime(end) })
      cursor = end
      const breakEntry = breaksByPeriod.get(period)
      if (breakEntry) {
        const breakEnd = cursor + breakEntry.durationMinutes
        breakTimings.push({
          ...breakEntry,
          startTime: minutesToTime(cursor),
          endTime: minutesToTime(breakEnd),
        })
        cursor = breakEnd
      }
    }
  }

  return {
    workingDayCount: value.workingWeekdays.length,
    weeklyCapacity: value.workingWeekdays.length * value.periodsPerDay,
    periodTimings,
    breakTimings,
  }
}

/** Serialize a validated College Timings snapshot for existing JSON snapshot storage. */
export function serializeCollegeTimings(value: CollegeTimings): string {
  const issues = validateCollegeTimings(value)
  if (issues.length) throw new Error(`Invalid College Timings configuration:\n${issues.join('\n')}`)
  return JSON.stringify(value)
}

/** Deserialize a snapshot; absent legacy values use the current compatibility defaults. */
export function deserializeCollegeTimings(snapshot?: string | null): CollegeTimings {
  if (snapshot == null) return getDefaultCollegeTimings()
  let value: unknown
  try {
    value = JSON.parse(snapshot)
  } catch {
    throw new Error('College Timings snapshot is not valid JSON.')
  }
  const issues = validateCollegeTimings(value)
  if (issues.length) throw new Error(`Invalid College Timings snapshot:\n${issues.join('\n')}`)
  return cloneCollegeTimings(value as CollegeTimings)
}
