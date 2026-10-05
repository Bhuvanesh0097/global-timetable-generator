import { Worker } from 'node:worker_threads'

const maximumWorkerCount = 4
const defaultWorkerCount = 2
const maximumQueueSize = 256
const defaultQueuedGenerations = 32
const defaultGenerationTimeoutMs = 15 * 60 * 1000
const defaultQueueWaitTimeoutMs = 30 * 60 * 1000
const workerUrl = new URL('./generic-scheduler-worker.mjs', import.meta.url)

function configuredInteger(name, value, defaultValue, minimum, maximum) {
  if (value === undefined || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return parsed
}

export function createGenericSchedulerWorkerPool({
  workerCount: workerCountInput = process.env.TIMETABLE_SCHEDULER_WORKERS,
  maximumQueueSize: maximumQueueSizeInput = process.env.TIMETABLE_SCHEDULER_QUEUE_SIZE,
  workerTimeoutMs: workerTimeoutInput = process.env.TIMETABLE_SCHEDULER_TIMEOUT_MS,
  queueWaitTimeoutMs: queueWaitTimeoutInput = process.env.TIMETABLE_SCHEDULER_QUEUE_WAIT_TIMEOUT_MS,
  workerUrl: workerUrlInput = workerUrl,
} = {}) {
  const workerCount = configuredInteger('TIMETABLE_SCHEDULER_WORKERS', workerCountInput, defaultWorkerCount, 1, maximumWorkerCount)
  const queueSize = configuredInteger('TIMETABLE_SCHEDULER_QUEUE_SIZE', maximumQueueSizeInput, defaultQueuedGenerations, 0, maximumQueueSize)
  const workerTimeoutMs = configuredInteger('TIMETABLE_SCHEDULER_TIMEOUT_MS', workerTimeoutInput, defaultGenerationTimeoutMs, 1_000, 60 * 60 * 1000)
  const queueWaitTimeoutMs = configuredInteger(
    'TIMETABLE_SCHEDULER_QUEUE_WAIT_TIMEOUT_MS',
    queueWaitTimeoutInput,
    defaultQueueWaitTimeoutMs,
    1_000,
    60 * 60 * 1000,
  )
  const workers = new Set()
  const queue = []
  let nextJobId = 1
  let closed = false
  let replacementTimer

  const schedulerError = (message, code) => Object.assign(new Error(message), { code })

  function rejectPending(error) {
    for (const job of queue.splice(0)) {
      clearTimeout(job.queueTimer)
      job.reject(error)
    }
  }

  function spawnWorker() {
    let worker
    try {
      worker = new Worker(workerUrlInput, { execArgv: ['--experimental-strip-types'] })
    } catch (error) {
      return error instanceof Error ? error : new Error('The timetable scheduler worker could not be started.')
    }

    const slot = { worker, busy: false, retired: false, job: undefined, timeout: undefined }
    workers.add(slot)
    worker.on('message', (message) => {
      if (!slot.job || !message || message.jobId !== slot.job.id) {
        retire(slot, schedulerError('The timetable scheduler worker returned an unexpected response.', 'SCHEDULER_WORKER_FAILED'))
        return
      }
      if (typeof message.error === 'string' || !message.value?.result
        || typeof message.value.result.ok !== 'boolean') {
        const failure = typeof message.error === 'string'
          ? message.error
          : 'The timetable scheduler worker returned an invalid response.'
        retire(slot, schedulerError(failure, 'SCHEDULER_WORKER_FAILED'))
        return
      }

      const job = slot.job
      clearTimeout(slot.timeout)
      slot.timeout = undefined
      slot.job = undefined
      slot.busy = false
      job.resolve(message.value)
      dispatch()
    })
    worker.on('error', (error) => retire(slot, error))
    worker.on('exit', (code) => {
      if (!slot.retired) {
        retire(slot, schedulerError(`A timetable scheduler worker exited unexpectedly with code ${code}.`, 'SCHEDULER_WORKER_FAILED'))
      }
    })
    return slot
  }

  function ensureWorkers() {
    if (closed) return
    clearTimeout(replacementTimer)
    replacementTimer = undefined
    while (workers.size < workerCount) {
      const slot = spawnWorker()
      if (slot instanceof Error) {
        if (!replacementTimer) {
          replacementTimer = setTimeout(() => {
            replacementTimer = undefined
            ensureWorkers()
            dispatch()
          }, 1_000)
          replacementTimer.unref?.()
        }
        break
      }
    }
  }

  function dispatch() {
    if (closed) return
    for (const slot of workers) {
      if (slot.retired || slot.busy || !queue.length) continue
      const job = queue.shift()
      if (!job) continue
      clearTimeout(job.queueTimer)
      slot.busy = true
      slot.job = job
      slot.timeout = setTimeout(() => {
        retire(slot, schedulerError(
          'Generation exceeded the allowed server calculation time.',
          'SCHEDULER_TIMEOUT',
        ))
      }, workerTimeoutMs)
      slot.timeout.unref?.()
      try {
        slot.worker.postMessage({ jobId: job.id, input: job.input })
      } catch (error) {
        retire(slot, error instanceof Error
          ? schedulerError(error.message, 'SCHEDULER_WORKER_FAILED')
          : schedulerError('The timetable generation request could not be sent to a worker.', 'SCHEDULER_WORKER_FAILED'))
      }
    }
  }

  function retire(slot, error) {
    if (slot.retired) return
    slot.retired = true
    clearTimeout(slot.timeout)
    slot.timeout = undefined
    if (slot.job) {
      slot.job.reject(error ?? schedulerError('A timetable scheduler worker stopped unexpectedly.', 'SCHEDULER_WORKER_FAILED'))
      slot.job = undefined
    }
    slot.busy = false
    void slot.worker.terminate().catch((terminationError) => {
      console.error('Could not terminate a failed timetable scheduler worker:', terminationError)
    }).finally(() => {
      workers.delete(slot)
      if (closed) return
      ensureWorkers()
      if (workers.size === 0) {
        rejectPending(schedulerError(
          'Timetable generation workers are temporarily unavailable. Please try again shortly.',
          'SCHEDULER_UNAVAILABLE',
        ))
      } else dispatch()
    })
  }

  return {
    run(input) {
      if (closed) return Promise.reject(schedulerError('Timetable generation is shutting down.', 'SCHEDULER_UNAVAILABLE'))
      ensureWorkers()
      if (workers.size === 0) {
        return Promise.reject(schedulerError(
          'Timetable generation workers are temporarily unavailable. Please try again shortly.',
          'SCHEDULER_UNAVAILABLE',
        ))
      }

      const availableWorker = [...workers].some((slot) => !slot.retired && !slot.busy)
      if (!availableWorker && queue.length >= queueSize) {
        return Promise.reject(schedulerError(
          'The generation request could not be queued because the bounded queue is full. Please try again shortly.',
          'SCHEDULER_CAPACITY',
        ))
      }

      return new Promise((resolve, reject) => {
        const job = { id: nextJobId++, input, resolve, reject, queueTimer: undefined }
        job.queueTimer = setTimeout(() => {
          const index = queue.indexOf(job)
          if (index < 0) return
          queue.splice(index, 1)
          job.reject(schedulerError(
            'The generation request exceeded the maximum queue wait time.',
            'SCHEDULER_QUEUE_TIMEOUT',
          ))
        }, queueWaitTimeoutMs)
        job.queueTimer.unref?.()
        queue.push(job)
        dispatch()
      })
    },
    async close() {
      if (closed) return
      closed = true
      clearTimeout(replacementTimer)
      replacementTimer = undefined
      rejectPending(schedulerError('Timetable generation was cancelled because the server is shutting down.', 'SCHEDULER_UNAVAILABLE'))
      const active = [...workers]
      for (const slot of active) {
        clearTimeout(slot.timeout)
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
