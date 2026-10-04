import type {
  CoreSubject, LabAssignment, OtherSubject, SectionName,
  SectionSubjectAssignment, SpecialActivityAssignment,
  TimetableSetup, WeekDay,
} from './models'
import { generateMechTimetables, validateMechGeneratedTimetables } from './mech-scheduler.ts'
import { generateRaTimetables, validateRaGeneratedTimetables } from './ra-scheduler.ts'
import { generateFtTimetables, validateFtGeneratedTimetables } from './ft-scheduler.ts'

const days: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const periods = Array.from({ length: 8 }, (_, index) => index + 1)
const lunchBoundaryAfter = 4
const searchNodeLimit = 300_000
const labBlockStarts = [2, 6]

function shuffled<T>(values: T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

export interface ScheduledCell {
  itemId: string
  code: string
  abbreviation: string
  name: string
  teacherId: string
  kind: 'core' | 'other' | 'lab' | 'activity'
  /** True only for a configured P1 core test; the test uses normal core workload. */
  isCoreTest?: boolean
}

export interface GeneratedSection {
  sectionId: SectionName
  schedule: Record<WeekDay, Record<number, ScheduledCell>>
}

export interface SectionValidationSummary {
  sectionId: SectionName
  periodsFilled: number
  coreHoursValid: boolean
  otherSubjectHoursValid: boolean
  labAllocationValid: boolean
}

export interface TimetableValidationSummary {
  sections: SectionValidationSummary[]
  globalTeacherClashes: number
}

export type TimetableGenerationResult =
  | { ok: true; sections: GeneratedSection[]; searchNodes: number; validation: TimetableValidationSummary }
  | { ok: false; code: 'INVALID_INPUT' | 'UNSATISFIABLE' | 'SEARCH_LIMIT'; message: string; blockingConstraints: string[] }

interface Item {
  id: string
  sectionId: SectionName
  code: string
  abbreviation: string
  name: string
  teacherId: string
  kind: ScheduledCell['kind']
  count: number
  isCore: boolean
  isLab: boolean
  isPlacement: boolean
}

interface Slot {
  dayIndex: number
  period: number
  index: number
}

export interface SavedTeacherUnavailableSlot {
  teacherId: string
  day: WeekDay
  period: number
  existing?: {
    department: string
    year: string
    semester: string
    section: string
    subject: string
  }
}

export interface GenerationConstraints {
  unavailableTeacherSlots?: SavedTeacherUnavailableSlot[]
}

const slots: Slot[] = days.flatMap((_, dayIndex) => periods.map((period) => ({ dayIndex, period, index: dayIndex * 8 + period - 1 })))

type FailureCode = Extract<TimetableGenerationResult, { ok: false }>['code']

function failure(code: FailureCode, blockingConstraints: string[]): TimetableGenerationResult {
  return { ok: false, code, message: 'Timetable could not be generated with the current constraints.', blockingConstraints }
}

function teacherFor(assignments: SectionSubjectAssignment[], sectionId: SectionName, subjectId: string): string {
  return assignments.find((assignment) => assignment.sectionId === sectionId && assignment.subjectId === subjectId)?.teacherId ?? ''
}

function activityTeacherFor(assignments: SpecialActivityAssignment[], sectionId: SectionName, activityId: string): string {
  return assignments.find((assignment) => assignment.sectionId === sectionId && assignment.activityId === activityId)?.teacherId ?? ''
}

function itemForSubject(item: CoreSubject | OtherSubject, sectionId: SectionName, teacherId: string, kind: 'core' | 'other'): Item {
  return {
    id: `${kind}:${sectionId}:${item.id}`, sectionId, code: item.code, abbreviation: item.abbreviation,
    name: item.name, teacherId, kind, count: item.hoursPerWeek, isCore: kind === 'core', isLab: false, isPlacement: false,
  }
}

function hasTeacherClash(teacherAtSlot: Map<number, Set<string>>, teacherId: string, slotIndex: number): boolean {
  return Boolean(teacherId && teacherAtSlot.get(slotIndex)?.has(teacherId))
}

function isLabRunAllowed(startPeriod: number): boolean {
  return labBlockStarts.includes(startPeriod)
}

function isPlacementRunAllowed(startPeriod: number): boolean {
  const endPeriod = startPeriod + 3
  if (endPeriod > 8) return false
  for (let boundary = startPeriod; boundary < endPeriod; boundary += 1) {
    if (boundary === lunchBoundaryAfter) return false
  }
  return true
}

function validateCseGeneratedTimetables(setup: TimetableSetup, generatedSections: GeneratedSection[]): { summary: TimetableValidationSummary; issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const warnings: string[] = []
  const sectionIds = setup.sections.map((section) => section.id)
  const p1CoreTests = setup.schedulerProfile?.p1CoreTests ?? false
  const actualSectionIds = generatedSections.map((section) => section.sectionId)
  if (actualSectionIds.length !== sectionIds.length || sectionIds.some((sectionId) => !actualSectionIds.includes(sectionId))) {
    issues.push(`The generated section set (${actualSectionIds.join(', ') || 'none'}) does not match the configured sections (${sectionIds.join(', ') || 'none'}).`)
  }
  let globalTeacherClashes = 0
  const sectionSummaries: SectionValidationSummary[] = []
  const globalTeacherSlots = new Map<string, Map<string, Map<SectionName, ScheduledCell>>>()
  const labResourceConflictSections = new Set<SectionName>()
  const labEntriesByDay = new Map<WeekDay, Array<{ sectionId: SectionName; itemId: string; abbreviation: string; periods: number[] }>>()
  const activityEntriesByDay = new Map<WeekDay, Array<{ sectionId: SectionName; itemId: string; activityType: string; abbreviation: string; periods: number[] }>>()
  const labResourceAtSlot = new Map<string, { sectionId: SectionName; resourceId: string; abbreviation: string; teacherId: string }>()

  for (const generated of generatedSections) {
    const firstPeriodItems = new Map<string, WeekDay>()
    for (const day of days) {
      const firstPeriodCell = generated.schedule[day]?.[1]
      const firstPeriodItem = firstPeriodCell?.itemId
      if (p1CoreTests && firstPeriodCell?.kind !== 'core') {
        issues.push(`Section ${generated.sectionId} ${day} P1 must contain a Core / Main subject test.`)
      }
      if (firstPeriodItem) {
        const previousDay = firstPeriodItems.get(firstPeriodItem)
        if (previousDay) issues.push(`Section ${generated.sectionId} P1 repeats ${firstPeriodItem} on ${previousDay} and ${day}; each day's P1 must differ.`)
        else firstPeriodItems.set(firstPeriodItem, day)
      }
      const groupedCells = new Map<string, Array<{ period: number; cell: ScheduledCell }>>()
      for (const period of periods) {
        const cell = generated.schedule[day]?.[period]
        if (cell?.kind === 'lab') {
          const resourceId = cell.itemId.slice(cell.itemId.lastIndexOf(':') + 1)
          const resourceKey = `${day}:P${period}:${resourceId}`
          const previous = labResourceAtSlot.get(resourceKey)
          if (previous && previous.sectionId !== generated.sectionId) {
            const resourceName = setup.labMaster.find((lab) => lab.id === resourceId)?.name ?? resourceId
            const previousTeacher = setup.staff.find((member) => member.id === previous.teacherId)?.name ?? previous.teacherId
            const teacher = setup.staff.find((member) => member.id === cell.teacherId)?.name ?? cell.teacherId
            issues.push(`Section ${generated.sectionId} ${day} P${period} ${cell.abbreviation} (${teacher}) conflicts with Section ${previous.sectionId} ${day} P${period} ${previous.abbreviation} (${previousTeacher}) on lab resource ${resourceName}.`)
            labResourceConflictSections.add(generated.sectionId)
            labResourceConflictSections.add(previous.sectionId)
          } else if (!previous) {
            labResourceAtSlot.set(resourceKey, { sectionId: generated.sectionId, resourceId, abbreviation: cell.abbreviation, teacherId: cell.teacherId })
          }
        }
        if (cell && (cell.kind === 'lab' || cell.kind === 'activity')) {
          const cells = groupedCells.get(cell.itemId) ?? []
          cells.push({ period, cell })
          groupedCells.set(cell.itemId, cells)
        }
      }
      for (const [itemId, cells] of groupedCells) {
        const first = cells[0].cell
        if (first.kind === 'lab') {
          const entries = labEntriesByDay.get(day) ?? []
          entries.push({ sectionId: generated.sectionId, itemId, abbreviation: first.abbreviation, periods: cells.map(({ period }) => period) })
          labEntriesByDay.set(day, entries)
        } else {
          const entries = activityEntriesByDay.get(day) ?? []
          entries.push({
            sectionId: generated.sectionId, itemId,
            activityType: itemId.slice(itemId.lastIndexOf(':') + 1),
            abbreviation: first.abbreviation, periods: cells.map(({ period }) => period),
          })
          activityEntriesByDay.set(day, entries)
        }
      }
    }
    if (p1CoreTests) {
      for (const subject of setup.coreSubjects) {
        const testDays = days.filter((day) => generated.schedule[day]?.[1]?.itemId === `core:${generated.sectionId}:${subject.id}`)
        if (testDays.length !== 1 || !generated.schedule[testDays[0]]?.[1]?.isCoreTest) {
          issues.push(`Section ${generated.sectionId} ${subject.abbreviation} must have exactly one marked P1 Core Test; found ${testDays.length}.`)
        }
      }
    }
  }

  for (const [day, labEntries] of labEntriesByDay) {
    const placements = activityEntriesByDay.get(day)?.filter((entry) => entry.activityType === 'placement') ?? []
    for (const placement of placements) {
      const placementPeriods = placement.periods.map((period) => `P${period}`).join(', ')
      const conflictingLabs = labEntries.map((entry) => `Section ${entry.sectionId} ${entry.abbreviation} ${entry.periods.map((period) => `P${period}`).join(', ')}`).join('; ')
      issues.push(`Section ${placement.sectionId} ${day} ${placementPeriods} violates the global lab/Placement day constraint. Placement conflicts with ${conflictingLabs}.`)
    }
  }

  for (const [day, activityEntries] of activityEntriesByDay) {
    const types = new Set(activityEntries.map((entry) => entry.activityType))
    if (types.size < 2) continue
    const sectionsInConflict = [...new Set(activityEntries.map((entry) => entry.sectionId))].join(', ')
    const conflictingEntries = activityEntries.map((entry) => `Section ${entry.sectionId} ${entry.abbreviation} ${entry.periods.map((period) => `P${period}`).join(', ')}`).join('; ')
    warnings.push(`Sections ${sectionsInConflict} ${day} stacks special-activity types. Entries: ${conflictingEntries}.`)
  }

  const labDaySets = new Map<SectionName, Set<WeekDay>>()
  for (const generated of generatedSections) {
    const sectionLabDays = new Set<WeekDay>()
    for (const day of days) {
      if (periods.some((period) => generated.schedule[day]?.[period]?.kind === 'lab')) sectionLabDays.add(day)
    }
    labDaySets.set(generated.sectionId, sectionLabDays)
  }
  for (let left = 0; left < sectionIds.length; left += 1) {
    for (let right = left + 1; right < sectionIds.length; right += 1) {
      const a = labDaySets.get(sectionIds[left]) ?? new Set<WeekDay>()
      const b = labDaySets.get(sectionIds[right]) ?? new Set<WeekDay>()
      const overlap = [...a].filter((day) => b.has(day))
      if (a.size === b.size && [...a].every((day) => b.has(day))) {
        warnings.push(`Sections ${sectionIds[left]} and ${sectionIds[right]} have identical lab-day patterns (${[...a].join(', ')}).`)
      }
      for (const day of overlap) {
        const aCells = periods.filter((period) => generatedSections.find((section) => section.sectionId === sectionIds[left])?.schedule[day]?.[period]?.kind === 'lab')
        const bCells = periods.filter((period) => generatedSections.find((section) => section.sectionId === sectionIds[right])?.schedule[day]?.[period]?.kind === 'lab')
        const periodOverlap = aCells.filter((period) => bCells.includes(period))
        if (periodOverlap.length) warnings.push(`Sections ${sectionIds[left]} and ${sectionIds[right]} overlap lab periods on ${day}: ${periodOverlap.map((period) => `P${period}`).join(', ')}.`)
      }
    }
  }

  for (const sectionId of sectionIds) {
    const generated = generatedSections.find((section) => section.sectionId === sectionId)
    if (!generated) {
      issues.push(`Section ${sectionId} is missing from the scheduler result.`)
      sectionSummaries.push({ sectionId, periodsFilled: 0, coreHoursValid: false, otherSubjectHoursValid: false, labAllocationValid: false })
      continue
    }

    let periodsFilled = 0
    let coreHoursValid = true
    let otherSubjectHoursValid = true
    let labAllocationValid = !labResourceConflictSections.has(sectionId)
    const counts = new Map<string, number>()

    for (const day of days) {
      for (const period of periods) {
        const cell = generated.schedule[day]?.[period]
        if (!cell || !cell.abbreviation.trim() || !cell.teacherId) {
          issues.push(`Section ${sectionId} ${day} P${period} is an empty or unassigned teaching period.`)
          continue
        }
        periodsFilled += 1
        counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1)
        const timeKey = `${day}:P${period}`
        const teachers = globalTeacherSlots.get(timeKey) ?? new Map<string, Map<SectionName, ScheduledCell>>()
        const teacherSections = teachers.get(cell.teacherId) ?? new Map<SectionName, ScheduledCell>()
        teacherSections.set(sectionId, cell)
        teachers.set(cell.teacherId, teacherSections)
        globalTeacherSlots.set(timeKey, teachers)
      }
    }

    if (periodsFilled !== 48) issues.push(`Section ${sectionId} has ${periodsFilled}/48 assigned teaching periods.`)

    for (const subject of setup.coreSubjects) {
      const id = `core:${sectionId}:${subject.id}`
      if ((counts.get(id) ?? 0) !== subject.hoursPerWeek) {
        coreHoursValid = false
        issues.push(`Section ${sectionId} ${subject.name} has ${counts.get(id) ?? 0}/${subject.hoursPerWeek} periods.`)
      }
      for (const day of days) {
        const assignedPeriods = periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id)
        const dailyMaximum = subject.abbreviation.trim().toUpperCase() === 'TOC' ? 3 : 2
        if (assignedPeriods.length > dailyMaximum) {
          coreHoursValid = false
          issues.push(`Section ${sectionId} ${subject.name} occurs ${assignedPeriods.length} times on ${day}; the daily maximum is ${dailyMaximum}.`)
        }
        let runLength = 0
        let previousPeriod = 0
        for (const period of assignedPeriods) {
          runLength = period === previousPeriod + 1 ? runLength + 1 : 1
          if (runLength > 2) {
            coreHoursValid = false
            issues.push(`Section ${sectionId} ${subject.name} exceeds the 2-period consecutive limit on ${day}.`)
            break
          }
          previousPeriod = period
        }
      }
    }

    for (const subject of setup.otherSubjects.filter((item) => item.code && item.name && item.hoursPerWeek > 0)) {
      const id = `other:${sectionId}:${subject.id}`
      if ((counts.get(id) ?? 0) !== subject.hoursPerWeek) {
        otherSubjectHoursValid = false
        issues.push(`Section ${sectionId} ${subject.name} has ${counts.get(id) ?? 0}/${subject.hoursPerWeek} periods.`)
      }
    }

    const sectionLabDays = new Set<WeekDay>()
    for (const lab of setup.labMaster) {
      const id = `lab:${sectionId}:${lab.id}`
      const labCells = days.flatMap((day) => periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id).map((period) => ({ day, period })))
      const labDays = new Set(labCells.map((cell) => cell.day))
      for (const day of labDays) sectionLabDays.add(day)
      const labPeriods = labCells.map((cell) => cell.period).sort((left, right) => left - right)
      const isOneBlock = labCells.length === lab.weeklyPeriods
        && labDays.size === 1
        && labPeriods.every((period, index) => index === 0 || period === labPeriods[index - 1] + 1)
        && isLabRunAllowed(labPeriods[0])
      if (!isOneBlock) {
        labAllocationValid = false
        issues.push(`Section ${sectionId} ${lab.name} is not exactly one lunch-safe 3-period block.`)
      }
    }

    if (sectionLabDays.size !== 3) {
      labAllocationValid = false
      issues.push(`Section ${sectionId} must schedule its three Labs on exactly three distinct days; found ${sectionLabDays.size}.`)
    }

    const labsPerDay = new Map<WeekDay, number>()
    for (const lab of setup.labMaster) {
      const id = `lab:${sectionId}:${lab.id}`
      for (const day of days) {
        if (periods.some((period) => generated.schedule[day]?.[period]?.itemId === id)) {
          labsPerDay.set(day, (labsPerDay.get(day) ?? 0) + 1)
        }
      }
    }
    for (const [day, count] of labsPerDay) {
      if (count > 1) {
        labAllocationValid = false
        issues.push(`Section ${sectionId} has ${count} labs on ${day}; the maximum is one lab per day.`)
      }
    }

    for (const activity of setup.specialActivities) {
      const id = `activity:${sectionId}:${activity.id}`
      const activityCells = days.flatMap((day) => periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id).map((period) => ({ day, period, teacherId: generated.schedule[day]?.[period]?.teacherId ?? '' })))
      if (activityCells.length !== activity.hoursPerWeek) {
        issues.push(`Section ${sectionId} ${activity.name} has ${activityCells.length}/${activity.hoursPerWeek} periods.`)
      }
      if (activity.id === 'placement') {
        const activityDays = new Set(activityCells.map((cell) => cell.day))
        const activityPeriods = activityCells.map((cell) => cell.period).sort((left, right) => left - right)
        const isOneBlock = activityCells.length === 4
          && activityDays.size === 1
          && activityPeriods.every((period, index) => index === 0 || period === activityPeriods[index - 1] + 1)
          && isPlacementRunAllowed(activityPeriods[0])
        if (!isOneBlock) issues.push(`Section ${sectionId} Placement is not one consecutive 4-period block on a single day without crossing lunch.`)
        const expectedTeacherId = setup.staff.find((member) => member.id === 'ST008')?.id
        if (!expectedTeacherId || activityCells.some((cell) => cell.teacherId !== expectedTeacherId)) {
          issues.push(`Section ${sectionId} Placement is not assigned to Mrs. J. Jayapradha.`)
        }
      }
    }

    sectionSummaries.push({ sectionId, periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid })
  }

  for (const [time, teachers] of globalTeacherSlots) {
    for (const [teacherId, teacherSections] of teachers) {
      if (teacherSections.size < 2) continue
      globalTeacherClashes += 1
      const teacherName = setup.staff.find((member) => member.id === teacherId)?.name ?? teacherId
      const [day, period] = time.split(':')
      const entries = [...teacherSections.entries()]
      for (let index = 1; index < entries.length; index += 1) {
        const [leftSection, leftCell] = entries[0]
        const [rightSection, rightCell] = entries[index]
        issues.push(`Section ${rightSection} ${day} ${period} ${rightCell.name} (${teacherName}) conflicts with Section ${leftSection} ${day} ${period} ${leftCell.name} (${teacherName}).`)
      }
    }
  }

  return { summary: { sections: sectionSummaries, globalTeacherClashes }, issues, warnings }
}

function generateCseTimetablesOnce(setup: TimetableSetup, constraints?: GenerationConstraints): TimetableGenerationResult {
  const inputProblems: string[] = []
  const sectionIds = setup.sections.map((section) => section.id)
  const placementRequired = (setup.schedulerProfile?.placement ?? 'required') === 'required'
  const p1CoreTests = setup.schedulerProfile?.p1CoreTests ?? false
  const sectionItems = new Map<SectionName, Item[]>()
  const labBlocks: Item[] = []
  const placementBlocks: Item[] = []
  const placementTeacher = setup.staff.find((member) => member.id === 'ST008')
  if (placementRequired && (!placementTeacher || placementTeacher.name.trim() !== 'Mrs. J. Jayapradha')) {
    inputProblems.push('Placement requires the fixed Staff Master teacher Mrs. J. Jayapradha.')
  }

  for (const sectionId of sectionIds) {
    const items: Item[] = []
    const coreTeacherIds = new Map<string, string>()
    for (const subject of setup.coreSubjects) {
      const teacherId = teacherFor(setup.sectionSubjectAssignments, sectionId, subject.id)
      if (!teacherId || !setup.staff.some((member) => member.id === teacherId)) {
        inputProblems.push(`Section ${sectionId}: assign a valid Staff Master teacher to ${subject.name}.`)
      }
      const existingSubjectId = coreTeacherIds.get(teacherId)
      if (teacherId && existingSubjectId && existingSubjectId !== subject.id) {
        const existing = setup.coreSubjects.find((candidate) => candidate.id === existingSubjectId)
        inputProblems.push(`Section ${sectionId}: ${setup.staff.find((member) => member.id === teacherId)?.name ?? 'A teacher'} is assigned to two Core / Main subjects (${existing?.name ?? existingSubjectId} and ${subject.name}).`)
      }
      if (teacherId) coreTeacherIds.set(teacherId, subject.id)
      items.push(itemForSubject(subject, sectionId, teacherId, 'core'))
    }

    for (const subject of setup.otherSubjects.filter((candidate) => candidate.code && candidate.name && candidate.hoursPerWeek > 0)) {
      const teacherId = teacherFor(setup.sectionSubjectAssignments, sectionId, subject.id)
      if (!teacherId || !setup.staff.some((member) => member.id === teacherId)) {
        inputProblems.push(`Section ${sectionId}: assign a valid Staff Master teacher to ${subject.name}.`)
      }
      items.push(itemForSubject(subject, sectionId, teacherId, 'other'))
    }

    const labTeacherAssignments = new Map<string, string>()
    for (const lab of setup.labMaster) {
      if (lab.weeklyPeriods !== 3) {
        inputProblems.push(`${lab.name} must be configured for exactly 3 weekly periods.`)
      }
      const teacherId = setup.labAssignments.find((assignment: LabAssignment) => assignment.labId === lab.id && assignment.sectionId === sectionId)?.teacherId ?? ''
      if (!teacherId || !setup.staff.some((member) => member.id === teacherId)) {
        inputProblems.push(`Section ${sectionId}: assign a valid Staff Master teacher to ${lab.name}.`)
      }
      const previouslyAssignedLabId = teacherId ? labTeacherAssignments.get(teacherId) : undefined
      if (previouslyAssignedLabId) {
        const teacherName = setup.staff.find((member) => member.id === teacherId)?.name ?? teacherId
        const existingLab = setup.labMaster.find((candidate) => candidate.id === previouslyAssignedLabId)?.name ?? previouslyAssignedLabId
        inputProblems.push(`Section ${sectionId}: ${teacherName} is already assigned to ${existingLab}. Each teacher may teach only one Lab per section; ${lab.name} was not assigned.`)
      } else if (teacherId) {
        labTeacherAssignments.set(teacherId, lab.id)
      }
      const block: Item = {
        id: `lab:${sectionId}:${lab.id}`, sectionId, code: lab.code, abbreviation: lab.abbreviation,
        name: lab.name, teacherId, kind: 'lab', count: lab.weeklyPeriods, isCore: false, isLab: true, isPlacement: false,
      }
      items.push(block)
      labBlocks.push(block)
    }

    for (const activity of setup.specialActivities) {
      const teacherId = activityTeacherFor(setup.specialActivityAssignments, sectionId, activity.id)
      if (!teacherId || !setup.staff.some((member) => member.id === teacherId)) {
        inputProblems.push(`Section ${sectionId}: assign a valid Staff Master teacher to ${activity.name}${activity.id === 'library-mentoring' ? ' (the class advisor)' : ''}.`)
      }
      const isPlacement = activity.id === 'placement' && placementRequired
      if (isPlacement && activity.hoursPerWeek !== 4) {
        inputProblems.push(`Section ${sectionId}: Placement must require exactly 4 teaching periods per week.`)
      }
      if (isPlacement && placementTeacher && teacherId !== placementTeacher.id) {
        inputProblems.push(`Section ${sectionId}: Placement must be assigned to Mrs. J. Jayapradha.`)
      }
      const activityItem: Item = {
        id: `activity:${sectionId}:${activity.id}`, sectionId, code: '', abbreviation: activity.id === 'placement' ? 'PLACEMENT' : activity.id === 'foss-nptel' ? 'FOSS/NPTEL' : activity.id === 'library-mentoring' || activity.id === 'cse2-library-mentoring' ? 'LIB/MEN' : activity.id === 'spl-lecture-gate' || activity.id === 'cse2-spl-lecture-gate' ? 'SPL LECT/GATE' : activity.id === 'cse2-pet' ? 'PET' : activity.name.trim().toUpperCase(),
        name: activity.name, teacherId, kind: 'activity', count: activity.hoursPerWeek, isCore: false, isLab: false, isPlacement,
      }
      items.push(activityItem)
      if (isPlacement) placementBlocks.push(activityItem)
    }

    const requiredPeriods = items.reduce((total, item) => total + item.count, 0)
    if (requiredPeriods !== 48) inputProblems.push(`Section ${sectionId} has ${requiredPeriods} configured weekly periods; exactly 48 are required to fill its timetable.`)
    sectionItems.set(sectionId, items)
  }

  if (setup.labMaster.length !== 3) inputProblems.push('Exactly three Labs are required to schedule three distinct Lab days per section.')
  if (inputProblems.length) return failure('INVALID_INPUT', [...new Set(inputProblems)])

  const occupied = new Map<SectionName, Array<Item | null>>(sectionIds.map((sectionId) => [sectionId, Array<Item | null>(48).fill(null)]))
  const randomizedSlots = shuffled(slots)
  const randomTieBreakers = new Map<string, number>()
  const randomTie = (key: string) => {
    if (!randomTieBreakers.has(key)) randomTieBreakers.set(key, Math.random())
    return randomTieBreakers.get(key)!
  }
  const teacherAtSlot = new Map<number, Set<string>>()
  // Each LabDefinition is the only resource inventory the project has: one
  // room/resource is therefore available per lab id across sections.
  const labResourceAtSlot = new Map<number, Map<string, Item>>()
  const labDayUsed = new Set<string>()
  const globalLabDayCounts = new Map<number, number>()
  const activityDayTypeCounts = new Map<number, Map<string, number>>()
  const minimumPlacementDays = Math.ceil(placementBlocks.length / 2)
  const maximumGlobalLabDays = days.length - minimumPlacementDays
  const attemptSearchNodeLimit = searchNodeLimit
  let searchNodes = 0
  let exceededLimit = false
  const rejectedCandidates = new Map<string, number>()
  const conflictDetails = new Set<string>()
  const placementBlockerDetails = new Set<string>()
  const savedTeacherAtSlot = new Map<number, Map<string, SavedTeacherUnavailableSlot>>()
  for (const reserved of constraints?.unavailableTeacherSlots ?? []) {
    const dayIndex = days.indexOf(reserved.day)
    if (!reserved.teacherId || dayIndex < 0 || !periods.includes(reserved.period)) continue
    const slotIndex = dayIndex * 8 + reserved.period - 1
    const teachers = savedTeacherAtSlot.get(slotIndex) ?? new Map<string, SavedTeacherUnavailableSlot>()
    teachers.set(reserved.teacherId, reserved)
    savedTeacherAtSlot.set(slotIndex, teachers)
  }
  const noteRejection = (reason: string, detail?: string) => {
    rejectedCandidates.set(reason, (rejectedCandidates.get(reason) ?? 0) + 1)
    if (detail && conflictDetails.size < 24) conflictDetails.add(detail)
    if (detail && reason.toLowerCase().includes('placement') && placementBlockerDetails.size < 12) placementBlockerDetails.add(detail)
  }

  const addTeacher = (item: Item, slotIndex: number) => {
    if (!item.teacherId) return
    const teachers = teacherAtSlot.get(slotIndex) ?? new Set<string>()
    teachers.add(item.teacherId)
    teacherAtSlot.set(slotIndex, teachers)
  }
  const removeTeacher = (item: Item, slotIndex: number) => {
    if (!item.teacherId) return
    const teachers = teacherAtSlot.get(slotIndex)
    teachers?.delete(item.teacherId)
    if (teachers?.size === 0) teacherAtSlot.delete(slotIndex)
  }
  const canPlace = (item: Item, slot: Slot): boolean => {
    if (occupied.get(item.sectionId)![slot.index]) return false
    if (p1CoreTests && slot.period === 1 && !item.isCore) {
      noteRejection('P1 is reserved for Core Tests')
      return false
    }
    if (p1CoreTests && slot.period === 1 && item.isCore && days.some((_, dayIndex) => dayIndex !== slot.dayIndex && occupied.get(item.sectionId)![dayIndex * 8]?.id === item.id)) {
      noteRejection('A Core Test may occur in P1 only once per week')
      return false
    }
    if (slot.period === 1 && days.some((_, dayIndex) => dayIndex !== slot.dayIndex && occupied.get(item.sectionId)![dayIndex * 8]?.id === item.id)) {
      noteRejection('P1 must differ each day')
      return false
    }
    if (hasTeacherClash(teacherAtSlot, item.teacherId, slot.index)) {
      const teacher = setup.staff.find((member) => member.id === item.teacherId)?.name ?? item.teacherId
      noteRejection('Global teacher clash across sections', `Section ${item.sectionId} ${days[slot.dayIndex]} P${slot.period} ${item.name} (${teacher}) conflicts with another section assigned to ${teacher} at the same period.`)
      return false
    }
    const savedAssignment = savedTeacherAtSlot.get(slot.index)?.get(item.teacherId)
    if (savedAssignment) {
      const teacher = setup.staff.find((member) => member.id === item.teacherId)?.name ?? item.teacherId
      const existing = savedAssignment.existing
      const existingDescription = existing
        ? `Existing: ${existing.department} · ${existing.year} · ${existing.semester} · Section ${existing.section} — ${existing.subject}.`
        : 'An already-saved timetable occupies this teacher slot.'
      noteRejection('Saved timetable teacher occupancy', `Teacher ${teacher} is unavailable at ${savedAssignment.day} P${savedAssignment.period}. ${existingDescription} Candidate: Section ${item.sectionId} — ${item.name}.`)
      return false
    }
    if (item.isLab) {
      const resourceId = item.id.slice(item.id.lastIndexOf(':') + 1)
      const previousLab = labResourceAtSlot.get(slot.index)?.get(resourceId)
      if (previousLab && previousLab.sectionId !== item.sectionId) {
        const resource = setup.labMaster.find((lab) => lab.id === resourceId)?.name ?? resourceId
        const previousTeacher = setup.staff.find((member) => member.id === previousLab.teacherId)?.name ?? previousLab.teacherId
        const teacher = setup.staff.find((member) => member.id === item.teacherId)?.name ?? item.teacherId
        noteRejection('Lab resource clash', `Section ${item.sectionId} ${days[slot.dayIndex]} P${slot.period} ${item.name} (${teacher}) conflicts with Section ${previousLab.sectionId} ${days[slot.dayIndex]} P${slot.period} ${previousLab.name} (${previousTeacher}) on lab resource ${resource}.`)
        return false
      }
    }
    const dayStart = slot.dayIndex * 8
    const sameDay = occupied.get(item.sectionId)!.slice(dayStart, dayStart + 8)
    if (item.isCore) {
      const dailyMaximum = item.abbreviation.trim().toUpperCase() === 'TOC' ? 3 : 2
      if (sameDay.filter((assigned) => assigned?.id === item.id).length >= dailyMaximum) {
        noteRejection(`Core subject daily maximum of ${dailyMaximum}`)
        return false
      }
      let streak = 1
      for (let period = slot.period - 1; period >= 1 && sameDay[period - 1]?.id === item.id; period -= 1) streak += 1
      for (let period = slot.period + 1; period <= 8 && sameDay[period - 1]?.id === item.id; period += 1) streak += 1
      if (streak > 2) { noteRejection('Core subject consecutive maximum of 2'); return false }
    } else if (!item.isLab && !item.isPlacement && sameDay.some((assigned) => assigned?.id === item.id)) {
      noteRejection('Non-core subject/activity daily maximum')
      return false
    }
    return true
  }
  const put = (item: Item, slot: Slot) => {
    occupied.get(item.sectionId)![slot.index] = item
    addTeacher(item, slot.index)
    if (item.isLab) {
      const resourceId = item.id.slice(item.id.lastIndexOf(':') + 1)
      const resources = labResourceAtSlot.get(slot.index) ?? new Map<string, Item>()
      resources.set(resourceId, item)
      labResourceAtSlot.set(slot.index, resources)
    }
    if (item.kind === 'activity') {
      const activityType = item.id.slice(item.id.lastIndexOf(':') + 1)
      const counts = activityDayTypeCounts.get(slot.dayIndex) ?? new Map<string, number>()
      counts.set(activityType, (counts.get(activityType) ?? 0) + 1)
      activityDayTypeCounts.set(slot.dayIndex, counts)
    }
  }
  const unput = (item: Item, slot: Slot) => {
    occupied.get(item.sectionId)![slot.index] = null
    removeTeacher(item, slot.index)
    if (item.isLab) {
      const resourceId = item.id.slice(item.id.lastIndexOf(':') + 1)
      const resources = labResourceAtSlot.get(slot.index)
      resources?.delete(resourceId)
      if (resources?.size === 0) labResourceAtSlot.delete(slot.index)
    }
    if (item.kind === 'activity') {
      const activityType = item.id.slice(item.id.lastIndexOf(':') + 1)
      const counts = activityDayTypeCounts.get(slot.dayIndex)
      const remaining = (counts?.get(activityType) ?? 0) - 1
      if (remaining > 0) counts?.set(activityType, remaining)
      else counts?.delete(activityType)
      if (counts?.size === 0) activityDayTypeCounts.delete(slot.dayIndex)
    }
  }
  const currentLabDays = (sectionId: SectionName): Set<number> => new Set(
    [...labDayUsed].filter((key) => key.startsWith(`${sectionId}:`)).map((key) => Number(key.slice(key.indexOf(':') + 1))),
  )
  const hasThreeConsecutiveDays = (daySet: Set<number>): boolean => {
    const ordered = [...daySet].sort((left, right) => left - right)
    return ordered.length === 3 && ordered[1] === ordered[0] + 1 && ordered[2] === ordered[1] + 1
  }
  const labCandidateScore = (item: Item, candidate: { dayIndex: number; startPeriod: number }): number => {
    const dayCount = globalLabDayCounts.get(candidate.dayIndex) ?? 0
    const addsGlobalDay = dayCount === 0
    let score = addsGlobalDay ? -100 : dayCount * 10
    const runPeriods = [candidate.startPeriod, candidate.startPeriod + 1, candidate.startPeriod + 2]
    for (const sectionId of sectionIds) {
      if (sectionId === item.sectionId) continue
      for (const period of runPeriods) {
        if (occupied.get(sectionId)![candidate.dayIndex * 8 + period - 1]?.isLab) score += 20
      }
    }

    const sectionDays = currentLabDays(item.sectionId)
    const nextSectionDays = new Set([...sectionDays, candidate.dayIndex])
    if (setup.labMaster.length > 0 && nextSectionDays.size === setup.labMaster.length) {
      for (const otherSection of sectionIds) {
        if (otherSection === item.sectionId) continue
        const otherDays = currentLabDays(otherSection)
        if (otherDays.size === setup.labMaster.length && [...nextSectionDays].every((day) => otherDays.has(day))) score += 500
      }
      if (hasThreeConsecutiveDays(nextSectionDays)) {
        const anotherConsecutiveSection = sectionIds.some((otherSection) => otherSection !== item.sectionId && hasThreeConsecutiveDays(currentLabDays(otherSection)))
        if (anotherConsecutiveSection) score += 100
      }
    }

    let morningLabs = 0
    let afternoonLabs = 0
    for (const slot of slots) {
      const existing = occupied.get(item.sectionId)![slot.index]
      if (existing?.isLab) {
        if (slot.period <= 4) morningLabs += 1
        else afternoonLabs += 1
      }
    }
    if (candidate.startPeriod <= 2) morningLabs += 3
    else afternoonLabs += 3
    score += Math.abs(morningLabs - afternoonLabs) / 3
    return score
  }

  const blockCandidates = (item: Item): Array<{ dayIndex: number; startPeriod: number }> => {
    const candidates: Array<{ dayIndex: number; startPeriod: number }> = []
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      for (const startPeriod of labBlockStarts) {
        if (!isLabRunAllowed(startPeriod)) continue
        const dayKey = `${item.sectionId}:${dayIndex}`
        if (labDayUsed.has(dayKey)) continue
        const run = [0, 1, 2].map((offset) => slots[dayIndex * 8 + startPeriod + offset - 1])
        if (run.every((slot) => canPlace(item, slot))) candidates.push({ dayIndex, startPeriod })
      }
    }
    return candidates.sort((left, right) => labCandidateScore(item, left) - labCandidateScore(item, right)
      || randomTie(`lab-day:${item.id}:${left.dayIndex}`) - randomTie(`lab-day:${item.id}:${right.dayIndex}`)
      || left.startPeriod - right.startPeriod)
  }

  const placementCandidates = (item: Item): Array<{ dayIndex: number; startPeriod: number }> => {
    const candidates: Array<{ dayIndex: number; startPeriod: number }> = []
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      if ((globalLabDayCounts.get(dayIndex) ?? 0) > 0) {
        const labs = sectionIds.flatMap((sectionId) => periods.flatMap((period) => {
          const assigned = occupied.get(sectionId)![dayIndex * 8 + period - 1]
          if (!assigned?.isLab) return []
          const teacher = setup.staff.find((member) => member.id === assigned.teacherId)?.name ?? assigned.teacherId
          const resource = setup.labMaster.find((lab) => lab.id === assigned.id.slice(assigned.id.lastIndexOf(':') + 1))?.name ?? assigned.id
          return [`Section ${sectionId} ${days[dayIndex]} P${period} ${assigned.name} (${teacher}, resource ${resource})`]
        })).join('; ')
        noteRejection('Global Placement day blocked by lab', `Placement for Section ${item.sectionId} is unavailable on ${days[dayIndex]} because another section has a lab: ${labs}.`)
        continue
      }
      for (let startPeriod = 1; startPeriod <= 5; startPeriod += 1) {
        if (!isPlacementRunAllowed(startPeriod)) continue
        const run = [0, 1, 2, 3].map((offset) => slots[dayIndex * 8 + startPeriod + offset - 1])
        if (run.every((slot) => canPlace(item, slot))) candidates.push({ dayIndex, startPeriod })
      }
    }
    if (!candidates.length) noteRejection('No global Placement block available', `Section ${item.sectionId} Placement has no valid 4-period block on any global lab-free day.`)
    return candidates
  }

  const placeLabs = (): boolean => {
    if (++searchNodes > attemptSearchNodeLimit) { exceededLimit = true; return false }
    const remaining = labBlocks.filter((block) => !occupied.get(block.sectionId)!.some((item) => item?.id === block.id))
    if (!remaining.length) return placePlacementBlocks()
    let selected: Item | undefined
    let candidates: Array<{ dayIndex: number; startPeriod: number }> = []
    for (const block of remaining) {
      const options = blockCandidates(block)
      if (!selected || options.length < candidates.length) { selected = block; candidates = options }
      if (!options.length) return false
    }
    if (!selected) return false
    for (const candidate of candidates) {
      const dayKey = `${selected.sectionId}:${candidate.dayIndex}`
      if (!globalLabDayCounts.has(candidate.dayIndex) && globalLabDayCounts.size >= maximumGlobalLabDays) {
        const placementNames = placementBlocks.map((item) => `Section ${item.sectionId} ${item.name}`).join(', ')
        noteRejection('Insufficient global lab-free days for Placement', `Section ${selected.sectionId} ${days[candidate.dayIndex]} lab day would leave fewer than ${minimumPlacementDays} globally lab-free days for Placement (${placementNames}).`)
        continue
      }
      const run = [0, 1, 2].map((offset) => slots[candidate.dayIndex * 8 + candidate.startPeriod + offset - 1])
      if (!run.every((slot) => canPlace(selected!, slot))) continue
      for (const slot of run) put(selected, slot)
      labDayUsed.add(dayKey)
      globalLabDayCounts.set(candidate.dayIndex, (globalLabDayCounts.get(candidate.dayIndex) ?? 0) + 1)
      if (placeLabs()) return true
      const remainingLabsOnDay = (globalLabDayCounts.get(candidate.dayIndex) ?? 0) - 1
      if (remainingLabsOnDay > 0) globalLabDayCounts.set(candidate.dayIndex, remainingLabsOnDay)
      else globalLabDayCounts.delete(candidate.dayIndex)
      labDayUsed.delete(dayKey)
      for (const slot of run) unput(selected, slot)
      if (exceededLimit) return false
    }
    return false
  }

  const placePlacementBlocks = (): boolean => {
    if (++searchNodes > attemptSearchNodeLimit) { exceededLimit = true; return false }
    const remaining = placementBlocks.filter((block) => !occupied.get(block.sectionId)!.some((item) => item?.id === block.id))
    if (!remaining.length) return placeSpecialActivities()
    let selected: Item | undefined
    let candidates: Array<{ dayIndex: number; startPeriod: number }> = []
    for (const block of remaining) {
      const options = placementCandidates(block)
      if (!selected || options.length < candidates.length) { selected = block; candidates = options }
      if (!options.length) return false
    }
    if (!selected) return false
    for (const candidate of candidates) {
      const run = [0, 1, 2, 3].map((offset) => slots[candidate.dayIndex * 8 + candidate.startPeriod + offset - 1])
      if (!run.every((slot) => canPlace(selected!, slot))) continue
      for (const slot of run) put(selected, slot)
      if (placePlacementBlocks()) return true
      for (const slot of run) unput(selected, slot)
      if (exceededLimit) return false
    }
    return false
  }

  const placeSpecialActivities = (): boolean => {
    if (++searchNodes > attemptSearchNodeLimit) { exceededLimit = true; return false }
    const remaining = sectionIds.flatMap((sectionId) => sectionItems.get(sectionId)!.filter((item) => item.kind === 'activity' && !item.isPlacement && item.count > 0))
    if (!remaining.length) return fillSinglePeriods()

    let selected: Item | undefined
    let candidates: Slot[] = []
    for (const activity of remaining) {
      const options = slots.filter((slot) => !occupied.get(activity.sectionId)![slot.index] && canPlace(activity, slot))
      if (!selected || options.length < candidates.length) { selected = activity; candidates = options }
      if (!options.length) return false
    }
    if (!selected) return false

    const activityType = selected.id.slice(selected.id.lastIndexOf(':') + 1)
    const activityDayPenalty = (slot: Slot) => {
      const typesOnDay = activityDayTypeCounts.get(slot.dayIndex) ?? new Map<string, number>()
      const otherTypePenalty = [...typesOnDay.keys()].some((type) => type !== activityType) ? 100 : 0
      const sameTypeUsedElsewhere = days.some((_, dayIndex) => dayIndex !== slot.dayIndex && (activityDayTypeCounts.get(dayIndex)?.get(activityType) ?? 0) > 0)
      const splitTypePenalty = sameTypeUsedElsewhere && !typesOnDay.has(activityType) ? 15 : 0
      return otherTypePenalty + splitTypePenalty
    }
    candidates.sort((left, right) => activityDayPenalty(left) - activityDayPenalty(right) || randomTie(`activity:${selected!.id}:${left.index}`) - randomTie(`activity:${selected!.id}:${right.index}`))

    for (const slot of candidates) {
      if (!canPlace(selected, slot)) continue
      selected.count -= 1
      put(selected, slot)
      if (placeSpecialActivities()) return true
      unput(selected, slot)
      selected.count += 1
      if (exceededLimit) return false
    }
    return false
  }

  const fillSinglePeriods = (): boolean => {
    if (++searchNodes > attemptSearchNodeLimit) { exceededLimit = true; return false }
    let bestSlot: Slot | undefined
    let bestCandidates: Item[] = []
    for (const sectionId of sectionIds) {
      const sectionSchedule = occupied.get(sectionId)!
      const remainingItems = sectionItems.get(sectionId)!.filter((item) => !item.isLab && !item.isPlacement && item.count > 0)
      for (const slot of randomizedSlots) {
        if (sectionSchedule[slot.index]) continue
        const candidates = remainingItems.filter((item) => item.count > 0 && canPlace(item, slot))
        if (!candidates.length) return false
        if (!bestSlot || candidates.length < bestCandidates.length) {
          bestSlot = slot
          bestCandidates = candidates
        }
      }
    }
    if (!bestSlot) return sectionIds.every((sectionId) => occupied.get(sectionId)!.every(Boolean))

    const candidateCapacity = (item: Item) => {
      let possibleSlots = 0
      const schedule = occupied.get(item.sectionId)!
      for (const slot of randomizedSlots) if (!schedule[slot.index] && canPlace(item, slot)) possibleSlots += 1
      return possibleSlots
    }
    const coreDistributionPenalty = (item: Item) => {
      if (!item.isCore) return 0
      const schedule = occupied.get(item.sectionId)!
      const dayStart = bestSlot!.dayIndex * 8
      const sameSubjectOnDay = schedule.slice(dayStart, dayStart + 8).filter((assigned) => assigned?.id === item.id).length
      const totalCoreOnDay = schedule.slice(dayStart, dayStart + 8).filter((assigned) => assigned?.isCore).length
      // A core subject needs six weekly periods, so use a fresh day whenever
      // possible. Balance the overall core load as a lower-weight preference.
      return sameSubjectOnDay * 1_000 + totalCoreOnDay * 20
    }
    const adjacencyPenalty = (item: Item) => {
      if (!item.isCore) return 0
      const schedule = occupied.get(item.sectionId)!
      const previous = bestSlot!.period > 1 ? schedule[bestSlot!.index - 1] : null
      const next = bestSlot!.period < 8 ? schedule[bestSlot!.index + 1] : null
      return Number(previous?.id === item.id) + Number(next?.id === item.id)
    }
    const specialActivityDayPenalty = (item: Item) => {
      if (item.kind !== 'activity') return 0
      const activityType = item.id.slice(item.id.lastIndexOf(':') + 1)
      const activityTypesOnDay = activityDayTypeCounts.get(bestSlot!.dayIndex) ?? new Map<string, number>()
      const stackedTypePenalty = [...activityTypesOnDay.keys()].some((type) => type !== activityType) ? 100 : 0
      const activityAlreadyOnAnotherDay = days.some((_, dayIndex) => dayIndex !== bestSlot!.dayIndex && (activityDayTypeCounts.get(dayIndex)?.get(activityType) ?? 0) > 0)
      const splitSameTypePenalty = activityAlreadyOnAnotherDay && !activityTypesOnDay.has(activityType) ? 15 : 0
      return stackedTypePenalty + splitSameTypePenalty
    }
    bestCandidates.sort((left, right) => coreDistributionPenalty(left) - coreDistributionPenalty(right) || adjacencyPenalty(left) - adjacencyPenalty(right) || specialActivityDayPenalty(left) - specialActivityDayPenalty(right) || candidateCapacity(left) - candidateCapacity(right) || left.count - right.count || randomTie(`item:${left.id}`) - randomTie(`item:${right.id}`))

    for (const item of bestCandidates) {
      if (item.count <= 0 || !canPlace(item, bestSlot)) continue
      item.count -= 1
      put(item, bestSlot)
      const stillPossible = sectionItems.get(item.sectionId)!.filter((candidate) => !candidate.isLab && !candidate.isPlacement && candidate.count > 0).every((candidate) => randomizedSlots.some((slot) => !occupied.get(candidate.sectionId)![slot.index] && canPlace(candidate, slot)))
      if (stillPossible && fillSinglePeriods()) return true
      unput(item, bestSlot)
      item.count += 1
      if (exceededLimit) return false
    }
    return false
  }

  if (!placeLabs()) {
    const observedBlockers = [...rejectedCandidates.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([reason, count]) => `${reason} was observed in ${count} candidate checks.`)
    return failure(exceededLimit ? 'SEARCH_LIMIT' : 'UNSATISFIABLE', [
      exceededLimit
        ? `Constraint search reached its ${attemptSearchNodeLimit.toLocaleString()}-node limit after ${searchNodes.toLocaleString()} search steps.`
        : `The solver exhausted ${searchNodes.toLocaleString()} search steps without finding a complete timetable.`,
      ...(observedBlockers.length ? observedBlockers : ['No legal lab or Placement block remained under the configured teacher and break constraints.']),
      ...[...placementBlockerDetails].slice(0, 6),
      ...[...conflictDetails].slice(0, 8),
      'No partial timetable was returned.',
    ])
  }

  // Lab windows are reserved before assigning other items; once the single
  // fill pass succeeds, do not swap or reorder any non-Lab periods.
  const generatedSections: GeneratedSection[] = sectionIds.map((sectionId) => {
    const schedule = Object.fromEntries(days.map((day) => [day, {}])) as GeneratedSection['schedule']
    for (const slot of slots) {
      const item = occupied.get(sectionId)![slot.index]!
      schedule[days[slot.dayIndex]][slot.period] = {
        itemId: item.id, code: item.code, abbreviation: item.abbreviation,
        name: item.name, teacherId: item.teacherId, kind: item.kind,
        ...(p1CoreTests && slot.period === 1 && item.isCore ? { isCoreTest: true } : {}),
      }
    }
    return { sectionId, schedule }
  })
  if (generatedSections.length !== sectionIds.length) {
    return failure('UNSATISFIABLE', [`The solver returned ${generatedSections.length} sections; exactly ${sectionIds.join(', ')} are required.`, 'No partial timetable was returned.'])
  }
  const { summary, issues } = validateGeneratedTimetables(setup, generatedSections)
  if (issues.length) return failure('UNSATISFIABLE', [...issues, 'No partial timetable was returned.'])
  return { ok: true, sections: generatedSections, searchNodes, validation: summary }
}

function generateCseTimetables(setup: TimetableSetup, constraints?: GenerationConstraints): TimetableGenerationResult {
  // The 4-section CSE-II profile has a larger shared-teacher search space.
  // Retry fresh randomized runs there only; the existing CSE-III one-run
  // behavior remains unchanged.
  const maxAttempts = setup.schedulerProfile?.p1CoreTests ? 5 : 1
  let lastResult: TimetableGenerationResult | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    lastResult = generateCseTimetablesOnce(setup, constraints)
    if (lastResult.ok || lastResult.code === 'INVALID_INPUT') return lastResult
  }
  return lastResult ?? failure('UNSATISFIABLE', ['The scheduler did not complete a search attempt.', 'No partial timetable was returned.'])
}

export function validateGeneratedTimetables(setup: TimetableSetup, generatedSections: GeneratedSection[]): { summary: TimetableValidationSummary; issues: string[]; warnings: string[] } {
  if (setup.academic.department === 'FT') return validateFtGeneratedTimetables(setup, generatedSections)
  if (setup.academic.department === 'MECH') return validateMechGeneratedTimetables(setup, generatedSections)
  if (setup.academic.department === 'RA') return validateRaGeneratedTimetables(setup, generatedSections)
  return validateCseGeneratedTimetables(setup, generatedSections)
}

export function generateTimetables(setup: TimetableSetup, constraints?: GenerationConstraints): TimetableGenerationResult {
  if (setup.academic.department === 'FT') return generateFtTimetables(setup)
  if (setup.academic.department === 'MECH') return generateMechTimetables(setup)
  if (setup.academic.department === 'RA') return generateRaTimetables(setup)
  // Saved cross-year occupancy is an opt-in constraint for the CSE-II
  // profile only. Existing CSE-III and other scheduler implementations retain
  // their established generation behavior.
  return generateCseTimetables(setup, setup.academic.department === 'CSE' && setup.schedulerProfile?.p1CoreTests ? constraints : undefined)
}
