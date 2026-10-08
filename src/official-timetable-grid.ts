import { calculateCollegeTimings, getDefaultCollegeTimings, usesDefaultCollegeTimetableLayout } from './college-timings.ts'
import type { CollegeTimings } from './college-timings.ts'

export const timetableRows = [
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
] as const

export type TimetableGridSlot = { kind: 'period'; label: string; period: number; time: string }
  | { kind: 'break'; label: string; time: string }

function clockLabel(value: string): string {
  const [hours, minutes] = value.split(':').map(Number)
  const suffix = hours < 12 ? 'AM' : 'PM'
  const hour = hours % 12 || 12
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`
}

export function buildOfficialTimetableGrid(value?: CollegeTimings | null): { days: string[]; rows: TimetableGridSlot[] } {
  const timings = value ?? getDefaultCollegeTimings()
  const days = [...timings.workingWeekdays]
  if (usesDefaultCollegeTimetableLayout(timings)) {
    return {
      days,
      rows: timetableRows.map((slot) => ({
        ...slot,
        period: slot.kind === 'period' ? Number(slot.label.slice(1)) : undefined,
      } as TimetableGridSlot)),
    }
  }

  const derived = calculateCollegeTimings(timings)
  const breaksAfter = new Map(derived.breakTimings.map((entry) => [entry.afterPeriod, entry]))
  const rows: TimetableGridSlot[] = []
  for (const period of derived.periodTimings) {
    rows.push({
      kind: 'period', label: `P${period.period}`, period: period.period,
      time: `${clockLabel(period.startTime)} – ${clockLabel(period.endTime)}`,
    })
    const breakTiming = breaksAfter.get(period.period)
    if (breakTiming) rows.push({
      kind: 'break', label: breakTiming.name,
      time: `${clockLabel(breakTiming.startTime)} – ${clockLabel(breakTiming.endTime)}`,
    })
  }
  return { days, rows }
}

/** Height for each timetable day row in an export grid, in millimeters. */
export function getOfficialGridDayRowHeight(gridHeightMm: number, fixedGridHeightMm: number, dayCount: number): number {
  const safeDayCount = Math.max(1, dayCount)
  return Math.max(0, (gridHeightMm - fixedGridHeightMm) / safeDayCount)
}
