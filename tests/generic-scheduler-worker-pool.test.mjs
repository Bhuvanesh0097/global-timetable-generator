import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenericSchedulerWorkerPool } from '../backend/generic-scheduler-worker-pool.mjs'

const testWorkerUrl = new URL('./fixtures/scheduler-capacity-worker.mjs', import.meta.url)

test('queues requests beyond the worker count in FIFO order and rejects only after the configured queue is full', async () => {
  const pool = createGenericSchedulerWorkerPool({
    workerCount: 1,
    maximumQueueSize: 2,
    workerUrl: testWorkerUrl,
    workerTimeoutMs: 5_000,
  })
  try {
    const first = pool.run({ marker: 'first', delayMs: 30 })
    const second = pool.run({ marker: 'second' })
    const third = pool.run({ marker: 'third' })
    await assert.rejects(pool.run({ marker: 'overflow' }), { code: 'SCHEDULER_CAPACITY' })

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third])
    assert.deepEqual([firstResult.marker, secondResult.marker, thirdResult.marker], ['first', 'second', 'third'])
    assert.ok(firstResult.startedAt <= secondResult.startedAt)
    assert.ok(secondResult.startedAt <= thirdResult.startedAt)
  } finally {
    await pool.close()
  }
})

test('times out a running worker, replaces it, and continues the FIFO queue', async () => {
  const pool = createGenericSchedulerWorkerPool({
    workerCount: 1,
    maximumQueueSize: 2,
    workerUrl: testWorkerUrl,
    workerTimeoutMs: 1_000,
  })
  try {
    const timedOut = pool.run({ mode: 'hang' })
    const queued = pool.run({ marker: 'after-timeout' })

    await assert.rejects(timedOut, {
      code: 'SCHEDULER_TIMEOUT',
      message: 'Generation exceeded the allowed server calculation time.',
    })
    assert.equal((await queued).marker, 'after-timeout')
  } finally {
    await pool.close()
  }
})

test('expires a queued request instead of allowing it to wait forever', async () => {
  const pool = createGenericSchedulerWorkerPool({
    workerCount: 1,
    maximumQueueSize: 2,
    workerUrl: testWorkerUrl,
    workerTimeoutMs: 1_500,
    queueWaitTimeoutMs: 1_000,
  })
  try {
    const active = pool.run({ mode: 'hang' })
    const expired = pool.run({ marker: 'expired' })
    await assert.rejects(expired, { code: 'SCHEDULER_QUEUE_TIMEOUT' })
    await assert.rejects(active, { code: 'SCHEDULER_TIMEOUT' })
  } finally {
    await pool.close()
  }
})

test('retires crashed or invalid-response workers and runs the next queued request', async (t) => {
  for (const mode of ['crash', 'invalid']) {
    await t.test(mode, async () => {
      const pool = createGenericSchedulerWorkerPool({
        workerCount: 1,
        maximumQueueSize: 2,
        workerUrl: testWorkerUrl,
        workerTimeoutMs: 5_000,
      })
      try {
        const failed = pool.run({ mode })
        const queued = pool.run({ marker: `after-${mode}` })
        await assert.rejects(failed, { code: 'SCHEDULER_WORKER_FAILED' })
        assert.equal((await queued).marker, `after-${mode}`)
      } finally {
        await pool.close()
      }
    })
  }
})
