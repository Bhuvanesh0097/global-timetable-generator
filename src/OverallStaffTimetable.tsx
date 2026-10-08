import { useEffect, useState } from 'react'
import type { StaffMember, WeekDay } from './models'
import { teacherTimetableDays, teacherTimetablePeriods } from './teacher-timetable'
import { listOverallStaffDirectory, loadOverallStaffTimetable, type OverallStaffTimetableAssignment, type OverallStaffTimetableData } from './timetable-version-client'
import { TeacherSelector } from './TeacherSelector'

function subjectForWeek(assignment: OverallStaffTimetableAssignment) {
  return assignment.week === 'alternate' && assignment.cell.alternateSubject
    ? assignment.cell.alternateSubject
    : assignment.cell
}

function subjectLabel(assignment: OverallStaffTimetableAssignment) {
  const subject = subjectForWeek(assignment)
  const abbreviation = subject.abbreviation || subject.code || subject.name
  const testMarkerPresent = /\(T\)\s*$/i.test(abbreviation)
  return `${abbreviation}${assignment.cell.isCoreTest && !testMarkerPresent ? ' (T)' : ''}`
}

export function OverallStaffTimetableFeature() {
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [teacherId, setTeacherId] = useState('')
  const [timetable, setTimetable] = useState<OverallStaffTimetableData | null>(null)
  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [timetableLoading, setTimetableLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [timetableError, setTimetableError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setDirectoryLoading(true)
    listOverallStaffDirectory()
      .then(({ teachers }) => {
        if (!current) return
        setStaff(teachers.map(({ id, canonicalName }) => ({ id, name: canonicalName })))
        setDirectoryError(null)
      })
      .catch((error: unknown) => {
        if (!current) return
        setDirectoryError(error instanceof Error ? error.message : 'The global Staff Master could not be loaded.')
      })
      .finally(() => {
        if (current) setDirectoryLoading(false)
      })
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!teacherId) {
      setTimetable(null)
      setTimetableError(null)
      setTimetableLoading(false)
      return
    }
    let current = true
    setTimetable(null)
    setTimetableError(null)
    setTimetableLoading(true)
    loadOverallStaffTimetable(teacherId)
      .then((result) => {
        if (current) setTimetable(result)
      })
      .catch((error: unknown) => {
        if (current) setTimetableError(error instanceof Error ? error.message : 'The saved staff timetable could not be loaded.')
      })
      .finally(() => {
        if (current) setTimetableLoading(false)
      })
    return () => { current = false }
  }, [teacherId])

  const selectedTeacher = staff.find((person) => person.id === teacherId)
  const clashes = timetable
    ? teacherTimetableDays.flatMap((day) => teacherTimetablePeriods.flatMap((period) => {
        const slot = timetable.days[day]?.[period]
        return slot?.conflict
          ? [{ day, period, assignments: slot.assignments.filter((assignment) => slot.conflictWeeks.includes(assignment.week)) }]
          : []
      }))
    : []
  const hasAssignments = Boolean(timetable && teacherTimetableDays.some((day) =>
    teacherTimetablePeriods.some((period) => (timetable.days[day]?.[period]?.assignments.length ?? 0) > 0)))

  return <details className="teacher-feature overall-staff-feature">
    <summary>Overall Staff Timetable</summary>
    <div className="teacher-feature-content">
      <label className="teacher-select-field">
        <span>Global Staff · search by name or teacher ID</span>
        <TeacherSelector
          className="teacher-selector--teacher-view"
          staff={staff}
          value={teacherId}
          ariaLabel="Search Global Staff"
          placeholder={directoryLoading ? 'Loading global staff…' : 'Search staff by name or ID'}
          onChange={(nextTeacherId) => {
            setTeacherId(nextTeacherId)
            setTimetable(null)
            setTimetableError(null)
          }}
        />
      </label>
      {directoryLoading && <p role="status">Loading the global Staff Master…</p>}
      {directoryError && <p className="export-error" role="alert">{directoryError}</p>}
      {!directoryLoading && !directoryError && staff.length === 0 && <p role="status">No global Staff Master teachers are available.</p>}
      {selectedTeacher && <p className="overall-staff-selected">Selected: {selectedTeacher.name} · {selectedTeacher.id}</p>}
      {timetableLoading && <p role="status">Loading active saved timetable cells…</p>}
      {timetableError && <p className="export-error" role="alert">{timetableError}</p>}
      {timetable && <>
        {clashes.length > 0 && <div className="teacher-clash-error overall-staff-clashes" role="alert">
          <strong>Conflicting saved assignments were found for this teacher.</strong>
          {clashes.map(({ day, period, assignments }) => <p key={`${day}-${period}`}>
            {day} P{period}: {assignments.map((assignment) => `${assignment.department} · ${assignment.year} · ${assignment.semester} · Section ${assignment.sectionName} — ${subjectForWeek(assignment).abbreviation || subjectForWeek(assignment).name}`).join(' / ')}
          </p>)}
        </div>}
        {!hasAssignments && <p role="status">No active saved timetable assignments were found. Empty periods are shown as FREE.</p>}
        <div className="teacher-grid-wrap">
          <table className="teacher-grid overall-staff-grid">
            <thead><tr><th scope="col">Day</th>{teacherTimetablePeriods.map((period) => <th scope="col" key={period}>P{period}</th>)}</tr></thead>
            <tbody>{teacherTimetableDays.map((day: WeekDay) => <tr key={day}>
              <th scope="row">{day}</th>
              {teacherTimetablePeriods.map((period) => {
                const slot = timetable.days[day]?.[period]
                const assignments = slot?.assignments ?? []
                return <td className={`${assignments.length ? 'teacher-busy-cell' : 'teacher-free-cell'}${slot?.conflict ? ' overall-staff-conflict-cell' : ''}`} key={period}>
                  {assignments.length
                    ? assignments.map((assignment) => {
                        const subject = subjectForWeek(assignment)
                        return <span className="overall-staff-assignment" key={`${assignment.versionId}-${assignment.week}`}>
                          <b>{subjectLabel(assignment)}</b>
                          <small>{subject.name}</small>
                          <small>Department: {assignment.department}</small>
                          <small>Year: {assignment.year} · Semester: {assignment.semester}</small>
                          <small>Section: {assignment.sectionName}</small>
                          {assignment.cell.cellType === 'PLACEMENT' && <small>Placement{assignment.week === 'alternate' ? ' · alternate week' : ''}</small>}
                          {assignment.week === 'alternate' && assignment.cell.cellType !== 'PLACEMENT' && <small>Alternate week</small>}
                        </span>
                      })
                    : 'FREE'}
                </td>
              })}
            </tr>)}</tbody>
          </table>
        </div>
      </>}
      {!teacherId && !directoryLoading && !directoryError && <p className="field-hint">Select a teacher to view assignments from active saved timetables.</p>}
    </div>
  </details>
}
