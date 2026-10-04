import type { CoreSubject, OtherSubject, SectionName, TimetableSetup, WeekDay } from './models'
import type { GeneratedSection, ScheduledCell, TimetableGenerationResult, TimetableValidationSummary } from './scheduler'

const sectionId: SectionName = 'A'
const days: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const periods = [1, 2, 3, 4, 5, 6, 7, 8]
const nodeLimit = 100_000
const attempts = 20

interface FtItem {
  id: string
  code: string
  abbreviation: string
  name: string
  teacherIds: string[]
  kind: ScheduledCell['kind']
  count: number
}

interface Candidate {
  item: FtItem
  teacherId: string
}

type Grid = Array<Array<ScheduledCell | null>>

function shuffled<T>(values: T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

function failure(blockingConstraints: string[], code: 'INVALID_INPUT' | 'UNSATISFIABLE' | 'SEARCH_LIMIT' = 'INVALID_INPUT'): TimetableGenerationResult {
  return { ok: false, code, message: 'FT timetable could not be generated with the current configuration.', blockingConstraints }
}

function assignedTeacherIds(setup: TimetableSetup, subjectId: string): string[] {
  return setup.sectionSubjectAssignments
    .filter((assignment) => assignment.sectionId === sectionId && assignment.subjectId === subjectId)
    .map((assignment) => assignment.teacherId)
    .filter(Boolean)
}

function assignedLabTeacher(setup: TimetableSetup, labId: string): string {
  return setup.labAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.labId === labId)?.teacherId ?? ''
}

function assignedActivityTeacher(setup: TimetableSetup, activityId: string): string {
  return setup.specialActivityAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.activityId === activityId)?.teacherId ?? ''
}

function validTeacher(setup: TimetableSetup, teacherId: string): boolean {
  return Boolean(teacherId && setup.staff.some((member) => member.id === teacherId && member.name.trim()))
}

export function validateFtConfiguration(setup: TimetableSetup): string[] {
  const issues: string[] = []
  if (setup.academic.department !== 'FT' || setup.academic.year !== 'III / 3rd Year' || setup.academic.semester !== 'V / 5th Semester') {
    issues.push('The FT scheduler is available only for 3rd Year Odd.')
  }
  if (setup.academic.academicYear !== '2026 - 2027') issues.push('FT 3rd Year Odd must use Academic Year 2026-2027.')
  if (setup.sections.length !== 1 || setup.sections[0]?.id !== 'A') issues.push('FT 3rd Year Odd supports only its fixed Section A.')

  const expectedCoreHours = new Map([
    ['ft-core-fa', 5], ['ft-core-eft', 5], ['ft-core-rccm', 6],
    ['ft-core-fpp', 5], ['ft-core-post', 5], ['ft-core-spt', 5],
  ])
  if (setup.coreSubjects.length !== expectedCoreHours.size) issues.push('FT requires exactly six configured Core / Main subjects.')
  for (const [id, hours] of expectedCoreHours) {
    const subject = setup.coreSubjects.find((row) => row.id === id)
    if (!subject) {
      issues.push(`The FT Core / Main subject ${id.replace('ft-core-', '').toUpperCase()} is missing.`)
      continue
    }
    if (!subject.code.trim() || !subject.name.trim() || !subject.abbreviation.trim()) issues.push(`${subject.name || 'Each FT Core / Main subject'} needs a code, name, and abbreviation.`)
    if (subject.hoursPerWeek !== hours) issues.push(`${subject.name} must remain configured for ${hours} periods per week.`)
    const teacherIds = assignedTeacherIds(setup, id)
    const requiredAssignments = id === 'ft-core-post' ? 2 : 1
    if (teacherIds.length < requiredAssignments) issues.push(`${subject.name} needs ${requiredAssignments === 2 ? 'both supplied staff assignments' : 'a staff assignment'}.`)
    if (new Set(teacherIds).size !== teacherIds.length) issues.push(`${subject.name} cannot list the same staff member more than once.`)
    for (const teacherId of teacherIds) if (!validTeacher(setup, teacherId)) issues.push(`Assign a valid FT Staff Member to ${subject.name}.`)
  }

  const other = setup.otherSubjects.find((subject) => subject.id === 'ft-other-gp1')
  if (setup.otherSubjects.length !== 1 || !other) issues.push('FT requires only the supplied GP-I Other Subject.')
  if (other) {
    if (!other.code.trim() || !other.name.trim() || !other.abbreviation.trim()) issues.push('GP-I needs a code, name, and abbreviation.')
    if (other.hoursPerWeek !== 2) issues.push('GP-I must remain configured for exactly 2 periods per week.')
    if (!validTeacher(setup, assignedTeacherIds(setup, other.id)[0] ?? '')) issues.push('Assign a valid FT Staff Member to GP-I.')
  }

  if (setup.labMaster.length !== 2) issues.push('FT requires exactly the supplied FPP Lab and EFT Lab.')
  for (const [id, name] of [['ft-lab-fpp', 'FPP Lab'], ['ft-lab-eft', 'EFT Lab']]) {
    const lab = setup.labMaster.find((row) => row.id === id)
    if (!lab) {
      issues.push(`${name} is missing.`)
      continue
    }
    if (!lab.code.trim() || !lab.name.trim() || !lab.abbreviation.trim()) issues.push(`${name} needs a code, name, and abbreviation.`)
    if (lab.weeklyPeriods !== 3) issues.push(`${name} must be configured for exactly 3 periods per week.`)
    if (!validTeacher(setup, assignedLabTeacher(setup, id))) issues.push(`Assign a valid FT Staff Member to ${name}.`)
  }

  const activityRequirements = new Map([
    ['ft-library-mentoring', ['LIB/MEN', 1]],
    ['ft-placement', ['PLACEMENT TRAINING', 4]],
    ['ft-mini-project', ['MINI PROJECT', 4]],
  ] as const)
  if (setup.specialActivities.length !== activityRequirements.size) issues.push('FT requires the supplied LIB/MEN, Placement Training, and Mini Project activities.')
  for (const [id, [label, hours]] of activityRequirements) {
    const activity = setup.specialActivities.find((row) => row.id === id)
    if (!activity) {
      issues.push(`${label} is missing.`)
      continue
    }
    if (activity.hoursPerWeek !== hours) issues.push(`${label} must be configured for exactly ${hours} periods per week.`)
    if (!activity.name.trim()) issues.push(`${label} needs an activity name.`)
    if (!validTeacher(setup, assignedActivityTeacher(setup, id))) issues.push(`Assign a valid FT Staff Member to ${label}.`)
  }

  const advisorId = setup.sections.find((section) => section.id === 'A')?.classAdvisorId ?? ''
  if (!validTeacher(setup, advisorId)) issues.push('Assign the Section A Class Advisor from the FT Staff Members list.')
  else if (setup.staff.find((member) => member.id === advisorId)?.name !== 'Ms. S. Meenambigai') {
    issues.push('Section A Class Advisor must be Ms. S. Meenambigai.')
  }

  const total = setup.coreSubjects.reduce((sum, row) => sum + row.hoursPerWeek, 0)
    + setup.otherSubjects.reduce((sum, row) => sum + row.hoursPerWeek, 0)
    + setup.labMaster.reduce((sum, row) => sum + row.weeklyPeriods, 0)
    + setup.specialActivities.reduce((sum, row) => sum + row.hoursPerWeek, 0)
  if (total !== 48) issues.push(`FT has ${total}/48 configured weekly teaching periods; exactly 48 are required.`)
  return [...new Set(issues)]
}

function makeCell(item: FtItem, teacherId: string, test = false): ScheduledCell {
  return {
    itemId: item.id,
    code: item.code,
    abbreviation: test ? `${item.abbreviation} (T)` : item.abbreviation,
    name: item.name,
    teacherId,
    kind: item.kind,
  }
}

function itemOccurrences(setup: TimetableSetup): FtItem[] {
  const core: FtItem[] = setup.coreSubjects.map((subject: CoreSubject) => ({
    id: `core:A:${subject.id}`, code: subject.code, abbreviation: subject.abbreviation,
    name: subject.name, teacherIds: assignedTeacherIds(setup, subject.id), kind: 'core', count: subject.hoursPerWeek,
  }))
  const other: FtItem[] = setup.otherSubjects.map((subject: OtherSubject) => ({
    id: `other:A:${subject.id}`, code: subject.code, abbreviation: subject.abbreviation,
    name: subject.name, teacherIds: assignedTeacherIds(setup, subject.id), kind: 'other', count: subject.hoursPerWeek,
  }))
  const labs: FtItem[] = setup.labMaster.map((lab) => ({
    id: `lab:A:${lab.id}`, code: lab.code, abbreviation: lab.abbreviation,
    name: lab.name, teacherIds: [assignedLabTeacher(setup, lab.id)], kind: 'lab', count: lab.weeklyPeriods,
  }))
  const activities: FtItem[] = setup.specialActivities.map((activity) => ({
    id: `activity:A:${activity.id}`, code: '', abbreviation: activity.name.toUpperCase(),
    name: activity.name, teacherIds: [assignedActivityTeacher(setup, activity.id)], kind: 'activity', count: activity.hoursPerWeek,
  }))
  return [...core, ...other, ...labs, ...activities]
}

function dayHasConsecutiveCore(grid: Grid, subjectId: string, otherDay: number): boolean {
  return grid[otherDay].some((cell, index) => index > 0 && cell?.kind === 'core' && cell.itemId === subjectId && grid[otherDay][index - 1]?.itemId === subjectId)
}

function canPlace(grid: Grid, day: number, periodIndex: number, item: FtItem, counts: Map<string, number>): boolean {
  if (grid[day][periodIndex]) return false
  if (item.kind === 'activity' && periodIndex === 0) return false
  if (item.kind === 'other' && grid[day].some((cell) => cell?.itemId === item.id)) return false
  if (item.kind === 'activity' && item.id.endsWith(':ft-mini-project') && grid[day].some((cell) => cell?.itemId === item.id)) return false
  if (item.kind === 'core') {
    const dayCount = grid[day].filter((cell) => cell?.itemId === item.id).length
    if (dayCount >= 2) return false
    const previousSame = periodIndex > 0 && grid[day][periodIndex - 1]?.itemId === item.id
    const nextSame = periodIndex < 7 && grid[day][periodIndex + 1]?.itemId === item.id
    if (previousSame && nextSame) return false
    if ((previousSame || nextSame) && grid.some((_, otherDay) => otherDay !== day && dayHasConsecutiveCore(grid, item.id, otherDay))) return false
  }
  return (counts.get(item.id) ?? 0) > 0
}

function generateAttempt(items: FtItem[], searchNodes: { value: number }): Grid | null {
  const coreItems = items.filter((item) => item.kind === 'core')
  const labItems = items.filter((item) => item.kind === 'lab')
  const placement = items.find((item) => item.id.endsWith(':ft-placement'))!
  const postItem = coreItems.find((item) => item.id.endsWith(':ft-core-post'))!
  const grid: Grid = Array.from({ length: days.length }, () => Array<ScheduledCell | null>(8).fill(null))
  const remaining = new Map(items.map((item) => [item.id, item.count]))
  const postTeacherIds = [...new Set(postItem.teacherIds)]
  const postTeachersUsed = new Set<string>()

  for (const [day, subject] of shuffled(coreItems).entries()) {
    const teacherId = shuffled(subject.teacherIds)[0]
    grid[day][0] = makeCell(subject, teacherId, true)
    remaining.set(subject.id, (remaining.get(subject.id) ?? 0) - 1)
    if (subject.id === postItem.id) postTeachersUsed.add(teacherId)
  }

  const placementDay = Math.floor(Math.random() * days.length)
  for (const period of [5, 6, 7, 8]) {
    grid[placementDay][period - 1] = makeCell(placement, placement.teacherIds[0])
    remaining.set(placement.id, (remaining.get(placement.id) ?? 0) - 1)
  }
  const labDays = shuffled(days.map((_, day) => day).filter((day) => day !== placementDay)).slice(0, 2)
  for (const [labIndex, lab] of shuffled(labItems).entries()) {
    const day = labDays[labIndex]
    const start = shuffled([2, 6])[0]
    for (let period = start; period < start + 3; period += 1) {
      grid[day][period - 1] = makeCell(lab, lab.teacherIds[0])
      remaining.set(lab.id, (remaining.get(lab.id) ?? 0) - 1)
    }
  }

  const fill = (): boolean => {
    searchNodes.value += 1
    if (searchNodes.value > nodeLimit) return false
    const empty: Array<{ day: number; periodIndex: number; options: Candidate[] }> = []
    for (let day = 0; day < days.length; day += 1) {
      for (let periodIndex = 1; periodIndex < 8; periodIndex += 1) {
        if (grid[day][periodIndex]) continue
        const options: Candidate[] = []
        for (const item of items) {
          if (item.kind === 'lab' || item.id === placement.id || !canPlace(grid, day, periodIndex, item, remaining)) continue
          for (const teacherId of shuffled(item.teacherIds)) options.push({ item, teacherId })
        }
        if (options.length === 0) return false
        empty.push({ day, periodIndex, options })
      }
    }
    if (empty.length === 0) return [...remaining.values()].every((count) => count === 0)
      && postTeacherIds.every((teacherId) => postTeachersUsed.has(teacherId))

    const minOptions = Math.min(...empty.map((slot) => slot.options.length))
    const slot = shuffled(empty.filter((candidate) => candidate.options.length === minOptions))[0]
    for (const candidate of shuffled(slot.options)) {
      const { item, teacherId } = candidate
      grid[slot.day][slot.periodIndex] = makeCell(item, teacherId)
      remaining.set(item.id, (remaining.get(item.id) ?? 0) - 1)
      if (item.id === postItem.id) postTeachersUsed.add(teacherId)
      const freeSlots = grid.reduce((count, row) => count + row.filter((cell) => cell === null).length, 0)
      const unitsLeft = [...remaining.values()].reduce((sum, count) => sum + count, 0)
      const postTeachersStillPossible = postTeacherIds.filter((id) => postTeachersUsed.has(id)).length
        + Math.min(remaining.get(postItem.id) ?? 0, postTeacherIds.filter((id) => !postTeachersUsed.has(id)).length)
        >= postTeacherIds.length
      if (freeSlots === unitsLeft && postTeachersStillPossible && fill()) return true
      if (item.id === postItem.id && !grid.some((row) => row.some((cell) => cell?.itemId === item.id && cell.teacherId === teacherId && cell !== grid[slot.day][slot.periodIndex]))) {
        postTeachersUsed.delete(teacherId)
      }
      grid[slot.day][slot.periodIndex] = null
      remaining.set(item.id, (remaining.get(item.id) ?? 0) + 1)
      if (searchNodes.value > nodeLimit) return false
    }
    return false
  }
  return fill() ? grid : null
}

export function validateFtGeneratedTimetables(setup: TimetableSetup, generatedSections: GeneratedSection[]): { summary: TimetableValidationSummary; issues: string[]; warnings: string[] } {
  const issues: string[] = []
  const sectionSummaries: TimetableValidationSummary['sections'] = []
  const globalTeachers = new Map<string, Set<string>>()
  let globalTeacherClashes = 0
  if (generatedSections.length !== 1 || generatedSections[0]?.sectionId !== sectionId) issues.push('FT generated output must contain only fixed Section A.')

  for (const generated of generatedSections) {
    let periodsFilled = 0
    let coreHoursValid = true
    let otherSubjectHoursValid = true
    let labAllocationValid = true
    const counts = new Map<string, number>()
    const p1Subjects = new Set<string>()
    const consecutiveDays = new Map<string, Set<WeekDay>>()
    const labsById = new Map<string, Array<{ day: WeekDay; period: number }>>()
    const placementSlots: Array<{ day: WeekDay; period: number; itemId: string }> = []
    const activityCounts = new Map<string, number>()

    for (const day of days) {
      const p1 = generated.schedule[day]?.[1]
      if (!p1 || p1.kind !== 'core') issues.push(`${day} P1 must contain a Core Test.`)
      else {
        p1Subjects.add(p1.itemId)
        if (!p1.abbreviation.endsWith('(T)')) issues.push(`${day} P1 Core Test must be marked (T).`)
      }
      for (const period of periods) {
        const cell = generated.schedule[day]?.[period]
        if (!cell || !cell.abbreviation.trim() || !validTeacher(setup, cell.teacherId)) {
          issues.push(`Section ${generated.sectionId} ${day} P${period} is empty or has an invalid staff assignment.`)
          continue
        }
        periodsFilled += 1
        counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1)
        const slotKey = `${day}:P${period}`
        const staffAtSlot = globalTeachers.get(slotKey) ?? new Set<string>()
        if (staffAtSlot.has(cell.teacherId)) {
          globalTeacherClashes += 1
          issues.push(`${setup.staff.find((member) => member.id === cell.teacherId)?.name ?? cell.teacherId} has a simultaneous teacher clash at ${day} P${period}.`)
        }
        staffAtSlot.add(cell.teacherId)
        globalTeachers.set(slotKey, staffAtSlot)
        if (cell.kind === 'core') {
          if (period === 1) p1Subjects.add(cell.itemId)
          if (period < 8 && generated.schedule[day]?.[period + 1]?.itemId === cell.itemId) {
            const daysWithPairs = consecutiveDays.get(cell.itemId) ?? new Set<WeekDay>()
            daysWithPairs.add(day)
            consecutiveDays.set(cell.itemId, daysWithPairs)
          }
          if (period > 1 && generated.schedule[day]?.[period - 1]?.itemId === cell.itemId
            && period < 8 && generated.schedule[day]?.[period + 1]?.itemId === cell.itemId) {
            issues.push(`${cell.name} has three consecutive Core periods on ${day}.`)
          }
        }
        if (cell.kind === 'lab') {
          const entries = labsById.get(cell.itemId) ?? []
          entries.push({ day, period })
          labsById.set(cell.itemId, entries)
        }
        if (cell.kind === 'activity') {
          activityCounts.set(cell.itemId, (activityCounts.get(cell.itemId) ?? 0) + 1)
          if (cell.itemId.endsWith(':ft-placement')) placementSlots.push({ day, period, itemId: cell.itemId })
          if ((cell.itemId.endsWith(':ft-library-mentoring') || cell.itemId.endsWith(':ft-mini-project')) && period === 1) {
            issues.push(`${cell.name} cannot occupy P1.`)
          }
        }
      }
      const dayCoreCounts = new Map<string, number>()
      for (const period of periods) {
        const cell = generated.schedule[day]?.[period]
        if (cell?.kind === 'core') dayCoreCounts.set(cell.itemId, (dayCoreCounts.get(cell.itemId) ?? 0) + 1)
      }
      for (const [itemId, count] of dayCoreCounts) if (count > 2) {
        issues.push(`${generated.schedule[day]?.[1]?.name ?? itemId} exceeds 2 occurrences per day.`)
      }
    }

    if (periodsFilled !== 48) issues.push(`Section ${generated.sectionId} has ${periodsFilled}/48 filled teaching periods.`)
    if (p1Subjects.size !== 6) issues.push('P1 must use all six Core subjects exactly once across Monday-Saturday.')
    for (const [itemId, pairDays] of consecutiveDays) if (pairDays.size > 1) {
      const name = setup.coreSubjects.find((subject) => itemId.endsWith(subject.id))?.name ?? itemId
      issues.push(`${name} repeats consecutively on more than one day.`)
    }

    for (const subject of setup.coreSubjects) {
      const itemId = `core:A:${subject.id}`
      if ((counts.get(itemId) ?? 0) !== subject.hoursPerWeek) {
        coreHoursValid = false
        issues.push(`${subject.abbreviation} has ${counts.get(itemId) ?? 0}/${subject.hoursPerWeek} weekly periods.`)
      }
    }
    for (const subject of setup.otherSubjects) {
      const itemId = `other:A:${subject.id}`
      if ((counts.get(itemId) ?? 0) !== subject.hoursPerWeek) {
        otherSubjectHoursValid = false
        issues.push(`${subject.abbreviation} has ${counts.get(itemId) ?? 0}/${subject.hoursPerWeek} weekly periods.`)
      }
      const occupiedDays = days.filter((day) => periods.some((period) => generated.schedule[day]?.[period]?.itemId === itemId))
      if (occupiedDays.length !== subject.hoursPerWeek) issues.push(`${subject.abbreviation} must occur on different days.`)
    }
    const labDays = new Set<WeekDay>()
    for (const lab of setup.labMaster) {
      const itemId = `lab:A:${lab.id}`
      const entries = labsById.get(itemId) ?? []
      const slots = entries.map((entry) => entry.period).sort((left, right) => left - right)
      const sameDay = entries.length === 3 && new Set(entries.map((entry) => entry.day)).size === 1
      const legalBlock = slots.join(',') === '2,3,4' || slots.join(',') === '6,7,8'
      if (entries.length !== 3 || !sameDay || !legalBlock) {
        labAllocationValid = false
        issues.push(`${lab.name} must occupy one uninterrupted P2-P4 or P6-P8 three-period block.`)
      }
      entries.forEach((entry) => labDays.add(entry.day))
    }
    if (labDays.size !== setup.labMaster.length) issues.push('FT Labs must occupy different days.')
    if (placementSlots.length !== 4 || new Set(placementSlots.map((entry) => entry.day)).size !== 1
      || placementSlots.map((entry) => entry.period).sort((a, b) => a - b).join(',') !== '5,6,7,8') {
      issues.push('Placement Training must be one four-period P5-P8 block on one day; P1-P4 is unavailable because all six P1 periods are Core Tests.')
    }
    if (placementSlots.some((entry) => labDays.has(entry.day))) issues.push('Placement and Labs must be on separate days.')
    for (const [id, hours] of [['ft-library-mentoring', 1], ['ft-placement', 4], ['ft-mini-project', 4]] as const) {
      const itemId = `activity:A:${id}`
      if ((activityCounts.get(itemId) ?? 0) !== hours) issues.push(`${id.replace('ft-', '').toUpperCase()} has ${activityCounts.get(itemId) ?? 0}/${hours} weekly periods.`)
    }
    sectionSummaries.push({ sectionId: generated.sectionId, periodsFilled, coreHoursValid, otherSubjectHoursValid, labAllocationValid })
  }

  return { summary: { sections: sectionSummaries, globalTeacherClashes }, issues: [...new Set(issues)], warnings: [] }
}

export function generateFtTimetables(setup: TimetableSetup): TimetableGenerationResult {
  const configurationIssues = validateFtConfiguration(setup)
  if (configurationIssues.length) return failure(configurationIssues)
  const items = itemOccurrences(setup)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const searchNodes = { value: 0 }
    const grid = generateAttempt(items, searchNodes)
    if (!grid) continue
    const schedule = Object.fromEntries(days.map((day, dayIndex) => [
      day,
      Object.fromEntries(periods.map((period) => [period, grid[dayIndex][period - 1]!])),
    ])) as GeneratedSection['schedule']
    const generatedSections: GeneratedSection[] = [{ sectionId, schedule }]
    const validation = validateFtGeneratedTimetables(setup, generatedSections)
    if (!validation.issues.length) return { ok: true, sections: generatedSections, searchNodes: searchNodes.value, validation: validation.summary }
  }
  return failure(['No randomized arrangement satisfied every FT rule after 20 search attempts.'], 'UNSATISFIABLE')
}
