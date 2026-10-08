import type { SectionName, StaffMember } from './models'
import type { GenericGeneratedSection, GenericScheduledCell, GenericWeekDay } from './generic-scheduling-model.ts'
import type { CollegeWeekday } from './college-timings.ts'
import type { WeekDay } from './models'

export const teacherTimetableDays: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const teacherTimetablePeriods = Array.from({ length: 8 }, (_, index) => index + 1)
export const teacherTimetableColumns = [
  { kind: 'period' as const, period: 1 },
  { kind: 'period' as const, period: 2 },
  { kind: 'break' as const, label: 'Morning Break', time: '10:30 AM – 10:45 AM' },
  { kind: 'period' as const, period: 3 },
  { kind: 'period' as const, period: 4 },
  { kind: 'break' as const, label: 'Lunch', time: '12:25 PM – 1:10 PM' },
  { kind: 'period' as const, period: 5 },
  { kind: 'period' as const, period: 6 },
  { kind: 'break' as const, label: 'Tea Break', time: '2:50 PM – 3:00 PM' },
  { kind: 'period' as const, period: 7 },
  { kind: 'period' as const, period: 8 },
] as const

export interface TeacherTimetableEntry {
  sectionId: SectionName
  cell: GenericScheduledCell
  alternateWeek?: boolean
}

export type TeacherTimetable = Partial<Record<CollegeWeekday, Record<number, TeacherTimetableEntry[]>>>

export interface TeacherTimetableTeacher {
  id: string
  name: string
}

export interface TeacherTimetableClash {
  teacherId: string
  day: CollegeWeekday
  period: number
  entries: TeacherTimetableEntry[]
}

/** Return only stable teacher identities represented by occupied timetable cells. */
export function getTeachersUsedInTimetable(
  generatedSections: GenericGeneratedSection[],
  staff: StaffMember[],
): TeacherTimetableTeacher[] {
  const usedTeacherNames = new Map<string, string>()
  for (const section of generatedSections) {
    for (const dayCells of Object.values(section.schedule)) {
      for (const cell of Object.values(dayCells ?? {})) {
        if (cell?.teacherId) usedTeacherNames.set(cell.teacherId, usedTeacherNames.get(cell.teacherId) ?? '')
        const alternate = cell?.alternateSubject
        if (alternate?.teacherId) {
          usedTeacherNames.set(alternate.teacherId, usedTeacherNames.get(alternate.teacherId) || alternate.teacherNameSnapshot || '')
        }
      }
    }
  }

  const staffById = new Map<string, StaffMember>()
  for (const person of staff) {
    if (person.id && !staffById.has(person.id)) staffById.set(person.id, person)
  }

  const teachers = [...usedTeacherNames].map(([id, snapshotName]) => ({
    id,
    name: staffById.get(id)?.name || snapshotName || id,
  }))
  const teachersById = new Map(teachers.map((teacher) => [teacher.id, teacher]))
  const orderedTeacherIds = new Set<string>()
  return [
    ...staff.flatMap((person) => {
      const teacher = teachersById.get(person.id)
      if (!teacher || orderedTeacherIds.has(person.id)) return []
      orderedTeacherIds.add(person.id)
      return [teacher]
    }),
    ...teachers.filter((person) => !orderedTeacherIds.has(person.id)),
  ]
}

/** Safety check for a staff member assigned to multiple generated sections at once. */
export function findTeacherTimetableClashes(generatedSections: GenericGeneratedSection[]): TeacherTimetableClash[] {
  const assignments = new Map<string, TeacherTimetableClash>()
  for (const section of generatedSections) {
    for (const [dayValue, dayCells] of Object.entries(section.schedule)) {
      const day = dayValue as CollegeWeekday
      for (const [periodValue, cell] of Object.entries(dayCells ?? {})) {
        if (!cell?.teacherId) continue
        const period = Number(periodValue)
        const key = `${cell.teacherId}\u0000${day}\u0000${period}`
        const clash = assignments.get(key) ?? { teacherId: cell.teacherId, day, period, entries: [] }
        clash.entries.push({ sectionId: section.sectionId, cell })
        assignments.set(key, clash)
      }
    }
  }
  return [...assignments.values()].filter(({ entries }) => entries.length > 1)
}

/** Build a read-only view from generated cells, preserving only actual teacher assignments. */
export function buildTeacherTimetable(
  generatedSections: GenericGeneratedSection[],
  teacherId: string,
  days: readonly GenericWeekDay[] = teacherTimetableDays,
  periods: readonly number[] = teacherTimetablePeriods,
): TeacherTimetable {
  const timetable = Object.fromEntries(days.map((day) => [
    day,
    Object.fromEntries(periods.map((period) => [period, [] as TeacherTimetableEntry[]])),
  ])) as TeacherTimetable

  for (const section of generatedSections) {
    for (const [dayValue, dayCells] of Object.entries(section.schedule)) {
      const day = dayValue as CollegeWeekday
      if (!timetable[day]) continue
      for (const [periodValue, cell] of Object.entries(dayCells ?? {})) {
        const period = Number(periodValue)
        if (!timetable[day]?.[period]) continue
        if (cell?.teacherId === teacherId) timetable[day]![period]!.push({ sectionId: section.sectionId, cell })
        const alternate = cell?.alternateSubject
        if (alternate?.teacherId === teacherId) {
          timetable[day]![period]!.push({
            sectionId: section.sectionId,
            alternateWeek: true,
            cell: {
              ...cell,
              itemId: alternate.subjectId,
              code: alternate.code,
              abbreviation: alternate.abbreviation,
              name: alternate.name,
              teacherId: alternate.teacherId,
              kind: alternate.subjectKind,
            },
          })
        }
      }
    }
  }

  return timetable
}
