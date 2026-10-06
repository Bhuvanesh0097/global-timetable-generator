import { useEffect, useMemo, useRef, useState } from 'react'
import type { TimetableSetup } from './models'
import type { GeneratedSection } from './scheduler'
import { buildTeacherTimetable, findTeacherTimetableClashes, getTeachersUsedInTimetable, teacherTimetableColumns, teacherTimetableDays } from './teacher-timetable'
import { buildTeacherExportPayload, createTeacherExportXmp, embedTeacherMetadataInJpeg, embedTeacherMetadataInPng } from './teacher-export-metadata'

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new Error(`The teacher timetable ${type.split('/')[1]?.toUpperCase() ?? 'image'} could not be rendered.`))
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

export function TeacherTimetableFeature({ setup, sections }: { setup: TimetableSetup; sections: GeneratedSection[] }) {
  const [teacherId, setTeacherId] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const documentRef = useRef<HTMLElement | null>(null)
  const relevantTeachers = useMemo(() => getTeachersUsedInTimetable(sections, setup.staff), [sections, setup.staff])
  const teacher = relevantTeachers.find((person) => person.id === teacherId)
  const timetable = teacher ? buildTeacherTimetable(sections, teacher.id) : null
  const teacherClashes = findTeacherTimetableClashes(sections)

  useEffect(() => {
    if (teacherId && !relevantTeachers.some((person) => person.id === teacherId)) {
      setTeacherId('')
      setExportError(null)
    }
  }, [relevantTeachers, teacherId])

  const capture = async () => {
    const element = documentRef.current
    if (!element || !teacher) throw new Error('Select a staff member before exporting.')
    const logo = element.querySelector('img')
    if (logo && !logo.complete) await new Promise<void>((resolve, reject) => {
      logo.addEventListener('load', () => resolve(), { once: true })
      logo.addEventListener('error', () => reject(new Error('The MVIT logo could not be loaded.')), { once: true })
    })
    if (logo && logo.naturalWidth === 0) throw new Error('The MVIT logo could not be loaded.')
    const { default: html2canvas } = await import('html2canvas')
    element.dataset.teacherExport = 'true'
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return await html2canvas(element, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        windowWidth: Math.ceil(297 * 96 / 25.4),
        windowHeight: Math.ceil(210 * 96 / 25.4),
        onclone: (_document, clone) => {
          clone.dataset.teacherExport = 'true'
          clone.style.width = '297mm'
          clone.style.height = '210mm'
          clone.style.minHeight = '210mm'
          clone.style.maxWidth = 'none'
          clone.style.boxSizing = 'border-box'
        },
      })
    } finally {
      delete element.dataset.teacherExport
    }
  }

  const withExport = async (action: (canvas: HTMLCanvasElement, payload: Awaited<ReturnType<typeof buildTeacherExportPayload>>) => Promise<void> | void) => {
    setExporting(true)
    setExportError(null)
    try {
      if (!teacher || !timetable) throw new Error('Select a staff member before exporting.')
      const payload = await buildTeacherExportPayload({ setup, teacher, generatedSections: sections, timetable })
      await action(await capture(), payload)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The teacher timetable could not be exported.')
    } finally {
      setExporting(false)
    }
  }

  const safeTeacherFilename = () => teacher?.name.replace(/[^a-z0-9]+/gi, '-') ?? 'Staff'

  const downloadJpg = () => withExport(async (canvas, payload) => {
    const source = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.95)).arrayBuffer())
    const jpegWithMetadata = embedTeacherMetadataInJpeg(source, payload)
    downloadBlob(new Blob([jpegWithMetadata.buffer.slice(jpegWithMetadata.byteOffset, jpegWithMetadata.byteOffset + jpegWithMetadata.byteLength) as ArrayBuffer], { type: 'image/jpeg' }), `MVIT-Teacher-Timetable-${safeTeacherFilename()}.jpg`)
  })

  const downloadPng = () => withExport(async (canvas, payload) => {
    const source = new Uint8Array(await (await canvasBlob(canvas, 'image/png')).arrayBuffer())
    const pngWithMetadata = embedTeacherMetadataInPng(source, payload)
    downloadBlob(new Blob([pngWithMetadata.buffer.slice(pngWithMetadata.byteOffset, pngWithMetadata.byteOffset + pngWithMetadata.byteLength) as ArrayBuffer], { type: 'image/png' }), `MVIT-Teacher-Timetable-${safeTeacherFilename()}.png`)
  })

  const downloadPdf = () => withExport(async (canvas, payload) => {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
    pdf.setProperties({
      title: `Teacher-wise Timetable - ${payload.teacherName}`,
      subject: 'Teacher-wise Timetable export from the College Timetable Generator',
      author: payload.teacherName,
      keywords: [payload.generator.id, payload.sourceType, payload.teacherId, payload.departmentId, payload.year, payload.semester, payload.exportId].join(', '),
      creator: `${payload.generator.id} ${payload.generator.version}`,
    })
    pdf.addMetadata(createTeacherExportXmp(payload), true)
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 297, 210, undefined, 'FAST')
    pdf.save(`MVIT-Teacher-Timetable-${safeTeacherFilename()}.pdf`)
  })

  const print = () => {
    if (!teacher || !documentRef.current) {
      setExportError('Select a staff member before printing.')
      return
    }
    const element = documentRef.current
    element.dataset.teacherPrint = 'true'
    const clearTarget = () => {
      delete element.dataset.teacherPrint
      window.removeEventListener('afterprint', clearTarget)
    }
    window.addEventListener('afterprint', clearTarget, { once: true })
    window.print()
    window.setTimeout(clearTarget, 1000)
  }

  return <details className="teacher-feature">
    <summary>Teacher-wise Timetable</summary>
    <div className="teacher-feature-content">
      {relevantTeachers.length > 0
        ? <label className="teacher-select-field">
            <span>Select Staff</span>
            <select value={teacher ? teacherId : ''} onChange={(event) => { setTeacherId(event.target.value); setExportError(null) }}>
              <option value="">Select staff member</option>
              {relevantTeachers.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.id}</option>)}
            </select>
          </label>
        : <p role="status">No teachers are assigned in this timetable.</p>}

      {teacherClashes.length > 0 && <div className="teacher-clash-error" role="alert">
        <strong>Invalid generated timetable: simultaneous teacher assignments were detected.</strong>
        {teacherClashes.map(({ teacherId: conflictingTeacherId, day, period, entries }) => <p key={`${conflictingTeacherId}-${day}-${period}`}>
          {setup.staff.find((person) => person.id === conflictingTeacherId)?.name ?? conflictingTeacherId} · {day} P{period}: {entries.map(({ sectionId, cell }) => `Section ${sectionId} — ${cell.abbreviation || cell.name}`).join(' / ')}
        </p>)}
      </div>}

      {teacher && timetable && <>
        <div className="teacher-export-actions">
          <button type="button" onClick={print} disabled={exporting}>Print</button>
          <button type="button" onClick={downloadPdf} disabled={exporting}>{exporting ? 'Preparing…' : 'Download PDF'}</button>
          <button type="button" onClick={downloadPng} disabled={exporting}>{exporting ? 'Preparing…' : 'Download PNG'}</button>
          <button type="button" onClick={downloadJpg} disabled={exporting}>{exporting ? 'Preparing…' : 'Download JPG'}</button>
        </div>
        <article className="teacher-timetable-sheet" ref={(element) => { documentRef.current = element }}>
          <header className="teacher-document-header">
            <img src="/college-logo.png" alt="Manakula Vinayagar Institute of Technology emblem" />
            <div className="teacher-document-brand"><strong>MANAKULA VINAYAGAR</strong><span>INSTITUTE OF TECHNOLOGY</span></div>
            <p>Affiliated to Pondicherry University, Approved by AICTE, New Delhi<br />Accredited by NBA &amp; NAAC · Puducherry – 605 107</p>
          </header>
          <div className="teacher-document-title">
            <h2>Teacher-wise Timetable</h2>
            <h3>{teacher.name}</h3>
            <p>{setup.academic.academicYear} · {setup.academic.semester.split(' / ').at(-1)} · {setup.academic.year.split(' / ')[0]} Year · {setup.academic.department}</p>
          </div>
          <div className="teacher-grid-wrap">
            <table className="teacher-grid">
              <thead><tr><th>Day</th>{teacherTimetableColumns.map((column) => <th className={column.kind === 'break' ? 'teacher-structure-heading' : ''} key={column.kind === 'period' ? `P${column.period}` : column.label}>
                {column.kind === 'period' ? `P${column.period}` : <><strong>{column.label}</strong><small>{column.time}</small></>}
              </th>)}</tr></thead>
              <tbody>{teacherTimetableDays.map((day) => <tr key={day}>
                <th scope="row">{day}</th>
                {teacherTimetableColumns.map((column) => {
                  if (column.kind === 'break') {
                    return day === teacherTimetableDays[0]
                      ? <td className="teacher-structure-cell" rowSpan={teacherTimetableDays.length} key={column.label}><strong>{column.label}</strong><small>{column.time}</small></td>
                      : null
                  }
                  const period = column.period
                  const entries = timetable[day][period]
                  return <td className={entries.length ? 'teacher-busy-cell' : 'teacher-free-cell'} key={period}>
                    {entries.length
                      ? entries.map(({ sectionId, cell, alternateWeek }, index) => <span key={`${sectionId}-${cell.itemId}-${index}`}><strong>Section {sectionId}</strong><b>{cell.abbreviation || cell.name}{cell.isCoreTest ? ' (T)' : ''}</b>{cell.name !== cell.abbreviation && <small>{cell.name}</small>}{alternateWeek && <small>Alternate week</small>}</span>)
                      : 'FREE'}
                  </td>
                })}
              </tr>)}</tbody>
            </table>
          </div>
        </article>
      </>}
      {exportError && <p className="export-error" role="alert">{exportError}</p>}
    </div>
  </details>
}
