import { createLogger, defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createTimetableApiMiddleware } from './backend/timetable-api.mjs'
import { openTimetableRepository } from './backend/timetable-repository.mjs'

const logger = createLogger()

function timetableApiPlugin(databaseUrl: string | undefined) {
  let repositoryPromise: ReturnType<typeof openTimetableRepository> | undefined
  let apiMiddlewarePromise: Promise<ReturnType<typeof createTimetableApiMiddleware>> | undefined
  const middleware: ReturnType<typeof createTimetableApiMiddleware> = async (request, response, next) => {
    try {
      repositoryPromise ??= openTimetableRepository({ databaseUrl })
      apiMiddlewarePromise ??= repositoryPromise.then((repository) => createTimetableApiMiddleware(repository))
      await (await apiMiddlewarePromise)(request, response, next)
    } catch (error) {
      logger.error(`Timetable PostgreSQL connection failed: ${String(error)}`)
      response.statusCode = 503
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'Timetable version storage is unavailable. Check the database service and try again.' }))
    }
  }
  const closeRepository = () => {
    void apiMiddlewarePromise?.then(async () => {
      await (await repositoryPromise)?.close()
      repositoryPromise = undefined
      apiMiddlewarePromise = undefined
    }).catch((error: unknown) => logger.error(`Could not close timetable PostgreSQL connection: ${String(error)}`))
  }
  return {
    name: 'mvit-timetable-version-api',
    configureServer(server: { middlewares: { use: (path: string, middleware: ReturnType<typeof createTimetableApiMiddleware>) => void }; httpServer?: { once: (event: string, listener: () => void) => void } }) {
      server.middlewares.use('/api', middleware)
      server.httpServer?.once('close', closeRepository)
    },
    configurePreviewServer(server: { middlewares: { use: (path: string, middleware: ReturnType<typeof createTimetableApiMiddleware>) => void }; httpServer?: { once: (event: string, listener: () => void) => void } }) {
      server.middlewares.use('/api', middleware)
      server.httpServer?.once('close', closeRepository)
    },
  }
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '.', '')
  return {
    plugins: [react(), timetableApiPlugin(environment.DATABASE_URL)],
    preview: {
      allowedHosts: ['global-timetable-generator.onrender.com'],
    },
  }
})
