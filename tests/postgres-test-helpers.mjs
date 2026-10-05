import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { openTimetableRepository } from '../backend/timetable-repository.mjs'

export const hasPostgresTestDatabase = Boolean(process.env.TEST_DATABASE_URL)

export async function createTestPostgresRepository() {
  const databaseUrl = process.env.TEST_DATABASE_URL
  if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to run PostgreSQL integration tests.')

  const schema = `mvit_test_${randomUUID().replaceAll('-', '')}`
  const repositories = new Set()
  const open = async () => {
    const repository = await openTimetableRepository({ databaseUrl, schema })
    repositories.add(repository)
    return repository
  }
  const close = async (repository) => {
    if (repositories.delete(repository)) await repository.close()
  }

  await open()
  return {
    schema,
    open,
    close,
    cleanup: async () => {
      for (const repository of [...repositories]) await close(repository)
      const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 })
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await pool.end()
      }
    },
    get repository() {
      return [...repositories].at(-1)
    },
  }
}
