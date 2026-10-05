import type { TimetableGenerationWorkerInput, TimetableGenerationWorkerOutput } from './timetable-api.mjs'

export function createGenericSchedulerWorkerPool(options?: {
  workerCount?: number | string
  maximumQueueSize?: number | string
  workerTimeoutMs?: number | string
  queueWaitTimeoutMs?: number | string
  workerUrl?: URL
}): {
  run(input: TimetableGenerationWorkerInput): Promise<TimetableGenerationWorkerOutput>
  close(): Promise<void>
}

export function runGenericTimetableGeneration(input: TimetableGenerationWorkerInput): Promise<TimetableGenerationWorkerOutput>
export function closeGenericSchedulerWorkerPool(): Promise<void>
