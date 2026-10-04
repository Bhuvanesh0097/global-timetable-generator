CREATE TRIGGER IF NOT EXISTS prevent_locked_timetable_cell_update
BEFORE UPDATE ON timetable_cells
WHEN EXISTS (
  SELECT 1 FROM timetable_versions
  WHERE id = OLD.timetable_version_id AND status = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'Locked timetable cells cannot be changed.');
END;

CREATE TRIGGER IF NOT EXISTS prevent_locked_timetable_cell_delete
BEFORE DELETE ON timetable_cells
WHEN EXISTS (
  SELECT 1 FROM timetable_versions
  WHERE id = OLD.timetable_version_id AND status = 'LOCKED'
)
BEGIN
  SELECT RAISE(ABORT, 'Locked timetable cells cannot be deleted.');
END;

CREATE TRIGGER IF NOT EXISTS prevent_locked_timetable_version_delete
BEFORE DELETE ON timetable_versions
WHEN OLD.status = 'LOCKED'
BEGIN
  SELECT RAISE(ABORT, 'Locked timetable versions cannot be deleted.');
END;

CREATE TRIGGER IF NOT EXISTS prevent_locked_timetable_version_mutation
BEFORE UPDATE ON timetable_versions
WHEN OLD.status = 'LOCKED'
  AND NOT (
    NEW.id = OLD.id
    AND NEW.timetable_id = OLD.timetable_id
    AND NEW.version_number = OLD.version_number
    AND NEW.generation_id = OLD.generation_id
    AND NEW.created_at = OLD.created_at
    AND NEW.validation_json = OLD.validation_json
    AND NEW.setup_snapshot_json = OLD.setup_snapshot_json
    AND NEW.status = 'SAVED'
    AND NEW.locked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'A locked timetable version can only be explicitly unlocked.');
END;
