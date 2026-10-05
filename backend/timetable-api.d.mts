import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  GenericGeneratedSection, GenericPlacementExceptionConfig, GenericScheduleConfig,
  GenericTimetableGenerationResult, GenericUnavailableTeacherSlot,
} from '../src/generic-scheduling-model'
import type { TimetableRepository } from './timetable-repository.mjs'

export interface TimetableGenerationWorkerInput {
  configuration: GenericScheduleConfig
  reservedSections: GenericGeneratedSection[]
  unavailableTeacherSlots: GenericUnavailableTeacherSlot[]
  alternateWeekUnavailableTeacherSlots: GenericUnavailableTeacherSlot[]
}

export interface TimetableGenerationWorkerOutput {
  result: GenericTimetableGenerationResult
  placementException?: GenericPlacementExceptionConfig
}

export function createTimetableApiMiddleware(
  repository: TimetableRepository,
  options?: {
    runGeneration?: (input: TimetableGenerationWorkerInput) => Promise<TimetableGenerationWorkerOutput>
    maximumRetainedGenerationJobs?: number
    generationJobRetentionMs?: number
  },
): (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>
