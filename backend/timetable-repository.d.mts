import type { GenericScheduleConfig, GenericTimetableValidationSummary } from '../src/generic-scheduling-model'
import type { TimetableSetup } from '../src/models'

export interface SavedVersionSummary {
  generationId: string
  versionNumber: number
  createdAt: string
  lockedAt?: string | null
  status: 'SAVED' | 'DRAFT' | 'LOCKED'
  sectionCount: number
  cellCount: number
  isActive: boolean
}

export interface SavedTimetableNavigationEntry extends SavedVersionSummary {
  versionId: string
  sectionName: string
  department: string
  year: string
  semester: string
  academicYear: string
}

export interface SavedGeneration {
  generationId: string
  configurationId: string
  validation: GenericTimetableValidationSummary | Record<string, unknown>
  setupSnapshot: TimetableSetup
  sections: Array<{
    sectionId: string
    department: string
    academicYear: string
    year: string
    semester: string
    schedule: Record<string, Record<number, {
      itemId: string
      blockId?: string
      code: string
      abbreviation: string
      name: string
      teacherId: string
      kind: 'core' | 'other' | 'lab' | 'activity'
      isCoreTest?: boolean
    }>>
  }>
  versions: Array<Record<string, unknown>>
}

export class TimetableRepository {
  close(): void
  createTimetableConfiguration(configuration: GenericScheduleConfig): string
  getTimetableConfigurationByIdentity(identity: { department: string; year: string; semester: string; academicYear: string; configurationVersion?: number }): string | null
  getSavedGenerationSummaries(identity: { department: string; year: string; semester: string; academicYear: string }): SavedVersionSummary[]
  getSavedTimetableNavigation(): SavedTimetableNavigationEntry[]
  deleteSavedTimetableVersion(input: { versionId: string }): {
    versionId: string
    generationId: string
    versionNumber: number
    sectionName: string
    deletedCellCount: number
    activeVersionId: string | null
  }
  getSavedTimetableVersion(versionId: string): (SavedGeneration & { versionId: string; sectionName: string }) | null
  getSavedGeneration(generationId: string, configurationId: string): SavedGeneration | null
  getTeacherOccupancyConflicts(input: {
    identity: { department: string; year: string; semester: string; academicYear: string }
    sections: SavedGeneration['sections']
    staff?: Array<{ id: string; name?: string; canonicalName?: string }>
  }): Array<{
    teacherId: string
    teacherName: string
    day: string
    period: number
    existing: { department: string; year: string; semester: string; section: string; subject: string }
    candidate: { department: string; year: string; semester: string; section: string; subject: string }
  }>
  getTeacherGenerationOccupancyConflicts(input: {
    identity: { department: string; year: string; semester: string; academicYear: string }
    sections: SavedGeneration['sections']
    staff?: Array<{ id: string; name?: string; canonicalName?: string }>
  }): Array<{
    teacherId: string
    teacherName: string
    day: string
    period: number
    week?: 'alternate'
    existing: { department: string; year: string; semester: string; section: string; subject: string }
    candidate: { department: string; year: string; semester: string; section: string; subject: string }
  }>
  getTeacherUnavailableSlots(input: {
    identity: { department: string; year: string; semester: string; academicYear: string }
    staff?: Array<{ id: string; name?: string; canonicalName?: string }>
  }): Array<{
    teacherId: string
    day: string
    period: number
    teacherName: string
    existing: { department: string; year: string; semester: string; section: string; subject: string }
  }>
  getTeacherUnavailableOccupancy(input: {
    identity: { department: string; year: string; semester: string; academicYear: string }
    staff?: Array<{ id: string; name?: string; canonicalName?: string }>
  }): {
    unavailableSlots: Array<{
      teacherId: string
      day: string
      period: number
      teacherName: string
      existing: { department: string; year: string; semester: string; section: string; subject: string }
    }>
    alternateWeekUnavailableSlots: Array<{
      teacherId: string
      day: string
      period: number
      teacherName: string
      existing: { department: string; year: string; semester: string; section: string; subject: string }
    }>
  }
  setSavedTimetableVersionStatus(input: { versionId: string; status: 'SAVED' | 'LOCKED' }): (SavedGeneration & { versionId: string; sectionName: string }) | null
  saveGeneratedTimetableData(input: { configurationId: string; generationId: string; sections: SavedGeneration['sections']; validation: unknown; setupSnapshot: TimetableSetup; staff?: GenericScheduleConfig['staff'] }): unknown[]
}

export function openTimetableRepository(options?: { filename?: string }): TimetableRepository
