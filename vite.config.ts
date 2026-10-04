import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createTimetableApiMiddleware } from './backend/timetable-api.mjs'
import { openTimetableRepository } from './backend/timetable-repository.mjs'

function timetableApiPlugin() {
  let repository: ReturnType<typeof openTimetableRepository> | undefined
  const middleware = () => {
    repository ??= openTimetableRepository()
    return createTimetableApiMiddleware(repository)
  }
  return {
    name: 'mvit-timetable-version-api',
    configureServer(server: { middlewares: { use: (path: string, middleware: ReturnType<typeof createTimetableApiMiddleware>) => void }; httpServer?: { once: (event: string, listener: () => void) => void } }) {
      server.middlewares.use('/api', middleware())
      server.httpServer?.once('close', () => {
        repository?.close()
        repository = undefined
      })
    },
    configurePreviewServer(server: { middlewares: { use: (path: string, middleware: ReturnType<typeof createTimetableApiMiddleware>) => void }; httpServer?: { once: (event: string, listener: () => void) => void } }) {
      server.middlewares.use('/api', middleware())
      server.httpServer?.once('close', () => {
        repository?.close()
        repository = undefined
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), timetableApiPlugin()],
  preview: {
    allowedHosts: ['global-timetable-generator.onrender.com'],
  },
})
