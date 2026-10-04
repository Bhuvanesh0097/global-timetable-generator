import type { SectionName, TimetableSetup, WeekDay } from './models'
import type { GeneratedSection, ScheduledCell } from './scheduler'

export function getEditableTimetableChoices(setup: TimetableSetup, sectionId: SectionName): ScheduledCell[] {
  const choices: ScheduledCell[] = []
  const staffIds = new Set(setup.staff.map((person) => person.id))
  const teacherFor = (subjectId: string) => setup.sectionSubjectAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.subjectId === subjectId)?.teacherId ?? ''
  const isPlacement = (name: string, id: string) => id.toLowerCase().includes('placement')
    || ['placement', 'placement training'].includes(name.trim().toLocaleLowerCase())

  for (const subject of setup.coreSubjects) {
    const teacherId = teacherFor(subject.id)
    if (!staffIds.has(teacherId)) continue
    choices.push({ itemId: `core:${sectionId}:${subject.id}`, code: subject.code, abbreviation: subject.abbreviation, name: subject.name, teacherId, kind: 'core' })
  }

  for (const subject of setup.otherSubjects.filter((item) => item.code && item.name)) {
    const teacherId = teacherFor(subject.id)
    if (!staffIds.has(teacherId)) continue
    choices.push({ itemId: `other:${sectionId}:${subject.id}`, code: subject.code, abbreviation: subject.abbreviation, name: subject.name, teacherId, kind: 'other' })
  }

  for (const activity of setup.specialActivities.filter((item) => !isPlacement(item.name, item.id) && item.name.trim())) {
    const teacherId = setup.specialActivityAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.activityId === activity.id)?.teacherId ?? ''
    if (!staffIds.has(teacherId)) continue
    const abbreviation = activity.id === 'foss-nptel' ? 'FOSS/NPTEL'
      : activity.id === 'library-mentoring' || activity.id === 'cse2-library-mentoring' ? 'LIB/MEN'
        : activity.id === 'cse2-pet' ? 'PET'
        : 'SPL LECT/GATE'
    choices.push({ itemId: `activity:${sectionId}:${activity.id}`, code: '', abbreviation, name: activity.name, teacherId, kind: 'activity' })
  }

  return choices
}

export function cloneGeneratedSections(sections: GeneratedSection[]): GeneratedSection[] {
  return sections.map((section) => ({
    sectionId: section.sectionId,
    schedule: Object.fromEntries(Object.entries(section.schedule).map(([day, cells]) => [
      day,
      Object.fromEntries(Object.entries(cells).map(([period, cell]) => [period, cell ? { ...cell } : cell])),
    ])) as GeneratedSection['schedule'],
  }))
}

export function updateGeneratedTimetableCell(
  sections: GeneratedSection[],
  sectionId: SectionName,
  day: WeekDay,
  period: number,
  choice: ScheduledCell,
): GeneratedSection[] {
  const nextSections = cloneGeneratedSections(sections)
  const section = nextSections.find((item) => item.sectionId === sectionId)
  if (section) {
    const currentCell = section.schedule[day][period]
    const preserveCoreTest = currentCell?.isCoreTest && choice.kind === 'core'
    section.schedule[day][period] = { ...choice, ...(preserveCoreTest ? { isCoreTest: true } : {}) }
  }
  return nextSections
}

export function exchangeGeneratedTimetableCells(
  sections: GeneratedSection[],
  sectionId: SectionName,
  first: { day: WeekDay; period: number },
  second: { day: WeekDay; period: number },
): GeneratedSection[] {
  const nextSections = cloneGeneratedSections(sections)
  const section = nextSections.find((item) => item.sectionId === sectionId)
  const firstCell = section?.schedule[first.day]?.[first.period]
  const secondCell = section?.schedule[second.day]?.[second.period]
  if (!section || !firstCell || !secondCell) return nextSections
  section.schedule[first.day][first.period] = secondCell
  section.schedule[second.day][second.period] = firstCell
  return nextSections
}
