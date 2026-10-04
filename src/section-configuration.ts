import type { Section, SectionName } from './models'

function sectionNameFromIndex(index: number): SectionName {
  let value = index + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

export function getSectionIds(sectionCount: number): SectionName[] {
  if (!Number.isSafeInteger(sectionCount) || sectionCount < 1) return []
  return Array.from({ length: sectionCount }, (_, index) => sectionNameFromIndex(index))
}

export function initializeConfiguredSections(existingSections: Section[], configuredSectionIds: SectionName[]): Section[] {
  const sectionsById = new Map(existingSections.map((section) => [section.id, section]))
  return configuredSectionIds.map((id) => sectionsById.get(id) ?? ({ id, classAdvisorId: '', studentCount: 0 }))
}

export function getSectionCountLabel(sectionCount: number): string {
  return `${sectionCount} section${sectionCount === 1 ? '' : 's'}`
}

export function getGenerateTimetableLabel(sectionIds: SectionName[]): string {
  const sectionLabel = sectionIds.length > 1
    ? `${sectionIds.slice(0, -1).join(', ')} & ${sectionIds.at(-1)}`
    : sectionIds[0] ?? '—'
  return `Generate Timetable${sectionIds.length === 1 ? '' : 's'} for ${sectionLabel}`
}
