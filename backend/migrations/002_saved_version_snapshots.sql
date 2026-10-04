ALTER TABLE timetable_cells ADD COLUMN abbreviation TEXT;
ALTER TABLE timetable_cells ADD COLUMN block_id TEXT;

ALTER TABLE timetable_versions ADD COLUMN validation_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE timetable_versions ADD COLUMN setup_snapshot_json TEXT NOT NULL DEFAULT '{}';
