# Timetable database foundation

The timetable repository uses PostgreSQL through the `pg` connection pool. Set `DATABASE_URL` in the backend environment before starting the application. For local development, add it to the root `.env` file; `.env.example` contains only the variable placeholder. The connection string is read server-side and must not be exposed to client code.

The database is created and migrated when `openTimetableRepository()` first connects. Numbered PostgreSQL migrations live in `migrations/` and are tracked by the `schema_migrations` table. Production migrations run transactionally; PostgreSQL advisory locks prevent concurrent app instances from applying the same migration or creating conflicting saved versions.

```js
import { openTimetableRepository } from './timetable-repository.mjs'

const repository = await openTimetableRepository()
try {
  const configurationId = await repository.createTimetableConfiguration(configuration)
  // Persist an already-generated result; this function does not invoke a scheduler.
  await repository.saveGeneratedTimetableData({ configurationId, generationId, sections })
  const savedConfiguration = await repository.getTimetableConfiguration(configurationId)
} finally {
  await repository.close()
}
```

`configuration` is the department-neutral schedule configuration shape used by the generic model. Teachers use stable caller-provided IDs; normalized names are indexed for lookup but are not unique, so similarly named people are never silently merged. Generated timetable cells store structured slot data and teacher-name snapshots. Each saved generation creates a new timetable version and updates that section timetable's active-version pointer.

The same-origin API endpoints in `timetable-api.mjs` preserve the existing frontend contract:

- `POST /api/timetable-versions` saves one complete generation as a new SAVED version for every section in one transaction.
- `GET /api/timetable-versions` lists each section version and its persisted database ID for the requested department/year/semester/academic year.
- `GET /api/timetable-versions/:timetableVersionId` restores exactly that section version without invoking a scheduler or changing active-version pointers.
- `POST /api/timetable-versions/:timetableVersionId/lock` and `/unlock` change only the identified version's status.
- `DELETE /api/timetable-versions/:timetableVersionId` deletes only the identified version and its cascading cells; locked versions must first be explicitly unlocked.

Version history is append-only. Saving a later generation advances each section's active-version pointer without deleting earlier versions. Use a dedicated, disposable database URL in `TEST_DATABASE_URL` to run the PostgreSQL integration tests against an isolated temporary schema; if it is unset, those tests are skipped. The test suite never falls back to `DATABASE_URL`.
