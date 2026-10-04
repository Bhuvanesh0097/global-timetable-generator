# Timetable database foundation

The project uses Node's built-in SQLite driver and a relational schema. Timetable version persistence has no dependency on either scheduler implementation.

Requires a Node release that provides `node:sqlite` (Node 24 is verified in this workspace). The default database file is `data/mvit-timetable.sqlite`; set `TIMETABLE_DATABASE_PATH` to use a different file. The database is created and migrated on the first call to `openTimetableRepository()`.

```js
import { openTimetableRepository } from './timetable-repository.mjs'

const repository = openTimetableRepository()
try {
  const configurationId = repository.createTimetableConfiguration(configuration)
  // Persist an already-generated result; this function does not invoke a scheduler.
  repository.saveGeneratedTimetableData({ configurationId, generationId, sections })
  const configuration = repository.getTimetableConfiguration(configurationId)
} finally {
  repository.close()
}
```

`configuration` is the department-neutral schedule configuration shape used by the generic model. Teachers use stable caller-provided IDs; normalized names are indexed for lookup but are not unique, so similarly named people are never silently merged. Generated timetable cells store structured slot data and teacher-name snapshots. Each saved generation creates a new timetable version and updates that section timetable's active-version pointer.

The initial schema is in `migrations/001_initial_schema.sql`; `migrations/002_saved_version_snapshots.sql` adds the exact rendering/setup snapshots used to reopen a saved version. Migrations are tracked with SQLite's `user_version`. The configured database file is runtime data and is excluded from source control.

Vite development and preview servers mount the same-origin persistence endpoints from `timetable-api.mjs`:

- `POST /api/timetable-versions` saves one complete generation as a new SAVED version for every section in one transaction.
- `GET /api/timetable-versions` lists each section version and its persisted database ID for the requested department/year/semester/academic year.
- `GET /api/timetable-versions/:timetableVersionId` restores exactly that section version without invoking a scheduler or changing active-version pointers.
- `POST /api/timetable-versions/:timetableVersionId/lock` and `/unlock` change only the identified version's status.
- `DELETE /api/timetable-versions/:timetableVersionId` deletes only the identified version and its cascading cells; locked versions must first be explicitly unlocked.

Version history is append-only. Saving a later generation advances each section's active-version pointer without deleting earlier versions.
