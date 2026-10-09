import { useEffect, useRef, useState } from 'react'
import type { StaffMember, WeekDay } from './models'
import { teacherTimetableDays, teacherTimetablePeriods } from './teacher-timetable'
import { listOverallStaffDirectory, loadOverallStaffTimetable, type OverallStaffTimetableAssignment, type OverallStaffTimetableData } from './timetable-version-client'
import { TeacherSelector } from './TeacherSelector'

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new Error(`The overall staff timetable ${type.split('/')[1]?.toUpperCase() ?? 'image'} could not be rendered.`))
  }, type, quality))
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.download = filename
  link.href = url
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

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
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportRef = useRef<HTMLDivElement | null>(null)

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

  const capture = async () => {
    const element = exportRef.current
    if (!element || !selectedTeacher || !timetable || element.dataset.teacherId !== selectedTeacher.id) {
      throw new Error('Select a staff member and wait for the saved timetable to load before exporting.')
    }
    const { default: html2canvas } = await import('html2canvas')
    if (element.dataset.teacherId !== selectedTeacher.id) {
      throw new Error('The selected staff member changed before the timetable could be exported.')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return html2canvas(element, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: Math.ceil(297 * 96 / 25.4),
      windowHeight: Math.ceil(210 * 96 / 25.4),
      onclone: (_document, clone) => {
        if (clone.dataset.teacherId !== selectedTeacher.id) {
          throw new Error('The selected staff member changed before the timetable could be exported.')
        }
        clone.dataset.overallExport = 'true'
        clone.style.width = '297mm'
        clone.style.minHeight = '210mm'
        clone.style.maxWidth = 'none'
        clone.style.boxSizing = 'border-box'
        clone.querySelector('.teacher-export-actions')?.remove()
      },
    })
  }

  const withExport = async (action: (canvas: HTMLCanvasElement) => Promise<void> | void) => {
    setExporting(true)
    setExportError(null)
    try {
      if (!selectedTeacher || !timetable) throw new Error('Select a staff member before exporting.')
      await action(await capture())
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The overall staff timetable could not be exported.')
    } finally {
      setExporting(false)
    }
  }

  const safeTeacherFilename = () => selectedTeacher?.name.replace(/[^a-z0-9]+/gi, '-') ?? 'Staff'

  const downloadJpg = () => withExport(async (canvas) => {
    const blob = await canvasBlob(canvas, 'image/jpeg', 0.95)
    downloadBlob(blob, `MVIT-Overall-Staff-Timetable-${safeTeacherFilename()}.jpg`)
  })

  const downloadPng = () => withExport(async (canvas) => {
    const blob = await canvasBlob(canvas, 'image/png')
    downloadBlob(blob, `MVIT-Overall-Staff-Timetable-${safeTeacherFilename()}.png`)
  })

  const downloadPdf = () => withExport(async (canvas) => {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
    pdf.setProperties({
      title: `Overall Staff Timetable - ${selectedTeacher?.name ?? ''}`,
      subject: 'Overall Staff Timetable export from active saved timetables',
      author: selectedTeacher?.name ?? '',
    })
    // The captured canvas already includes the page padding and is sized to A4.
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 297, 210, undefined, 'FAST')
    pdf.save(`MVIT-Overall-Staff-Timetable-${safeTeacherFilename()}.pdf`)
  })

  const print = () => {
    const element = exportRef.current
    if (!selectedTeacher || !timetable || !element || element.dataset.teacherId !== selectedTeacher.id) {
      setExportError('Select a staff member and wait for the saved timetable to load before printing.')
      return
    }
    setExportError(null)
    element.dataset.overallPrint = 'true'
    const clearTarget = () => {
      delete element.dataset.overallPrint
      window.removeEventListener('afterprint', clearTarget)
    }
    window.addEventListener('afterprint', clearTarget, { once: true })
    window.print()
    window.setTimeout(clearTarget, 1000)
  }

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
            setExportError(null)
          }}
        />
      </label>
      {directoryLoading && <p role="status">Loading the global Staff Master…</p>}
      {directoryError && <p className="export-error" role="alert">{directoryError}</p>}
      {!directoryLoading && !directoryError && staff.length === 0 && <p role="status">No global Staff Master teachers are available.</p>}
      {selectedTeacher && <div className="overall-staff-export-source" data-teacher-id={selectedTeacher.id} ref={(element) => { exportRef.current = element }}>
        <p className="overall-staff-selected">Selected: {selectedTeacher.name} · {selectedTeacher.id}</p>
        {timetableLoading && <p role="status">Loading active saved timetable cells…</p>}
        {timetableError && <p className="export-error" role="alert">{timetableError}</p>}
        {timetable && <>
          <div className="teacher-export-actions">
            <button type="button" onClick={print} disabled={exporting}>Print</button>
            <button type="button" onClick={downloadPdf} disabled={exporting}>{exporting ? 'Preparing…' : 'Download PDF'}</button>
            <button type="button" onClick={downloadPng} disabled={exporting}>{exporting ? 'Preparing…' : 'Download PNG'}</button>
            <button type="button" onClick={downloadJpg} disabled={exporting}>{exporting ? 'Preparing…' : 'Download JPG'}</button>
          </div>
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
      </div>}
      {exportError && <p className="export-error" role="alert">{exportError}</p>}
      {!teacherId && !directoryLoading && !directoryError && <p className="field-hint">Select a teacher to view assignments from active saved timetables.</p>}
    </div>
  </details>
}
