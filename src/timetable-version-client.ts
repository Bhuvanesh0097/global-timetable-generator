import type { TimetableSetup } from './models'
import type { GeneratedSection, SavedTeacherUnavailableSlot, TimetableValidationSummary } from './scheduler'
import type { GenericGeneratedSection, GenericScheduleConfig, GenericTimetableValidationSummary, GenericUnavailableTeacherSlot } from './generic-scheduling-model.ts'

export interface SavedTimetableVersionSummary {
  versionId: string
  generationId: string
  sectionName: string
  department: string
  year: string
  semester: string
  academicYear: string
  versionNumber: number
  createdAt: string
  lockedAt?: string | null
  status: 'SAVED' | 'DRAFT' | 'LOCKED'
  sectionCount: number
  cellCount: number
  isActive: boolean
}

export interface SavedTimetableNavigationEntry extends SavedTimetableVersionSummary {}

export interface SavedTimetableGeneration {
  versionId: string
  generationId: string
  configurationId: string
  sectionName: string
  validation: GenericTimetableValidationSummary
  setupSnapshot: TimetableSetup
  sections: GenericGeneratedSection[]
}

export interface SavedTimetableOccupancyConflict {
  teacherId: string
  teacherName: string
  day: string
  period: number
  week?: 'alternate'
  existing: { department: string; year: string; semester: string; section: string; subject: string }
  candidate: { department: string; year: string; semester: string; section: string; subject: string }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new Error('Timetable version storage is unavailable. Check the database service and try again.')
  }
  const payload = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(payload.error || `Timetable version request failed (${response.status}).`)
  return payload
}

export function listSavedTimetableVersions(identity: {
  department: string
  year: string
  semester: string
  academicYear: string
}): Promise<{ versions: SavedTimetableVersionSummary[] }> {
  const query = new URLSearchParams(identity)
  return apiRequest(`/api/timetable-versions?${query}`)
}

export function listSavedTimetableNavigation(): Promise<{ timetables: SavedTimetableNavigationEntry[] }> {
  return apiRequest('/api/saved-timetables')
}

export function deleteSavedTimetableVersion(versionId: string): Promise<{ deletedVersion: {
  versionId: string
  generationId: string
  versionNumber: number
  sectionName: string
  deletedCellCount: number
  activeVersionId: string | null
} }> {
  return apiRequest(`/api/timetable-versions/${encodeURIComponent(versionId)}`, {
    method: 'DELETE',
  })
}

export function saveTimetableVersion(input: {
  configuration: GenericScheduleConfig
  generationId: string
  sections: GenericGeneratedSection[] | GeneratedSection[]
  setupSnapshot: TimetableSetup
  validation: GenericTimetableValidationSummary | TimetableValidationSummary
}): Promise<{ configurationId: string; generationId: string; savedVersion: Record<string, unknown>; versions: Array<Record<string, unknown>>; timetableVersions: SavedTimetableNavigationEntry[] }> {
  return apiRequest('/api/timetable-versions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function loadSavedTimetableVersion(versionId: string): Promise<SavedTimetableGeneration> {
  return apiRequest(`/api/timetable-versions/${encodeURIComponent(versionId)}`)
}

export function setSavedTimetableVersionLock(versionId: string, locked: boolean): Promise<{
  versionId: string
  savedTimetableVersion: SavedTimetableGeneration
  savedVersion: SavedTimetableNavigationEntry
}> {
  return apiRequest(`/api/timetable-versions/${encodeURIComponent(versionId)}/${locked ? 'lock' : 'unlock'}`, {
    method: 'POST',
  })
}

export function checkSavedTimetableOccupancy(input: {
  identity: { department: string; year: string; semester: string; academicYear: string }
  sections: GenericGeneratedSection[] | GeneratedSection[]
  staff: Array<{ id: string; name: string }>
}): Promise<{ conflicts: SavedTimetableOccupancyConflict[] }> {
  return apiRequest('/api/timetable-conflicts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function loadSavedTeacherUnavailableSlots(input: {
  identity: { department: string; year: string; semester: string; academicYear: string }
  staff: Array<{ id: string; name: string }>
}): Promise<{
  unavailableSlots: SavedTeacherUnavailableSlot[]
  alternateWeekUnavailableSlots: GenericUnavailableTeacherSlot[]
}> {
  return apiRequest('/api/timetable-teacher-occupancy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}
