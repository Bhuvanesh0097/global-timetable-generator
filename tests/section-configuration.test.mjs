import test from 'node:test'
import assert from 'node:assert/strict'
import { getSectionIds, getGenerateTimetableLabel, getSectionCountLabel, initializeConfiguredSections } from '../src/section-configuration.ts'

test('section IDs are department-independent and generated for any positive count', () => {
  assert.deepEqual(getSectionIds(1), ['A'])
  assert.deepEqual(getSectionIds(2), ['A', 'B'])
  assert.deepEqual(getSectionIds(3), ['A', 'B', 'C'])
  assert.deepEqual(getSectionIds(4), ['A', 'B', 'C', 'D'])
  assert.deepEqual(getSectionIds(5), ['A', 'B', 'C', 'D', 'E'])
  assert.deepEqual(getSectionIds(8), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  assert.equal(getSectionIds(27).at(-1), 'AA')
  for (const invalidCount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(getSectionIds(invalidCount), [])
  }
})

test('configured section count initializes blank sections and reuses existing section data', () => {
  const configuredSectionIds = getSectionIds(1)
  const before = []
  const after = initializeConfiguredSections(before, configuredSectionIds)
  assert.equal(before.length, 0)
  assert.equal(after.length, 1)
  assert.deepEqual(after[0], { id: 'A', classAdvisorId: '', studentCount: 0 })

  const existingSectionA = { id: 'A', classAdvisorId: 'existing-staff-id', studentCount: 42 }
  assert.deepEqual(initializeConfiguredSections([existingSectionA], configuredSectionIds), [existingSectionA])
})

test('single-section labels are singular while multi-section labels remain plural', () => {
  assert.equal(getSectionCountLabel(1), '1 section')
  assert.equal(getGenerateTimetableLabel(['A']), 'Generate Timetable for A')
  assert.equal(getSectionCountLabel(2), '2 sections')
  assert.equal(getGenerateTimetableLabel(['A', 'B']), 'Generate Timetables for A & B')
})

