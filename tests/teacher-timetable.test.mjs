import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTeacherTimetable, findTeacherTimetableClashes, teacherTimetableColumns } from '../src/teacher-timetable.ts'
import { globalStaffIds } from '../src/staff-identities.ts'

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const section = (sectionId, assignments) => ({
  sectionId,
  schedule: Object.fromEntries(days.map((day) => [day, Object.fromEntries(
    Object.entries(assignments[day] ?? {}).map(([period, cell]) => [Number(period), cell]),
  )])),
})
const cell = (teacherId, itemId, abbreviation, name = abbreviation) => ({
  teacherId, itemId, code: itemId.toUpperCase(), abbreviation, name, kind: 'core',
})

test('teacher timetable combines only matching generated assignments across sections', () => {
  const generated = [
    section('A', { Monday: { 1: cell('staff-1', 'coi', 'COI'), 3: cell('staff-2', 'cn', 'CN') } }),
    section('B', { Monday: { 4: cell('staff-1', 'dbs', 'DBS') } }),
    section('C', { Tuesday: { 7: cell('staff-1', 'foss', 'FOSS/NPTEL', 'FOSS / NPTEL') } }),
  ]

  const timetable = buildTeacherTimetable(generated, 'staff-1')

  assert.deepEqual(timetable.Monday[1], [{ sectionId: 'A', cell: generated[0].schedule.Monday[1] }])
  assert.deepEqual(timetable.Monday[4], [{ sectionId: 'B', cell: generated[1].schedule.Monday[4] }])
  assert.deepEqual(timetable.Tuesday[7], [{ sectionId: 'C', cell: generated[2].schedule.Tuesday[7] }])
  assert.deepEqual(timetable.Monday[3], [])
  assert.deepEqual(timetable.Saturday[8], [])
  assert.deepEqual(buildTeacherTimetable(generated, 'staff-2').Monday[3].map(({ sectionId, cell: assignedCell }) => [sectionId, assignedCell.abbreviation]), [['A', 'CN']])
})

test('same subject and slot remain separate when different staff teach across sections', () => {
  const generated = [
    section('A', { Monday: { 3: cell('staff-1', 'cn', 'CN') } }),
    section('B', { Monday: { 3: cell('staff-2', 'cn', 'CN') } }),
  ]

  assert.deepEqual(buildTeacherTimetable(generated, 'staff-1').Monday[3].map(({ sectionId, cell: assignedCell }) => [sectionId, assignedCell.abbreviation]), [['A', 'CN']])
  assert.deepEqual(buildTeacherTimetable(generated, 'staff-2').Monday[3].map(({ sectionId, cell: assignedCell }) => [sectionId, assignedCell.abbreviation]), [['B', 'CN']])
  assert.deepEqual(findTeacherTimetableClashes(generated), [])
})

test('a globally shared staff identity clashes across department schedules at the same slot', () => {
  const generated = [
    section('A', { Monday: { 3: cell(globalStaffIds.drAMathiarasu, 'mech-core-mmm', 'MMM') } }),
    section('B', { Monday: { 3: cell(globalStaffIds.drAMathiarasu, 'ft-core-rccm', 'RCCM') } }),
  ]
  assert.deepEqual(findTeacherTimetableClashes(generated).map(({ teacherId, day, period }) => [teacherId, day, period]), [
    [globalStaffIds.drAMathiarasu, 'Monday', 3],
  ])

  generated[1].schedule.Monday[3] = cell('another-staff-global-id', 'ft-core-rccm', 'RCCM')
  assert.deepEqual(findTeacherTimetableClashes(generated), [])
})

test('teacher timetable retains simultaneous source entries instead of inventing a choice', () => {
  const generated = [
    section('A', { Monday: { 2: cell('staff-1', 'cn', 'CN') } }),
    section('B', { Monday: { 2: cell('staff-1', 'dbs', 'DBS') } }),
  ]

  const slot = buildTeacherTimetable(generated, 'staff-1').Monday[2]

  assert.deepEqual(slot.map(({ sectionId, cell: scheduledCell }) => [sectionId, scheduledCell.abbreviation]), [
    ['A', 'CN'],
    ['B', 'DBS'],
  ])
  assert.deepEqual(findTeacherTimetableClashes(generated).map(({ teacherId, day, period, entries }) => [teacherId, day, period, entries.length]), [
    ['staff-1', 'Monday', 2, 2],
  ])
})

test('teacher timetable keeps breaks and lunch structural instead of treating them as periods', () => {
  assert.deepEqual(teacherTimetableColumns.map((column) => column.kind === 'period' ? `P${column.period}` : column.label), [
    'P1', 'P2', 'Morning Break', 'P3', 'P4', 'Lunch', 'P5', 'P6', 'Tea Break', 'P7', 'P8',
  ])
})
