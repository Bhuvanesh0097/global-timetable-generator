ALTER TABLE timetable_cells ADD COLUMN IF NOT EXISTS abbreviation TEXT;
ALTER TABLE timetable_cells ADD COLUMN IF NOT EXISTS block_id TEXT;

ALTER TABLE timetable_versions ADD COLUMN IF NOT EXISTS validation_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE timetable_versions ADD COLUMN IF NOT EXISTS setup_snapshot_json TEXT NOT NULL DEFAULT '{}';
