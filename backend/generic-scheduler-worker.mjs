import { parentPort } from 'node:worker_threads'
import { generateGenericTimetable, validateGenericScheduleConfig } from '../src/generic-scheduler.ts'
import { randomizeGenericPlacementAlternates } from '../src/generic-schedule-adapter.ts'

if (!parentPort) throw new Error('The timetable scheduler worker must run inside a worker thread.')

function generate(input) {
  const {
    configuration,
    reservedSections,
    unavailableTeacherSlots,
    alternateWeekUnavailableTeacherSlots,
  } = input
  const randomAllocation = configuration.placementException?.enabled
    && configuration.placementException.allocationMode === 'random'
  const attempts = randomAllocation ? 8 : 1
  let lastResult

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const allocation = randomizeGenericPlacementAlternates(configuration)
    if (allocation.issues.length) {
      return {
        result: {
          ok: false,
          code: 'INVALID_INPUT',
          message: 'Placement alternate allocation is incomplete.',
          blockingConstraints: allocation.issues,
        },
      }
    }

    const candidateConfig = allocation.config
    const candidateIssues = validateGenericScheduleConfig(candidateConfig)
    if (candidateIssues.length) {
      return {
        result: {
          ok: false,
          code: 'INVALID_INPUT',
          message: 'Placement alternate allocation is invalid.',
          blockingConstraints: candidateIssues,
        },
      }
    }

    const result = generateGenericTimetable({
      schedules: [candidateConfig],
      reservedSections,
      unavailableTeacherSlots,
      alternateWeekUnavailableTeacherSlots,
      candidateCount: candidateConfig.candidateCount,
    })
    if (result.ok) {
      return {
        result,
        ...(randomAllocation && candidateConfig.placementException
          ? {
            placementException: {
              ...candidateConfig.placementException,
              allocationMode: 'random',
            },
          }
          : {}),
      }
    }
    lastResult = result
  }

  return {
    result: lastResult ?? {
      ok: false,
      code: 'UNSATISFIABLE',
      message: 'No valid random Placement allocation was found.',
      blockingConstraints: [],
    },
  }
}

parentPort.on('message', ({ jobId, input }) => {
  try {
    parentPort.postMessage({ jobId, value: generate(input) })
  } catch (error) {
    parentPort.postMessage({
      jobId,
      error: error instanceof Error ? error.message : 'The timetable scheduler worker failed.',
    })
  }
})
