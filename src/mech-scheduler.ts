import type {
  CoreSubject, LabDefinition, OtherSubject, SectionName, SpecialActivity,
  TimetableSetup, WeekDay,
} from './models'
import type {
  GeneratedSection, ScheduledCell, TimetableGenerationResult, TimetableValidationSummary,
} from './scheduler'

const days: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const periods = Array.from({ length: 8 }, (_, index) => index + 1)
const attemptLimit = 24
const nodesPerAttemptLimit = 18_000

interface MechItem {
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
  isMiniProject: boolean
}

interface SectionPlan {
  sectionId: SectionName
  items: MechItem[]
  byId: Map<string, MechItem>
  occupied: Array<MechItem | null>
  remaining: Map<string, number>
  placementDay: number
  placementStart: number
  miniProjectBlockDay: number
  testSlots: Set<number>
}

interface Block {
  id: string
  type: 'placement' | 'lab' | 'mini-project'
  item: MechItem
  sectionIndex: number
}

interface BlockCandidate {
  day: number
  start: number
}

interface SearchState {
  plans: SectionPlan[]
  teacherAtSlot: Map<number, Set<string>>
  labResourceAtSlot: Map<number, Map<string, SectionName>>
  labDays: Map<number, number>
  placementDays: Map<number, number>
  sectionLabDays: Map<SectionName, Set<number>>
  projectBlockDay: Map<SectionName, number>
  searchNodes: number
  exceeded: boolean
}

const slotIndex = (day: number, period: number) => day * 8 + period - 1
const activityRole = (activity: SpecialActivity): string => `${activity.id} ${activity.name}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
const isPlacement = (activity: SpecialActivity) => /\bplacement\b/.test(activityRole(activity))
const isMiniProject = (activity: SpecialActivity) => /mini\s*project/.test(activityRole(activity))
const isLibrary = (activity: SpecialActivity) => /\blibrary\b/.test(activityRole(activity))
const isMentoring = (activity: SpecialActivity) => /\bmentoring\b/.test(activityRole(activity))
const isIct = (subject: OtherSubject) => subject.abbreviation.trim().toUpperCase() === 'ICT' || subject.code.trim().toUpperCase() === 'MEP53'

function shuffled<T>(values: T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

function teacherFor(setup: TimetableSetup, sectionId: SectionName, subjectId: string): string {
  return setup.sectionSubjectAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.subjectId === subjectId)?.teacherId ?? ''
}

function activityTeacherFor(setup: TimetableSetup, sectionId: SectionName, activityId: string): string {
  return setup.specialActivityAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.activityId === activityId)?.teacherId ?? ''
}

function makeCoreItem(subject: CoreSubject, sectionId: SectionName, teacherId: string): MechItem {
  return { id: `core:${sectionId}:${subject.id}`, sectionId, code: subject.code, abbreviation: subject.abbreviation, name: subject.name, teacherId, kind: 'core', count: subject.hoursPerWeek, isCore: true, isLab: false, isPlacement: false, isMiniProject: false }
}

function makeOtherItem(subject: OtherSubject, sectionId: SectionName, teacherId: string): MechItem {
  return { id: `other:${sectionId}:${subject.id}`, sectionId, code: subject.code, abbreviation: subject.abbreviation, name: subject.name, teacherId, kind: 'other', count: subject.hoursPerWeek, isCore: false, isLab: false, isPlacement: false, isMiniProject: false }
}

function makeLabItem(lab: LabDefinition, sectionId: SectionName, teacherId: string): MechItem {
  return { id: `lab:${sectionId}:${lab.id}`, sectionId, code: lab.code, abbreviation: lab.abbreviation, name: lab.name, teacherId, kind: 'lab', count: lab.weeklyPeriods, isCore: false, isLab: true, isPlacement: false, isMiniProject: false }
}

function makeActivityItem(activity: SpecialActivity, sectionId: SectionName, teacherId: string): MechItem {
  const placement = isPlacement(activity)
  const miniProject = isMiniProject(activity)
  return { id: `activity:${sectionId}:${activity.id}`, sectionId, code: '', abbreviation: activity.name.toUpperCase(), name: activity.name, teacherId, kind: 'activity', count: activity.hoursPerWeek, isCore: false, isLab: false, isPlacement: placement, isMiniProject: miniProject }
}

function configurationIssues(setup: TimetableSetup): string[] {
  const issues: string[] = []
  const sectionIds = setup.sections.map((section) => section.id)
  if (sectionIds.length < 1 || sectionIds.length > 3 || sectionIds.some((id, index) => id !== String.fromCharCode(65 + index))) {
    issues.push('MECH generation supports 1, 2, or 3 consecutively named sections (A, B, C).')
  }
  if (setup.coreSubjects.length !== 5) issues.push('MECH P1 tests require exactly five configured Core subjects.')
  if (setup.labMaster.length !== 2 || setup.labMaster.some((lab) => lab.weeklyPeriods !== 3)) issues.push('MECH requires exactly two Labs, each configured for 3 periods per week.')
  const placements = setup.specialActivities.filter(isPlacement)
  const projects = setup.specialActivities.filter(isMiniProject)
  const libraries = setup.specialActivities.filter(isLibrary)
  const mentoring = setup.specialActivities.filter(isMentoring)
  if (placements.length !== 1 || placements[0]?.hoursPerWeek !== 4) issues.push('MECH requires exactly one PLACEMENT activity configured for 4 periods per week.')
  if (projects.length !== 1 || projects[0]?.hoursPerWeek !== 5) issues.push('MECH requires exactly one MINI PROJECT activity configured for 5 periods per week.')
  if (libraries.length !== 1 || libraries[0]?.hoursPerWeek !== 1) issues.push('MECH requires one separate LIBRARY activity configured for 1 period per week.')
  if (mentoring.length !== 1 || mentoring[0]?.hoursPerWeek !== 1) issues.push('MECH requires one separate MENTORING activity configured for 1 period per week.')
  const ict = setup.otherSubjects.filter(isIct)
  if (ict.length !== 1 || ict[0]?.hoursPerWeek !== 3) issues.push('MECH requires one ICT Other Subject configured for 3 periods per week.')
  const total = setup.coreSubjects.reduce((sum, item) => sum + item.hoursPerWeek, 0)
    + setup.labMaster.reduce((sum, item) => sum + item.weeklyPeriods, 0)
    + setup.otherSubjects.reduce((sum, item) => sum + item.hoursPerWeek, 0)
    + setup.specialActivities.reduce((sum, item) => sum + item.hoursPerWeek, 0)
  if (total !== 48) issues.push(`MECH must total exactly 48 configured teaching periods; current total is ${total}.`)

  for (const sectionId of sectionIds) {
    const assignedCoreTeachers = new Set<string>()
    for (const subject of setup.coreSubjects) {
      const teacherId = teacherFor(setup, sectionId, subject.id)
      if (!teacherId || !setup.staff.some((staff) => staff.id === teacherId)) issues.push(`Section ${sectionId}: assign a valid MECH Staff Member to ${subject.name}.`)
      if (teacherId && assignedCoreTeachers.has(teacherId)) issues.push(`Section ${sectionId}: one teacher is assigned to more than one Core subject.`)
      if (teacherId) assignedCoreTeachers.add(teacherId)
    }
    const assignedLabTeachers = new Set<string>()
    for (const lab of setup.labMaster) {
      const teacherId = setup.labAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.labId === lab.id)?.teacherId ?? ''
      if (!teacherId || !setup.staff.some((staff) => staff.id === teacherId)) issues.push(`Section ${sectionId}: assign a valid MECH Staff Member to ${lab.name}.`)
      if (teacherId && assignedLabTeachers.has(teacherId)) issues.push(`Section ${sectionId}: the same teacher cannot be assigned to different Labs.`)
      if (teacherId) assignedLabTeachers.add(teacherId)
    }
    for (const subject of setup.otherSubjects) {
      const teacherId = teacherFor(setup, sectionId, subject.id)
      if (!teacherId || !setup.staff.some((staff) => staff.id === teacherId)) issues.push(`Section ${sectionId}: assign a valid MECH Staff Member to ${subject.name}.`)
    }
    for (const activity of setup.specialActivities) {
      const teacherId = activityTeacherFor(setup, sectionId, activity.id)
      if (!teacherId || !setup.staff.some((staff) => staff.id === teacherId)) issues.push(`Section ${sectionId}: assign a valid MECH Staff Member to ${activity.name}.`)
    }
  }
  return [...new Set(issues)]
}

function createPlans(setup: TimetableSetup): SectionPlan[] {
  return setup.sections.map(({ id: sectionId }) => {
    const items = [
      ...setup.coreSubjects.map((subject) => makeCoreItem(subject, sectionId, teacherFor(setup, sectionId, subject.id))),
      ...setup.otherSubjects.map((subject) => makeOtherItem(subject, sectionId, teacherFor(setup, sectionId, subject.id))),
      ...setup.labMaster.map((lab) => makeLabItem(lab, sectionId, setup.labAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.labId === lab.id)?.teacherId ?? '')),
      ...setup.specialActivities.map((activity) => makeActivityItem(activity, sectionId, activityTeacherFor(setup, sectionId, activity.id))),
    ]
    return {
      sectionId,
      items,
      byId: new Map(items.map((item) => [item.id, item])),
      occupied: Array<MechItem | null>(48).fill(null),
      remaining: new Map(items.map((item) => [item.id, item.count])),
      placementDay: -1,
      placementStart: -1,
      miniProjectBlockDay: -1,
      testSlots: new Set<number>(),
    }
  })
}

function createBlocks(plans: SectionPlan[]): Block[] {
  return plans.flatMap((plan, sectionIndex) => [
    ...plan.items.filter((item) => item.isPlacement).map((item) => ({ id: `placement:${plan.sectionId}`, type: 'placement' as const, item, sectionIndex })),
    ...plan.items.filter((item) => item.isLab).map((item) => ({ id: item.id, type: 'lab' as const, item, sectionIndex })),
    ...plan.items.filter((item) => item.isMiniProject).map((item) => ({ id: `mini-project:${plan.sectionId}`, type: 'mini-project' as const, item, sectionIndex })),
  ])
}

function makeState(plans: SectionPlan[]): SearchState {
  return {
    plans,
    teacherAtSlot: new Map(),
    labResourceAtSlot: new Map(),
    labDays: new Map(),
    placementDays: new Map(),
    sectionLabDays: new Map(plans.map((plan) => [plan.sectionId, new Set<number>()])),
    projectBlockDay: new Map(),
    searchNodes: 0,
    exceeded: false,
  }
}

function canReserve(state: SearchState, block: Block, candidate: BlockCandidate): boolean {
  const { plan, start, end } = { plan: state.plans[block.sectionIndex], start: candidate.start, end: candidate.start + (block.type === 'mini-project' ? 3 : block.type === 'placement' ? 3 : 2) }
  if (block.type === 'placement' && (state.labDays.get(candidate.day) ?? 0) > 0) return false
  if (block.type === 'lab' && (state.placementDays.get(candidate.day) ?? 0) > 0) return false
  if (block.type === 'lab' && state.sectionLabDays.get(plan.sectionId)?.has(candidate.day)) return false
  if (block.type === 'mini-project' && state.projectBlockDay.has(plan.sectionId)) return false
  const labId = block.type === 'lab' ? block.item.id.split(':').at(-1) ?? '' : ''
  for (let period = start; period <= end; period += 1) {
    const index = slotIndex(candidate.day, period)
    if (plan.occupied[index]) return false
    if (state.teacherAtSlot.get(index)?.has(block.item.teacherId)) return false
    if (labId && state.labResourceAtSlot.get(index)?.has(labId)) return false
  }
  return true
}

function reserve(state: SearchState, block: Block, candidate: BlockCandidate): void {
  const plan = state.plans[block.sectionIndex]
  const length = block.type === 'mini-project' ? 4 : block.type === 'placement' ? 4 : 3
  for (let offset = 0; offset < length; offset += 1) {
    const index = slotIndex(candidate.day, candidate.start + offset)
    plan.occupied[index] = block.item
    plan.remaining.set(block.item.id, (plan.remaining.get(block.item.id) ?? 0) - 1)
    const teachers = state.teacherAtSlot.get(index) ?? new Set<string>()
    teachers.add(block.item.teacherId)
    state.teacherAtSlot.set(index, teachers)
    if (block.type === 'lab') {
      const labId = block.item.id.split(':').at(-1) ?? ''
      const resources = state.labResourceAtSlot.get(index) ?? new Map<string, SectionName>()
      resources.set(labId, plan.sectionId)
      state.labResourceAtSlot.set(index, resources)
    }
  }
  if (block.type === 'placement') {
    plan.placementDay = candidate.day
    plan.placementStart = candidate.start
    state.placementDays.set(candidate.day, (state.placementDays.get(candidate.day) ?? 0) + 1)
  }
  if (block.type === 'lab') {
    state.sectionLabDays.get(plan.sectionId)?.add(candidate.day)
    state.labDays.set(candidate.day, (state.labDays.get(candidate.day) ?? 0) + 1)
  }
  if (block.type === 'mini-project') {
    plan.miniProjectBlockDay = candidate.day
    state.projectBlockDay.set(plan.sectionId, candidate.day)
  }
}

function unreserve(state: SearchState, block: Block, candidate: BlockCandidate): void {
  const plan = state.plans[block.sectionIndex]
  const length = block.type === 'mini-project' ? 4 : block.type === 'placement' ? 4 : 3
  for (let offset = 0; offset < length; offset += 1) {
    const index = slotIndex(candidate.day, candidate.start + offset)
    plan.occupied[index] = null
    plan.remaining.set(block.item.id, (plan.remaining.get(block.item.id) ?? 0) + 1)
    const teachers = state.teacherAtSlot.get(index)
    teachers?.delete(block.item.teacherId)
    if (teachers?.size === 0) state.teacherAtSlot.delete(index)
    if (block.type === 'lab') {
      const resources = state.labResourceAtSlot.get(index)
      resources?.delete(block.item.id.split(':').at(-1) ?? '')
      if (resources?.size === 0) state.labResourceAtSlot.delete(index)
    }
  }
  if (block.type === 'placement') {
    plan.placementDay = -1
    plan.placementStart = -1
    const remaining = (state.placementDays.get(candidate.day) ?? 0) - 1
    if (remaining > 0) state.placementDays.set(candidate.day, remaining)
    else state.placementDays.delete(candidate.day)
  }
  if (block.type === 'lab') {
    const sectionDays = state.sectionLabDays.get(plan.sectionId)
    sectionDays?.delete(candidate.day)
    const remaining = (state.labDays.get(candidate.day) ?? 0) - 1
    if (remaining > 0) state.labDays.set(candidate.day, remaining)
    else state.labDays.delete(candidate.day)
  }
  if (block.type === 'mini-project') {
    plan.miniProjectBlockDay = -1
    state.projectBlockDay.delete(plan.sectionId)
  }
}

function blockCandidates(state: SearchState, block: Block): BlockCandidate[] {
  const starts = block.type === 'placement' ? [1, 5] : block.type === 'lab' ? [2, 6] : [5]
  const candidates = shuffled(days.flatMap((_, day) => shuffled(starts).map((start) => ({ day, start }))))
  return candidates.filter((candidate) => canReserve(state, block, candidate))
}

function assignTests(state: SearchState, setup: TimetableSetup): boolean {
  const plans = shuffled(state.plans)
  const placed: Array<{ plan: SectionPlan; index: number; item: MechItem }> = []
  for (const plan of plans) {
    const coreItems = shuffled(plan.items.filter((item) => item.isCore))
    const placementMorning = plan.placementStart === 1
    const eligibleDays = shuffled(days.map((_, index) => index).filter((index) => !placementMorning || index !== plan.placementDay))
    const testDays = eligibleDays.slice(0, coreItems.length)
    if (testDays.length !== coreItems.length) return false
    for (let testIndex = 0; testIndex < coreItems.length; testIndex += 1) {
      const item = coreItems[testIndex]
      const index = slotIndex(testDays[testIndex], 1)
      if (plan.occupied[index] || state.teacherAtSlot.get(index)?.has(item.teacherId)) {
        for (const previous of placed) {
          previous.plan.occupied[previous.index] = null
          previous.plan.testSlots.delete(previous.index)
          previous.plan.remaining.set(previous.item.id, (previous.plan.remaining.get(previous.item.id) ?? 0) + 1)
          const teachers = state.teacherAtSlot.get(previous.index)
          teachers?.delete(previous.item.teacherId)
          if (teachers?.size === 0) state.teacherAtSlot.delete(previous.index)
        }
        return false
      }
      plan.occupied[index] = item
      plan.testSlots.add(index)
      plan.remaining.set(item.id, (plan.remaining.get(item.id) ?? 0) - 1)
      const teachers = state.teacherAtSlot.get(index) ?? new Set<string>()
      teachers.add(item.teacherId)
      state.teacherAtSlot.set(index, teachers)
      placed.push({ plan, index, item })
    }
    if (!placementMorning) {
      const testDaySet = new Set(testDays)
      const remainingDay = shuffled(days.map((_, index) => index).filter((index) => !testDaySet.has(index)))[0]
      const ictItem = plan.items.find((item) => item.kind === 'other' && isIct(setup.otherSubjects.find((subject) => `other:${plan.sectionId}:${subject.id}` === item.id)!))
      if (remainingDay === undefined || !ictItem || (plan.remaining.get(ictItem.id) ?? 0) <= 0) {
        for (const previous of placed) {
          previous.plan.occupied[previous.index] = null
          previous.plan.testSlots.delete(previous.index)
          previous.plan.remaining.set(previous.item.id, (previous.plan.remaining.get(previous.item.id) ?? 0) + 1)
          const teachers = state.teacherAtSlot.get(previous.index)
          teachers?.delete(previous.item.teacherId)
          if (teachers?.size === 0) state.teacherAtSlot.delete(previous.index)
        }
        return false
      }
      const index = slotIndex(remainingDay, 1)
      if (plan.occupied[index] || state.teacherAtSlot.get(index)?.has(ictItem.teacherId)) {
        for (const previous of placed) {
          previous.plan.occupied[previous.index] = null
          previous.plan.testSlots.delete(previous.index)
          previous.plan.remaining.set(previous.item.id, (previous.plan.remaining.get(previous.item.id) ?? 0) + 1)
          const teachers = state.teacherAtSlot.get(previous.index)
          teachers?.delete(previous.item.teacherId)
          if (teachers?.size === 0) state.teacherAtSlot.delete(previous.index)
        }
        return false
      }
      plan.occupied[index] = ictItem
      plan.remaining.set(ictItem.id, (plan.remaining.get(ictItem.id) ?? 0) - 1)
      const teachers = state.teacherAtSlot.get(index) ?? new Set<string>()
      teachers.add(ictItem.teacherId)
      state.teacherAtSlot.set(index, teachers)
      placed.push({ plan, index, item: ictItem })
    }
  }
  return true
}

function canPlaceSingle(state: SearchState, plan: SectionPlan, item: MechItem, day: number, period: number): boolean {
  const index = slotIndex(day, period)
  if (plan.occupied[index] || state.teacherAtSlot.get(index)?.has(item.teacherId)) return false
  const sameDay = plan.occupied.slice(day * 8, day * 8 + 8)
  const occurrencesToday = sameDay.filter((assigned) => assigned?.id === item.id).length
  if (item.isCore) {
    if (occurrencesToday >= 2) return false
    const adjacent = (period > 1 && plan.occupied[index - 1]?.id === item.id) || (period < 8 && plan.occupied[index + 1]?.id === item.id)
    if (adjacent) {
      for (let otherDay = 0; otherDay < days.length; otherDay += 1) {
        if (otherDay === day) continue
        for (let slot = 1; slot < 8; slot += 1) {
          if (plan.occupied[slotIndex(otherDay, slot)]?.id === item.id && plan.occupied[slotIndex(otherDay, slot + 1)]?.id === item.id) return false
        }
      }
    }
    return !((period > 1 && plan.occupied[index - 1]?.id === item.id && period < 8 && plan.occupied[index + 1]?.id === item.id))
  }
  if (occurrencesToday > 0) return false
  if (item.isMiniProject && (period === 1 || day === plan.miniProjectBlockDay)) return false
  return true
}

function putSingle(state: SearchState, plan: SectionPlan, item: MechItem, day: number, period: number): void {
  const index = slotIndex(day, period)
  plan.occupied[index] = item
  plan.remaining.set(item.id, (plan.remaining.get(item.id) ?? 0) - 1)
  const teachers = state.teacherAtSlot.get(index) ?? new Set<string>()
  teachers.add(item.teacherId)
  state.teacherAtSlot.set(index, teachers)
}

function unputSingle(state: SearchState, plan: SectionPlan, item: MechItem, day: number, period: number): void {
  const index = slotIndex(day, period)
  plan.occupied[index] = null
  plan.remaining.set(item.id, (plan.remaining.get(item.id) ?? 0) + 1)
  const teachers = state.teacherAtSlot.get(index)
  teachers?.delete(item.teacherId)
  if (teachers?.size === 0) state.teacherAtSlot.delete(index)
}

function fillRemaining(state: SearchState): boolean {
  if (++state.searchNodes > nodesPerAttemptLimit) { state.exceeded = true; return false }
  let selectedPlan: SectionPlan | undefined
  let selectedDay = 0
  let selectedPeriod = 0
  let selectedCandidates: MechItem[] = []
  let selectedCount = Number.POSITIVE_INFINITY
  for (const plan of state.plans) {
    for (let day = 0; day < days.length; day += 1) {
      for (const period of periods) {
        const index = slotIndex(day, period)
        if (plan.occupied[index]) continue
        const candidates = plan.items.filter((item) => (plan.remaining.get(item.id) ?? 0) > 0 && !item.isLab && !item.isPlacement && canPlaceSingle(state, plan, item, day, period))
        if (!candidates.length) return false
        const tie = Math.random()
        if (candidates.length < selectedCount || (candidates.length === selectedCount && tie < 0.5)) {
          selectedPlan = plan
          selectedDay = day
          selectedPeriod = period
          selectedCandidates = candidates
          selectedCount = candidates.length
        }
      }
    }
  }
  if (!selectedPlan) return state.plans.every((plan) => plan.occupied.every(Boolean) && [...plan.remaining.values()].every((count) => count === 0))

  const sameDayCoreCount = () => selectedPlan!.occupied.slice(selectedDay * 8, selectedDay * 8 + 8).filter((assigned) => assigned?.isCore).length
  selectedCandidates.sort((left, right) => {
    const adjacency = (item: MechItem) => Number((selectedPeriod > 1 && selectedPlan!.occupied[slotIndex(selectedDay, selectedPeriod - 1)]?.id === item.id)
      || (selectedPeriod < 8 && selectedPlan!.occupied[slotIndex(selectedDay, selectedPeriod + 1)]?.id === item.id))
    const sameDayCount = (item: MechItem) => selectedPlan!.occupied.slice(selectedDay * 8, selectedDay * 8 + 8).filter((assigned) => assigned?.id === item.id).length
    const score = (item: MechItem) => (item.isCore ? sameDayCount(item) * 100 + sameDayCoreCount() * 8 + adjacency(item) * 500 : 0) + (item.count - (selectedPlan!.remaining.get(item.id) ?? 0))
    return score(left) - score(right) || Math.random() - 0.5
  })
  for (const item of selectedCandidates) {
    if (!canPlaceSingle(state, selectedPlan, item, selectedDay, selectedPeriod)) continue
    putSingle(state, selectedPlan, item, selectedDay, selectedPeriod)
    if (fillRemaining(state)) return true
    unputSingle(state, selectedPlan, item, selectedDay, selectedPeriod)
    if (state.exceeded) return false
  }
  return false
}

function scheduleSignature(section: GeneratedSection): string {
  return days.flatMap((day) => periods.map((period) => {
    const cell = section.schedule[day]?.[period]
    return `${cell?.kind ?? ''}:${cell?.code ?? ''}:${cell?.name ?? ''}`
  })).join('|')
}

function generatedFromState(state: SearchState): GeneratedSection[] {
  return state.plans.map((plan) => {
    const schedule = Object.fromEntries(days.map((day) => [day, {}])) as GeneratedSection['schedule']
    for (const dayIndex of days.keys()) {
      for (const period of periods) {
        const index = slotIndex(dayIndex, period)
        const item = plan.occupied[index]!
        schedule[days[dayIndex]][period] = {
          itemId: item.id,
          code: item.code,
          abbreviation: `${item.abbreviation}${plan.testSlots.has(index) ? ' (T)' : ''}`,
          name: item.name,
          teacherId: item.teacherId,
          kind: item.kind,
        }
      }
    }
    return { sectionId: plan.sectionId, schedule }
  })
}

export function validateMechGeneratedTimetables(setup: TimetableSetup, generatedSections: GeneratedSection[]): { summary: TimetableValidationSummary; issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const warnings: string[] = []
  let globalTeacherClashes = 0
  const sectionSummaries: TimetableValidationSummary['sections'] = []
  const expectedSections = setup.sections.map((section) => section.id)
  if (generatedSections.length !== expectedSections.length || expectedSections.some((id) => !generatedSections.some((generated) => generated.sectionId === id))) {
    issues.push('Generated sections do not match the selected MECH section count.')
  }
  const teacherSlots = new Map<string, Map<string, Set<SectionName>>>()
  const labResources = new Map<string, SectionName>()
  const labDaysBySection = new Map<SectionName, Set<WeekDay>>()
  const globalLabDays = new Set<WeekDay>()
  const placementDays = new Set<WeekDay>()

  for (const sectionId of expectedSections) {
    const generated = generatedSections.find((section) => section.sectionId === sectionId)
    let periodsFilled = 0
    let coreHoursValid = true
    let otherSubjectHoursValid = true
    let labAllocationValid = true
    if (!generated) {
      issues.push(`Section ${sectionId} is missing from the MECH schedule.`)
      sectionSummaries.push({ sectionId, periodsFilled, coreHoursValid: false, otherSubjectHoursValid: false, labAllocationValid: false })
      continue
    }
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
        const key = `${day}:P${period}`
        const teachers = teacherSlots.get(key) ?? new Map<string, Set<SectionName>>()
        const sectionsAtSlot = teachers.get(cell.teacherId) ?? new Set<SectionName>()
        sectionsAtSlot.add(sectionId)
        teachers.set(cell.teacherId, sectionsAtSlot)
        teacherSlots.set(key, teachers)
        if (cell.kind === 'lab') {
          const resourceId = cell.itemId.split(':').at(-1) ?? ''
          const resourceKey = `${key}:${resourceId}`
          const previousSection = labResources.get(resourceKey)
          if (previousSection && previousSection !== sectionId) {
            labAllocationValid = false
            issues.push(`Lab resource ${resourceId} is used by Sections ${previousSection} and ${sectionId} at ${day} P${period}.`)
          } else labResources.set(resourceKey, sectionId)
        }
      }
    }
    if (periodsFilled !== 48) issues.push(`Section ${sectionId} has ${periodsFilled}/48 teaching periods.`)

    const testSubjects = new Set<string>()
    const testDays = new Set<WeekDay>()
    let nonTestP1Count = 0
    for (const day of days) {
      const p1 = generated.schedule[day]?.[1]
      if (!p1) continue
      if (p1.kind === 'core' && p1.abbreviation.endsWith(' (T)')) {
        testSubjects.add(p1.itemId)
        testDays.add(day)
      } else {
        nonTestP1Count += 1
        const isPlacementP1 = p1.kind === 'activity' && /\bplacement\b/i.test(p1.name)
        const isIctP1 = p1.kind === 'other' && /\bICT\b/i.test(p1.abbreviation)
        if (!isPlacementP1 && !isIctP1) issues.push(`Section ${sectionId} ${day} P1 must be a Core Test, ICT exception, or morning Placement.`)
      }
    }
    if (testSubjects.size !== setup.coreSubjects.length || testDays.size !== setup.coreSubjects.length || nonTestP1Count !== 1) {
      issues.push(`Section ${sectionId} must have each Core subject tested once on a different P1 day and exactly one permitted P1 exception.`)
    }
    for (const subject of setup.coreSubjects) {
      const id = `core:${sectionId}:${subject.id}`
      if ((counts.get(id) ?? 0) !== subject.hoursPerWeek) {
        coreHoursValid = false
        issues.push(`Section ${sectionId} ${subject.name} has ${counts.get(id) ?? 0}/${subject.hoursPerWeek} periods.`)
      }
      const consecutiveDays = new Set<WeekDay>()
      for (const day of days) {
        const assigned = periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id)
        if (assigned.length > 2) {
          coreHoursValid = false
          issues.push(`Section ${sectionId} ${subject.name} occurs more than twice on ${day}.`)
        }
        let run = 1
        for (let index = 1; index < assigned.length; index += 1) {
          run = assigned[index] === assigned[index - 1] + 1 ? run + 1 : 1
          if (run > 2) {
            coreHoursValid = false
            issues.push(`Section ${sectionId} ${subject.name} has more than two consecutive periods on ${day}.`)
          }
        }
        if (assigned.some((period, index) => index > 0 && period === assigned[index - 1] + 1)) consecutiveDays.add(day)
      }
      if (consecutiveDays.size > 1) {
        coreHoursValid = false
        issues.push(`Section ${sectionId} ${subject.name} has consecutive repetition on more than one day.`)
      }
    }

    for (const subject of setup.otherSubjects) {
      const id = `other:${sectionId}:${subject.id}`
      if ((counts.get(id) ?? 0) !== subject.hoursPerWeek) {
        otherSubjectHoursValid = false
        issues.push(`Section ${sectionId} ${subject.name} has ${counts.get(id) ?? 0}/${subject.hoursPerWeek} periods.`)
      }
      for (const day of days) {
        if (periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id).length > 1) {
          otherSubjectHoursValid = false
          issues.push(`Section ${sectionId} ${subject.name} repeats on ${day}.`)
        }
      }
    }

    const sectionLabDays = new Set<WeekDay>()
    for (const lab of setup.labMaster) {
      const id = `lab:${sectionId}:${lab.id}`
      const labCells = days.flatMap((day) => periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id).map((period) => ({ day, period })))
      const labDates = new Set(labCells.map((cell) => cell.day))
      const labPeriods = labCells.map((cell) => cell.period).sort((a, b) => a - b)
      const allowed = (labPeriods.join(',') === '2,3,4' || labPeriods.join(',') === '6,7,8') && labDates.size === 1 && labPeriods.length === 3
      if (!allowed) {
        labAllocationValid = false
        issues.push(`Section ${sectionId} ${lab.name} must occupy exactly P2-P4 or P6-P8 on one day.`)
      }
      labCells.forEach((cell) => sectionLabDays.add(cell.day))
    }
    if (sectionLabDays.size !== setup.labMaster.length) {
      labAllocationValid = false
      issues.push(`Section ${sectionId} Labs must occur on different days.`)
    }
    labDaysBySection.set(sectionId, sectionLabDays)
    for (const day of sectionLabDays) globalLabDays.add(day)

    const placement = setup.specialActivities.find(isPlacement)
    const placementId = placement ? `activity:${sectionId}:${placement.id}` : ''
    const placementCells = days.flatMap((day) => periods.filter((period) => generated.schedule[day]?.[period]?.itemId === placementId).map((period) => ({ day, period })))
    const placementPeriods = placementCells.map((cell) => cell.period).sort((a, b) => a - b)
    if (placementCells.length !== 4 || new Set(placementCells.map((cell) => cell.day)).size !== 1 || !['1,2,3,4', '5,6,7,8'].includes(placementPeriods.join(','))) {
      issues.push(`Section ${sectionId} Placement must occupy exactly P1-P4 or P5-P8 on one day.`)
    }
    placementCells.forEach((cell) => placementDays.add(cell.day))

    const project = setup.specialActivities.find(isMiniProject)
    const projectId = project ? `activity:${sectionId}:${project.id}` : ''
    const projectCells = days.flatMap((day) => periods.filter((period) => generated.schedule[day]?.[period]?.itemId === projectId).map((period) => ({ day, period })))
    const projectBlockDays = days.filter((day) => [5, 6, 7, 8].every((period) => generated.schedule[day]?.[period]?.itemId === projectId))
    const projectStandalone = projectCells.filter((cell) => !projectBlockDays.some((day) => day === cell.day))
    if (projectCells.length !== 5 || projectBlockDays.length !== 1 || projectStandalone.length !== 1 || projectStandalone[0].period === 1 || projectStandalone[0].day === projectBlockDays[0]) {
      issues.push(`Section ${sectionId} Mini Project must be one P5-P8 block plus one period on another day, not P1.`)
    }

    for (const activity of setup.specialActivities) {
      const id = `activity:${sectionId}:${activity.id}`
      if ((counts.get(id) ?? 0) !== activity.hoursPerWeek) issues.push(`Section ${sectionId} ${activity.name} has ${counts.get(id) ?? 0}/${activity.hoursPerWeek} periods.`)
    }
    for (const activity of setup.specialActivities.filter((item) => isLibrary(item) || isMentoring(item))) {
      if ((counts.get(`activity:${sectionId}:${activity.id}`) ?? 0) !== 1) issues.push(`Section ${sectionId} ${activity.name} must occur exactly once.`)
    }
    sectionSummaries.push({ sectionId, periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid })
  }

  for (const day of days) {
    if (globalLabDays.has(day) && placementDays.has(day)) issues.push(`${day} cannot contain both Lab and Placement blocks.`)
  }
  for (const [time, teachers] of teacherSlots) {
    for (const [teacherId, sectionsAtSlot] of teachers) {
      if (sectionsAtSlot.size < 2) continue
      globalTeacherClashes += 1
      issues.push(`MECH teacher clash: ${setup.staff.find((member) => member.id === teacherId)?.name ?? teacherId} is assigned to Sections ${[...sectionsAtSlot].join(', ')} at ${time}.`)
    }
  }

  return { summary: { sections: sectionSummaries, globalTeacherClashes }, issues: [...new Set(issues)], warnings }
}

function search(setup: TimetableSetup, state: SearchState, blocks: Block[], assigned: Set<string>): boolean {
  if (++state.searchNodes > nodesPerAttemptLimit) { state.exceeded = true; return false }
  const remaining = blocks.filter((block) => !assigned.has(block.id))
  if (remaining.length === 0) {
    if (!assignTests(state, setup)) return false
    if (fillRemaining(state)) {
      const generated = generatedFromState(state)
      const signatures = generated.map(scheduleSignature)
      return signatures.length === new Set(signatures).size
    }
    // fillRemaining backtracks all its singles on failure. Test slots are then removed below.
    for (const plan of state.plans) {
      for (const index of [...plan.testSlots]) {
        const item = plan.occupied[index]
        if (!item) continue
        plan.occupied[index] = null
        plan.testSlots.delete(index)
        plan.remaining.set(item.id, (plan.remaining.get(item.id) ?? 0) + 1)
        const teachers = state.teacherAtSlot.get(index)
        teachers?.delete(item.teacherId)
        if (teachers?.size === 0) state.teacherAtSlot.delete(index)
      }
      // P1 ICT fallback periods are not Core test slots; remove them on failed attempts too.
      for (const planDay of days.keys()) {
        const index = slotIndex(planDay, 1)
        const item = plan.occupied[index]
        if (item?.kind === 'other') {
          plan.occupied[index] = null
          plan.remaining.set(item.id, (plan.remaining.get(item.id) ?? 0) + 1)
          const teachers = state.teacherAtSlot.get(index)
          teachers?.delete(item.teacherId)
          if (teachers?.size === 0) state.teacherAtSlot.delete(index)
        }
      }
    }
    return false
  }

  let selected: Block | undefined
  let candidates: BlockCandidate[] = []
  for (const block of remaining) {
    const options = blockCandidates(state, block)
    if (!selected || options.length < candidates.length) { selected = block; candidates = options }
    if (options.length === 0) return false
  }
  if (!selected) return false
  for (const candidate of candidates) {
    if (!canReserve(state, selected, candidate)) continue
    reserve(state, selected, candidate)
    assigned.add(selected.id)
    if (search(setup, state, blocks, assigned)) return true
    assigned.delete(selected.id)
    unreserve(state, selected, candidate)
    if (state.exceeded) return false
  }
  return false
}

export function generateMechTimetables(setup: TimetableSetup): TimetableGenerationResult {
  const issues = configurationIssues(setup)
  if (issues.length) return { ok: false, code: 'INVALID_INPUT', message: 'MECH timetable configuration is incomplete or invalid.', blockingConstraints: issues }
  const blocks = createBlocks(createPlans(setup))
  let totalNodes = 0
  let exceeded = false
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    const state = makeState(createPlans(setup))
    const success = search(setup, state, blocks.map((block) => ({ ...block, item: state.plans[block.sectionIndex].byId.get(block.item.id)! })), new Set())
    totalNodes += state.searchNodes
    exceeded ||= state.exceeded
    if (!success) continue
    const sections = generatedFromState(state)
    const validation = validateMechGeneratedTimetables(setup, sections)
    if (!validation.issues.length) return { ok: true, sections, searchNodes: totalNodes, validation: validation.summary }
  }
  return {
    ok: false,
    code: exceeded ? 'SEARCH_LIMIT' : 'UNSATISFIABLE',
    message: 'MECH timetable could not be generated after randomized valid attempts.',
    blockingConstraints: [
      `The solver tried ${attemptLimit} randomized candidates (${totalNodes.toLocaleString()} search nodes).`,
      'No partial timetable was returned; review the configured teacher assignments and global block availability.',
    ],
  }
}
