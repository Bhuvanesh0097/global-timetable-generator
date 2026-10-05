CREATE OR REPLACE FUNCTION prevent_locked_timetable_cell_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_version_id TEXT;
  target_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR target_version_id IN
      SELECT version_id
      FROM (VALUES (OLD.timetable_version_id), (NEW.timetable_version_id)) AS versions(version_id)
      ORDER BY version_id
    LOOP
      SELECT status INTO target_status
      FROM timetable_versions
      WHERE id = target_version_id
      FOR UPDATE;

      IF target_status = 'LOCKED' THEN
        RAISE EXCEPTION 'Locked timetable cells cannot be changed.'
          USING ERRCODE = '55000';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  target_version_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.timetable_version_id
    ELSE NEW.timetable_version_id
  END;
  SELECT status INTO target_status
  FROM timetable_versions
  WHERE id = target_version_id
  FOR UPDATE;

  IF target_status = 'LOCKED' THEN
    RAISE EXCEPTION 'Locked timetable cells cannot be changed.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_locked_timetable_version_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'LOCKED' THEN
    RAISE EXCEPTION 'Locked timetable versions cannot be deleted.'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_locked_timetable_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'LOCKED'
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
  THEN
    RAISE EXCEPTION 'A locked timetable version can only be explicitly unlocked.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_locked_timetable_cell_insert ON timetable_cells;
CREATE TRIGGER prevent_locked_timetable_cell_insert
BEFORE INSERT ON timetable_cells
FOR EACH ROW EXECUTE FUNCTION prevent_locked_timetable_cell_mutation();

DROP TRIGGER IF EXISTS prevent_locked_timetable_cell_update ON timetable_cells;
CREATE TRIGGER prevent_locked_timetable_cell_update
BEFORE UPDATE ON timetable_cells
FOR EACH ROW EXECUTE FUNCTION prevent_locked_timetable_cell_mutation();

DROP TRIGGER IF EXISTS prevent_locked_timetable_cell_delete ON timetable_cells;
CREATE TRIGGER prevent_locked_timetable_cell_delete
BEFORE DELETE ON timetable_cells
FOR EACH ROW EXECUTE FUNCTION prevent_locked_timetable_cell_mutation();

DROP TRIGGER IF EXISTS prevent_locked_timetable_version_delete ON timetable_versions;
CREATE TRIGGER prevent_locked_timetable_version_delete
BEFORE DELETE ON timetable_versions
FOR EACH ROW EXECUTE FUNCTION prevent_locked_timetable_version_delete();

DROP TRIGGER IF EXISTS prevent_locked_timetable_version_mutation ON timetable_versions;
CREATE TRIGGER prevent_locked_timetable_version_mutation
BEFORE UPDATE ON timetable_versions
FOR EACH ROW EXECUTE FUNCTION prevent_locked_timetable_version_mutation();
