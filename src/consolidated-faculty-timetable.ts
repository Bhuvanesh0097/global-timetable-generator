import type { WeekDay } from './models'
import type { TeacherExportAssignment, TeacherExportPayload } from './teacher-export-metadata'
import { teacherExportSourceKey } from './teacher-export-metadata.ts'
import { teacherTimetableDays, teacherTimetablePeriods } from './teacher-timetable.ts'

export type ConsolidatedTimetableCell =
  | { status: 'free' }
  | { status: 'assigned'; assignment: TeacherExportAssignment }
  | { status: 'conflict'; assignments: TeacherExportAssignment[] }

export interface ConsolidatedTimetableConflict {
  day: WeekDay
  period: number
  assignments: TeacherExportAssignment[]
}

export interface ConsolidatedFacultyTimetable {
  teacherId: string
  teacherName: string
  departmentId: string
  departmentName: string
  academicYear: string
  yearsIncluded: string[]
  valid: boolean
  conflicts: ConsolidatedTimetableConflict[]
  timetable: Record<WeekDay, Record<number, ConsolidatedTimetableCell>>
}

const yearOrder = ['1st Year', '2nd Year', '3rd Year', '4th Year']

/**
 * Combines only the teacher assignments in already-verified upload payloads.
 * It deliberately has no scheduler access and never edits its input payloads.
 */
export function combineValidatedTeacherTimetables(
  payloads: readonly TeacherExportPayload[],
): ConsolidatedFacultyTimetable {
  if (payloads.length < 2) throw new Error('Upload at least two validated Teacher-wise Timetables before combining.')

  const first = payloads[0]
  const sourceKeys = new Set<string>()
  for (const payload of payloads) {
    if (payload.teacherId !== first.teacherId) {
      throw new Error('Teacher mismatch. All uploaded timetables must belong to the same teacher.')
    }
    const sourceKey = teacherExportSourceKey(payload)
    if (sourceKeys.has(sourceKey)) throw new Error('Duplicate timetable source. Remove repeated exports before combining.')
    sourceKeys.add(sourceKey)
  }

  const assignmentsBySlot = new Map<string, TeacherExportAssignment[]>()
  for (const payload of payloads) {
    for (const assignment of payload.assignments) {
      if (!teacherTimetableDays.includes(assignment.day as WeekDay) || !teacherTimetablePeriods.includes(assignment.period)) {
        throw new Error('A source timetable contains an assignment outside Monday-Saturday P1-P8.')
      }
      const key = `${assignment.day}\u0000${assignment.period}`
      const slotAssignments = assignmentsBySlot.get(key) ?? []
      slotAssignments.push(assignment)
      assignmentsBySlot.set(key, slotAssignments)
    }
  }

  const conflicts: ConsolidatedTimetableConflict[] = []
  const timetable = Object.fromEntries(teacherTimetableDays.map((day) => [
    day,
    Object.fromEntries(teacherTimetablePeriods.map((period) => {
      const assignments = assignmentsBySlot.get(`${day}\u0000${period}`) ?? []
      if (assignments.length > 1) {
        conflicts.push({ day, period, assignments })
        return [period, { status: 'conflict', assignments } satisfies ConsolidatedTimetableCell]
      }
      if (assignments.length === 1) {
        return [period, { status: 'assigned', assignment: assignments[0] } satisfies ConsolidatedTimetableCell]
      }
      return [period, { status: 'free' } satisfies ConsolidatedTimetableCell]
    })),
  ])) as Record<WeekDay, Record<number, ConsolidatedTimetableCell>>

  const departmentNames = new Map<string, string>()
  for (const payload of payloads) {
    if (!departmentNames.has(payload.departmentId)) departmentNames.set(payload.departmentId, payload.departmentName)
  }
  const years = [...new Set(payloads.map(({ year }) => year))]
    .sort((left, right) => {
      const leftOrder = yearOrder.indexOf(left)
      const rightOrder = yearOrder.indexOf(right)
      return (leftOrder < 0 ? yearOrder.length : leftOrder) - (rightOrder < 0 ? yearOrder.length : rightOrder)
        || left.localeCompare(right)
    })
  return {
    teacherId: first.teacherId,
    teacherName: first.teacherName,
    departmentId: [...departmentNames.keys()].sort().join(', '),
    departmentName: [...departmentNames.values()].sort().join(', '),
    academicYear: [...new Set(payloads.map(({ academicYear }) => academicYear))].sort().join(', '),
    yearsIncluded: years,
    valid: conflicts.length === 0,
    conflicts,
    timetable,
  }
}
