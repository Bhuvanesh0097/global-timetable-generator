import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent, type Ref } from 'react'
import { Check, FileText, Image as ImageIcon, UploadCloud, X } from 'lucide-react'
import {
  canGenerateTogether,
  createConsolidatedUploadItem,
  removeConsolidatedUploadItem,
  validateConsolidatedUpload,
  validateConsolidationScope,
  type ConsolidatedUploadItem,
} from './consolidated-faculty-upload'
import { combineValidatedTeacherTimetables, type ConsolidatedFacultyTimetable as ConsolidatedTimetable } from './consolidated-faculty-timetable'
import { teacherTimetableColumns, teacherTimetableDays } from './teacher-timetable'

function createId(): string {
  return crypto.randomUUID()
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob)
    else reject(new Error(`The consolidated timetable ${type.split('/')[1]?.toUpperCase() ?? 'image'} could not be rendered.`))
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

export function ConsolidatedFacultyTimetable() {
  const [uploads, setUploads] = useState<ConsolidatedUploadItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [combined, setCombined] = useState<ConsolidatedTimetable | null>(null)
  const [combineError, setCombineError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const documentRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dragDepth = useRef(0)
  const uploadsRef = useRef<ConsolidatedUploadItem[]>([])
  const validationQueue = useRef<Promise<void>>(Promise.resolve())

  const addFiles = (files: FileList | File[]) => {
    const added = Array.from(files).map((file) => createConsolidatedUploadItem(file, createId()))
    if (!added.length) return
    const queued = [...uploadsRef.current, ...added]
    uploadsRef.current = queued
    setUploads(queued)
    setCombined(null)
    setCombineError('')
    setExportError('')

    validationQueue.current = validationQueue.current.then(async () => {
      for (const pending of added) {
        if (pending.status !== 'pending') continue
        if (!uploadsRef.current.some(({ id }) => id === pending.id)) continue
        const checked = await validateConsolidatedUpload(pending)
        const current = uploadsRef.current
        if (!current.some(({ id }) => id === pending.id)) continue
        const scoped = validateConsolidationScope(checked, current.filter(({ id }) => id !== pending.id))
        const next = current.map((item) => item.id === pending.id ? scoped : item)
        uploadsRef.current = next
        setUploads(next)
      }
    })
  }

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files) addFiles(event.currentTarget.files)
    // Let the user select the same file again after removing it.
    event.currentTarget.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setIsDragging(false)
    addFiles(event.dataTransfer.files)
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setIsDragging(true)
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }

  const handleDropzoneKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      inputRef.current?.click()
    }
  }

  const removeUpload = (id: string) => {
    const next = removeConsolidatedUploadItem(uploadsRef.current, id)
    uploadsRef.current = next
    setUploads(next)
    setCombined(null)
    setCombineError('')
    setExportError('')
  }

  const validCount = uploads.filter(({ status }) => status === 'valid').length
  const generateTogether = () => {
    setCombineError('')
    setExportError('')
    try {
      const payloads = uploads.flatMap((item) => item.status === 'valid' && item.payload ? [item.payload] : [])
      setCombined(combineValidatedTeacherTimetables(payloads))
    } catch (error) {
      setCombined(null)
      setCombineError(error instanceof Error ? error.message : 'The uploaded timetables could not be combined.')
    }
  }

  const capture = async (): Promise<HTMLCanvasElement> => {
    const element = documentRef.current
    if (!element || !combined?.valid) throw new Error('Generate a valid consolidated timetable before exporting.')
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
          clone.classList.add('consolidated-export-document')
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

  const withExport = async (action: (canvas: HTMLCanvasElement) => Promise<void> | void) => {
    setExporting(true)
    setExportError('')
    try {
      if (!combined?.valid) throw new Error('Resolve all timetable conflicts before exporting.')
      await action(await capture())
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The consolidated timetable could not be exported.')
    } finally {
      setExporting(false)
    }
  }

  const safeTeacherFilename = () => combined?.teacherName.replace(/[^a-z0-9]+/gi, '-') ?? 'Staff'
  const downloadPng = () => withExport(async (canvas) => {
    downloadBlob(await canvasBlob(canvas, 'image/png'), `MVIT-Consolidated-Faculty-Timetable-${safeTeacherFilename()}.png`)
  })
  const downloadJpg = () => withExport(async (canvas) => {
    downloadBlob(await canvasBlob(canvas, 'image/jpeg', 0.95), `MVIT-Consolidated-Faculty-Timetable-${safeTeacherFilename()}.jpg`)
  })
  const downloadPdf = () => withExport(async (canvas) => {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
    pdf.setProperties({
      title: `Consolidated Faculty Timetable - ${combined?.teacherName ?? ''}`,
      subject: `${combined?.academicYear ?? ''} · ${combined?.departmentName ?? ''} · ${(combined?.yearsIncluded ?? []).join(', ')}`,
      author: combined?.teacherName ?? '',
      keywords: ['Consolidated Faculty Timetable', combined?.teacherId ?? '', combined?.departmentId ?? '', ...(combined?.yearsIncluded ?? [])].join(', '),
      creator: 'MVIT College Timetable Generator',
    })
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 297, 210, undefined, 'FAST')
    pdf.save(`MVIT-Consolidated-Faculty-Timetable-${safeTeacherFilename()}.pdf`)
  })
  const print = () => {
    if (!combined?.valid || !documentRef.current) {
      setExportError('Resolve all timetable conflicts before printing.')
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

  return <section className="consolidated-faculty-card" aria-labelledby="consolidated-faculty-title">
    <div className="consolidated-faculty-heading">
      <div>
        <h2 id="consolidated-faculty-title">Consolidated Faculty Timetable</h2>
        <p>Combine teaching schedules across multiple years</p>
      </div>
    </div>

    <div
      className={`consolidated-upload-zone${isDragging ? ' is-dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Drop Teacher-wise Timetables here or click to upload"
      onClick={() => inputRef.current?.click()}
      onKeyDown={handleDropzoneKey}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span className="consolidated-upload-icon"><UploadCloud size={23} /></span>
      <strong>Drop Teacher-wise Timetables here</strong>
      <span>Upload PDF, PNG or JPG files generated by this application.</span>
      <small>Click to choose files · Multiple files are supported</small>
      <input
        ref={inputRef}
        className="consolidated-upload-input"
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        multiple
        onChange={handleInput}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>

    {uploads.length > 0 && <div className="consolidated-file-list" aria-label="Uploaded teacher timetables">
      {uploads.map(({ id, file, fileType, status, payload, rejectionReason }) => <article className="consolidated-file-card" key={id}>
        <span className="consolidated-file-icon" aria-hidden="true">{fileType === 'PDF' ? <FileText size={20} /> : <ImageIcon size={20} />}</span>
        <div className="consolidated-file-info">
          <div className="consolidated-file-title"><strong title={file.name}>{file.name}</strong><span>{fileType}</span></div>
          <div className="consolidated-file-details">
            <span>Teacher <b>{status === 'pending' ? 'Checking…' : payload?.teacherName ?? 'Not available'}</b></span>
            <span>Department <b>{status === 'pending' ? 'Checking…' : payload?.departmentName ?? 'Not available'}</b></span>
            <span>Year <b>{status === 'pending' ? 'Checking…' : payload?.year ?? 'Not available'}</b></span>
            {payload && <span>Semester <b>{payload.semester}</b></span>}
          </div>
          <span className={`consolidated-file-status ${status}`} role="status">
            {status === 'pending' ? 'Checking file…' : status === 'valid' ? <><Check size={15} aria-hidden="true" /> Valid</> : <>✕ Rejected</>}
          </span>
          {status === 'rejected' && <p className="consolidated-file-reason" role="alert">{rejectionReason}</p>}
        </div>
        <button
          type="button"
          className="consolidated-file-remove"
          aria-label={`Remove ${file.name}`}
          onClick={() => removeUpload(id)}
        ><X size={17} /><span>Remove</span></button>
      </article>)}
    </div>}

    <div className="consolidated-generate-row">
      <p>{uploads.length === 0
        ? 'Files will be checked before they can be combined.'
        : `${validCount} valid file${validCount === 1 ? '' : 's'} · ${uploads.length - validCount} awaiting validation or rejected.`}</p>
      <button
        type="button"
        className="consolidated-generate-button"
        disabled={!canGenerateTogether(uploads)}
        onClick={generateTogether}
      >Generate Together</button>
    </div>
    {combineError && <p className="consolidated-merge-error" role="alert">{combineError}</p>}
    {!combined && !combineError && <p className="consolidated-phase-note">Only verified Teacher-wise Timetables for the same teacher and department, with unique years, can be combined. Source timetables are never changed.</p>}

    {combined && <ConsolidatedTimetableView
      timetable={combined}
      documentRef={documentRef}
      exporting={exporting}
      exportError={exportError}
      onPrint={print}
      onDownloadPdf={downloadPdf}
      onDownloadPng={downloadPng}
      onDownloadJpg={downloadJpg}
    />}
  </section>
}

function ConsolidatedTimetableView({
  timetable,
  documentRef,
  exporting,
  exportError,
  onPrint,
  onDownloadPdf,
  onDownloadPng,
  onDownloadJpg,
}: {
  timetable: ConsolidatedTimetable
  documentRef: Ref<HTMLElement>
  exporting: boolean
  exportError: string
  onPrint: () => void
  onDownloadPdf: () => void
  onDownloadPng: () => void
  onDownloadJpg: () => void
}) {
  return <div className="consolidated-merge-result" aria-label="Combined teacher timetable">
    {!timetable.valid && <section className="consolidated-conflicts" role="alert" aria-labelledby="consolidated-conflicts-title">
      <strong id="consolidated-conflicts-title">Conflict detected — this consolidated timetable is not valid.</strong>
      {timetable.conflicts.map(({ day, period, assignments }) => <div className="consolidated-conflict-item" key={`${day}-${period}`}>
        <b>{day} P{period}</b>
        {assignments.map((assignment, index) => <span key={`${assignment.year}-${assignment.section}-${assignment.code}-${index}`}>
          {assignment.year} • {assignment.departmentId} • Section {assignment.section}: {assignment.abbreviation || assignment.subjectOrActivity}
          {assignment.subjectOrActivity !== assignment.abbreviation && ` — ${assignment.subjectOrActivity}`}
        </span>)}
      </div>)}
    </section>}

    {timetable.valid && <div className="teacher-export-actions consolidated-export-actions">
      <button type="button" onClick={onPrint} disabled={exporting}>Print</button>
      <button type="button" onClick={onDownloadPdf} disabled={exporting}>{exporting ? 'Preparing…' : 'Download PDF'}</button>
      <button type="button" onClick={onDownloadPng} disabled={exporting}>{exporting ? 'Preparing…' : 'Download PNG'}</button>
      <button type="button" onClick={onDownloadJpg} disabled={exporting}>{exporting ? 'Preparing…' : 'Download JPG'}</button>
    </div>}
    {exportError && <p className="export-error" role="alert">{exportError}</p>}
    <article className="teacher-timetable-sheet consolidated-timetable-sheet" ref={documentRef}>
      <header className="teacher-document-header">
        <img src="/college-logo.png" alt="Manakula Vinayagar Institute of Technology emblem" />
        <div className="teacher-document-brand"><strong>MANAKULA VINAYAGAR</strong><span>INSTITUTE OF TECHNOLOGY</span></div>
        <p>Affiliated to Pondicherry University, Approved by AICTE, New Delhi<br />Accredited by NBA &amp; NAAC · Puducherry – 605 107</p>
      </header>
      <div className="teacher-document-title">
        <h2>Consolidated Faculty Timetable</h2>
        <h3>Teacher: {timetable.teacherName}</h3>
        <p>Academic Year: {timetable.academicYear}</p>
        <p>Department: {timetable.departmentId} Department</p>
        <small>Years Included: {timetable.yearsIncluded.join(' • ')}</small>
      </div>
      <div className="teacher-grid-wrap">
        <table className="teacher-grid consolidated-teacher-grid">
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
              const slot = timetable.timetable[day][column.period]
              if (slot.status === 'free') return <td className="teacher-free-cell" key={column.period}>FREE</td>
              if (slot.status === 'conflict') return <td className="consolidated-conflict-cell" key={column.period}>CONFLICT</td>
              const { assignment } = slot
              return <td className="teacher-busy-cell" key={column.period}>
                <span>
                  <strong>Section {assignment.section}</strong>
                  <b>{assignment.abbreviation || assignment.subjectOrActivity}</b>
                  {assignment.subjectOrActivity !== assignment.abbreviation && <small>{assignment.subjectOrActivity}</small>}
                  <small className="consolidated-assignment-context">{assignment.year} • {assignment.departmentId}</small>
                </span>
              </td>
            })}
          </tr>)}</tbody>
        </table>
      </div>
    </article>
  </div>
}
