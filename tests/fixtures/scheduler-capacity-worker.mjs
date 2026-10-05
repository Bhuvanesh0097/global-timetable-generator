import { parentPort } from 'node:worker_threads'

parentPort.on('message', ({ jobId, input }) => {
  if (input.mode === 'hang') return
  if (input.mode === 'crash') process.exit(17)
  if (input.mode === 'invalid') {
    parentPort.postMessage({ jobId, value: {} })
    return
  }

  const respond = () => parentPort.postMessage({
    jobId,
    value: {
      result: { ok: true, sections: [], searchNodes: 1, validation: { sections: [], globalTeacherClashes: 0 } },
      marker: input.marker,
      startedAt: Date.now(),
    },
  })
  setTimeout(respond, input.delayMs ?? 0)
})
