import type { TimetableSetup } from './models'
import type { GeneratedSection, SavedTeacherUnavailableSlot, TimetableValidationSummary } from './scheduler'
import type {
  GenericGeneratedSection, GenericPlacementExceptionConfig, GenericScheduleConfig,
  GenericTimetableGenerationResult, GenericTimetableValidationSummary, GenericUnavailableTeacherSlot,
} from './generic-scheduling-model.ts'

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

export interface GenericTimetableGenerationResponse {
  result: GenericTimetableGenerationResult
  placementException?: GenericPlacementExceptionConfig
  jobId?: string
  elapsedMs?: number
}

function logGenerationEvent(event: string, details: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...details }))
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw Object.assign(new Error('Timetable version storage is unavailable. Check the database service and try again.'), {
      retryable: true,
    })
  }
  const payload = await response.json().catch(() => ({})) as { error?: string; code?: string } & T
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `Timetable version request failed (${response.status}).`), {
      code: payload.code,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    })
  }
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

export function generateGenericTimetableOnServer(input: {
  configuration: GenericScheduleConfig
  reservedSections: GenericGeneratedSection[]
}): Promise<GenericTimetableGenerationResponse> {
  return createGenerationRequest(input)
}

export function acknowledgeGeneratedTimetable(jobId: string): Promise<{ accepted: boolean }> {
  return apiRequest(`/api/timetable/generation-jobs/${encodeURIComponent(jobId)}/accepted`, {
    method: 'POST',
  })
}

async function createGenerationRequest(input: {
  configuration: GenericScheduleConfig
  reservedSections: GenericGeneratedSection[]
}): Promise<GenericTimetableGenerationResponse> {
  const startedAt = Date.now()
  const { jobId } = await apiRequest<{ jobId: string }>('/api/timetable/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    throw new Error('The timetable generation service returned an invalid job ID.')
  }
  logGenerationEvent('FRONTEND_GENERATION_JOB_RECEIVED', {
    jobId,
    elapsedMs: Date.now() - startedAt,
    status: 'queued',
  })
  const deadline = Date.now() + 30 * 60 * 1000
  let pollInterval = 500
  let lastLoggedStatus: string | undefined

  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, pollInterval))
    let job: {
      status: 'queued' | 'running' | 'completed' | 'failed'
      value?: GenericTimetableGenerationResponse
      error?: string
      code?: string
    }
    try {
      job = await apiRequest<{
        status: 'queued' | 'running' | 'completed' | 'failed'
        value?: GenericTimetableGenerationResponse
        error?: string
        code?: string
      }>(`/api/timetable/generation-jobs/${encodeURIComponent(jobId)}`)
    } catch (error) {
      if (error && typeof error === 'object' && 'retryable' in error && error.retryable === true) {
        logGenerationEvent('FRONTEND_POLL_RETRY', {
          jobId,
          elapsedMs: Date.now() - startedAt,
        })
        pollInterval = Math.min(2_000, Math.round(pollInterval * 1.5))
        continue
      }
      throw error
    }
    if (!['queued', 'running', 'completed', 'failed'].includes(job.status)) {
      throw new Error('The timetable generation service returned an invalid job status.')
    }
    if (job.status !== lastLoggedStatus) {
      logGenerationEvent('FRONTEND_POLL_STATUS', {
        jobId,
        elapsedMs: Date.now() - startedAt,
        status: job.status,
      })
      lastLoggedStatus = job.status
    }
    if (job.status === 'completed') {
      const value = job.value
      const result = value?.result
      logGenerationEvent('FRONTEND_POLL_COMPLETED', {
        jobId,
        elapsedMs: Date.now() - startedAt,
        resultOk: result?.ok === true,
      })
      if (!result || typeof result.ok !== 'boolean') {
        throw new Error('The timetable generation service returned an invalid job result.')
      }
      return { ...value, jobId, elapsedMs: Date.now() - startedAt }
    }
    if (job.status === 'failed') {
      throw Object.assign(new Error(job.error || 'The timetable generation service failed.'), { code: job.code })
    }
    pollInterval = Math.min(2_000, Math.round(pollInterval * 1.5))
  }

  throw new Error(`Timetable generation job ${jobId} is taking longer than expected after ${Date.now() - startedAt} ms. The server may still be working; please check again before submitting another request.`)
}
