import type {
  GenericActivity, GenericLab, GenericOtherSubject, GenericScheduleConfig, GenericSchedulerInput,
  GenericSection, GenericSubject, GenericWeekDay, GenericGeneratedSection, GenericScheduledCell,
  GenericTimetableGenerationResult, GenericTimetableValidationSummary, GenericScheduleGroupInput,
  GenericUnavailableTeacherSlot,
  GenericSchedulingRules,
  GenericPlacementExceptionConfig,
  GenericPlacementAlternateSubject,
} from './generic-scheduling-model.ts'
import { genericPeriodsPerDay, genericStudentSlotsPerWeek, genericTimetableDays } from './generic-scheduling-model.ts'

type ItemKind = GenericScheduledCell['kind']

interface WorkItem {
  id: string
  sourceId: string
  sectionId: string
  code: string
  abbreviation: string
  name: string
  teacherId: string
  labResourceId: string
  rules: GenericSchedulingRules
  kind: ItemKind
  weeklyPeriods: number
  blockDuration: number
  blockDurations: number[]
  allowedStartPeriods?: number[]
  isCore: boolean
  isLab: boolean
  isPlacement: boolean
  placementException?: GenericPlacementExceptionConfig
  schedulesAsBlocks: boolean
  remaining: number
}

interface BlockTask {
  id: string
  item: WorkItem
  duration: number
  isTest: boolean
  markAsTest?: boolean
  validateBlock?: boolean
}

interface BlockCandidate {
  dayIndex: number
  startPeriod: number
}

interface GenericCell extends GenericScheduledCell {
  isCoreTest?: boolean
}

interface SectionState {
  section: GenericSection
  profileKey: string
  profile: GenericScheduleConfig
  cells: Array<GenericCell | null>
}

interface NormalizedSection {
  key: string
  profileKey: string
  profile: GenericScheduleConfig
  section: GenericSection
}

interface NormalizedProfile {
  profileKey: string
  profile: GenericScheduleConfig
  sections: NormalizedSection[]
  itemsBySection: Map<string, WorkItem[]>
  testTasks: BlockTask[]
  issues: string[]
}

const periods = Array.from({ length: genericPeriodsPerDay }, (_, index) => index + 1)
const defaultSearchNodeLimit = 1_000_000
const maximumSearchNodeLimit = 1_000_000
const maximumCandidateCount = 20
const searchRecoveryCandidateCount = 3
const searchRecoveryFullCandidateCount = 6

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function failure(blockingConstraints: string[], code: 'INVALID_INPUT' | 'UNSATISFIABLE' | 'SEARCH_LIMIT' = 'INVALID_INPUT'): GenericTimetableGenerationResult {
  return { ok: false, code, message: 'The timetable could not be generated from the supplied generic schedule configuration.', blockingConstraints }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function standardLabBlockDurations(weeklyPeriods: number, blockDuration: number): number[] {
  const blocks = Array.from({ length: Math.floor(weeklyPeriods / blockDuration) }, () => blockDuration)
  const remainder = weeklyPeriods % blockDuration
  return remainder ? [...blocks, remainder] : blocks
}

function placementBlockDurations(weeklyPeriods: number, blockDuration: number): number[] {
  const blocks = Array.from({ length: Math.floor(weeklyPeriods / blockDuration) }, () => blockDuration)
  const remainder = weeklyPeriods % blockDuration
  return remainder ? [...blocks, remainder] : blocks
}

function validStartsForBlock(opts: { isLab?: boolean; isPlacement?: boolean; isNormalActivity?: boolean; allowedStartPeriods?: number[] }, duration: number, rules: GenericSchedulingRules): number[] {
  let starts = periods.filter((start) => start + duration - 1 <= genericPeriodsPerDay)
  if (opts.isLab) {
    starts = duration === 4 ? [1, 5] : [2, 3, 4, 6, 7, 8]
      .filter((start) => start + duration - 1 <= genericPeriodsPerDay && !crossesLunch(start, duration))
  } else if (opts.isPlacement) {
    starts = starts.filter((start) => Math.floor((start - 1) / 4) === Math.floor((start + duration - 2) / 4))
  } else if (opts.isNormalActivity) {
    starts = starts.filter((start) => start !== 1
      && (duration === 1 || rules.blocksAvoidLunch === false || !crossesLunch(start, duration)))
  } else if (duration > 1 && rules.blocksAvoidLunch !== false) {
    starts = starts.filter((start) => !crossesLunch(start, duration))
  }
  if (opts.allowedStartPeriods) starts = starts.filter((start) => opts.allowedStartPeriods!.includes(start))
  return starts
}

function normalizeRows<T extends { id: string; name: string; code?: string; abbreviation?: string; blockDuration?: number; allowedStartPeriods?: number[]; teacherAssignments: Array<{ sectionId: string; teacherId: string }> }>(
  rows: T[] | undefined,
  kind: ItemKind,
  periodCount: (row: T) => number,
  blockDuration: (row: T) => number,
  input: GenericScheduleConfig,
  itemsBySection: Map<string, WorkItem[]>,
  sectionKeys: Map<string, string>,
  profileKey: string,
  usedIds: Set<string>,
  issues: string[],
  opts: { isCore?: boolean; isLab?: boolean; isPlacement?: boolean; isNormalActivity?: boolean; enabled?: (row: T) => boolean; placementException?: GenericPlacementExceptionConfig } = {},
): void {
  for (const row of rows ?? []) {
    if (!row.id.trim() || usedIds.has(row.id)) {
      issues.push(`Work-item ID “${row.id}” is empty or duplicated.`)
      continue
    }
    usedIds.add(row.id)
    if (opts.enabled && !opts.enabled(row)) continue
    const count = periodCount(row)
    const duration = opts.isPlacement
      ? row.blockDuration ?? count
      : opts.isLab
        ? row.blockDuration ?? Math.min(count, 4)
        : blockDuration(row)
    if (!row.name.trim()) issues.push(`${kind} ${row.id} needs a name.`)
    if (!Number.isInteger(count) || count <= 0) issues.push(`${row.name || row.id} needs a positive whole-number weekly period count.`)
    if (!isPositiveInteger(duration)) issues.push(`${row.name || row.id} needs a positive whole-number block duration.`)
    if ((opts.isLab || opts.isPlacement) && duration > 4) issues.push(`${row.name || row.id}: the current generic timetable framework supports a maximum 4-period continuous ${opts.isLab ? 'lab' : 'Placement'} block.`)
    if (row.allowedStartPeriods?.some((start) => !Number.isInteger(start) || start < 1 || start > genericPeriodsPerDay)) {
      issues.push(`${row.name || row.id} has an invalid allowed block start period.`)
    }
    if (!Number.isInteger(count) || count <= 0 || !isPositiveInteger(duration) || ((opts.isLab || opts.isPlacement) && duration > 4)) continue
    if (!opts.isLab && !opts.isPlacement && count % duration !== 0) {
      issues.push(`${row.name || row.id} has ${count} weekly periods, which is not divisible by its ${duration}-period block duration.`)
      continue
    }
    const blockDurations = opts.isLab
      ? standardLabBlockDurations(count, duration)
      : opts.isPlacement
        ? placementBlockDurations(count, duration)
        : Array.from({ length: count / duration }, () => duration)
    for (const blockLength of blockDurations) {
      if (!validStartsForBlock({ isLab: opts.isLab, isPlacement: opts.isPlacement, isNormalActivity: opts.isNormalActivity, allowedStartPeriods: row.allowedStartPeriods }, blockLength, input.rules ?? {}).length) {
        issues.push(`${row.name || row.id} has no valid start for its ${blockLength}-period block within the teaching day.`)
      }
    }

    const assignments = Array.isArray(row.teacherAssignments) ? row.teacherAssignments : []
    const assignmentsBySection = new Map<string, string>()
    for (const assignment of assignments) {
      if (!input.sections.some((section) => section.id === assignment.sectionId)) {
        issues.push(`${row.name || row.id} has a teacher assignment for unknown Section ${assignment.sectionId}.`)
      }
      if (assignmentsBySection.has(assignment.sectionId)) {
        issues.push(`${row.name || row.id} has more than one teacher assignment for Section ${assignment.sectionId}.`)
      } else assignmentsBySection.set(assignment.sectionId, assignment.teacherId)
      if (!input.staff.some((teacher) => teacher.id === assignment.teacherId)) {
        issues.push(`${row.name || row.id} is assigned to unknown staff ID ${assignment.teacherId || '(blank)'}.`)
      }
    }

    for (const section of input.sections) {
      const teacherId = assignmentsBySection.get(section.id) ?? ''
      if (!teacherId || !input.staff.some((teacher) => teacher.id === teacherId)) {
        issues.push(`Section ${section.id}: assign a valid Staff Member to ${row.name || row.id}.`)
        continue
      }
      const sectionKey = sectionKeys.get(section.id)!
      itemsBySection.get(sectionKey)!.push({
        id: `${kind}:${sectionKey}:${row.id}`,
        sourceId: row.id,
        sectionId: sectionKey,
        code: row.code ?? '',
        abbreviation: row.abbreviation?.trim() || row.code?.trim() || row.name,
        name: row.name,
        teacherId,
        labResourceId: `${profileKey}:${row.id}`,
        rules: input.rules ?? {},
        kind,
        weeklyPeriods: count,
        blockDuration: duration,
        blockDurations,
        ...(row.allowedStartPeriods ? { allowedStartPeriods: [...row.allowedStartPeriods] } : {}),
        isCore: Boolean(opts.isCore),
        isLab: Boolean(opts.isLab),
        isPlacement: Boolean(opts.isPlacement),
        ...(opts.isPlacement && opts.placementException?.enabled ? { placementException: opts.placementException } : {}),
        schedulesAsBlocks: Boolean(opts.isLab || opts.isPlacement || duration > 1),
        remaining: count,
      })
    }
  }
}

function validateProfile(input: GenericScheduleConfig, profileKey: string, qualifySectionKeys: boolean): NormalizedProfile {
  const issues: string[] = []
  if (!input.department.trim()) issues.push('Department is required.')
  if (!input.academicYear.trim()) issues.push('Academic Year is required.')
  if (!input.year.trim()) issues.push('Year is required.')
  if (!input.semester.trim()) issues.push('Semester is required.')
  if (!input.sections.length) issues.push('At least one section is required.')
  if (new Set(input.sections.map((section) => section.id)).size !== input.sections.length || input.sections.some((section) => !section.id.trim())) {
    issues.push('Section IDs must be non-empty and unique.')
  }
  if (new Set(input.staff.map((staff) => staff.id)).size !== input.staff.length || input.staff.some((staff) => !staff.id.trim())) {
    issues.push('Staff IDs must be non-empty and unique.')
  }
  for (const activity of input.specialActivities ?? []) {
    if (typeof activity.enabled !== 'boolean') issues.push(`${activity.name || activity.id} needs an explicit enabled/disabled value.`)
  }
  validatePlacementException(input, issues)
  for (const section of input.sections) {
    if (section.classAdvisorId && !input.staff.some((staff) => staff.id === section.classAdvisorId)) {
      issues.push(`Section ${section.id} has an unknown Class Advisor staff ID.`)
    }
  }

  const ruleValues: Array<[string, number | undefined]> = [
    ['Core daily maximum', input.rules?.coreDailyMaximum],
    ['Core consecutive maximum', input.rules?.coreConsecutiveMaximum],
    ['Subject consecutive maximum', input.rules?.subjectConsecutiveMaximum],
    ['Item daily maximum', input.rules?.itemDailyMaximum],
    ['Labs per day maximum', input.rules?.labsPerDayMaximum],
    ['Search node limit', input.rules?.searchNodeLimit],
    ['Candidate count', input.candidateCount],
  ]
  for (const [label, value] of ruleValues) {
    if (value !== undefined && !isPositiveInteger(value)) issues.push(`${label} must be a positive whole number.`)
  }
  if (input.rules?.searchNodeLimit !== undefined && input.rules.searchNodeLimit > maximumSearchNodeLimit) {
    issues.push(`Search node limit cannot exceed ${maximumSearchNodeLimit.toLocaleString()}.`)
  }
  if (input.candidateCount !== undefined && input.candidateCount > maximumCandidateCount) {
    issues.push(`Candidate count cannot exceed ${maximumCandidateCount}.`)
  }
  if (input.randomSeed !== undefined && !Number.isSafeInteger(input.randomSeed)) {
    issues.push('Random seed must be a safe whole number.')
  }

  const sectionKeys = new Map(input.sections.map((section) => [section.id, qualifySectionKeys ? `${profileKey}::${section.id}` : section.id]))
  const sections: NormalizedSection[] = input.sections.map((section) => ({
    key: sectionKeys.get(section.id)!, profileKey, profile: input, section,
  }))
  const itemsBySection = new Map(sections.map(({ key }) => [key, [] as WorkItem[]]))
  const usedIds = new Set<string>()
  normalizeRows<GenericSubject>(input.subjects, 'core', (row) => row.weeklyHours, (row) => row.blockDuration ?? 1, input, itemsBySection, sectionKeys, profileKey, usedIds, issues, { isCore: true })
  normalizeRows<GenericOtherSubject>(input.otherSubjects, 'other', (row) => row.weeklyHours, (row) => row.blockDuration ?? 1, input, itemsBySection, sectionKeys, profileKey, usedIds, issues, { enabled: (row) => row.enabled !== false })
  normalizeRows<GenericLab>(input.labs, 'lab', (row) => row.weeklyPeriods, (row) => Math.min(row.weeklyPeriods, 4), input, itemsBySection, sectionKeys, profileKey, usedIds, issues, { isLab: true, enabled: (row) => row.enabled !== false })
  normalizeRows<GenericActivity>(input.specialActivities, 'activity', (row) => row.weeklyPeriods, (row) => row.blockDuration ?? 1, input, itemsBySection, sectionKeys, profileKey, usedIds, issues, { isNormalActivity: true, enabled: (row) => row.enabled })

  if (input.placement) {
    if (typeof input.placement.enabled !== 'boolean') issues.push('Placement needs an explicit enabled/disabled value.')
    if (input.placement.enabled) {
      normalizeRows([input.placement], 'activity', (row) => row.weeklyPeriods, (row) => row.weeklyPeriods, input, itemsBySection, sectionKeys, profileKey, usedIds, issues, { isPlacement: true, placementException: input.placementException })
    }
  }

  for (const section of input.sections) {
    const weeklyTotal = itemsBySection.get(sectionKeys.get(section.id)!)!.reduce((total, item) => total + item.weeklyPeriods, 0)
    if (weeklyTotal !== genericStudentSlotsPerWeek) {
      const difference = Math.abs(genericStudentSlotsPerWeek - weeklyTotal)
      issues.push(weeklyTotal < genericStudentSlotsPerWeek
        ? `Configured workload is ${weeklyTotal} periods for ${input.department} Section ${section.id}, but timetable capacity is fixed at ${genericStudentSlotsPerWeek} periods. ${difference} periods remain unconfigured. Please complete the workload to exactly ${genericStudentSlotsPerWeek} periods.`
        : `Configured workload is ${weeklyTotal} periods for ${input.department} Section ${section.id}, but timetable capacity is fixed at ${genericStudentSlotsPerWeek} periods. Please reduce the configured workload by ${difference} periods.`)
    }
    const activityBlocks = itemsBySection.get(sectionKeys.get(section.id)!)!
      .filter((item) => isNormalActivity(item))
      .reduce((total, item) => total + item.blockDurations.length, 0)
    if (activityBlocks > genericTimetableDays.length) {
      issues.push(`Section ${section.id} has ${activityBlocks} normal Special Activity blocks, but the maximum is ${genericTimetableDays.length} because only one can be scheduled per day.`)
    }
  }

  const testTasks: BlockTask[] = []
  const p1Tests = input.rules?.p1Tests
  if (p1Tests?.enabled) {
    const selectedIds = p1Tests.subjectIds ?? input.subjects.map((subject) => subject.id)
    const testsPerSubject = p1Tests.testsPerSubject ?? 1
    if (!selectedIds.length) issues.push('P1 tests are enabled but no eligible Core subjects are selected.')
    if (!isPositiveInteger(testsPerSubject)) issues.push('P1 tests per subject must be a positive whole number.')
    if (new Set(selectedIds).size !== selectedIds.length) issues.push('P1 test subject IDs must not be duplicated.')
    for (const subjectId of selectedIds) {
      const subject = input.subjects.find((candidate) => candidate.id === subjectId)
      if (!subject) {
        issues.push(`P1 tests refer to unknown subject ID ${subjectId}.`)
        continue
      }
      if (!isPositiveInteger(testsPerSubject) || subject.weeklyHours < testsPerSubject) {
        issues.push(`${subject.name} does not have enough weekly hours for its configured P1 tests.`)
        continue
      }
      for (const section of input.sections) {
        const item = itemsBySection.get(sectionKeys.get(section.id)!)!.find((candidate) => candidate.sourceId === subjectId && candidate.isCore)
        if (!item) continue
        for (let index = 0; index < testsPerSubject; index += 1) {
          testTasks.push({ id: `p1-test:${profileKey}:${section.id}:${subjectId}:${index}`, item, duration: 1, isTest: true, markAsTest: p1Tests.markAsTest !== false })
        }
      }
    }
    if (testTasks.length / Math.max(1, input.sections.length) > genericTimetableDays.length) {
      issues.push('P1 test assignments exceed the number of teaching days.')
    }
    if (p1Tests.reserveEveryP1ForTest && testTasks.length !== genericTimetableDays.length * input.sections.length) {
      issues.push('Reserving every P1 for a test requires exactly one configured test on each teaching day in every section.')
    }
    if (testTasks.length === 0 && selectedIds.length > 0) {
      issues.push('P1 tests are enabled but no eligible Core subjects could be assigned to any section.')
    }
  } else if (p1Tests?.reserveEveryP1ForTest) {
    issues.push('Every P1 cannot be reserved for tests when P1 test scheduling is disabled.')
  }

  for (const items of itemsBySection.values()) {
    for (const item of items) {
      const testsForItem = testTasks.filter((task) => task.item === item).length
      const periodsLeft = item.weeklyPeriods - testsForItem
      if (periodsLeft < 0 || (item.schedulesAsBlocks && !item.isLab && !item.isPlacement && periodsLeft % item.blockDuration !== 0)) {
        issues.push(`${item.name} cannot fit its non-test ${periodsLeft} periods into ${item.blockDuration}-period blocks.`)
      }
    }
  }
  return { profileKey, profile: input, sections, itemsBySection, testTasks, issues: [...new Set(issues)] }
}

function validatePlacementException(input: GenericScheduleConfig, issues: string[]): void {
  const exception = input.placementException
  if (!exception?.enabled) return
  const placement = input.placement
  if (!placement?.enabled) {
    issues.push('Placement Exception requires an enabled Placement activity.')
    return
  }
  const duration = placement.blockDuration ?? 4
  if (!Number.isInteger(duration) || duration < 1 || duration > 4) {
    issues.push('Placement Exception requires a valid Placement block duration from 1 to 4 periods.')
    return
  }
  const alternates = Array.isArray(exception.alternateSubjects) ? exception.alternateSubjects : []
  if (exception.allocationMode !== 'random' && alternates.every((alternate) => !alternate.sectionId) && alternates.length !== duration) {
    issues.push(`Placement Exception needs exactly ${duration} alternate subject entr${duration === 1 ? 'y' : 'ies'}, one for each Placement block position.`)
  }
  if (exception.allocationMode === 'random') {
    const subjects = [
      ...input.subjects.map((subject) => ({ subject, kind: 'core' as const })),
      ...(input.otherSubjects ?? []).filter((subject) => subject.enabled !== false).map((subject) => ({ subject, kind: 'other' as const })),
    ]
    for (const section of input.sections) {
      const hasEligibleSubject = subjects.some(({ subject }) => subject.teacherAssignments.some((assignment) =>
        assignment.sectionId === section.id && input.staff.some((staff) => staff.id === assignment.teacherId)))
      if (!hasEligibleSubject) {
        issues.push(`Section ${section.id} has no configured academic subject with an assigned teacher for random Placement allocation.`)
      }
    }
    return
  }
  const seenSectionPositions = new Set<string>()
  for (const alternate of alternates) {
    if (!Number.isInteger(alternate.placementPosition) || alternate.placementPosition < 1 || alternate.placementPosition > duration) {
      issues.push(`Placement Exception has an invalid Placement position ${alternate.placementPosition}.`)
    }
    const scopedSections = alternate.sectionId
      ? input.sections.filter((section) => section.id === alternate.sectionId)
      : input.sections
    if (alternate.sectionId && scopedSections.length === 0) {
      issues.push(`Placement position ${alternate.placementPosition} has an alternate subject for unknown Section ${alternate.sectionId}.`)
    }
    for (const section of scopedSections) {
      const sectionPosition = `${section.id}:${alternate.placementPosition}`
      if (seenSectionPositions.has(sectionPosition)) {
        issues.push(alternate.sectionId
          ? `Placement Exception repeats alternate subject position ${alternate.placementPosition} for Section ${section.id}.`
          : `Placement Exception repeats Placement position ${alternate.placementPosition}.`)
      }
      seenSectionPositions.add(sectionPosition)
    }
    const subject = alternate.subjectKind === 'core'
      ? input.subjects.find((candidate) => candidate.id === alternate.subjectId)
      : alternate.subjectKind === 'other'
        ? input.otherSubjects?.find((candidate) => candidate.id === alternate.subjectId && candidate.enabled !== false)
        : undefined
    if (!subject) {
      issues.push(`Placement position ${alternate.placementPosition} must select an existing configured Core / Main or enabled Other Subject.`)
    }
    if (!alternate.subjectNameSnapshot?.trim()) {
      issues.push(`Placement position ${alternate.placementPosition} needs an alternate subject name snapshot.`)
    }
    const assignments = Array.isArray(alternate.teacherAssignments) ? alternate.teacherAssignments : []
    const seenSections = new Set<string>()
    for (const assignment of assignments) {
      if (!input.sections.some((section) => section.id === assignment.sectionId)) {
        issues.push(`Placement position ${alternate.placementPosition} has an alternate teacher assignment for unknown Section ${assignment.sectionId}.`)
      }
      if (seenSections.has(assignment.sectionId)) {
        issues.push(`Placement position ${alternate.placementPosition} has more than one alternate teacher assignment for Section ${assignment.sectionId}.`)
      }
      seenSections.add(assignment.sectionId)
      if (!input.staff.some((staff) => staff.id === assignment.teacherId)) {
        issues.push(`Placement position ${alternate.placementPosition} needs a valid alternate teacher for Section ${assignment.sectionId}.`)
      }
      if (!assignment.teacherNameSnapshot?.trim()) {
        issues.push(`Placement position ${alternate.placementPosition} needs an alternate teacher name snapshot for Section ${assignment.sectionId}.`)
      }
    }
    for (const section of scopedSections) {
      if (!seenSections.has(section.id)) {
        issues.push(`Placement position ${alternate.placementPosition} needs an alternate teacher assignment for Section ${section.id}.`)
      }
    }
  }
  for (const section of input.sections) {
    for (let position = 1; position <= duration; position += 1) {
      if (!seenSectionPositions.has(`${section.id}:${position}`)) {
        issues.push(`Placement Exception is missing alternate subject position ${position} for Section ${section.id}.`)
      }
    }
  }
}

function slotIndex(dayIndex: number, period: number): number {
  return dayIndex * genericPeriodsPerDay + period - 1
}

function crossesLunch(startPeriod: number, duration: number): boolean {
  const endPeriod = startPeriod + duration - 1
  return startPeriod <= 4 && endPeriod >= 5
}

function isNormalActivity(item: Pick<WorkItem, 'kind' | 'isPlacement'>): boolean {
  return item.kind === 'activity' && !item.isPlacement
}

function arrangementSignature(cells: Array<GenericCell | null>): string {
  return cells.map((cell) => cell
    ? `${cell.kind}\u001f${cell.code}\u001f${cell.abbreviation}\u001f${cell.name}\u001f${cell.isCoreTest ? 'TEST' : ''}\u001f${cell.alternateSubject ? [cell.alternateSubject.subjectKind, cell.alternateSubject.subjectId, cell.alternateSubject.teacherId, cell.alternateSubject.code, cell.alternateSubject.abbreviation, cell.alternateSubject.name].join('\u001f') : ''}`
    : 'FREE').join('\u001e')
}

function sectionArrangementSignature(section: GenericGeneratedSection): string {
  return arrangementSignature(genericTimetableDays.flatMap((day) => periods.map((period) => section.schedule[day]?.[period] ?? null)))
}

function reservedTeacherSlots(sections: GenericGeneratedSection[], alternateWeek = false): Map<number, Set<string>> {
  const occupied = new Map<number, Set<string>>()
  for (const section of sections) {
    for (const [dayIndex, day] of genericTimetableDays.entries()) {
      for (const period of periods) {
        const cell = section.schedule[day]?.[period]
        const teacherId = alternateWeek ? cell?.alternateSubject?.teacherId ?? cell?.teacherId : cell?.teacherId
        if (teacherId) {
          const slot = slotIndex(dayIndex, period)
          const teachers = occupied.get(slot) ?? new Set<string>()
          teachers.add(teacherId)
          occupied.set(slot, teachers)
        }
      }
    }
  }
  return occupied
}

function unavailableTeacherSlotMap(slots: GenericUnavailableTeacherSlot[]): Map<number, Set<string>> {
  const occupied = new Map<number, Set<string>>()
  for (const unavailable of slots) {
    const dayIndex = genericTimetableDays.indexOf(unavailable.day)
    if (dayIndex < 0 || !unavailable.teacherId) continue
    const slot = slotIndex(dayIndex, unavailable.period)
    const teachers = occupied.get(slot) ?? new Set<string>()
    teachers.add(unavailable.teacherId)
    occupied.set(slot, teachers)
  }
  return occupied
}

function validateUnavailableTeacherSlots(slots: GenericUnavailableTeacherSlot[], label: string, issues: string[]): void {
  for (const [index, unavailable] of slots.entries()) {
    if (!unavailable || typeof unavailable.teacherId !== 'string' || !unavailable.teacherId.trim()) {
      issues.push(`${label} entry ${index + 1} has no teacher ID.`)
      continue
    }
    if (!genericTimetableDays.includes(unavailable.day)) issues.push(`${label} entry ${index + 1} has an unsupported day.`)
    if (!Number.isInteger(unavailable.period) || unavailable.period < 1 || unavailable.period > genericPeriodsPerDay) {
      issues.push(`${label} entry ${index + 1} has an invalid period.`)
    }
  }
}

function buildSchedule(
  profiles: NormalizedProfile[],
  itemsBySection: Map<string, WorkItem[]>,
  testTasks: BlockTask[],
  reservedSections: GenericGeneratedSection[] = [],
  unavailableTeacherSlots: GenericUnavailableTeacherSlot[] = [],
  alternateWeekUnavailableTeacherSlots: GenericUnavailableTeacherSlot[] = [],
  random: () => number = Math.random,
  requestedSearchLimit?: number,
): GenericTimetableGenerationResult {
  const normalizedSections = profiles.flatMap((profile) => profile.sections)
  for (const items of itemsBySection.values()) {
    for (const item of items) item.remaining = item.weeklyPeriods
  }
  const states = new Map<string, SectionState>(normalizedSections.map(({ key, section, profileKey, profile }) => [key, {
    section, profileKey, profile,
    cells: Array<GenericCell | null>(genericStudentSlotsPerWeek).fill(null),
  }]))
  const fixedTeacherAtSlot = reservedTeacherSlots(reservedSections)
  for (const [slot, unavailableTeachers] of unavailableTeacherSlotMap(unavailableTeacherSlots)) {
    const teachers = fixedTeacherAtSlot.get(slot) ?? new Set<string>()
    for (const teacher of unavailableTeachers) teachers.add(teacher)
    fixedTeacherAtSlot.set(slot, teachers)
  }
  const fixedAlternateTeacherAtSlot = reservedTeacherSlots(reservedSections, true)
  for (const [slot, unavailableTeachers] of unavailableTeacherSlotMap(alternateWeekUnavailableTeacherSlots)) {
    const teachers = fixedAlternateTeacherAtSlot.get(slot) ?? new Set<string>()
    for (const teacher of unavailableTeachers) teachers.add(teacher)
    fixedAlternateTeacherAtSlot.set(slot, teachers)
  }
  const teacherAtSlot = new Map<number, Set<string>>()
  const alternateTeacherAtSlot = new Map<number, Set<string>>()
  const placementAlternateClashes = new Set<string>()
  const describeOccupiedTeacher = (teacherId: string, index: number): string | undefined => {
    const dayIndex = Math.floor(index / genericPeriodsPerDay)
    const day = genericTimetableDays[dayIndex]
    const period = index % genericPeriodsPerDay + 1
    for (const section of reservedSections) {
      const cell = section.schedule[day]?.[period]
      if (cell && (cell.alternateSubject?.teacherId ?? cell.teacherId) === teacherId) {
        return `${section.department} · ${section.year} · ${section.semester} · Section ${section.sectionId} — ${cell.alternateSubject?.name ?? cell.name}`
      }
    }
    for (const state of states.values()) {
      if (state.cells[index] && (state.cells[index]!.alternateSubject?.teacherId ?? state.cells[index]!.teacherId) === teacherId) {
        const cell = state.cells[index]!
        return `${state.profile.department} · ${state.profile.year} · ${state.profile.semester} · Section ${state.section.id} — ${cell.alternateSubject?.name ?? cell.name}`
      }
    }
    const saved = alternateWeekUnavailableTeacherSlots.find((entry) => entry.teacherId === teacherId && entry.day === day && entry.period === period)
    if (saved?.existing) {
      return `saved timetable ${saved.existing.department} · ${saved.existing.year} · Section ${saved.existing.section} — ${saved.existing.subject}`
    }
    return saved ? 'a saved timetable' : undefined
  }
  const labResourceAtSlot = Array.from({ length: genericStudentSlotsPerWeek }, () => new Map<string, string>())
  const labBlocksPerDay = new Map<string, number>()
  const labBlocksPerDefinitionDay = new Map<string, number>()
  const placementPeriodsPerDay = new Map<string, number>()
  const specialActivityAtDay = new Map<string, string>()
  const tasks: BlockTask[] = [...testTasks]
  const testTaskCounts = new Map<WorkItem, number>()
  for (const task of testTasks) testTaskCounts.set(task.item, (testTaskCounts.get(task.item) ?? 0) + 1)
  for (const sectionItems of itemsBySection.values()) {
    for (const item of sectionItems) {
      const periodsLeft = item.weeklyPeriods - (testTaskCounts.get(item) ?? 0)
      if (item.schedulesAsBlocks) {
        const blockDurations = item.isLab || item.isPlacement
          ? item.blockDurations
          : Array.from({ length: periodsLeft / item.blockDuration }, () => item.blockDuration)
        blockDurations.forEach((duration, block) => {
          tasks.push({ id: `block:${item.id}:${block}`, item, duration, isTest: false, validateBlock: true })
        })
      }
    }
  }

  let searchNodes = 0
  let exceededLimit = false
  const searchDeadEnds = new Map<string, number>()
  const configuredSearchLimit = Math.min(...profiles.map(({ profile }) => profile.rules?.searchNodeLimit ?? defaultSearchNodeLimit))
  const searchLimit = Math.min(configuredSearchLimit, requestedSearchLimit ?? configuredSearchLimit)

  const getDayCells = (item: WorkItem, dayIndex: number) => states.get(item.sectionId)!.cells.slice(dayIndex * 8, dayIndex * 8 + 8)
  const countItemOnDay = (item: WorkItem, dayIndex: number) => {
    const cells = states.get(item.sectionId)!.cells
    const dayStart = dayIndex * 8
    let count = 0
    for (let index = dayStart; index < dayStart + 8; index += 1) {
      if (cells[index]?.itemId === item.id) count += 1
    }
    return count
  }
  const sectionDayKey = (item: WorkItem, dayIndex: number) => `${item.sectionId}:${dayIndex}`
  const isNormalActivity = (item: WorkItem) => item.kind === 'activity' && !item.isPlacement

  const alternateDefinition = (item: WorkItem, placementPosition: number): GenericPlacementAlternateSubject | undefined => {
    const alternates = item.placementException?.alternateSubjects ?? []
    const sectionId = inputSectionId(item.sectionId)
    return alternates.find((alternate) => alternate.placementPosition === placementPosition && alternate.sectionId === sectionId)
      ?? alternates.find((alternate) => alternate.placementPosition === placementPosition && !alternate.sectionId)
  }
  const alternateAssignment = (definition: GenericPlacementAlternateSubject, sectionId: string) =>
    definition.teacherAssignments.find((assignment) => assignment.sectionId === sectionId)
  const inputSectionId = (sectionKey: string) => states.get(sectionKey)?.section.id ?? sectionKey
  const alternateWorkItem = (item: WorkItem, placementPosition: number): WorkItem | undefined => {
    const definition = alternateDefinition(item, placementPosition)
    return definition
      ? itemsBySection.get(item.sectionId)?.find((candidate) => candidate.sourceId === definition.subjectId && candidate.kind === definition.subjectKind)
      : undefined
  }
  const alternateScheduledSubject = (item: WorkItem, placementPosition: number) => {
    const definition = alternateDefinition(item, placementPosition)
    const profile = states.get(item.sectionId)?.profile
    const subject = definition && (definition.subjectKind === 'core'
      ? profile?.subjects.find((candidate) => candidate.id === definition.subjectId)
      : profile?.otherSubjects?.find((candidate) => candidate.id === definition.subjectId && candidate.enabled !== false))
    const assignment = definition && alternateAssignment(definition, inputSectionId(item.sectionId))
    if (!definition || !subject || !assignment) return undefined
    return {
      placementPosition,
      subjectId: definition.subjectId,
      subjectKind: definition.subjectKind,
      code: subject.code ?? '',
      abbreviation: subject.abbreviation?.trim() || subject.code?.trim() || definition.subjectNameSnapshot,
      name: definition.subjectNameSnapshot,
      teacherId: assignment.teacherId,
      teacherNameSnapshot: assignment.teacherNameSnapshot,
    }
  }
  const hasFixedTeacherConflict = (item: WorkItem, candidate: BlockCandidate, duration: number): boolean => {
    for (let offset = 0; offset < duration; offset += 1) {
      const index = slotIndex(candidate.dayIndex, candidate.startPeriod + offset)
      if (fixedTeacherAtSlot.get(index)?.has(item.teacherId)) return true
      const alternateTeacherId = item.isPlacement && item.placementException
        ? alternateAssignment(alternateDefinition(item, offset + 1)!, inputSectionId(item.sectionId))?.teacherId
        : item.teacherId
      if (!alternateTeacherId) return true
      if (fixedAlternateTeacherAtSlot.get(index)?.has(alternateTeacherId)) {
        const occupiedBy = describeOccupiedTeacher(alternateTeacherId, index)
        if (occupiedBy) {
          const day = genericTimetableDays[candidate.dayIndex]
          const period = candidate.startPeriod + offset
          if (item.isPlacement && item.placementException) {
            const alternate = alternateDefinition(item, offset + 1)!
            const teacherName = alternateAssignment(alternate, inputSectionId(item.sectionId))?.teacherNameSnapshot
              ?? alternateTeacherId
            const state = states.get(item.sectionId)!
            placementAlternateClashes.add(`${state.profile.department} · ${state.profile.year} · ${state.profile.semester} · Section ${state.section.id} alternate subject ${alternate.subjectNameSnapshot} assigned to ${teacherName} (${alternateTeacherId}) conflicts at ${day} P${period} with ${occupiedBy}.`)
          } else {
            const teacherName = states.get(item.sectionId)?.profile.staff.find((staff) => staff.id === item.teacherId)?.name
              ?? item.teacherId
            const state = states.get(item.sectionId)!
            placementAlternateClashes.add(`${state.profile.department} · ${state.profile.year} · ${state.profile.semester} · Section ${state.section.id} ${item.name} assigned to ${teacherName} (${item.teacherId}) conflicts at ${day} P${period} with ${occupiedBy}.`)
          }
        }
        return true
      }
    }
    return false
  }
  const projectedAlternateItem = (sectionId: string, cell: GenericCell | null | undefined): WorkItem | undefined => {
    if (!cell) return undefined
    if (!cell.alternateSubject) return itemsBySection.get(sectionId)?.find((candidate) => candidate.id === cell.itemId)
    return itemsBySection.get(sectionId)?.find((candidate) => candidate.sourceId === cell.alternateSubject!.subjectId
      && candidate.kind === cell.alternateSubject!.subjectKind)
  }
  const placementAlternateRulesAllow = (item: WorkItem, candidate: BlockCandidate, duration: number): boolean => {
    if (!item.placementException) return true
    const dayStart = candidate.dayIndex * genericPeriodsPerDay
    const dayCells = states.get(item.sectionId)!.cells.slice(dayStart, dayStart + genericPeriodsPerDay)
    const proposedByPeriod = new Map<number, WorkItem>()
    for (let placementPosition = 1; placementPosition <= duration; placementPosition += 1) {
      const alternate = alternateWorkItem(item, placementPosition)
      if (!alternate) return false
      const period = candidate.startPeriod + placementPosition - 1
      if (period === 1) {
        if (alternate.isCore && item.rules.allowCoreSubjectsInP1 === false) return false
        if (alternate.kind === 'other' && item.rules.allowOtherSubjectsInP1 === false) return false
        if (item.rules.p1Tests?.reserveEveryP1ForTest) return false
      }
      proposedByPeriod.set(period, alternate)
    }
    const projected = dayCells.map((cell, index) => proposedByPeriod.get(index + 1) ?? projectedAlternateItem(item.sectionId, cell))
    for (const alternate of new Set(proposedByPeriod.values())) {
      const count = projected.filter((projectedItem) => projectedItem?.id === alternate.id).length
      if (alternate.isCore && alternate.rules.coreDailyMaximum !== undefined && count > alternate.rules.coreDailyMaximum) return false
      if (alternate.rules.itemDailyMaximum !== undefined && count > alternate.rules.itemDailyMaximum) return false
      const configuredLimit = alternate.isCore
        ? alternate.rules.coreConsecutiveMaximum ?? alternate.rules.subjectConsecutiveMaximum ?? 2
        : alternate.rules.subjectConsecutiveMaximum ?? 2
      const consecutiveLimit = Math.max(Math.min(configuredLimit, 2), alternate.blockDuration)
      let run = 0
      for (const projectedItem of projected) {
        run = projectedItem?.id === alternate.id ? run + 1 : 0
        if (run > consecutiveLimit) return false
      }
    }
    return true
  }
  const regularSubjectAlternateRulesAllow = (item: WorkItem, candidate: BlockCandidate, duration: number): boolean => {
    if (item.kind !== 'core' && item.kind !== 'other') return true
    if (!states.get(item.sectionId)?.profile.placementException?.enabled) return true
    const dayStart = candidate.dayIndex * genericPeriodsPerDay
    const dayCells = states.get(item.sectionId)!.cells.slice(dayStart, dayStart + genericPeriodsPerDay)
    const proposedPeriods = new Set(Array.from({ length: duration }, (_, index) => candidate.startPeriod + index))
    const projected = dayCells.map((cell, index) => proposedPeriods.has(index + 1) ? item : projectedAlternateItem(item.sectionId, cell))
    const count = projected.filter((projectedItem) => projectedItem?.id === item.id).length
    if (item.isCore && item.rules.coreDailyMaximum !== undefined && count > item.rules.coreDailyMaximum) return false
    if (item.rules.itemDailyMaximum !== undefined && count > item.rules.itemDailyMaximum) return false
    const configuredLimit = item.isCore
      ? item.rules.coreConsecutiveMaximum ?? item.rules.subjectConsecutiveMaximum ?? 2
      : item.rules.subjectConsecutiveMaximum ?? 2
    const consecutiveLimit = Math.max(Math.min(configuredLimit, 2), item.blockDuration)
    let run = 0
    for (const projectedItem of projected) {
      run = projectedItem?.id === item.id ? run + 1 : 0
      if (run > consecutiveLimit) return false
    }
    return true
  }

  const canPlace = (task: BlockTask, candidate: BlockCandidate): boolean => {
    const { item, duration } = task
    const { dayIndex, startPeriod } = candidate
    const endPeriod = startPeriod + duration - 1
    if (startPeriod < 1 || endPeriod > genericPeriodsPerDay) return false
    if (task.isTest && startPeriod !== 1) return false
    if (!task.isTest && isNormalActivity(item) && startPeriod === 1) return false
    if (!task.isTest && item.isCore && item.rules.allowCoreSubjectsInP1 === false && startPeriod === 1) return false
    if (!task.isTest && item.kind === 'other' && item.rules.allowOtherSubjectsInP1 === false && startPeriod === 1) return false
    if (!task.isTest && item.rules.p1Tests?.enabled && item.rules.p1Tests.reserveEveryP1ForTest && startPeriod === 1) return false
    if (item.isPlacement && !placementAlternateRulesAllow(item, candidate, duration)) return false
    if (item.allowedStartPeriods && !item.allowedStartPeriods.includes(startPeriod)) return false
    if (duration > 1
      && (item.isLab || item.isPlacement || item.rules.blocksAvoidLunch !== false)
      && crossesLunch(startPeriod, duration)) return false

    const sectionState = states.get(item.sectionId)!
    const dayKey = sectionDayKey(item, dayIndex)
    if (item.isPlacement && (labBlocksPerDay.get(dayKey) ?? 0) > 0) return false
    if (item.isLab && (placementPeriodsPerDay.get(dayKey) ?? 0) > 0) return false
    if (isNormalActivity(item) && specialActivityAtDay.has(dayKey)) return false
    if (isNormalActivity(item) && item.rules.allowConsecutiveSpecialActivityDays === false
      && ((dayIndex > 0 && specialActivityAtDay.has(`${item.sectionId}:${dayIndex - 1}`))
        || (dayIndex + 1 < genericTimetableDays.length && specialActivityAtDay.has(`${item.sectionId}:${dayIndex + 1}`)))) return false
    if (item.isPlacement && (placementPeriodsPerDay.get(dayKey) ?? 0) + duration >= 4
      && specialActivityAtDay.has(dayKey)) return false
    if (isNormalActivity(item) && (placementPeriodsPerDay.get(dayKey) ?? 0) >= 4) return false
    for (let period = startPeriod; period <= endPeriod; period += 1) {
      const index = slotIndex(dayIndex, period)
      if (sectionState.cells[index]) return false
      if (teacherAtSlot.get(index)?.has(item.teacherId)) return false
      if (item.isPlacement && item.placementException) {
        const alternate = alternateDefinition(item, period - startPeriod + 1)!
        const alternateTeacherId = alternateAssignment(alternate, inputSectionId(item.sectionId))?.teacherId
        if (!alternateTeacherId) return false
        if (alternateTeacherAtSlot.get(index)?.has(alternateTeacherId)) {
          const section = sectionState.section
          const teacherName = alternateAssignment(alternate, inputSectionId(item.sectionId))?.teacherNameSnapshot ?? alternateTeacherId
          const occupiedBy = describeOccupiedTeacher(alternateTeacherId, index) ?? 'another occupied timetable slot'
          placementAlternateClashes.add(`${sectionState.profile.department} · ${sectionState.profile.year} · ${sectionState.profile.semester} · Section ${section.id} alternate subject ${alternate.subjectNameSnapshot} assigned to ${teacherName} (${alternateTeacherId}) conflicts at ${genericTimetableDays[dayIndex]} P${period} with ${occupiedBy}.`)
          return false
        }
      } else if (alternateTeacherAtSlot.get(index)?.has(item.teacherId)) {
        const occupiedBy = describeOccupiedTeacher(item.teacherId, index)
        if (occupiedBy) {
          const teacherName = states.get(item.sectionId)?.profile.staff.find((staff) => staff.id === item.teacherId)?.name ?? item.teacherId
          placementAlternateClashes.add(`${sectionState.profile.department} · ${sectionState.profile.year} · ${sectionState.profile.semester} · Section ${sectionState.section.id} ${item.name} assigned to ${teacherName} (${item.teacherId}) conflicts at ${genericTimetableDays[dayIndex]} P${period} with ${occupiedBy}.`)
        }
        return false
      }
      if (item.isLab && item.rules.preventConcurrentUseOfSameLab !== false) {
        const previousSection = labResourceAtSlot[index].get(item.labResourceId)
        if (previousSection && previousSection !== item.sectionId) return false
      }
    }

    if (item.isCore && item.rules.coreDailyMaximum !== undefined
      && countItemOnDay(item, dayIndex) + duration > item.rules.coreDailyMaximum) return false
    if (item.rules.itemDailyMaximum !== undefined
      && countItemOnDay(item, dayIndex) + duration > item.rules.itemDailyMaximum) return false

    if (item.kind === 'core' || item.kind === 'other') {
      const configuredLimit = item.isCore
        ? item.rules.coreConsecutiveMaximum ?? item.rules.subjectConsecutiveMaximum ?? 2
        : item.rules.subjectConsecutiveMaximum ?? 2
      const consecutiveLimit = Math.max(Math.min(configuredLimit, 2), item.blockDuration)
      const cells = sectionState.cells
      const dayStart = dayIndex * genericPeriodsPerDay
      const proposedStart = dayStart + startPeriod - 1
      const proposedEnd = dayStart + endPeriod - 1
      let run = 0
      for (let index = dayStart; index < dayStart + genericPeriodsPerDay; index += 1) {
        const isItem = index >= proposedStart && index <= proposedEnd
          || cells[index]?.itemId === item.id
        run = isItem ? run + 1 : 0
        if (run > consecutiveLimit) return false
      }
      if (!regularSubjectAlternateRulesAllow(item, candidate, duration)) return false
    }

    if (item.isLab) {
      const labDayCount = labBlocksPerDay.get(dayKey) ?? 0
      if (labDayCount > 0) return false
      if (item.rules.labsPerDayMaximum !== undefined && labDayCount + 1 > item.rules.labsPerDayMaximum) return false
      if ((labBlocksPerDefinitionDay.get(`${item.sectionId}:${item.sourceId}:${dayIndex}`) ?? 0) > 0) return false
    }
    return true
  }

  const put = (task: BlockTask, candidate: BlockCandidate): void => {
    const { item, duration, isTest } = task
    for (let period = candidate.startPeriod; period < candidate.startPeriod + duration; period += 1) {
      const index = slotIndex(candidate.dayIndex, period)
      states.get(item.sectionId)!.cells[index] = {
        itemId: item.id,
        ...(task.validateBlock ? { blockId: task.id } : {}),
        code: item.code,
        abbreviation: item.abbreviation,
        name: item.name,
        teacherId: item.teacherId,
        kind: item.kind,
        ...(item.isPlacement && item.placementException ? { alternateSubject: alternateScheduledSubject(item, period - candidate.startPeriod + 1) } : {}),
        ...(isTest ? { isCoreTest: true } : {}),
      }
      const teachers = teacherAtSlot.get(index) ?? new Set<string>()
      teachers.add(item.teacherId)
      teacherAtSlot.set(index, teachers)
      const alternateTeacherId = item.isPlacement
        ? alternateScheduledSubject(item, period - candidate.startPeriod + 1)?.teacherId ?? item.teacherId
        : item.teacherId
      const alternateTeachers = alternateTeacherAtSlot.get(index) ?? new Set<string>()
      alternateTeachers.add(alternateTeacherId)
      alternateTeacherAtSlot.set(index, alternateTeachers)
      if (item.isLab && item.rules.preventConcurrentUseOfSameLab !== false) labResourceAtSlot[index].set(item.labResourceId, item.sectionId)
    }
    item.remaining -= duration
    if (item.isLab) {
      const dayKey = sectionDayKey(item, candidate.dayIndex)
      const definitionDayKey = `${item.sectionId}:${item.sourceId}:${candidate.dayIndex}`
      labBlocksPerDay.set(dayKey, (labBlocksPerDay.get(dayKey) ?? 0) + 1)
      labBlocksPerDefinitionDay.set(definitionDayKey, (labBlocksPerDefinitionDay.get(definitionDayKey) ?? 0) + 1)
    }
    if (item.isPlacement) {
      const dayKey = sectionDayKey(item, candidate.dayIndex)
      placementPeriodsPerDay.set(dayKey, (placementPeriodsPerDay.get(dayKey) ?? 0) + duration)
    }
    if (isNormalActivity(item)) specialActivityAtDay.set(sectionDayKey(item, candidate.dayIndex), task.id)
  }

  const remove = (task: BlockTask, candidate: BlockCandidate): void => {
    const { item, duration } = task
    for (let period = candidate.startPeriod; period < candidate.startPeriod + duration; period += 1) {
      const index = slotIndex(candidate.dayIndex, period)
      states.get(item.sectionId)!.cells[index] = null
      const teachers = teacherAtSlot.get(index)
      teachers?.delete(item.teacherId)
      if (teachers?.size === 0) teacherAtSlot.delete(index)
      const alternateTeacherId = item.isPlacement
        ? alternateScheduledSubject(item, period - candidate.startPeriod + 1)?.teacherId ?? item.teacherId
        : item.teacherId
      const alternateTeachers = alternateTeacherAtSlot.get(index)
      alternateTeachers?.delete(alternateTeacherId)
      if (alternateTeachers?.size === 0) alternateTeacherAtSlot.delete(index)
      if (item.isLab && item.rules.preventConcurrentUseOfSameLab !== false) labResourceAtSlot[index].delete(item.labResourceId)
    }
    item.remaining += duration
    if (item.isLab) {
      const dayKey = sectionDayKey(item, candidate.dayIndex)
      const definitionDayKey = `${item.sectionId}:${item.sourceId}:${candidate.dayIndex}`
      const count = (labBlocksPerDay.get(dayKey) ?? 1) - 1
      if (count) labBlocksPerDay.set(dayKey, count)
      else labBlocksPerDay.delete(dayKey)
      const definitionDayCount = (labBlocksPerDefinitionDay.get(definitionDayKey) ?? 1) - 1
      if (definitionDayCount) labBlocksPerDefinitionDay.set(definitionDayKey, definitionDayCount)
      else labBlocksPerDefinitionDay.delete(definitionDayKey)
    }
    if (item.isPlacement) {
      const dayKey = sectionDayKey(item, candidate.dayIndex)
      const periodsLeft = (placementPeriodsPerDay.get(dayKey) ?? duration) - duration
      if (periodsLeft) placementPeriodsPerDay.set(dayKey, periodsLeft)
      else placementPeriodsPerDay.delete(dayKey)
    }
    if (isNormalActivity(item)) specialActivityAtDay.delete(sectionDayKey(item, candidate.dayIndex))
  }

  const equivalentTaskGroups = new Map<string, BlockTask[]>()
  const previousEquivalentTasks = new Map<string, BlockTask[]>()
  const taskCandidates = new Map<string, BlockCandidate[]>()
  for (const task of tasks) {
    const key = JSON.stringify([task.item.id, task.duration, task.isTest])
    const group = equivalentTaskGroups.get(key) ?? []
    previousEquivalentTasks.set(task.id, [...group])
    group.push(task)
    equivalentTaskGroups.set(key, group)
    const candidates = task.isTest
      ? genericTimetableDays.map((_, dayIndex) => ({ dayIndex, startPeriod: 1 }))
      : genericTimetableDays.flatMap((_, dayIndex) =>
        validStartsForBlock(
        { ...task.item, isNormalActivity: isNormalActivity(task.item) },
        task.duration,
        task.item.rules,
        ).map((startPeriod) => ({ dayIndex, startPeriod })))
    taskCandidates.set(task.id, candidates.filter((candidate) =>
      !hasFixedTeacherConflict(task.item, candidate, task.duration)))
  }
  const singleCandidatesByItem = new Map<WorkItem, BlockCandidate[]>()
  for (const items of itemsBySection.values()) {
    for (const item of items) {
      if (item.schedulesAsBlocks || item.blockDuration !== 1) continue
      const candidates = genericTimetableDays.flatMap((_, dayIndex) =>
        periods.map((startPeriod) => ({ dayIndex, startPeriod })))
      singleCandidatesByItem.set(item, candidates.filter((candidate) =>
        !hasFixedTeacherConflict(item, candidate, 1)))
    }
  }
  const legalSingleCandidates = (): Map<WorkItem, BlockCandidate[]> | undefined => {
    const result = new Map<WorkItem, BlockCandidate[]>()
    const requiredByTeacher = new Map<string, number>()
    const availableSlotsByTeacher = new Map<string, Set<number>>()
    for (const section of normalizedSections) {
      for (const item of itemsBySection.get(section.key) ?? []) {
        if (item.schedulesAsBlocks || item.blockDuration !== 1 || item.remaining <= 0) continue
        const task = { id: `single:${item.id}`, item, duration: 1, isTest: false }
        const candidates = singleCandidatesByItem.get(item)!.filter((candidate) => canPlace(task, candidate))
        if (candidates.length < item.remaining) {
          const reason = `${item.name}: only ${candidates.length} legal period(s) remain for ${item.remaining} required period(s).`
          searchDeadEnds.set(reason, (searchDeadEnds.get(reason) ?? 0) + 1)
          return undefined
        }
        result.set(item, candidates)
        requiredByTeacher.set(item.teacherId, (requiredByTeacher.get(item.teacherId) ?? 0) + item.remaining)
        const availableSlots = availableSlotsByTeacher.get(item.teacherId) ?? new Set<number>()
        for (const candidate of candidates) {
          availableSlots.add(slotIndex(candidate.dayIndex, candidate.startPeriod))
        }
        availableSlotsByTeacher.set(item.teacherId, availableSlots)
      }
    }
    for (const [teacherId, requiredPeriods] of requiredByTeacher) {
      const availablePeriods = availableSlotsByTeacher.get(teacherId)?.size ?? 0
      if (availablePeriods < requiredPeriods) {
        const reason = `Teacher ${teacherId}: only ${availablePeriods} globally available period(s) remain for ${requiredPeriods} required period(s).`
        searchDeadEnds.set(reason, (searchDeadEnds.get(reason) ?? 0) + 1)
        return undefined
      }
    }
    return result
  }
  const singleCandidatesHaveCapacity = () => legalSingleCandidates() !== undefined
  const assignedCandidates = new Map<string, BlockCandidate>()
  const candidatesFor = (task: BlockTask): BlockCandidate[] => {
    const previousPositions = previousEquivalentTasks.get(task.id)!
      .map((previous) => assignedCandidates.get(previous.id))
      .filter((candidate): candidate is BlockCandidate => candidate !== undefined)
      .map((candidate) => candidate.dayIndex * genericPeriodsPerDay + candidate.startPeriod)
    const minimumPosition = previousPositions.length ? Math.max(...previousPositions) : -1
    return taskCandidates.get(task.id)!
      .filter((candidate) => candidate.dayIndex * genericPeriodsPerDay + candidate.startPeriod > minimumPosition)
      .filter((candidate) => canPlace(task, candidate))
  }

  const fillSinglePeriods = (): boolean => {
    if (++searchNodes > searchLimit) { exceededLimit = true; return false }
    const candidatesByItem = legalSingleCandidates()
    if (!candidatesByItem) return false
    if (!candidatesByItem.size) return [...states.values()].every((state) => state.cells.every(Boolean))
      && areSectionArrangementsUniqueWithReserved(normalizedSections, states, reservedSections)

    const peersByStudentSlot = new Map<string, Set<WorkItem>>()
    const peersByTeacherSlot = new Map<string, Set<WorkItem>>()
    for (const [item, candidates] of candidatesByItem) {
      for (const candidate of candidates) {
        const position = slotIndex(candidate.dayIndex, candidate.startPeriod)
        const studentKey = `${item.sectionId}:${position}`
        const studentPeers = peersByStudentSlot.get(studentKey) ?? new Set<WorkItem>()
        studentPeers.add(item)
        peersByStudentSlot.set(studentKey, studentPeers)
        const teacherKey = `${item.teacherId}:${position}`
        const teacherPeers = peersByTeacherSlot.get(teacherKey) ?? new Set<WorkItem>()
        teacherPeers.add(item)
        peersByTeacherSlot.set(teacherKey, teacherPeers)
      }
    }
    const peerCount = (item: WorkItem, candidate: BlockCandidate): number => {
      const position = slotIndex(candidate.dayIndex, candidate.startPeriod)
      const peers = new Set([
        ...(peersByStudentSlot.get(`${item.sectionId}:${position}`) ?? []),
        ...(peersByTeacherSlot.get(`${item.teacherId}:${position}`) ?? []),
      ])
      peers.delete(item)
      return peers.size
    }
    const pressureByItem = new Map<WorkItem, number>()
    for (const [item, candidates] of candidatesByItem) {
      pressureByItem.set(item, candidates.reduce((total, candidate) => total + peerCount(item, candidate), 0))
    }
    const [item] = shuffled([...candidatesByItem.keys()], random).sort((left, right) =>
      (candidatesByItem.get(left)!.length - left.remaining) - (candidatesByItem.get(right)!.length - right.remaining)
      || pressureByItem.get(right)! - pressureByItem.get(left)!
      || candidatesByItem.get(left)!.length - candidatesByItem.get(right)!.length
      || right.remaining - left.remaining)
    if (!item) return false
    const candidates = shuffled(candidatesByItem.get(item)!, random).sort((left, right) =>
      peerCount(item, left) - peerCount(item, right)
      || countItemOnDay(item, left.dayIndex) - countItemOnDay(item, right.dayIndex)
      || (item.isCore
        ? getDayCells(item, left.dayIndex).filter((cell) => cell?.kind === 'core').length
          - getDayCells(item, right.dayIndex).filter((cell) => cell?.kind === 'core').length
        : 0))
    for (const candidate of candidates) {
      const task = { id: `single:${item.id}`, item, duration: 1, isTest: false }
      put(task, candidate)
      if (fillSinglePeriods()) return true
      remove(task, candidate)
      if (exceededLimit) return false
    }
    return false
  }

  const placeBlocks = (assigned: Set<string>): boolean => {
    if (++searchNodes > searchLimit) { exceededLimit = true; return false }
    if (testTasks.every((task) => assigned.has(task.id)) && !singleCandidatesHaveCapacity()) return false
    const pending = tasks.filter((task) => !assigned.has(task.id))
    if (!pending.length) return fillSinglePeriods()
    let selected: BlockTask | undefined
    let candidates: BlockCandidate[] = []
    let selectedPriority = -1
    for (const task of pending) {
      if (previousEquivalentTasks.get(task.id)!.some((previous) => !assigned.has(previous.id))) continue
      const options = candidatesFor(task)
      const equivalentTasksRemaining = equivalentTaskGroups
        .get(JSON.stringify([task.item.id, task.duration, task.isTest]))!
        .filter((equivalent) => !assigned.has(equivalent.id)).length
      if (options.length < equivalentTasksRemaining) {
        const reason = `${task.item.name}: ${options.length} legal block start(s) remain for ${equivalentTasksRemaining} equivalent blocks.`
        searchDeadEnds.set(reason, (searchDeadEnds.get(reason) ?? 0) + 1)
        return false
      }
      const priority = task.isTest ? 4
        : task.item.isPlacement && task.item.placementException ? 3
          : task.item.isLab ? 2
            : isNormalActivity(task.item) ? 1 : 0
      if (!selected || options.length < candidates.length
        || (options.length === candidates.length
          && (priority > selectedPriority
            || (priority === selectedPriority && task.duration > selected.duration)))) {
        selected = task
        candidates = options
        selectedPriority = priority
      }
      if (!options.length) {
        const reason = `${task.item.name}: its ${task.duration}-period block has no legal remaining placement.`
        searchDeadEnds.set(reason, (searchDeadEnds.get(reason) ?? 0) + 1)
        return false
      }
    }
    if (!selected) return false
    for (const candidate of shuffled(candidates, random)) {
      put(selected, candidate)
      assigned.add(selected.id)
      assignedCandidates.set(selected.id, candidate)
      if (placeBlocks(assigned)) return true
      assigned.delete(selected.id)
      assignedCandidates.delete(selected.id)
      remove(selected, candidate)
      if (exceededLimit) return false
    }
    return false
  }

  if (!placeBlocks(new Set())) {
    return failure([
      exceededLimit ? `Generic constraint search reached its ${searchLimit.toLocaleString()}-node limit.` : 'No complete assignment satisfies the configured workload, block, and teacher constraints.',
      ...(!exceededLimit ? [...searchDeadEnds.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([reason]) => `Most frequent search dead end: ${reason}`) : []),
      ...[...placementAlternateClashes].slice(0, 8),
      ...(reservedSections.length ? [`Candidates were checked against ${reservedSections.length} previously generated active section timetable(s) for teacher-slot clashes and duplicate complete grids.`] : []),
      ...(unavailableTeacherSlots.length ? [`Candidate placement respected ${unavailableTeacherSlots.length} saved normal-week teacher-slot restriction(s).`] : []),
      ...(alternateWeekUnavailableTeacherSlots.length ? [`Candidate placement respected ${alternateWeekUnavailableTeacherSlots.length} saved alternate-week teacher-slot restriction(s).`] : []),
      'No partial timetable was returned.',
    ], exceededLimit ? 'SEARCH_LIMIT' : 'UNSATISFIABLE')
  }

  const generated: GenericGeneratedSection[] = normalizedSections.map(({ section, key, profileKey, profile }) => {
    const schedule = Object.fromEntries(genericTimetableDays.map((day) => [day, {}])) as GenericGeneratedSection['schedule']
    for (let dayIndex = 0; dayIndex < genericTimetableDays.length; dayIndex += 1) {
      const day = genericTimetableDays[dayIndex] as GenericWeekDay
      for (const period of periods) {
        const cell = states.get(key)!.cells[slotIndex(dayIndex, period)]!
        schedule[day][period] = cell
      }
    }
    return {
      sectionId: section.id,
      profileId: profileKey,
      department: profile.department,
      academicYear: profile.academicYear,
      year: profile.year,
      semester: profile.semester,
      schedule,
    }
  })

  const validation = validateGenericGenerated(
    normalizedSections, generated, itemsBySection, testTasks, reservedSections,
    unavailableTeacherSlots, alternateWeekUnavailableTeacherSlots,
  )
  if (validation.issues.length) return failure(validation.issues, 'UNSATISFIABLE')
  return { ok: true, sections: generated, searchNodes, validation: validation.summary }
}

function areSectionArrangementsUniqueWithReserved(
  sections: NormalizedSection[],
  states: Map<string, SectionState>,
  reservedSections: GenericGeneratedSection[],
): boolean {
  const signatures = new Set(reservedSections.map(sectionArrangementSignature))
  for (const { key } of sections) {
    const signature = arrangementSignature(states.get(key)!.cells)
    if (signatures.has(signature)) return false
    signatures.add(signature)
  }
  return true
}

function validateGenericGenerated(
  sectionsToCheck: NormalizedSection[],
  generated: GenericGeneratedSection[],
  itemsBySection: Map<string, WorkItem[]>,
  testTasks: BlockTask[],
  reservedSections: GenericGeneratedSection[] = [],
  unavailableTeacherSlots: GenericUnavailableTeacherSlot[] = [],
  alternateWeekUnavailableTeacherSlots: GenericUnavailableTeacherSlot[] = [],
  editMode = false,
): { summary: GenericTimetableValidationSummary; issues: string[] } {
  const issues: string[] = []
  let globalTeacherClashes = 0
  const sectionSummaries: GenericTimetableValidationSummary['sections'] = []
  const teacherSlots = new Map<string, Map<string, Set<string>>>()
  const alternateTeacherSlots = new Map<string, Map<string, Set<string>>>()
  const reservedSlots = reservedTeacherSlots(reservedSections)
  const reservedAlternateSlots = reservedTeacherSlots(reservedSections, true)
  const savedSlots = unavailableTeacherSlotMap(unavailableTeacherSlots)
  const savedAlternateSlots = unavailableTeacherSlotMap(alternateWeekUnavailableTeacherSlots)
  const workItems = new Map([...itemsBySection.values()].flat().map((item) => [item.id, item]))
  const blockEntries = new Map<string, Array<{ item: WorkItem; dayIndex: number; period: number; cell: GenericScheduledCell }>>()
  for (const normalizedSection of sectionsToCheck) {
    const { section, key, profileKey, profile } = normalizedSection
    const result = generated.find((candidate) => candidate.sectionId === section.id && candidate.profileId === profileKey)
    let periodsFilled = 0
    let coreHoursValid = true
    let otherSubjectHoursValid = true
    let labAllocationValid = true
    const counts = new Map<string, number>()
    const normalActivityDays = new Set<number>()
    const expectedTestsByItem = new Map<string, number>()
    const actualTestsByItem = new Map<string, number>()
    for (const task of testTasks) {
      if (task.item.sectionId === key) expectedTestsByItem.set(task.item.id, (expectedTestsByItem.get(task.item.id) ?? 0) + 1)
    }
    if (!result) {
      issues.push(`Section ${section.id} is missing from the generated schedule.`)
      sectionSummaries.push({ sectionId: section.id, profileId: profileKey, department: profile.department, periodsFilled, coreHoursValid: false, otherSubjectHoursValid: false, labAllocationValid: false })
      continue
    }
    for (let dayIndex = 0; dayIndex < genericTimetableDays.length; dayIndex += 1) {
      const day = genericTimetableDays[dayIndex]
      const normalActivityBlocks = new Set<string>()
      const dayItems: Array<{ item: WorkItem | undefined; cell: GenericScheduledCell; period: number }> = []
      const dayItemCounts = new Map<string, number>()
      const dayLabBlocks = new Set<string>()
      const dayLabBlocksByItem = new Map<string, Set<string>>()
      let placementPeriods = 0
      let hasLab = false
      for (const period of periods) {
        const cell = result.schedule[day]?.[period]
        if (!cell?.teacherId || !cell.abbreviation.trim()) {
          issues.push(`${profile.department} Section ${section.id} ${day} P${period} is empty or unassigned.`)
          continue
        }
        periodsFilled += 1
        const item = workItems.get(cell.itemId)
        dayItems.push({ item, cell, period })
        counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1)
        if (!item) issues.push(`${profile.department} Section ${section.id} contains an unconfigured timetable item at ${day} P${period}.`)
        if (item && cell.kind !== item.kind) {
          issues.push(`${profile.department} Section ${section.id} ${day} P${period} has an item kind that does not match ${item.name}.`)
        }
        if (item && cell.teacherId !== item.teacherId) {
          issues.push(`${profile.department} Section ${section.id} ${day} P${period} has a teacher that does not match configured ${item.name} staff.`)
        }
        if (item) dayItemCounts.set(item.id, (dayItemCounts.get(item.id) ?? 0) + 1)
        if (item?.isLab) {
          const blockKey = cell.blockId ?? item.id
          dayLabBlocks.add(blockKey)
          const itemBlocks = dayLabBlocksByItem.get(item.id) ?? new Set<string>()
          itemBlocks.add(blockKey)
          dayLabBlocksByItem.set(item.id, itemBlocks)
        }
        if (cell.alternateSubject && !item?.isPlacement) {
          issues.push(`${profile.department} Section ${section.id} has alternate-week subject metadata outside a Placement cell at ${day} P${period}.`)
        }
        if (item?.isPlacement && profile.placementException?.enabled && !cell.alternateSubject) {
          issues.push(`${profile.department} Section ${section.id} Placement at ${day} P${period} is missing its alternate-week subject.`)
        }
        if (item?.isPlacement && !profile.placementException?.enabled && cell.alternateSubject) {
          issues.push(`${profile.department} Section ${section.id} has an alternate-week subject while Placement Exception is disabled.`)
        }
        if (cell.isCoreTest && period !== 1) issues.push(`${profile.department} Section ${section.id} has a Core Test outside P1.`)
        if (cell.isCoreTest) {
          actualTestsByItem.set(cell.itemId, (actualTestsByItem.get(cell.itemId) ?? 0) + 1)
          if (!item?.isCore || !expectedTestsByItem.has(cell.itemId)) {
            issues.push(`${profile.department} Section ${section.id} has a Test on an item that is not an eligible configured Core subject at ${day} P${period}.`)
          }
        }
        if (period === 1 && item && !cell.isCoreTest) {
          if (item.kind === 'activity' && !item.isPlacement) issues.push(`${item.name} cannot occupy P1 as a normal Special Activity.`)
          if (item.isCore && profile.rules?.allowCoreSubjectsInP1 === false) issues.push(`${item.name} is not allowed in P1 by the Core Subject policy.`)
          if (item.kind === 'other' && profile.rules?.allowOtherSubjectsInP1 === false) issues.push(`${item.name} is not allowed in P1 by the Other Subject policy.`)
        }
        if (period === 1 && cell.alternateSubject) {
          if (cell.alternateSubject.subjectKind === 'core' && profile.rules?.allowCoreSubjectsInP1 === false) {
            issues.push(`${cell.alternateSubject.name} is not allowed in P1 by the Core Subject policy in the alternate week.`)
          }
          if (cell.alternateSubject.subjectKind === 'other' && profile.rules?.allowOtherSubjectsInP1 === false) {
            issues.push(`${cell.alternateSubject.name} is not allowed in P1 by the Other Subject policy in the alternate week.`)
          }
          if (profile.rules?.p1Tests?.reserveEveryP1ForTest) {
            issues.push(`${cell.alternateSubject.name} cannot occupy P1 because every P1 is reserved for a configured Core Test.`)
          }
        }
        if (item?.isPlacement) placementPeriods += 1
        if (item?.isLab) hasLab = true
        if (item && item.kind === 'activity' && !item.isPlacement) {
          normalActivityBlocks.add(cell.blockId ?? `${item.id}:P${period}`)
          normalActivityDays.add(dayIndex)
        }
        if (item && cell.blockId) {
          const entries = blockEntries.get(cell.blockId) ?? []
          entries.push({ item, dayIndex, period, cell })
          blockEntries.set(cell.blockId, entries)
        }
        const slotKey = `${day}:P${period}`
        if (reservedSlots.get(slotIndex(dayIndex, period))?.has(cell.teacherId)) {
          globalTeacherClashes += 1
          issues.push(`${cell.teacherId} has a teacher clash at ${slotKey} with a previously generated active timetable.`)
        }
        const savedSlot = slotIndex(dayIndex, period)
        if (savedSlots.get(savedSlot)?.has(cell.teacherId)) {
          globalTeacherClashes += 1
          const existing = unavailableTeacherSlots.find((entry) => entry.teacherId === cell.teacherId && entry.day === day && entry.period === period)?.existing
          issues.push(`${cell.teacherId} has a teacher clash at ${slotKey} with a saved timetable${existing ? ` (${existing.department} ${existing.year}, Section ${existing.section}: ${existing.subject})` : ''}.`)
        }
        const teachers = teacherSlots.get(slotKey) ?? new Map<string, Set<string>>()
        const sections = teachers.get(cell.teacherId) ?? new Set<string>()
        sections.add(key)
        teachers.set(cell.teacherId, sections)
        teacherSlots.set(slotKey, teachers)
        const alternateTeacherId = cell.alternateSubject?.teacherId ?? cell.teacherId
        if (reservedAlternateSlots.get(slotIndex(dayIndex, period))?.has(alternateTeacherId)) {
          globalTeacherClashes += 1
          issues.push(`${alternateTeacherId} has an alternate-week teacher clash at ${slotKey} with a previously generated active timetable.`)
        }
        if (savedAlternateSlots.get(savedSlot)?.has(alternateTeacherId)) {
          globalTeacherClashes += 1
          const existing = alternateWeekUnavailableTeacherSlots.find((entry) => entry.teacherId === alternateTeacherId && entry.day === day && entry.period === period)?.existing
          issues.push(`${alternateTeacherId} has an alternate-week teacher clash at ${slotKey} with a saved timetable${existing ? ` (${existing.department} ${existing.year}, Section ${existing.section}: ${existing.subject})` : ''}.`)
        }
        const alternateTeachers = alternateTeacherSlots.get(slotKey) ?? new Map<string, Set<string>>()
        const alternateSections = alternateTeachers.get(alternateTeacherId) ?? new Set<string>()
        alternateSections.add(key)
        alternateTeachers.set(alternateTeacherId, alternateSections)
        alternateTeacherSlots.set(slotKey, alternateTeachers)
      }
      for (const item of itemsBySection.get(key) ?? []) {
        const dailyPeriods = dayItemCounts.get(item.id) ?? 0
        if (item.isCore && item.rules.coreDailyMaximum !== undefined && dailyPeriods > item.rules.coreDailyMaximum) {
          issues.push(`${item.name} exceeds its ${item.rules.coreDailyMaximum}-period daily maximum on ${day}.`)
        }
        if (item.rules.itemDailyMaximum !== undefined && dailyPeriods > item.rules.itemDailyMaximum) {
          issues.push(`${item.name} exceeds its ${item.rules.itemDailyMaximum}-period daily maximum on ${day}.`)
        }
        if (item.isLab && item.rules.labsOnDistinctDays && (dayLabBlocksByItem.get(item.id)?.size ?? 0) > 1) {
          issues.push(`${item.name} has more than one Lab block on ${day}, but its blocks must use distinct days.`)
        }
        if (item.isLab && item.rules.labsPerDayMaximum !== undefined && dayLabBlocks.size > item.rules.labsPerDayMaximum) {
          issues.push(`${profile.department} Section ${section.id} has ${dayLabBlocks.size} Lab blocks on ${day}, above the configured maximum of ${item.rules.labsPerDayMaximum}.`)
        }
      }
      if (hasLab && placementPeriods > 0) issues.push(`${profile.department} Section ${section.id} ${day} cannot contain both Placement and a Lab.`)
      if (normalActivityBlocks.size > 1) issues.push(`${profile.department} Section ${section.id} ${day} has more than one normal Special Activity block.`)
      if (placementPeriods >= 4 && normalActivityBlocks.size > 0) issues.push(`${profile.department} Section ${section.id} ${day} cannot combine four-period Placement with a normal Special Activity.`)
      let currentItemId = ''
      let currentRun = 0
      for (const { item, cell } of dayItems) {
        if (item?.kind === 'core' || item?.kind === 'other') {
          currentRun = cell.itemId === currentItemId ? currentRun + 1 : 1
          currentItemId = cell.itemId
          if (currentRun > Math.max(2, item.blockDuration)) issues.push(`${item.name} has more than two consecutive normal subject periods in ${day}.`)
        } else {
          currentItemId = ''
          currentRun = 0
        }
      }
      const alternateItems = dayItems.map(({ item, cell }) => cell.alternateSubject
        ? (itemsBySection.get(key) ?? []).find((candidate) => candidate.sourceId === cell.alternateSubject!.subjectId && candidate.kind === cell.alternateSubject!.subjectKind)
        : item)
      const alternateCounts = new Map<string, number>()
      for (const alternateItem of alternateItems) {
        if (alternateItem && (alternateItem.kind === 'core' || alternateItem.kind === 'other')) {
          alternateCounts.set(alternateItem.id, (alternateCounts.get(alternateItem.id) ?? 0) + 1)
        }
      }
      if (dayItems.some(({ cell }) => Boolean(cell.alternateSubject))) {
      for (const [alternateItemId, count] of alternateCounts) {
        const alternateItem = workItems.get(alternateItemId)!
        if (alternateItem.isCore && alternateItem.rules.coreDailyMaximum !== undefined && count > alternateItem.rules.coreDailyMaximum) {
          issues.push(`${alternateItem.name} exceeds its ${alternateItem.rules.coreDailyMaximum}-period daily maximum in the alternate week on ${day}.`)
        }
        if (alternateItem.rules.itemDailyMaximum !== undefined && count > alternateItem.rules.itemDailyMaximum) {
          issues.push(`${alternateItem.name} exceeds its ${alternateItem.rules.itemDailyMaximum}-period daily maximum in the alternate week on ${day}.`)
        }
      }
      let alternateRunItemId = ''
      let alternateRun = 0
      for (const alternateItem of alternateItems) {
        if (alternateItem?.kind === 'core' || alternateItem?.kind === 'other') {
          alternateRun = alternateItem.id === alternateRunItemId ? alternateRun + 1 : 1
          alternateRunItemId = alternateItem.id
          const configuredLimit = alternateItem.isCore
            ? alternateItem.rules.coreConsecutiveMaximum ?? alternateItem.rules.subjectConsecutiveMaximum ?? 2
            : alternateItem.rules.subjectConsecutiveMaximum ?? 2
          const maximum = Math.max(Math.min(configuredLimit, 2), alternateItem.blockDuration)
          if (alternateRun > maximum) issues.push(`${alternateItem.name} has more than ${maximum} consecutive periods in the alternate week on ${day}.`)
        } else {
          alternateRunItemId = ''
          alternateRun = 0
        }
      }
      }
    }
    if (profile.rules?.allowConsecutiveSpecialActivityDays === false) {
      for (let dayIndex = 1; dayIndex < genericTimetableDays.length; dayIndex += 1) {
        if (normalActivityDays.has(dayIndex - 1) && normalActivityDays.has(dayIndex)) {
          issues.push(`${profile.department} Section ${section.id} has normal Special Activities on consecutive days.`)
        }
      }
    }
    if (periodsFilled !== genericStudentSlotsPerWeek) issues.push(`${profile.department} Section ${section.id} has ${periodsFilled}/${genericStudentSlotsPerWeek} occupied student periods.`)

    for (const item of itemsBySection.get(key) ?? []) {
      if (!editMode && (counts.get(item.id) ?? 0) !== item.weeklyPeriods) {
        if (item.kind === 'core') coreHoursValid = false
        if (item.kind === 'other') otherSubjectHoursValid = false
        if (item.kind === 'lab') labAllocationValid = false
        issues.push(`${profile.department} Section ${section.id} ${item.name} has ${counts.get(item.id) ?? 0}/${item.weeklyPeriods} periods.`)
      }
    }
    const configuredTestCount = testTasks.filter((task) => task.item.sectionId === key).length
    const actualTestCount = Object.values(result.schedule).flatMap((day) => Object.values(day)).filter((cell) => cell.isCoreTest).length
    if (actualTestCount !== configuredTestCount) issues.push(`${profile.department} Section ${section.id} has ${actualTestCount}/${configuredTestCount} configured P1 Test periods.`)
    for (const [itemId, expectedCount] of expectedTestsByItem) {
      if ((actualTestsByItem.get(itemId) ?? 0) !== expectedCount) {
        issues.push(`${profile.department} Section ${section.id} Core Test assignment for ${workItems.get(itemId)?.name ?? itemId} is ${(actualTestsByItem.get(itemId) ?? 0)}/${expectedCount}.`)
      }
    }
    if (profile.rules?.p1Tests?.enabled && profile.rules.p1Tests.reserveEveryP1ForTest) {
      for (const day of genericTimetableDays) {
        if (!result.schedule[day]?.[1]?.isCoreTest) issues.push(`${profile.department} Section ${section.id} ${day} P1 must be reserved for a configured Core Test.`)
      }
    }
    sectionSummaries.push({ sectionId: section.id, profileId: profileKey, department: profile.department, periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid })
  }
  for (const [slot, teachers] of teacherSlots) {
    for (const [teacherId, sections] of teachers) {
      if (sections.size > 1) {
        globalTeacherClashes += 1
        const labels = [...sections].map((key) => {
          const section = sectionsToCheck.find((candidate) => candidate.key === key)!
          return `${section.profile.department} Section ${section.section.id}`
        })
        issues.push(`${teacherId} has a teacher clash at ${slot} across ${labels.join(', ')}.`)
      }
    }
  }
  for (const [slot, teachers] of alternateTeacherSlots) {
    for (const [teacherId, sections] of teachers) {
      if (sections.size > 1) {
        globalTeacherClashes += 1
        const labels = [...sections].map((key) => {
          const section = sectionsToCheck.find((candidate) => candidate.key === key)!
          return `${section.profile.department} Section ${section.section.id}`
        })
        issues.push(`${teacherId} has an alternate-week teacher clash at ${slot} across ${labels.join(', ')}.`)
      }
    }
  }

  for (const [blockId, entries] of blockEntries) {
    const item = entries[0].item
    const ordered = [...entries].sort((left, right) => left.dayIndex - right.dayIndex || left.period - right.period)
    const sameDay = ordered.every((entry) => entry.dayIndex === ordered[0].dayIndex)
    const consecutive = ordered.every((entry, index) => index === 0 || entry.period === ordered[index - 1].period + 1)
    if (!item.blockDurations.includes(entries.length) || !sameDay || !consecutive) {
      issues.push(`${item.name} contains an invalid or split ${entries.length}-period block (${blockId}).`)
      continue
    }
    const startPeriod = ordered[0].period
    if (item.isPlacement) {
      for (const [index, entry] of ordered.entries()) {
        const position = index + 1
        const actual = entry.cell.alternateSubject
        const sectionId = sectionsToCheck.find((candidate) => candidate.key === item.sectionId)?.section.id
        const expected = item.placementException?.alternateSubjects.find((alternate) => alternate.placementPosition === position && alternate.sectionId === sectionId)
          ?? item.placementException?.alternateSubjects.find((alternate) => alternate.placementPosition === position && !alternate.sectionId)
        const expectedTeacher = expected?.teacherAssignments.find((assignment) => assignment.sectionId === sectionId)
        if (item.placementException?.enabled) {
          if (!actual || actual.placementPosition !== position || actual.subjectId !== expected?.subjectId
            || actual.subjectKind !== expected?.subjectKind || actual.name !== expected?.subjectNameSnapshot
            || actual.teacherId !== expectedTeacher?.teacherId || actual.teacherNameSnapshot !== expectedTeacher?.teacherNameSnapshot) {
            issues.push(`${item.name} block ${blockId} has incorrect alternate subject or teacher data at position ${position}.`)
          }
        } else if (actual) {
          issues.push(`${item.name} block ${blockId} has alternate subject data while Placement Exception is disabled.`)
        }
      }
    }
    if (!validStartsForBlock({ ...item, isNormalActivity: isNormalActivity(item) }, entries.length, item.rules).includes(startPeriod)) {
      issues.push(`${item.name} starts at disallowed period P${startPeriod}.`)
    }
    if ((item.isLab || item.isPlacement || item.rules.blocksAvoidLunch !== false) && crossesLunch(startPeriod, entries.length)) {
      issues.push(`${item.name} crosses lunch.`)
    }
  }

  for (const item of workItems.values()) {
    if (!item.schedulesAsBlocks) continue
    const actualDurations = [...blockEntries.values()]
      .filter((entries) => entries[0]?.item.id === item.id)
      .map((entries) => entries.length)
      .sort((left, right) => left - right)
    const expectedDurations = [...item.blockDurations].sort((left, right) => left - right)
    if (actualDurations.length !== expectedDurations.length
      || actualDurations.some((duration, index) => duration !== expectedDurations[index])) {
      issues.push(`${item.name} does not match its configured continuous block breakdown (${expectedDurations.join(' + ')} periods).`)
    }
  }

  const signatures = [...reservedSections.map(sectionArrangementSignature), ...generated.map(sectionArrangementSignature)]
  if (new Set(signatures).size !== signatures.length) issues.push('Two sections have identical complete timetable arrangements.')
  return { summary: { sections: sectionSummaries, globalTeacherClashes }, issues: [...new Set(issues)] }
}

/** Validate an edited timetable's structural constraints without configured workload totals. */
export function validateGenericScheduleEdit(
  input: GenericScheduleConfig,
  generated: GenericGeneratedSection[],
  reservedSections: GenericGeneratedSection[] = [],
  unavailableTeacherSlots: GenericUnavailableTeacherSlot[] = [],
  alternateWeekUnavailableTeacherSlots: GenericUnavailableTeacherSlot[] = [],
): { summary: GenericTimetableValidationSummary; issues: string[] } {
  const profile = validateProfile(input, profileIdentity(input), false)
  const issues = profile.issues.filter((issue) => !issue.startsWith('Configured workload is '))
  if (issues.length) {
    return {
      summary: {
        sections: profile.sections.map(({ section, profileKey, profile: schedule }) => ({
          sectionId: section.id,
          profileId: profileKey,
          department: schedule.department,
          periodsFilled: 0,
          coreHoursValid: false,
          otherSubjectHoursValid: false,
          labAllocationValid: false,
        })),
        globalTeacherClashes: 0,
      },
      issues: [...new Set(issues)],
    }
  }
  return validateGenericGenerated(
    profile.sections,
    generated,
    profile.itemsBySection,
    profile.testTasks,
    reservedSections,
    unavailableTeacherSlots,
    alternateWeekUnavailableTeacherSlots,
    true,
  )
}

function scheduleArrangementScore(sections: NormalizedSection[], states: Map<string, SectionState>, itemsBySection: Map<string, WorkItem[]>): number {
  let score = 0
  for (const { key } of sections) {
    const itemById = new Map((itemsBySection.get(key) ?? []).map((item) => [item.id, item]))
    const daySignatures = new Set<string>()
    const placementStarts = new Map<string, number[]>()
    const dailySubjectOccurrences = new Map<string, number[]>()
    const labsByDay: Set<string>[] = Array.from({ length: genericTimetableDays.length }, () => new Set<string>())
    for (let dayIndex = 0; dayIndex < genericTimetableDays.length; dayIndex += 1) {
      const dayCells = states.get(key)!.cells.slice(dayIndex * genericPeriodsPerDay, (dayIndex + 1) * genericPeriodsPerDay)
      const signature = arrangementSignature(dayCells)
      if (daySignatures.has(signature)) score += 25
      daySignatures.add(signature)
      const occurrences = new Map<string, number>()
      for (const cell of dayCells) {
        const item = cell && itemById.get(cell.itemId)
        if (item && (item.kind === 'core' || item.kind === 'other')) occurrences.set(item.id, (occurrences.get(item.id) ?? 0) + 1)
        if (item?.isLab) labsByDay[dayIndex].add(item.sourceId)
        if (item?.isPlacement && cell?.blockId) {
          const block = placementStarts.get(cell.blockId) ?? []
          placementStarts.set(cell.blockId, [...block, dayCells.indexOf(cell) + 1])
        }
      }
      for (const [itemId, count] of occurrences) {
        score += count * count
        const dailyCounts = dailySubjectOccurrences.get(itemId) ?? Array<number>(genericTimetableDays.length).fill(0)
        dailyCounts[dayIndex] = count
        dailySubjectOccurrences.set(itemId, dailyCounts)
      }
    }
    // Keep separate configured labs on different days when another valid candidate allows it.
    for (const labs of labsByDay) {
      score += (labs.size * (labs.size - 1) / 2) * 100
    }
    for (const periodsInBlock of placementStarts.values()) {
      const start = Math.min(...periodsInBlock)
      score += Math.floor((start - 1) / 2) * 10
    }
    for (const [itemId, dailyCounts] of dailySubjectOccurrences) {
      const item = itemById.get(itemId)!
      let cumulative = 0
      for (let dayIndex = 0; dayIndex < genericTimetableDays.length - 1; dayIndex += 1) {
        cumulative += dailyCounts[dayIndex]
        const expected = item.weeklyPeriods * (dayIndex + 1) / genericTimetableDays.length
        score += Math.abs(cumulative - expected)
      }
    }
  }
  return score
}

function isGroupInput(input: GenericSchedulerInput): input is GenericScheduleGroupInput {
  return 'schedules' in input
}

function profileIdentity(profile: GenericScheduleConfig): string {
  return profile.configurationId?.trim() || `${profile.department}|${profile.academicYear}|${profile.year}|${profile.semester}`
}

/** Validate readiness without searching for a timetable candidate. */
export function validateGenericScheduleConfig(input: GenericScheduleConfig): string[] {
  const profileKey = profileIdentity(input)
  const validation = validateProfile(input, profileKey, false)
  if (input.candidateCount !== undefined && (!Number.isInteger(input.candidateCount) || input.candidateCount < 2)) {
    validation.issues.push('At least two randomized candidates are required.')
  } else if (input.candidateCount !== undefined && input.candidateCount > maximumCandidateCount) {
    validation.issues.push(`Candidate count cannot exceed ${maximumCandidateCount}.`)
  }
  return [...new Set(validation.issues)]
}

/** Generate any configured schedule without dispatching on department identity. */
export function generateGenericTimetable(input: GenericSchedulerInput): GenericTimetableGenerationResult {
  const profilesInput = isGroupInput(input) ? input.schedules : [input]
  const reservedSections = isGroupInput(input) ? input.reservedSections ?? [] : []
  const unavailableTeacherSlots = isGroupInput(input) ? input.unavailableTeacherSlots ?? [] : []
  const alternateWeekUnavailableTeacherSlots = isGroupInput(input) ? input.alternateWeekUnavailableTeacherSlots ?? [] : []
  if (!profilesInput.length) return failure(['At least one schedule configuration is required.'])
  const candidateCount = isGroupInput(input)
    ? input.candidateCount ?? 5
    : input.candidateCount ?? 5
  const rootSeed = isGroupInput(input) ? input.randomSeed : input.randomSeed
  const profileSeeds = [...new Set(profilesInput.map((profile) => profile.randomSeed).filter((seed): seed is number => seed !== undefined))]
  const randomSeed = rootSeed ?? profileSeeds[0]
  if (!Number.isInteger(candidateCount) || candidateCount < 2) return failure(['At least two randomized candidates are required.'])
  if (candidateCount > maximumCandidateCount) return failure([`Candidate count cannot exceed ${maximumCandidateCount}.`])
  const grouped = profilesInput.length > 1
  const seenProfileIds = new Set<string>()
  const globalStaff = new Map<string, string>()
  const normalizedProfiles: NormalizedProfile[] = []
  const issues: string[] = []
  if (rootSeed !== undefined && !Number.isSafeInteger(rootSeed)) issues.push('Random seed must be a safe whole number.')
  if (rootSeed === undefined && profileSeeds.length > 1) issues.push('Grouped schedule configurations must use one shared random seed.')
  validateUnavailableTeacherSlots(unavailableTeacherSlots, 'Saved timetable occupancy', issues)
  validateUnavailableTeacherSlots(alternateWeekUnavailableTeacherSlots, 'Saved alternate-week timetable occupancy', issues)
  profilesInput.forEach((profile) => {
    const profileKey = profileIdentity(profile)
    if (seenProfileIds.has(profileKey)) issues.push(`Schedule configuration identity ${profileKey} is duplicated.`)
    seenProfileIds.add(profileKey)
    for (const staff of profile.staff) {
      const knownName = globalStaff.get(staff.id)
      if (knownName && knownName !== staff.name) issues.push(`Staff ID ${staff.id} maps to different names across configurations.`)
      else globalStaff.set(staff.id, staff.name)
    }
    normalizedProfiles.push(validateProfile(profile, profileKey, grouped))
  })
  for (const profile of normalizedProfiles) {
    issues.push(...profile.issues.map((issue) => `${profile.profile.department} (${profile.profileKey}): ${issue}`))
  }
  if (issues.length) return failure([...new Set(issues)])

  const itemsBySection = new Map(normalizedProfiles.flatMap((profile) => [...profile.itemsBySection.entries()]))
  const allSections = normalizedProfiles.flatMap((profile) => profile.sections)
  const testTasks = normalizedProfiles.flatMap((profile) => profile.testTasks)
  const randomSeedBase = randomSeed ?? Math.floor(Math.random() * 4_294_967_296)
  let best: GenericTimetableGenerationResult | undefined
  let bestScore = Number.POSITIVE_INFINITY
  let lastFailure: GenericTimetableGenerationResult | undefined
  const configuredSearchLimit = Math.min(...normalizedProfiles.map(({ profile }) => profile.rules?.searchNodeLimit ?? defaultSearchNodeLimit))
  const quickSearchLimit = Math.max(1, Math.floor(configuredSearchLimit / 30))
  const considerCandidate = (candidate: number, searchLimit: number): void => {
    // Give each bounded retry an independent deterministic stream so a difficult
    // first candidate does not leave later retries deep in the same random walk.
    const candidateSeed = (randomSeedBase >>> 0) + Math.imul(candidate, 0x9e3779b9)
    const random = seededRandom(candidateSeed)
    const generated = buildSchedule(
      normalizedProfiles, itemsBySection, testTasks, reservedSections,
      unavailableTeacherSlots, alternateWeekUnavailableTeacherSlots, random, searchLimit,
    )
    if (!generated.ok) { lastFailure = generated; return }
    const statesForScore = new Map<string, SectionState>()
    generated.sections.forEach((section, index) => {
      const normalizedSection = allSections[index]
      statesForScore.set(normalizedSection.key, {
        section: normalizedSection.section,
        profileKey: normalizedSection.profileKey,
        profile: normalizedSection.profile,
        cells: genericTimetableDays.flatMap((day) => periods.map((period) => section.schedule[day][period] ?? null)),
      })
    })
    const score = scheduleArrangementScore(allSections, statesForScore, itemsBySection)
    if (score < bestScore) { best = generated; bestScore = score }
  }
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    considerCandidate(candidate, quickSearchLimit)
  }
  if (!best && lastFailure && !lastFailure.ok && lastFailure.code === 'SEARCH_LIMIT') {
    for (let recovery = 0; recovery < searchRecoveryCandidateCount; recovery += 1) {
      considerCandidate(candidateCount + recovery, quickSearchLimit)
      if (best) break
    }
    for (let recovery = 0; recovery < searchRecoveryFullCandidateCount && !best; recovery += 1) {
      considerCandidate(candidateCount + searchRecoveryCandidateCount + recovery, configuredSearchLimit)
    }
  }
  return best ?? lastFailure ?? failure(['No valid randomized schedule candidate was found.'], 'UNSATISFIABLE')
}
