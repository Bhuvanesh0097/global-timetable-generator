import { Worker } from 'node:worker_threads'

const maximumWorkerCount = 4
const defaultWorkerCount = 2
const maximumQueuedGenerations = 8
const workerUrl = new URL('./generic-scheduler-worker.mjs', import.meta.url)

function configuredWorkerCount(value) {
  if (value === undefined || value === '') return defaultWorkerCount
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximumWorkerCount) {
    throw new Error(`TIMETABLE_SCHEDULER_WORKERS must be an integer from 1 to ${maximumWorkerCount}.`)
  }
  return parsed
}

export function createGenericSchedulerWorkerPool({
  workerCount: workerCountInput = process.env.TIMETABLE_SCHEDULER_WORKERS,
  maximumQueueSize = maximumQueuedGenerations,
} = {}) {
  const workerCount = configuredWorkerCount(workerCountInput)
  const workers = new Set()
  const queue = []
  let nextJobId = 1
  let closed = false
  let consecutiveWorkerFailures = 0
  let unavailableError

  const schedulerError = (message, code) => Object.assign(new Error(message), { code })

  function rejectPending(error) {
    for (const job of queue.splice(0)) job.reject(error)
  }

  function dispatch() {
    if (closed) return
    for (const slot of workers) {
      if (slot.retired || slot.busy || !queue.length) continue
      const job = queue.shift()
      if (!job) continue
      slot.busy = true
      slot.job = job
      try {
        slot.worker.postMessage({ jobId: job.id, input: job.input })
      } catch (error) {
        retire(slot, error instanceof Error
          ? error
          : schedulerError('The timetable generation request could not be sent to a worker.', 'SCHEDULER_WORKER_FAILED'))
      }
    }
  }

  function retire(slot, error) {
    if (slot.retired) return
    slot.retired = true
    workers.delete(slot)
    if (slot.job) {
      slot.job.reject(error ?? schedulerError('A timetable scheduler worker stopped unexpectedly.', 'SCHEDULER_WORKER_FAILED'))
      slot.job = undefined
    }
    slot.busy = false
    void slot.worker.terminate()
    if (!closed) {
      consecutiveWorkerFailures += 1
      if (consecutiveWorkerFailures >= workerCount * 3) {
        unavailableError = schedulerError(
          'Timetable generation workers repeatedly failed to start. Restart the server before trying again.',
          'SCHEDULER_UNAVAILABLE',
        )
        rejectPending(unavailableError)
        return
      }
      spawnWorker()
      dispatch()
    }
  }

  function spawnWorker() {
    const slot = {
      worker: new Worker(workerUrl, { execArgv: ['--experimental-strip-types'] }),
      busy: false,
      retired: false,
      job: undefined,
    }
    workers.add(slot)
    slot.worker.on('message', (message) => {
      if (!slot.job || message.jobId !== slot.job.id) {
        retire(slot, schedulerError('The timetable scheduler worker returned an unexpected response.', 'SCHEDULER_WORKER_FAILED'))
        return
      }
      const job = slot.job
      slot.job = undefined
      slot.busy = false
      consecutiveWorkerFailures = 0
      unavailableError = undefined
      if (typeof message.error === 'string') {
        job.reject(schedulerError(message.error, 'SCHEDULER_WORKER_FAILED'))
      } else job.resolve(message.value)
      dispatch()
    })
    slot.worker.on('error', (error) => retire(slot, error))
    slot.worker.on('exit', (code) => {
      if (!slot.retired) {
        retire(slot, schedulerError(`A timetable scheduler worker exited unexpectedly with code ${code}.`, 'SCHEDULER_WORKER_FAILED'))
      }
    })
  }

  return {
    run(input) {
      if (closed) return Promise.reject(schedulerError('Timetable generation is shutting down.', 'SCHEDULER_UNAVAILABLE'))
      if (unavailableError) return Promise.reject(unavailableError)
      while (workers.size < workerCount) spawnWorker()
      const availableWorker = [...workers].some((slot) => !slot.retired && !slot.busy)
      if (!availableWorker && queue.length >= maximumQueueSize) {
        return Promise.reject(schedulerError(
          'The timetable generation service is busy. Please wait briefly and try again.',
          'SCHEDULER_CAPACITY',
        ))
      }

      return new Promise((resolve, reject) => {
        queue.push({ id: nextJobId++, input, resolve, reject })
        dispatch()
      })
    },
    async close() {
      if (closed) return
      closed = true
      rejectPending(schedulerError('Timetable generation was cancelled because the server is shutting down.', 'SCHEDULER_UNAVAILABLE'))
      const active = [...workers]
      for (const slot of active) {
        if (slot.job) {
          slot.job.reject(schedulerError('Timetable generation was cancelled because the server is shutting down.', 'SCHEDULER_UNAVAILABLE'))
          slot.job = undefined
        }
        slot.retired = true
        workers.delete(slot)
      }
      await Promise.all(active.map(({ worker }) => worker.terminate()))
    },
  }
}

let defaultPool

function getDefaultPool() {
  defaultPool ??= createGenericSchedulerWorkerPool()
  return defaultPool
}

export function runGenericTimetableGeneration(input) {
  return getDefaultPool().run(input)
}

export async function closeGenericSchedulerWorkerPool() {
  const pool = defaultPool
  defaultPool = undefined
  await pool?.close()
}
