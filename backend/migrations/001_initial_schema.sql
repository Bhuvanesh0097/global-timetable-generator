CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS teachers_normalized_name_idx ON teachers(normalized_name);

CREATE TABLE IF NOT EXISTS timetable_configurations (
  id TEXT PRIMARY KEY,
  department TEXT NOT NULL,
  year TEXT NOT NULL,
  semester TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  configuration_version INTEGER NOT NULL DEFAULT 1 CHECK (configuration_version > 0),
  rules_json TEXT NOT NULL DEFAULT '{}',
  candidate_count INTEGER,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (department, year, semester, academic_year, configuration_version)
);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES timetable_configurations(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  section_name TEXT NOT NULL,
  class_advisor_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (configuration_id, id),
  UNIQUE (configuration_id, source_id),
  UNIQUE (configuration_id, section_name)
);

CREATE TABLE IF NOT EXISTS configuration_teachers (
  configuration_id TEXT NOT NULL REFERENCES timetable_configurations(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  PRIMARY KEY (configuration_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS configuration_items (
  id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES timetable_configurations(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('CORE_SUBJECT', 'OTHER_SUBJECT', 'LAB', 'PLACEMENT', 'SPECIAL_ACTIVITY')),
  code TEXT,
  name TEXT NOT NULL,
  weekly_periods INTEGER CHECK (weekly_periods IS NULL OR weekly_periods > 0),
  block_duration INTEGER CHECK (block_duration IS NULL OR block_duration > 0),
  enabled SMALLINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allowed_start_periods_json TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  item_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (configuration_id, id),
  UNIQUE (configuration_id, item_type, source_id)
);
CREATE INDEX IF NOT EXISTS configuration_items_type_idx ON configuration_items(configuration_id, item_type);

CREATE TABLE IF NOT EXISTS item_teacher_assignments (
  configuration_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, section_id),
  FOREIGN KEY (configuration_id, item_id) REFERENCES configuration_items(configuration_id, id) ON DELETE CASCADE,
  FOREIGN KEY (configuration_id, section_id) REFERENCES sections(configuration_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS item_teacher_assignments_teacher_idx ON item_teacher_assignments(teacher_id);

CREATE TABLE IF NOT EXISTS generated_timetables (
  id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES timetable_configurations(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  active_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (configuration_id, section_id),
  UNIQUE (id, configuration_id),
  FOREIGN KEY (configuration_id, section_id) REFERENCES sections(configuration_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS generated_timetables_generation_idx ON generated_timetables(generation_id);

CREATE TABLE IF NOT EXISTS timetable_versions (
  id TEXT PRIMARY KEY,
  timetable_id TEXT NOT NULL REFERENCES generated_timetables(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SAVED', 'LOCKED')),
  generation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at TIMESTAMPTZ,
  UNIQUE (timetable_id, version_number),
  UNIQUE (id, timetable_id)
);

ALTER TABLE generated_timetables
  ADD CONSTRAINT generated_timetables_active_version_fk
  FOREIGN KEY (active_version_id, id)
  REFERENCES timetable_versions(id, timetable_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS timetable_cells (
  id TEXT PRIMARY KEY,
  timetable_version_id TEXT NOT NULL REFERENCES timetable_versions(id) ON DELETE CASCADE,
  configuration_item_id TEXT REFERENCES configuration_items(id) ON DELETE SET NULL,
  source_item_key TEXT,
  cell_type TEXT NOT NULL CHECK (cell_type IN ('SUBJECT', 'OTHER_SUBJECT', 'LAB', 'PLACEMENT', 'SPECIAL_ACTIVITY')),
  day TEXT NOT NULL CHECK (day IN ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')),
  period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 8),
  subject_code TEXT,
  subject_name TEXT,
  activity_name TEXT,
  is_test SMALLINT NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  teacher_name_snapshot TEXT,
  section_name TEXT NOT NULL,
  department TEXT NOT NULL,
  year TEXT NOT NULL,
  semester TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (timetable_version_id, day, period)
);
CREATE INDEX IF NOT EXISTS timetable_cells_teacher_slot_idx ON timetable_cells(teacher_id, day, period);
CREATE INDEX IF NOT EXISTS timetable_cells_slot_idx ON timetable_cells(timetable_version_id, day, period);
