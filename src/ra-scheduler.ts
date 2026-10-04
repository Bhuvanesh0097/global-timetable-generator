import type { CoreSubject, OtherSubject, SectionName, TimetableSetup, WeekDay } from './models'
import type { GeneratedSection, ScheduledCell, TimetableGenerationResult, TimetableValidationSummary } from './scheduler.ts'

const sectionId: SectionName = 'A'
const days: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const periods = Array.from({ length: 8 }, (_, index) => index + 1)
const slots = days.flatMap((_, dayIndex) => periods.map((period) => ({ dayIndex, period, index: dayIndex * 8 + period - 1 })))
const labStarts = [2, 3, 6, 7]
const placementStarts = [1, 5]
const searchNodeLimit = 300_000

interface RaItem {
  id: string
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

function failure(code: Extract<TimetableGenerationResult, { ok: false }>['code'], blockingConstraints: string[]): TimetableGenerationResult {
  return { ok: false, code, message: 'RA timetable could not be generated with the current configuration.', blockingConstraints }
}

function validTeacher(setup: TimetableSetup, teacherId: string): boolean {
  return Boolean(teacherId && setup.staff.some((member) => member.id === teacherId && member.name.trim()))
}

function subjectItem(item: CoreSubject | OtherSubject, kind: 'core' | 'other', teacherId: string): RaItem {
  return {
    id: `${kind}:A:${item.id}`, code: item.code, abbreviation: item.abbreviation,
    name: item.name, teacherId, kind, count: item.hoursPerWeek,
    isCore: kind === 'core', isLab: false, isPlacement: false,
  }
}

function isPlacementActivity(id: string, name: string): boolean {
  return id === 'ra-placement' || name.trim().toLowerCase() === 'placement'
}

function assignment(setup: TimetableSetup, subjectId: string): string {
  return setup.sectionSubjectAssignments.find((entry) => entry.sectionId === sectionId && entry.subjectId === subjectId)?.teacherId ?? ''
}

function validateInputs(setup: TimetableSetup): { issues: string[]; items: RaItem[]; labs: RaItem[]; placement?: RaItem } {
  const issues: string[] = []
  const items: RaItem[] = []
  const labs: RaItem[] = []
  const coreTeachers = new Map<string, string>()
  const labTeachers = new Map<string, string>()
  if (setup.academic.year !== 'III / 3rd Year' || setup.academic.semester !== 'V / 5th Semester') {
    issues.push('RA generation is configured only for 3rd Year Odd.')
  }
  if (setup.sections.length !== 1 || setup.sections[0]?.id !== sectionId) {
    issues.push('RA generation requires its fixed Section A only.')
  }
  for (const subject of setup.coreSubjects) {
    if (!subject.code.trim() || !subject.name.trim() || !subject.abbreviation.trim() || !Number.isInteger(subject.hoursPerWeek) || subject.hoursPerWeek <= 0) {
      issues.push(`${subject.name || 'Each Core subject'} needs a code, name, abbreviation, and positive whole-number weekly hours.`)
    }
    const teacherId = assignment(setup, subject.id)
    if (!validTeacher(setup, teacherId)) issues.push(`Section A: assign a valid RA Staff Member to ${subject.name}.`)
    const prior = coreTeachers.get(teacherId)
    if (teacherId && prior && prior !== subject.id) issues.push(`Section A: one teacher cannot be assigned to multiple Core subjects (${setup.coreSubjects.find((candidate) => candidate.id === prior)?.name} and ${subject.name}).`)
    if (teacherId) coreTeachers.set(teacherId, subject.id)
    items.push(subjectItem(subject, 'core', teacherId))
  }
  for (const subject of setup.otherSubjects) {
    if (!subject.code.trim() || !subject.name.trim() || !subject.abbreviation.trim() || !Number.isInteger(subject.hoursPerWeek) || subject.hoursPerWeek <= 0) {
      issues.push(`${subject.name || 'Each Other Subject'} needs a code, name, abbreviation, and positive whole-number weekly hours.`)
    }
    const teacherId = assignment(setup, subject.id)
    if (!validTeacher(setup, teacherId)) issues.push(`Section A: assign a valid RA Staff Member to ${subject.name}.`)
    items.push(subjectItem(subject, 'other', teacherId))
  }
  for (const lab of setup.labMaster) {
    if (!lab.code.trim() || !lab.name.trim() || !lab.abbreviation.trim()) issues.push(`${lab.name || 'Each Lab'} needs a code, name, and abbreviation.`)
    if (lab.weeklyPeriods !== 2) issues.push(`${lab.name} must be configured for exactly 2 weekly periods under the RA Lab exception.`)
    const teacherId = setup.labAssignments.find((entry) => entry.sectionId === sectionId && entry.labId === lab.id)?.teacherId ?? ''
    if (!validTeacher(setup, teacherId)) issues.push(`Section A: assign a valid RA Staff Member to ${lab.name}.`)
    const prior = labTeachers.get(teacherId)
    if (teacherId && prior && prior !== lab.id) issues.push(`Section A: ${setup.staff.find((member) => member.id === teacherId)?.name} cannot be assigned to more than one Lab.`)
    if (teacherId) labTeachers.set(teacherId, lab.id)
    labs.push({ id: `lab:A:${lab.id}`, code: lab.code, abbreviation: lab.abbreviation, name: lab.name, teacherId, kind: 'lab', count: lab.weeklyPeriods, isCore: false, isLab: true, isPlacement: false })
  }
  if (setup.labMaster.length !== 3) issues.push('RA requires exactly three configured Labs.')

  const placementActivities = setup.specialActivities.filter((item) => isPlacementActivity(item.id, item.name))
  if (placementActivities.length !== 1) issues.push('RA requires exactly one Placement activity.')
  let placement: RaItem | undefined
  for (const activity of setup.specialActivities) {
    const teacherId = setup.specialActivityAssignments.find((entry) => entry.sectionId === sectionId && entry.activityId === activity.id)?.teacherId ?? ''
    if (!activity.name.trim() || !Number.isInteger(activity.hoursPerWeek) || activity.hoursPerWeek <= 0) {
      issues.push(`${activity.name || 'Each Special Activity'} needs a name and positive whole-number weekly hours.`)
    }
    if (!validTeacher(setup, teacherId)) issues.push(`Section A: assign a valid RA Staff Member to ${activity.name}.`)
    const isPlacement = isPlacementActivity(activity.id, activity.name)
    if (isPlacement && activity.hoursPerWeek !== 4) issues.push('RA Placement must be configured for exactly 4 periods per week.')
    const item: RaItem = {
      id: `activity:A:${activity.id}`, code: '', abbreviation: activity.name,
      name: activity.name, teacherId, kind: 'activity', count: activity.hoursPerWeek,
      isCore: false, isLab: false, isPlacement,
    }
    if (isPlacement) placement = item
    else items.push(item)
  }
  const configuredHours = [...items, ...labs, ...(placement ? [placement] : [])].reduce((total, item) => total + item.count, 0)
  if (configuredHours !== 48) issues.push(`RA has ${configuredHours} configured weekly periods; exactly 48 are required to fill Section A without FREE periods.`)
  return { issues: [...new Set(issues)], items, labs, placement }
}

function raValidation(setup: TimetableSetup, generatedSections: GeneratedSection[]): { summary: TimetableValidationSummary; issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const summaries: TimetableValidationSummary['sections'] = []
  let globalTeacherClashes = 0
  if (generatedSections.length !== 1 || generatedSections[0]?.sectionId !== sectionId) issues.push('Generated schedule must contain only fixed Section A.')
  const globalTeachers = new Map<string, Set<string>>()

  for (const generated of generatedSections) {
    let periodsFilled = 0
    let coreHoursValid = true
    let otherSubjectHoursValid = true
    let labAllocationValid = true
    const counts = new Map<string, number>()
    const labDays = new Set<WeekDay>()
    const labsPerDay = new Map<WeekDay, Set<string>>()
    const placementDays = new Set<WeekDay>()

    for (const day of days) {
      const p1 = generated.schedule[day]?.[1]
      if (p1?.kind === 'core' && days.some((otherDay) => otherDay !== day && generated.schedule[otherDay]?.[1]?.itemId === p1.itemId)) {
        issues.push(`Section A P1 repeats ${p1.name}; Core test subjects in P1 must differ by day.`)
      }
      const activityById = new Map<string, number[]>()
      const labsById = new Map<string, number[]>()
      for (const period of periods) {
        const cell = generated.schedule[day]?.[period]
        if (!cell || !cell.abbreviation.trim() || !validTeacher(setup, cell.teacherId)) {
          issues.push(`Section A ${day} P${period} is empty or has an invalid teacher assignment.`)
          continue
        }
        periodsFilled += 1
        counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1)
        const teacherKey = `${day}:P${period}`
        const teachers = globalTeachers.get(teacherKey) ?? new Set<string>()
        if (teachers.has(cell.teacherId)) globalTeacherClashes += 1
        teachers.add(cell.teacherId)
        globalTeachers.set(teacherKey, teachers)
        if (cell.kind === 'lab') {
          labDays.add(day)
          const dayLabs = labsPerDay.get(day) ?? new Set<string>()
          dayLabs.add(cell.itemId)
          labsPerDay.set(day, dayLabs)
          const ids = labsById.get(cell.itemId) ?? []
          ids.push(period)
          labsById.set(cell.itemId, ids)
        }
        if (cell.kind === 'activity') {
          const ids = activityById.get(cell.itemId) ?? []
          ids.push(period)
          activityById.set(cell.itemId, ids)
          if (cell.itemId.endsWith(':ra-placement')) placementDays.add(day)
        }
        if (cell.kind === 'core') {
          const occurrences = periods.filter((candidate) => generated.schedule[day]?.[candidate]?.itemId === cell.itemId)
          if (occurrences.length > 2) {
            coreHoursValid = false
            issues.push(`Section A ${cell.name} occurs more than twice on ${day}.`)
          }
          let run = 1
          for (let candidate = 2; candidate <= 8; candidate += 1) {
            if (generated.schedule[day]?.[candidate]?.itemId === cell.itemId && generated.schedule[day]?.[candidate - 1]?.itemId === cell.itemId) run += 1
            else run = 1
            if (run > 2) {
              coreHoursValid = false
              issues.push(`Section A ${cell.name} exceeds the 2-period consecutive limit on ${day}.`)
              break
            }
          }
        }
      }
      for (const [activityId, activityPeriods] of activityById) {
        const activity = setup.specialActivities.find((item) => `activity:A:${item.id}` === activityId)
        if (activity && !isPlacementActivity(activity.id, activity.name) && activityPeriods.length > 1) {
          issues.push(`Section A ${activity.name} repeats on ${day}; special activities are limited to one period per day.`)
        }
      }
      for (const [labId, labPeriods] of labsById) {
        const lab = setup.labMaster.find((item) => `lab:A:${item.id}` === labId)
        const start = Math.min(...labPeriods)
        const validBlock = labPeriods.length === 2 && (start === 2 || start === 3 || start === 6 || start === 7) && labPeriods[1] === start + 1
        if (!validBlock) {
          labAllocationValid = false
          issues.push(`Section A ${lab?.name ?? labId} is not a valid contiguous 2-period RA Lab block after P1 and outside lunch.`)
        }
      }
    }

    if (periodsFilled !== 48) issues.push(`Section A has ${periodsFilled}/48 assigned teaching periods; FREE periods are not allowed.`)
    for (const subject of setup.coreSubjects) {
      const id = `core:A:${subject.id}`
      if ((counts.get(id) ?? 0) !== subject.hoursPerWeek) {
        coreHoursValid = false
        issues.push(`Section A ${subject.name} has ${counts.get(id) ?? 0}/${subject.hoursPerWeek} periods.`)
      }
    }
    for (const subject of setup.otherSubjects) {
      const id = `other:A:${subject.id}`
      if ((counts.get(id) ?? 0) !== subject.hoursPerWeek) {
        otherSubjectHoursValid = false
        issues.push(`Section A ${subject.name} has ${counts.get(id) ?? 0}/${subject.hoursPerWeek} periods.`)
      }
    }
    if (labDays.size !== 3 || [...labsPerDay.values()].some((dayLabs) => dayLabs.size !== 1)) {
      labAllocationValid = false
      issues.push('Section A Labs must occupy three distinct days, with no more than one Lab per day.')
    }
    for (const lab of setup.labMaster) {
      const id = `lab:A:${lab.id}`
      if ((counts.get(id) ?? 0) !== 2 || lab.weeklyPeriods !== 2) {
        labAllocationValid = false
        issues.push(`Section A ${lab.name} must have exactly its configured 2-period RA Lab block.`)
      }
    }
    const placements = setup.specialActivities.filter((item) => isPlacementActivity(item.id, item.name))
    if (placements.length !== 1) issues.push('Section A requires exactly one Placement activity.')
    for (const activity of setup.specialActivities) {
      const id = `activity:A:${activity.id}`
      if ((counts.get(id) ?? 0) !== activity.hoursPerWeek) issues.push(`Section A ${activity.name} has ${counts.get(id) ?? 0}/${activity.hoursPerWeek} periods.`)
      if (isPlacementActivity(activity.id, activity.name)) {
        const placementPeriods = days.flatMap((day) => periods.filter((period) => generated.schedule[day]?.[period]?.itemId === id).map((period) => ({ day, period })))
        const start = Math.min(...placementPeriods.map((entry) => entry.period))
        if (placementPeriods.length !== 4 || placementDays.size !== 1 || !placementPeriods.every((entry, index) => entry.period === start + index) || !(start === 1 || start === 5)) {
          issues.push('Section A Placement must be one 4-period block in P1-P4 or P5-P8 on one day.')
        }
        if ([...placementDays].some((day) => labDays.has(day))) issues.push('Section A Placement cannot share a day with an RA Lab.')
      }
    }
    summaries.push({ sectionId: generated.sectionId, periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid })
  }
  if (globalTeacherClashes) issues.push('RA timetable contains a teacher clash.')
  return { summary: { sections: summaries, globalTeacherClashes }, issues: [...new Set(issues)], warnings: [] }
}

export function validateRaGeneratedTimetables(setup: TimetableSetup, generatedSections: GeneratedSection[]) {
  return raValidation(setup, generatedSections)
}

export function generateRaTimetables(setup: TimetableSetup): TimetableGenerationResult {
  const input = validateInputs(setup)
  if (input.issues.length || !input.placement) return failure('INVALID_INPUT', input.issues.length ? input.issues : ['RA requires a Placement activity.'])

  const labs = input.labs
  const placement = input.placement
  const singles = input.items
  const search = (): { generated?: GeneratedSection[]; nodes: number } => {
    const occupied: Array<RaItem | null> = Array.from({ length: 48 }, () => null)
    const randomizedSlots = [...slots]
    const shuffle = <T,>(values: T[]) => {
      for (let index = values.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1))
        ;[values[index], values[swap]] = [values[swap], values[index]]
      }
      return values
    }
    shuffle(randomizedSlots)
    let nodes = 0
    const labDays = new Set<number>()

    const coreP1AlreadyUsed = (item: RaItem, dayIndex: number) => days.some((_, otherDay) => otherDay !== dayIndex && occupied[otherDay * 8]?.id === item.id)
    const canPlaceSingle = (item: RaItem, slot: typeof slots[number]) => {
      if (occupied[slot.index]) return false
      const day = occupied.slice(slot.dayIndex * 8, slot.dayIndex * 8 + 8)
      if (item.isCore) {
        if (slot.period === 1 && coreP1AlreadyUsed(item, slot.dayIndex)) return false
        if (day.filter((entry) => entry?.id === item.id).length >= 2) return false
        let run = 1
        for (let period = slot.period - 1; period >= 1 && day[period - 1]?.id === item.id; period -= 1) run += 1
        for (let period = slot.period + 1; period <= 8 && day[period - 1]?.id === item.id; period += 1) run += 1
        if (run > 2) return false
      } else if (day.some((entry) => entry?.id === item.id)) return false
      return true
    }

    const fillSingles = (): boolean => {
      if (++nodes > searchNodeLimit) return false
      let bestSlot: typeof slots[number] | undefined
      let bestCandidates: RaItem[] = []
      for (const slot of randomizedSlots) {
        if (occupied[slot.index]) continue
        const candidates = singles.filter((item) => item.count > 0 && canPlaceSingle(item, slot))
        if (!candidates.length) return false
        if (!bestSlot || candidates.length < bestCandidates.length) {
          bestSlot = slot
          bestCandidates = candidates
        }
      }
      if (!bestSlot) return true
      const rank = (item: RaItem) => {
        const day = occupied.slice(bestSlot!.dayIndex * 8, bestSlot!.dayIndex * 8 + 8)
        const sameDay = day.filter((entry) => entry?.id === item.id).length
        const coreLoad = day.filter((entry) => entry?.isCore).length
        const adjacent = Number(bestSlot!.period > 1 && day[bestSlot!.period - 2]?.id === item.id)
          + Number(bestSlot!.period < 8 && day[bestSlot!.period]?.id === item.id)
        const distribution = item.isCore ? sameDay * 1000 + coreLoad * 20 + adjacent * 5 : adjacent * 10
        return distribution + Math.random()
      }
      bestCandidates.sort((left, right) => rank(left) - rank(right))
      for (const item of bestCandidates) {
        if (!canPlaceSingle(item, bestSlot)) continue
        item.count -= 1
        occupied[bestSlot.index] = item
        const stillSchedulable = singles.filter((candidate) => candidate.count > 0).every((candidate) => randomizedSlots.some((slot) => !occupied[slot.index] && canPlaceSingle(candidate, slot)))
        if (stillSchedulable && fillSingles()) return true
        occupied[bestSlot.index] = null
        item.count += 1
        if (nodes > searchNodeLimit) return false
      }
      return false
    }

    const placePlacement = (): boolean => {
      const dayOrder = shuffle(days.map((_, index) => index).filter((index) => !labDays.has(index)))
      for (const dayIndex of dayOrder) {
        for (const start of shuffle([...placementStarts])) {
          const run = [0, 1, 2, 3].map((offset) => dayIndex * 8 + start + offset - 1)
          if (!run.every((index) => !occupied[index])) continue
          for (const index of run) occupied[index] = placement
          if (fillSingles()) return true
          for (const index of run) occupied[index] = null
          if (nodes > searchNodeLimit) return false
        }
      }
      return false
    }

    const placeLabs = (pending: RaItem[]): boolean => {
      if (++nodes > searchNodeLimit) return false
      if (!pending.length) return placePlacement()
      let selected: RaItem | undefined
      let options: Array<{ day: number; start: number; indexes: number[] }> = []
      for (const lab of pending) {
        const candidates = days.flatMap((_, day) => labDays.has(day) ? [] : labStarts.flatMap((start) => {
          const indexes = [day * 8 + start - 1, day * 8 + start]
          return indexes.every((index) => !occupied[index]) ? [{ day, start, indexes }] : []
        }))
        if (!selected || candidates.length < options.length) { selected = lab; options = candidates }
        if (!options.length) return false
      }
      if (!selected) return false
      for (const candidate of shuffle(options)) {
        for (const index of candidate.indexes) occupied[index] = selected
        labDays.add(candidate.day)
        if (placeLabs(pending.filter((lab) => lab.id !== selected!.id))) return true
        labDays.delete(candidate.day)
        for (const index of candidate.indexes) occupied[index] = null
        if (nodes > searchNodeLimit) return false
      }
      return false
    }

    const success = placeLabs([...labs])
    if (!success) return { nodes }
    const schedule = Object.fromEntries(days.map((day) => [day, {}])) as GeneratedSection['schedule']
    for (const slot of slots) {
      const item = occupied[slot.index]
      if (!item) return { nodes }
      schedule[days[slot.dayIndex]][slot.period] = {
        itemId: item.id, code: item.code, abbreviation: item.abbreviation,
        name: item.name, teacherId: item.teacherId, kind: item.kind,
      }
    }
    return { generated: [{ sectionId, schedule }], nodes }
  }

  let totalSearchNodes = 0
  let generatedSections: GeneratedSection[] | undefined
  for (let attempt = 0; attempt < 3 && !generatedSections; attempt += 1) {
    const result = search()
    totalSearchNodes += result.nodes
    generatedSections = result.generated
  }
  if (!generatedSections) return failure('UNSATISFIABLE', [`RA search could not place the configured activities and two-period Labs within ${totalSearchNodes.toLocaleString()} search nodes.`, 'No partial timetable was returned.'])

  const { summary, issues } = raValidation(setup, generatedSections)
  if (issues.length) return failure('UNSATISFIABLE', [...issues, 'No partial timetable was returned.'])
  return { ok: true, sections: generatedSections, searchNodes: totalSearchNodes, validation: summary }
}
