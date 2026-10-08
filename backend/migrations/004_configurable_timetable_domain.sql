ALTER TABLE timetable_cells
  DROP CONSTRAINT IF EXISTS timetable_cells_day_check,
  DROP CONSTRAINT IF EXISTS timetable_cells_period_check;

ALTER TABLE timetable_cells
  ADD CONSTRAINT timetable_cells_day_check
    CHECK (day IN ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')),
  ADD CONSTRAINT timetable_cells_period_check
    CHECK (period > 0);
