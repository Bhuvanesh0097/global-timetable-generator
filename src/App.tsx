import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  BookOpen, ChevronDown, ChevronUp, LockKeyhole,
  FlaskConical, GraduationCap, Plus, Settings2, Sparkles, Star, Trash2, Users,
} from 'lucide-react'
import type { CoreSubject, LabAssignment, LabDefinition, OtherSubject, Section, SectionName, SectionSubjectAssignment, SpecialActivity, SpecialActivityAssignment, StaffMember, TimetableSetup, WeekDay } from './models'
import type { GeneratedSection, ScheduledCell, TimetableGenerationResult } from './scheduler'
import { validateGenericScheduleConfig, validateGenericScheduleEdit } from './generic-scheduler.ts'
import { toGenericScheduleConfig } from './generic-schedule-adapter.ts'
import { cloneGeneratedSections, exchangeGeneratedTimetableCells, getEditableTimetableChoices, updateGeneratedTimetableCell } from './timetable-edit'
import { TeacherTimetableFeature } from './TeacherTimetable'
import { ConsolidatedFacultyTimetable } from './ConsolidatedFacultyTimetable'
import { getGenerateTimetableLabel, getSectionCountLabel, getSectionIds, initializeConfiguredSections } from './section-configuration'
import { globalStaffMaster } from './staff-identities'
import { TeacherSelector } from './TeacherSelector'
import type { GenericGeneratedSection, GenericScheduledAlternateSubject, GenericTimetableGenerationResult } from './generic-scheduling-model.ts'
import { deleteSavedTimetableVersion, generateGenericTimetableOnServer, listSavedTimetableNavigation, listSavedTimetableVersions, loadSavedTeacherUnavailableSlots, loadSavedTimetableVersion, saveTimetableVersion, setSavedTimetableVersionLock, type SavedTimetableNavigationEntry, type SavedTimetableVersionSummary } from './timetable-version-client'

const departments = ['CSE', 'IT', 'AIML', 'ECE', 'EEE', 'IOT', 'RA', 'FT', 'MECH']
const yearOptions = [
  { value: 'II / 2nd Year', label: '2nd Year' },
  { value: 'III / 3rd Year', label: '3rd Year' },
]
const semesterOptions = [
  { value: 'V / 5th Semester', label: 'Odd' },
  { value: 'VI / 6th Semester', label: 'Even' },
]
interface AcademicConfigurationSelection {
  department: string
  year: string
  semester: string
}
const academicConfigurationKey = ({ department, year, semester }: AcademicConfigurationSelection) => `${department}|${year}|${semester}`
const weekDays: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const timetableRows = [
  { kind: 'period', label: 'P1', time: '8:50 AM – 9:40 AM' },
  { kind: 'period', label: 'P2', time: '9:40 AM – 10:30 AM' },
  { kind: 'break', label: 'Break', time: '10:30 AM – 10:45 AM' },
  { kind: 'period', label: 'P3', time: '10:45 AM – 11:35 AM' },
  { kind: 'period', label: 'P4', time: '11:35 AM – 12:25 PM' },
  { kind: 'break', label: 'Lunch', time: '12:25 PM – 1:10 PM' },
  { kind: 'period', label: 'P5', time: '1:10 PM – 2:00 PM' },
  { kind: 'period', label: 'P6', time: '2:00 PM – 2:50 PM' },
  { kind: 'break', label: 'Tea Break', time: '2:50 PM – 3:00 PM' },
  { kind: 'period', label: 'P7', time: '3:00 PM – 3:50 PM' },
  { kind: 'period', label: 'P8', time: '3:50 PM – 4:40 PM' },
] as const
const periods = Array.from({ length: 8 }, (_, index) => index + 1)
const academicYearLabel = '2026 - 2027'

function uniqueStaffMembers(members: StaffMember[]): StaffMember[] {
  const byId = new Map<string, StaffMember>()
  for (const member of members) {
    const candidate = member.id?.trim() ?? ''
    if (!candidate) continue
    if (!byId.has(candidate)) byId.set(candidate, member)
  }
  return [...byId.values()]
}

function sanitizeStaffMembers(members: StaffMember[]): StaffMember[] {
  const canonicalByName = new Map(globalStaffMaster.map((member) => [member.name.trim().toLocaleLowerCase(), member.id]))
  const canonicalById = new Map(globalStaffMaster.map((member) => [member.id, member]))
  const merged = new Map<string, StaffMember>()

  for (const member of members) {
    const rawId = member.id?.trim() ?? ''
    const rawName = member.name?.trim() ?? ''
    const canonicalNameMatch = rawName ? canonicalByName.get(rawName.toLocaleLowerCase()) : undefined
    const canonicalId = canonicalById.has(rawId) ? rawId : canonicalNameMatch ?? rawId
    const canonical = canonicalById.get(canonicalId) ?? { id: canonicalId, name: rawName }
    const key = canonical.id
    if (!merged.has(key)) merged.set(key, canonical)
  }

  return uniqueStaffMembers([...globalStaffMaster, ...[...merged.values()]])
}

function nextGlobalStaffId(currentStaff: StaffMember[]): string {
  const used = new Set(currentStaff.map((member) => member.id))
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `ST${String(index).padStart(3, '0')}`
    if (!used.has(candidate)) return candidate
  }
  return `ST${String(Date.now() % 100000).padStart(5, '0')}`
}

const initialStaffMaster = sanitizeStaffMembers(globalStaffMaster)

function createEmptyConfiguration(selection: AcademicConfigurationSelection, staff: StaffMember[]): TimetableSetup {
  return {
    academic: {
      department: selection.department,
      academicYear: academicYearLabel,
      year: selection.year,
      semester: selection.semester,
    },
    staff,
    sections: [{ id: 'A', classAdvisorId: '', studentCount: 0 }],
    coreSubjects: [],
    otherSubjectMaster: [],
    otherSubjects: [],
    labMaster: [],
    labAssignments: [],
    specialActivities: [],
    sectionSubjectAssignments: [],
    specialActivityAssignments: [],
    genericScheduling: {
      allowConsecutiveSpecialActivityDays: false,
      allowCoreSubjectsInP1: true,
      allowOtherSubjectsInP1: true,
      testPolicy: 'off',
      p1TestSubjectIds: [],
    },
  }
}

function staffForSelection(_selection: AcademicConfigurationSelection): StaffMember[] {
  return initialStaffMaster
}

function configurationForSections(configuration: TimetableSetup, sectionIds: SectionName[]): TimetableSetup {
  return {
    ...configuration,
    sections: initializeConfiguredSections(configuration.sections, sectionIds),
  }
}

function configuredWeeklyHours(setup: TimetableSetup): number {
  const placementRow = setup.specialActivities.find((item) => ['placement', 'placement training'].includes(item.name.trim().toLocaleLowerCase()))
  const placementEnabled = setup.genericScheduling?.placementEnabled ?? true
  const placementPeriods = placementRow && placementEnabled ? placementRow.hoursPerWeek : 0
  return setup.coreSubjects.reduce((total, subject) => total + subject.hoursPerWeek, 0)
    + setup.labMaster.reduce((total, lab) => total + lab.weeklyPeriods, 0)
    + setup.otherSubjects.reduce((total, subject) => total + subject.hoursPerWeek, 0)
    + setup.specialActivities.filter((item) => !['placement', 'placement training'].includes(item.name.trim().toLocaleLowerCase()))
      .reduce((total, item) => total + item.hoursPerWeek, 0)
    + placementPeriods
}

function genericWorkloadIssue(total: number): string | null {
  if (total > 48) return `Total configured workload is ${total}/48. Remove ${total - 48} weekly periods before generating.`
  if (total < 48) return `Total configured workload is ${total}/48. Add ${48 - total} weekly periods before generating.`
  return null
}

type SectionKey = 'academic' | 'staff' | 'sections' | 'coreSubjects' | 'otherSubjects' | 'labs' | 'specialActivities' | 'rules'
interface AccordionProps { id: SectionKey; number: string; title: string; description: string; icon: typeof GraduationCap; count?: string; open: boolean; onToggle: (id: SectionKey) => void; children: React.ReactNode }

function Accordion({ id, number, title, description, icon: Icon, count, open, onToggle, children }: AccordionProps) {
  return <section className={`accordion ${open ? 'is-open' : ''}`}>
    <button className="accordion-heading" aria-expanded={open} aria-controls={`panel-${id}`} onClick={() => onToggle(id)}>
      <span className="section-icon"><Icon size={19} strokeWidth={1.9} /></span>
      <span className="section-number">{number}</span>
      <span className="section-copy"><span className="section-title">{title}</span><span className="section-description">{description}</span></span>
      {count && <span className="section-count">{count}</span>}
      <span className="chevron">{open ? <ChevronUp size={19} /> : <ChevronDown size={19} />}</span>
    </button>
    {open && <div className="accordion-panel" id={`panel-${id}`}>{children}</div>}
  </section>
}

function Field({ label, value, onChange, type = 'text', options, choices, min, max }: { label: string; value: string | number; onChange: (value: string) => void; type?: string; options?: string[]; choices?: { value: string; label: string }[]; min?: number; max?: number }) {
  return <label className="field"><span>{label}</span>{options || choices ? <select value={value} onChange={(e) => onChange(e.target.value)}>{options?.map((option) => <option key={option}>{option}</option>)}{choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input type={type} value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} />}</label>
}

function TeacherSelect({ sectionId, subjectId, subjectName, staff, assignments, onAssign, coreSubjectIds }: { sectionId: SectionName; subjectId: string; subjectName: string; staff: StaffMember[]; assignments: SectionSubjectAssignment[]; onAssign: (sectionId: SectionName, subjectId: string, teacherId: string, enforceCoreRule?: boolean) => void; coreSubjectIds?: Set<string> }) {
  const selectedTeacherId = assignments.find((assignment) => assignment.sectionId === sectionId && assignment.subjectId === subjectId)?.teacherId ?? ''
  return <TeacherSelector
    staff={staff}
    value={selectedTeacherId}
    ariaLabel={`Section ${sectionId} teacher for ${subjectName}`}
    placeholder="Search by teacher name or ID"
    onChange={(teacherId) => onAssign(sectionId, subjectId, teacherId, coreSubjectIds !== undefined)}
  />
}

function TeamTeacherSelects({ sectionId, subjectId, subjectName, staff, assignments, onAssign }: { sectionId: SectionName; subjectId: string; subjectName: string; staff: StaffMember[]; assignments: SectionSubjectAssignment[]; onAssign: (sectionId: SectionName, subjectId: string, teacherIds: string[]) => void }) {
  const selectedTeacherIds = assignments
    .filter((assignment) => assignment.sectionId === sectionId && assignment.subjectId === subjectId)
    .map((assignment) => assignment.teacherId)
  const values = [selectedTeacherIds[0] ?? '', selectedTeacherIds[1] ?? '']
  return <div className="team-teacher-selects">
    {values.map((value, index) => <TeacherSelector
      key={index}
      staff={staff}
      value={value}
      ariaLabel={`Section ${sectionId} teacher ${index + 1} for ${subjectName}`}
      placeholder={`Search teacher ${index + 1}`}
      onChange={(teacherId) => {
        const next = [...values]
        next[index] = teacherId
        onAssign(sectionId, subjectId, next)
      }}
    />)}
  </div>
}

function StaffDropdown({ sectionId, subjectName, staff, value, onChange }: { sectionId: SectionName; subjectName: string; staff: StaffMember[]; value: string; onChange: (teacherId: string) => void }) {
  return <TeacherSelector
    staff={staff}
    value={value}
    ariaLabel={`Section ${sectionId} teacher for ${subjectName}`}
    placeholder="Search by teacher name or ID"
    onChange={onChange}
  />
}

function CoreSubjectTable({ rows, staff, assignments, onAssign, onAssignTeam, multiTeacherSubjectIds, onUpdate, onAdd, onRemove, sectionIds }: { rows: CoreSubject[]; staff: StaffMember[]; assignments: SectionSubjectAssignment[]; onAssign: (sectionId: SectionName, subjectId: string, teacherId: string, enforceCoreRule?: boolean) => void; onAssignTeam?: (sectionId: SectionName, subjectId: string, teacherIds: string[]) => void; multiTeacherSubjectIds?: Set<string>; onUpdate: (id: string, patch: Partial<CoreSubject>) => void; onAdd: () => void; onRemove: (id: string) => void; sectionIds: SectionName[] }) {
  const coreSubjectIds = new Set(rows.map((row) => row.id))
  return <div className="table-wrap">
    <div className="subtable-heading"><h3>Core / Main Subjects</h3><button type="button" className="text-button" onClick={onAdd}><Plus size={15} /> Add Subject</button></div>
    <table className="fixed-subject-table"><thead><tr><th className="row-number">S.No</th><th>Subject Code</th><th>Subject Name</th><th>Abbreviation</th><th className="hours-col">Hours/Week</th>{sectionIds.map((section) => <th key={section}>Section {section} Teacher</th>)}<th aria-label="Actions" /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id}>
        <td className="row-number">{index + 1}</td>
        <td><input aria-label={`Core subject code ${index + 1}`} value={row.code} required onChange={(event) => onUpdate(row.id, { code: event.target.value })} /></td>
        <td><input aria-label={`Core subject name ${index + 1}`} value={row.name} required onChange={(event) => onUpdate(row.id, { name: event.target.value })} /></td>
        <td><input aria-label={`Core subject abbreviation ${index + 1}`} value={row.abbreviation} required onChange={(event) => onUpdate(row.id, { abbreviation: event.target.value })} /></td>
        <td><input aria-label={`Core subject hours per week ${index + 1}`} type="number" min={1} step={1} value={row.hoursPerWeek || ''} required onChange={(event) => onUpdate(row.id, { hoursPerWeek: Number(event.target.value) || 0 })} /></td>
        {sectionIds.map((section) => <td key={section}>{multiTeacherSubjectIds?.has(row.id) && onAssignTeam
          ? <TeamTeacherSelects sectionId={section} subjectId={row.id} subjectName={row.name} staff={staff} assignments={assignments} onAssign={onAssignTeam} />
          : <TeacherSelect sectionId={section} subjectId={row.id} subjectName={row.name} staff={staff} assignments={assignments} onAssign={onAssign} coreSubjectIds={coreSubjectIds} />}</td>)}
        <td><button type="button" className="icon-button danger" aria-label={`Remove ${row.name || `Core subject ${index + 1}`}`} title="Remove Core / Main Subject" onClick={() => onRemove(row.id)}><Trash2 size={15} /></button></td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="empty-row">No Core / Main Subjects configured. Add a subject to get started.</p>}
  </div>
}

function OtherSubjectTable({ rows, staff, assignments, onAssign, onUpdate, onAdd, onRemove, sectionIds, allowZeroHours = false }: { rows: OtherSubject[]; staff: StaffMember[]; assignments: SectionSubjectAssignment[]; onAssign: (sectionId: SectionName, subjectId: string, teacherId: string) => void; onUpdate: (id: string, patch: Partial<OtherSubject>) => void; onAdd: () => void; onRemove: (id: string) => void; sectionIds: SectionName[]; allowZeroHours?: boolean }) {
  return <div className="table-wrap">
    <div className="subtable-heading"><h3>Other subject selections</h3><button className="text-button" onClick={onAdd}><Plus size={15} /> Add subject</button></div>
    <table className="fixed-subject-table"><thead><tr><th className="row-number">S.No</th><th>Subject Code</th><th>Subject Name</th><th>Abbreviation</th><th className="hours-col">Hours/Week</th>{sectionIds.map((section) => <th key={section}>Section {section} Teacher</th>)}<th aria-label="Actions" /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id}>
        <td className="row-number">{index + 1}</td>
        <td><input aria-label={`Other subject code ${index + 1}`} value={row.code} required onChange={(event) => onUpdate(row.id, { code: event.target.value })} /></td>
        <td><input aria-label={`Other subject name ${index + 1}`} value={row.name} required onChange={(event) => onUpdate(row.id, { name: event.target.value })} /></td>
        <td><input aria-label={`Other subject abbreviation ${index + 1}`} value={row.abbreviation} required onChange={(event) => onUpdate(row.id, { abbreviation: event.target.value })} /></td>
        <td><input aria-label={`Other subject hours per week ${index + 1}`} type="number" min={allowZeroHours ? 0 : 1} step={1} value={allowZeroHours ? row.hoursPerWeek : row.hoursPerWeek || ''} required onChange={(event) => onUpdate(row.id, { hoursPerWeek: Number(event.target.value) || 0 })} /></td>
        {sectionIds.map((section) => <td key={section}><TeacherSelect sectionId={section} subjectId={row.id} subjectName={row.name || 'Other subject'} staff={staff} assignments={assignments} onAssign={onAssign} /></td>)}
        <td><button className="icon-button danger" aria-label={`Remove ${row.name || 'other subject'}`} onClick={() => onRemove(row.id)}><Trash2 size={15} /></button></td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="empty-row">No other subjects selected. Add a subject to get started.</p>}
  </div>
}

function LabAssignmentTable({ rows, master, staff, onAssign, onUpdate, onAdd, onRemove, sectionIds }: { rows: LabAssignment[]; master: LabDefinition[]; staff: StaffMember[]; onAssign: (labId: string, sectionId: SectionName, teacherId: string) => void; onUpdate: (id: string, patch: Partial<LabDefinition>) => void; onAdd: () => void; onRemove: (id: string) => void; sectionIds: SectionName[] }) {
  return <div className="table-wrap">
    <div className="subtable-heading"><h3>Labs</h3><button type="button" className="text-button" onClick={onAdd}><Plus size={15} /> Add Lab</button></div>
    <table className="fixed-subject-table"><thead><tr><th className="row-number">S.No</th><th>Lab Code</th><th>Lab Name</th><th>Abbreviation</th><th className="hours-col">Hours/Week</th>{sectionIds.map((section) => <th key={section}>Teacher for Section {section}</th>)}<th aria-label="Actions" /></tr></thead>
      <tbody>{master.map((lab, index) => <tr key={lab.id}>
        <td className="row-number">{index + 1}</td>
        <td><input aria-label={`Lab code ${index + 1}`} value={lab.code} required onChange={(event) => onUpdate(lab.id, { code: event.target.value })} /></td>
        <td><input aria-label={`Lab name ${index + 1}`} value={lab.name} required onChange={(event) => onUpdate(lab.id, { name: event.target.value })} /></td>
        <td><input aria-label={`Lab abbreviation ${index + 1}`} value={lab.abbreviation} required onChange={(event) => onUpdate(lab.id, { abbreviation: event.target.value })} /></td>
        <td><input aria-label={`Lab hours per week ${index + 1}`} type="number" min={1} step={1} value={lab.weeklyPeriods || ''} required onChange={(event) => onUpdate(lab.id, { weeklyPeriods: Number(event.target.value) || 0 })} /></td>
        {sectionIds.map((sectionId) => {
          const teacherId = rows.find((assignment) => assignment.labId === lab.id && assignment.sectionId === sectionId)?.teacherId ?? ''
          return <td key={sectionId}><StaffDropdown sectionId={sectionId} subjectName={lab.name} staff={staff} value={teacherId} onChange={(teacherId) => onAssign(lab.id, sectionId, teacherId)} /></td>
        })}
        <td><button type="button" className="icon-button danger" aria-label={`Remove ${lab.name || `Lab ${index + 1}`}`} title="Remove Lab" onClick={() => onRemove(lab.id)}><Trash2 size={15} /></button></td>
      </tr>)}</tbody>
    </table>
    {master.length === 0 && <p className="empty-row">No labs configured. Add a lab to get started.</p>}
  </div>
}

function SpecialActivitiesTable({ rows, staff, assignments, onUpdate, onAssign, onAdd, onRemove, sectionIds, showPlacementControls = false }: { rows: SpecialActivity[]; staff: StaffMember[]; assignments: SpecialActivityAssignment[]; onUpdate: (id: string, patch: Partial<SpecialActivity>) => void; onAssign: (activityId: string, sectionId: SectionName, teacherId: string) => void; onAdd: () => void; onRemove: (activityId: string) => void; sectionIds: SectionName[]; showPlacementControls?: boolean }) {
  return <div className="table-wrap">
    <div className="subtable-heading"><h3>Special Activities</h3><button type="button" className="text-button" onClick={onAdd}><Plus size={15} /> Add Activity</button></div>
    <table className="fixed-subject-table"><thead><tr><th className="row-number">S.No</th><th>Activity</th><th className="hours-col">Hours/Week</th>{sectionIds.map((section) => <th key={section}>Section {section} Teacher</th>)}<th aria-label="Actions" /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id}>
        <td className="row-number">{index + 1}</td>
        <td><input aria-label={`Activity name ${index + 1}`} value={row.name} required onChange={(event) => onUpdate(row.id, { name: event.target.value })} /></td>
        <td>{showPlacementControls && ['placement', 'placement training'].includes(row.name.trim().toLocaleLowerCase())
          ? <div className="placement-activity-controls"><label className="placement-number-field"><span>Weekly periods</span><input aria-label="Placement weekly periods" type="number" min={1} step={1} value={row.hoursPerWeek || ''} required onChange={(event) => onUpdate(row.id, { hoursPerWeek: Number(event.target.value) || 0 })} /></label></div>
          : <input aria-label={`Activity hours per week ${index + 1}`} type="number" min={1} step={1} value={row.hoursPerWeek || ''} required onChange={(event) => onUpdate(row.id, { hoursPerWeek: Number(event.target.value) || 0 })} />}</td>
        {sectionIds.map((sectionId) => {
          const teacherId = assignments.find((assignment) => assignment.sectionId === sectionId && assignment.activityId === row.id)?.teacherId ?? ''
          return <td key={sectionId}><StaffDropdown sectionId={sectionId} subjectName={row.name} staff={staff} value={teacherId} onChange={(teacherId) => onAssign(row.id, sectionId, teacherId)} /></td>
        })}
        <td><button type="button" className="icon-button danger" aria-label={`Remove ${row.name || `activity ${index + 1}`}`} title="Remove activity" onClick={() => onRemove(row.id)}><Trash2 size={15} /></button></td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="empty-row">No special activities configured. Add an activity to get started.</p>}
  </div>
}

function PlacementExceptionControls({ enabled, placementExists, blockDuration, exception, coreSubjects, otherSubjects, sections, onEnabledChange, onModeChange, onSubjectChange }: {
  enabled: boolean
  placementExists: boolean
  blockDuration: number
  exception?: TimetableSetup['placementException']
  coreSubjects: CoreSubject[]
  otherSubjects: OtherSubject[]
  sections: Section[]
  onEnabledChange: (enabled: boolean) => void
  onModeChange: (mode: 'random' | 'custom') => void
  onSubjectChange: (sectionId: SectionName, position: number, selectedValue: string) => void
}) {
  const allocationMode = exception?.allocationMode
    ?? (exception?.alternateSubjects.some((alternate) => !alternate.sectionId) ? 'custom' : 'random')
  const choices = [
    ...coreSubjects.map((subject) => ({ value: `core:${subject.id}`, label: `${subject.name || subject.code} (${subject.code}) · Core / Main` })),
    ...otherSubjects.map((subject) => ({ value: `other:${subject.id}`, label: `${subject.name || subject.code} (${subject.code}) · Other` })),
  ]
  return <div className="placement-exception-controls">
    <label className="checkbox-label"><input type="checkbox" aria-label="Placement Exception enabled" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} /> Placement Exception · Enabled</label>
    {enabled && !placementExists && <p className="validation-error" role="alert">Placement Exception requires Placement to be enabled.</p>}
    {enabled && placementExists && blockDuration > 0 && blockDuration <= 4 && <>
      <Field label="Alternate Subject Allocation" value={allocationMode} choices={[{ value: 'random', label: 'Random Allocation' }, { value: 'custom', label: 'Custom Selection' }]} onChange={(value) => onModeChange(value as 'random' | 'custom')} />
      {allocationMode === 'random'
        ? <p className="field-hint">Alternate subjects are allocated per section during generation using configured subjects and their assigned teachers.</p>
        : <div className="placement-alternate-sections">
          {sections.map((section) => <div className="placement-alternate-section" key={section.id}>
            <strong>Section {section.id}</strong>
            <div className="field-grid">
              {Array.from({ length: Math.max(0, Math.min(blockDuration, 4)) }, (_, index) => {
                const position = index + 1
                const alternate = exception?.alternateSubjects.find((entry) => entry.sectionId === section.id && entry.placementPosition === position)
                  ?? exception?.alternateSubjects.find((entry) => !entry.sectionId && entry.placementPosition === position)
                const value = alternate ? `${alternate.subjectKind}:${alternate.subjectId}` : ''
                return <Field key={position} label={`Placement position ${position}`} value={value} choices={[{ value: '', label: 'Select configured subject' }, ...choices]} onChange={(selectedValue) => onSubjectChange(section.id, position, selectedValue)} />
              })}
            </div>
          </div>)}
        </div>}
      <p className="field-hint">The configured teacher for each selected subject and section is used in the alternate week. These subjects replace Placement in the same positions and do not add weekly workload.</p>
    </>}
  </div>
}

interface TimetableSubjectRow {
  code: string
  abbreviation: string
  name: string
  teacher: string
  hours: number
}

function getTimetableSubjectRows(setup: TimetableSetup, sectionId: SectionName, generatedSection?: GeneratedSection): TimetableSubjectRow[] {
  const teacherName = (teacherId: string) => setup.staff.find((person) => person.id === teacherId)?.name ?? ''
  const actualHours = (itemId: string, configuredHours: number) => generatedSection
    ? Object.values(generatedSection.schedule).flatMap((day) => Object.values(day)).filter((cell) => cell.itemId === itemId).length
    : configuredHours
  const coreRows = setup.coreSubjects.map((item) => ({
    code: item.code,
    abbreviation: item.abbreviation,
    name: item.name,
    teacher: [...new Set(setup.sectionSubjectAssignments
      .filter((assignment) => assignment.sectionId === sectionId && assignment.subjectId === item.id)
      .map((assignment) => teacherName(assignment.teacherId)).filter(Boolean))].join(' / '),
    hours: actualHours(`core:${sectionId}:${item.id}`, item.hoursPerWeek),
  }))
  const otherRows = setup.otherSubjects.filter((item) => item.code && item.name).map((item) => ({
    code: item.code,
    abbreviation: item.abbreviation,
    name: item.name,
    teacher: teacherName(setup.sectionSubjectAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.subjectId === item.id)?.teacherId ?? ''),
    hours: actualHours(`other:${sectionId}:${item.id}`, item.hoursPerWeek),
  }))
  const labRows = setup.labAssignments.filter((item) => item.sectionId === sectionId).flatMap((item) => {
    const lab = setup.labMaster.find((definition) => definition.id === item.labId)
    if (!lab) return []
    return [{ code: lab.code, abbreviation: lab.abbreviation, name: lab.name, teacher: teacherName(item.teacherId), hours: actualHours(`lab:${sectionId}:${lab.id}`, lab.weeklyPeriods) }]
  })
  const activityRows = setup.specialActivities.map((item) => ({
    code: '',
    abbreviation: '',
    name: item.name,
    teacher: teacherName(setup.specialActivityAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.activityId === item.id)?.teacherId ?? ''),
    hours: actualHours(`activity:${sectionId}:${['placement', 'placement training'].includes(item.name.trim().toLocaleLowerCase()) ? 'placement' : item.id}`, item.hoursPerWeek),
  }))
  return [...coreRows, ...otherRows, ...labRows, ...activityRows]
}

function getAlternateWeekSubject(cell: ScheduledCell | undefined) {
  return (cell as (ScheduledCell & { alternateSubject?: GenericScheduledAlternateSubject }) | undefined)?.alternateSubject
}

function setupForEditedSections(setup: TimetableSetup): TimetableSetup {
  const sectionIds = new Set(setup.sections.map((section) => section.id))
  return {
    ...setup,
    sectionSubjectAssignments: setup.sectionSubjectAssignments.filter((assignment) => sectionIds.has(assignment.sectionId)),
    labAssignments: setup.labAssignments.filter((assignment) => sectionIds.has(assignment.sectionId)),
    specialActivityAssignments: setup.specialActivityAssignments.filter((assignment) => sectionIds.has(assignment.sectionId)),
    ...(setup.placementException ? {
      placementException: {
        ...setup.placementException,
        alternateSubjects: setup.placementException.alternateSubjects.map((alternate) => ({
          ...alternate,
          teacherAssignments: alternate.teacherAssignments.filter((assignment) => sectionIds.has(assignment.sectionId)),
        })),
      },
    } : {}),
  }
}

function genericSectionsForEdit(setup: TimetableSetup, sectionsToEdit: GeneratedSection[]): GenericGeneratedSection[] {
  const profileId = `${setup.academic.department}|${setup.academic.academicYear}|${setup.academic.year}|${setup.academic.semester}`
  return sectionsToEdit.map((section) => {
    const schedule = Object.fromEntries(Object.entries(section.schedule).map(([day, dayCells]) => {
      let priorBlockKey = ''
      let priorBlockId = ''
      let blockIndex = 0
      const cells = Object.fromEntries(Object.entries(dayCells).map(([period, rawCell]) => {
        const cell = rawCell as ScheduledCell & { blockId?: string }
        const protectedBlock = cell.kind === 'lab' || (cell.kind === 'activity' && isPlacementActivity(cell.name, cell.itemId))
        if (!protectedBlock) {
          priorBlockKey = ''
          priorBlockId = ''
          return [period, cell]
        }
        const blockKey = `${cell.kind}:${cell.itemId}`
        if (blockKey !== priorBlockKey) {
          priorBlockKey = blockKey
          priorBlockId = cell.blockId ?? `edit-block:${section.sectionId}:${day}:${blockKey}:${blockIndex++}`
        }
        return [period, cell.blockId ? cell : { ...cell, blockId: priorBlockId }]
      }))
      return [day, cells]
    })) as GenericGeneratedSection['schedule']
    return {
      ...section,
      profileId,
      department: setup.academic.department,
      academicYear: setup.academic.academicYear,
      year: setup.academic.year,
      semester: setup.academic.semester,
      schedule,
    }
  })
}

function isPlacementActivity(name: string, id: string): boolean {
  return id.toLowerCase().includes('placement') || ['placement', 'placement training'].includes(name.trim().toLocaleLowerCase())
}

function isProtectedEditCell(cell: ScheduledCell | undefined): boolean {
  return !cell || cell.kind === 'lab' || (cell.kind === 'activity' && isPlacementActivity(cell.name, cell.itemId))
}

function describeEditValidationFailure(action: string, issues: string[], setup: TimetableSetup): string {
  const issue = issues[0] ?? 'The edited timetable violates an active constraint.'
  const teacherClash = issue.match(/^([^\s]+) has (?:an alternate-week )?teacher clash at ([^ ]+):P(\d+) across (.+)\.$/)
  if (teacherClash) {
    const teacherName = setup.staff.find((person) => person.id === teacherClash[1])?.name ?? teacherClash[1]
    const [day] = teacherClash[2].split(':')
    return `${action} ${teacherName} is already teaching at ${day} P${teacherClash[3]} across ${teacherClash[4]}.`
  }
  const savedClash = issue.match(/^([^\s]+) has (?:an alternate-week )?teacher clash at ([^ ]+):P(\d+) with a saved timetable(.*)$/)
  if (savedClash) {
    const teacherName = setup.staff.find((person) => person.id === savedClash[1])?.name ?? savedClash[1]
    const [day] = savedClash[2].split(':')
    return `${action} ${teacherName} is already assigned at ${day} P${savedClash[3]} in a saved timetable${savedClash[4]}.`
  }
  return `${action} ${issue}`
}

function OfficialTimetable({ setup, generatedSection, onElement }: { setup: TimetableSetup; generatedSection: GeneratedSection; onElement: (element: HTMLElement | null) => void }) {
  const sectionId = generatedSection.sectionId
  const section = setup.sections.find((item) => item.id === sectionId)
  const advisor = setup.staff.find((person) => person.id === section?.classAdvisorId)
  const subjectRows = getTimetableSubjectRows(setup, sectionId, generatedSection)
  const documentSizing = getDocumentSizing(subjectRows.length)
  const semesterNumber = setup.academic.semester.split(' / ')[0]
  const semesterKind = ['I', 'III', 'V', 'VII'].includes(semesterNumber) ? 'ODD' : 'EVEN'
  const departmentName = setup.academic.department === 'CSE' ? 'Computer Science & Engineering' : setup.academic.department === 'RA' ? 'Robotics and Automation' : setup.academic.department
  return <article
    className="official-timetable"
    data-official-section={sectionId}
    ref={onElement}
    style={{
      '--document-grid-height': `${documentSizing.gridHeight}mm`,
      '--document-subject-table-height': `${documentSizing.subjectTableHeight}mm`,
      '--document-subject-row-height': `${documentSizing.subjectRowHeight}mm`,
      '--document-density': String(documentSizing.density),
    } as CSSProperties}
  >
    <header className="official-header">
      <img src="/college-logo.png" alt="Manakula Vinayagar Institute of Technology emblem" />
      <div className="official-college-name"><strong>MANAKULA VINAYAGAR</strong><span>INSTITUTE OF TECHNOLOGY</span></div>
      <p>Affiliated to Pondicherry University, Approved by AICTE, New Delhi<br />Accredited by NBA (B.Tech.-CSE, EC, EEE &amp; ME) &amp; NAAC ‘A’ Grade<br />Kalitheerthalkuppam, Puducherry – 605 107</p>
    </header>
    <div className="official-title">
      <h2>Time Table ({setup.academic.academicYear} {semesterKind} Semester)</h2>
      <h3>{setup.academic.year.split(' / ')[0]} YEAR</h3>
      <h3>Department of {departmentName} ({semesterNumber} Semester) SECTION – {sectionId}</h3>
      <p>Class Advisor: {advisor?.name ?? 'Select class advisor in Sections'}</p>
    </div>
    <div className="official-grid-wrap">
      <table className="official-grid">
        <thead><tr><th className="official-day-heading">Day<br />/Hour</th>{timetableRows.map((slot) => {
          const breakLabel = slot.label === 'Break' ? 'Morning Break' : slot.label
          const [breakStart, breakEnd] = slot.time.split(' – ')
          return <th className={slot.kind === 'break' ? 'official-break-heading' : ''} key={slot.label}>
            {slot.kind === 'break'
              ? <div className="official-break-heading-content"><strong>{breakLabel}</strong><small>{breakStart} – {breakEnd}</small></div>
              : <><span>{slot.label}</span><small>{slot.time}</small></>}
          </th>
        })}</tr></thead>
        <tbody>{weekDays.map((day, dayIndex) => <tr key={day}>
          <th className="official-day-name">{day.slice(0, 3)}</th>
          {timetableRows.map((slot) => {
            if (slot.kind === 'break') {
              if (dayIndex !== 0) return null
              const breakLabel = slot.label === 'Break' ? 'Morning Break' : slot.label
              const [breakStart, breakEnd] = slot.time.split(' – ')
              return <td className="official-break-cell" rowSpan={weekDays.length} key={slot.label}><div className="official-break-content">
                <strong>{breakLabel}</strong>
                <small>{breakStart} – {breakEnd}</small>
              </div></td>
            }
            const cell = generatedSection.schedule[day][Number(slot.label.slice(1))]
            const alternateSubject = getAlternateWeekSubject(cell)
            const alternateDescription = alternateSubject
              ? `Alternate week: ${alternateSubject.name} (${alternateSubject.abbreviation}), taught by ${alternateSubject.teacherNameSnapshot}`
              : ''
            const cellClasses = ['official-period-cell', cell?.kind === 'lab' ? 'official-lab-cell' : '', cell?.kind === 'activity' && (cell.itemId.toLowerCase().includes('placement') || cell.name.trim().toUpperCase() === 'PLACEMENT') ? 'official-placement-cell' : ''].filter(Boolean).join(' ')
            return <td className={cellClasses} key={slot.label}><span aria-label={`${day} ${slot.label}: ${cell?.name ?? 'missing'}${cell?.isCoreTest ? ' (Core Test)' : ''}${alternateDescription ? `; ${alternateDescription}` : ''}`}>{cell?.abbreviation ?? '—'}{cell?.isCoreTest ? ' (T)' : ''}</span>{alternateSubject && <small className="official-alternate-week" title={alternateDescription}>{alternateSubject.abbreviation}</small>}</td>
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <section className="official-notes"><strong>Notes</strong><span>—</span></section>
    <div className="official-subject-table-wrap"><table className="official-subject-table"><thead><tr><th>S.No</th><th>Subject code</th><th>ABBREV</th><th>Name of the subject</th><th>Name of the staff</th><th>No. of Hours</th></tr></thead>
      <tbody>{subjectRows.map((row, index) => <tr key={`${row.code}-${row.name}-${index}`}><td>{index + 1}</td><td>{row.code}</td><td>{row.abbreviation}</td><td>{row.name}</td><td>{row.teacher || '—'}</td><td>{row.hours}</td></tr>)}</tbody>
    </table></div>
    <footer className="official-signatures"><span>HOD</span><span>PRINCIPAL</span></footer>
  </article>
}

function TimetableEditPanel({
  setup,
  sectionId,
  sectionIds,
  sectionsToEdit,
  isValidating,
  onSectionChange,
  onCellChange,
  onExchange,
  onProtectedCellDrop,
}: {
  setup: TimetableSetup
  sectionId: SectionName
  sectionIds: SectionName[]
  sectionsToEdit: GeneratedSection[]
  isValidating: boolean
  onSectionChange: (sectionId: SectionName) => void
  onCellChange: (sectionId: SectionName, day: WeekDay, period: number, choice: ScheduledCell) => Promise<boolean>
  onExchange: (sectionId: SectionName, first: { day: WeekDay; period: number }, second: { day: WeekDay; period: number }) => Promise<boolean>
  onProtectedCellDrop: (cell: ScheduledCell) => void
}) {
  const [editingCell, setEditingCell] = useState<{ day: WeekDay; period: number } | null>(null)
  const [search, setSearch] = useState('')
  const [exchangeMode, setExchangeMode] = useState(false)
  const [exchangeCells, setExchangeCells] = useState<Array<{ day: WeekDay; period: number }>>([])
  const section = sectionsToEdit.find((item) => item.sectionId === sectionId)
  const choices = getEditableTimetableChoices(setup, sectionId)
  const choicesById = new Map(choices.map((choice) => [choice.itemId, choice]))
  if (!section) return null
  const matchingChoices = choices.filter((choice) => `${choice.name} ${choice.code} ${choice.abbreviation}`.toLowerCase().includes(search.trim().toLowerCase()))
  const selectExchangeCell = (position: { day: WeekDay; period: number }) => setExchangeCells((current) => {
    if (current.some((cell) => cell.day === position.day && cell.period === position.period)) {
      return current.filter((cell) => cell.day !== position.day || cell.period !== position.period)
    }
    return current.length >= 2 ? [current[1], position] : [...current, position]
  })

  return <section className="timetable-edit-panel" aria-label="Edit generated timetable">
    <div className="timetable-edit-section-tabs" aria-label="Select section to edit">
      {sectionIds.map((id) => <button type="button" key={id} className={sectionId === id ? 'active' : ''} aria-pressed={sectionId === id} disabled={isValidating} onClick={() => {
        onSectionChange(id)
        setEditingCell(null)
        setSearch('')
        setExchangeCells([])
      }}>Section {id}</button>)}
    </div>
    <p className="timetable-edit-hint">Select an unlocked cell, then search and choose an approved subject or activity. Changes remain a draft until saved.</p>
    <div className="timetable-edit-actions">
      <button type="button" className="timetable-edit-secondary" aria-pressed={exchangeMode} disabled={isValidating} onClick={() => {
        setExchangeMode((current) => !current)
        setExchangeCells([])
        setEditingCell(null)
      }}>{exchangeMode ? 'Cancel Exchange' : 'Select cells to exchange'}</button>
      {exchangeMode && <button type="button" className="timetable-edit-primary" disabled={isValidating || exchangeCells.length !== 2} onClick={() => {
        if (exchangeCells.length === 2) void onExchange(sectionId, exchangeCells[0], exchangeCells[1]).then((applied) => {
          if (applied) { setExchangeCells([]); setExchangeMode(false) }
        })
      }}>Exchange Selected</button>}
    </div>
    {exchangeMode && <p className="timetable-edit-hint" role="status">Select two unlocked cells in Section {sectionId}.</p>}
    <div className="timetable-edit-grid-scroll">
      <table className="timetable-edit-grid">
        <thead><tr><th>Day / Period</th>{timetableRows.map((slot) => <th key={slot.label} className={slot.kind === 'break' ? 'locked' : ''}>{slot.kind === 'break' && <LockKeyhole size={12} aria-hidden="true" />}<span>{slot.label}</span><small>{slot.time}</small></th>)}</tr></thead>
        <tbody>{weekDays.map((day, dayIndex) => <tr key={day}>
          <th scope="row">{day.slice(0, 3)}</th>
          {timetableRows.map((slot) => {
            if (slot.kind === 'break') return dayIndex === 0
              ? <td className="timetable-edit-locked" rowSpan={weekDays.length} key={slot.label}><LockKeyhole size={15} aria-hidden="true" /><strong>{slot.label === 'Break' ? 'Morning Break' : slot.label}</strong><small>{slot.time}</small></td>
              : null
            const period = Number(slot.label.slice(1))
            const cell = section.schedule[day]?.[period]
            const alternateSubject = getAlternateWeekSubject(cell)
            const alternateDescription = alternateSubject
              ? `Alternate week: ${alternateSubject.name} (${alternateSubject.abbreviation}), taught by ${alternateSubject.teacherNameSnapshot}`
              : ''
            const locked = !cell || cell.kind === 'lab' || (cell.kind === 'activity' && (cell.itemId.toLowerCase().includes('placement') || ['placement', 'placement training'].includes(cell.name.trim().toLocaleLowerCase())))
            const exchangeSelected = exchangeCells.some((position) => position.day === day && position.period === period)
            return <td key={slot.label} className={locked ? 'timetable-edit-locked' : ''}
              onDragOver={(event) => { if (event.dataTransfer.types.includes('text/plain')) event.preventDefault() }}
              onDrop={(event) => {
                event.preventDefault()
                if (isValidating) return
                const choice = choicesById.get(event.dataTransfer.getData('text/plain'))
                if (!choice) return
                if (locked) { if (cell) onProtectedCellDrop(cell); return }
                void onCellChange(sectionId, day, period, choice).then((applied) => {
                  if (applied) { setEditingCell(null); setSearch('') }
                })
              }}>
              {locked
                ? <span className="timetable-edit-locked-value" title={alternateDescription || undefined}><LockKeyhole size={13} aria-hidden="true" /><strong>{cell?.abbreviation ?? 'Unassigned'}{cell?.isCoreTest ? ' (T)' : ''}</strong><small>{cell?.name ?? ''}</small>{alternateSubject && <small className="timetable-edit-alternate-week">Alt: {alternateSubject.abbreviation} · {alternateSubject.teacherNameSnapshot}</small>}</span>
                : <button type="button" className={`timetable-edit-cell${exchangeSelected ? ' exchange-selected' : ''}`} disabled={isValidating} aria-pressed={exchangeMode ? exchangeSelected : undefined} aria-label={`${exchangeMode ? 'Select for exchange' : 'Edit'} ${day} ${slot.label}: ${cell.abbreviation}`} aria-haspopup={exchangeMode ? undefined : 'listbox'} onClick={() => {
                    if (exchangeMode) { selectExchangeCell({ day, period }); setEditingCell(null); return }
                    setEditingCell({ day, period })
                    setSearch('')
                  }}>
                    <strong>{cell.abbreviation}{cell.isCoreTest ? ' (T)' : ''}</strong><small>{cell.name}</small><small>{setup.staff.find((person) => person.id === cell.teacherId)?.name ?? cell.teacherId}</small>
                  </button>}
            </td>
          })}
        </tr>)}</tbody>
      </table>
    </div>
    {editingCell && <div className="timetable-edit-search" role="group" aria-label={`Choose a subject for ${editingCell.day} P${editingCell.period}`}>
      <label htmlFor="timetable-edit-search-input">Search approved subjects and activities for {editingCell.day} P{editingCell.period}</label>
      <input id="timetable-edit-search-input" type="search" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Type a subject or activity name" />
      <div className="timetable-edit-options" role="listbox" aria-label="Approved subjects and activities">
        {matchingChoices.map((choice) => <button type="button" draggable="true" disabled={isValidating} role="option" aria-selected={section.schedule[editingCell.day]?.[editingCell.period]?.itemId === choice.itemId} key={choice.itemId} onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', choice.itemId)
          event.dataTransfer.effectAllowed = 'copy'
        }} onClick={() => void onCellChange(sectionId, editingCell.day, editingCell.period, choice).then((applied) => {
          if (applied) { setEditingCell(null); setSearch('') }
        })}>
          <strong>{choice.name}</strong><span>{[choice.code, choice.abbreviation].filter(Boolean).join(' · ')}</span><small>Teacher: {setup.staff.find((person) => person.id === choice.teacherId)?.name ?? choice.teacherId}</small>
        </button>)}
        {matchingChoices.length === 0 && <p>No approved subject or activity matches that search.</p>}
      </div>
      <button type="button" className="timetable-edit-close" disabled={isValidating} onClick={() => { setEditingCell(null); setSearch('') }}>Close</button>
    </div>}
  </section>
}

export function GeneratedTimetablePreview({ setup, result, onSave, preferredSectionId, isLocked = false, validateSavedOccupancy }: {
  setup: TimetableSetup
  result: Extract<TimetableGenerationResult, { ok: true }>
  onSave: (result: Extract<TimetableGenerationResult, { ok: true }>) => void
  preferredSectionId?: string | null
  isLocked?: boolean
  validateSavedOccupancy: (sections: GeneratedSection[]) => Promise<string[]>
}) {
  const sectionIds = setup.sections.map((section) => section.id)
  const [activeSection, setActiveSection] = useState<SectionName>('A')
  const [exporting, setExporting] = useState<SectionName | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftSections, setDraftSections] = useState<GeneratedSection[] | null>(null)
  const [editSection, setEditSection] = useState<SectionName>('A')
  const [editError, setEditError] = useState<string | null>(null)
  const [editValidationPending, setEditValidationPending] = useState(false)
  const editOperationRef = useRef(false)
  const timetableElement = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (preferredSectionId && sectionIds.includes(preferredSectionId)) setActiveSection(preferredSectionId)
  }, [preferredSectionId, result])
  useEffect(() => {
    if (!isLocked) return
    setDraftSections(null)
    setEditing(false)
    setEditError(null)
  }, [isLocked])
  const generatedSection = result.sections.find((section) => section.sectionId === activeSection)
  const editSetup = setupForEditedSections(setup)
  const editConversion = toGenericScheduleConfig(editSetup)
  const draftGenericSections = draftSections ? genericSectionsForEdit(editSetup, draftSections) : []
  const draftEditValidation = draftSections ? validateGenericScheduleEdit(editConversion.config, draftGenericSections) : null
  const draftValidation = draftEditValidation ? { issues: [...editConversion.issues, ...draftEditValidation.issues], summary: draftEditValidation.summary } : null
  if (!generatedSection) return null

  const beginEditing = () => {
    if (isLocked) return
    setDraftSections(cloneGeneratedSections(result.sections))
    setEditSection(activeSection)
    setEditError(null)
    setEditing(true)
  }
  const cancelEditing = () => {
    setDraftSections(null)
    setEditing(false)
    setEditError(null)
  }
  const applyEditCandidate = async (candidate: GeneratedSection[], action: string): Promise<boolean> => {
    if (isLocked || editOperationRef.current) return false
    editOperationRef.current = true
    setEditError(null)
    const candidateGenericSections = genericSectionsForEdit(editSetup, candidate)
    const localValidation = validateGenericScheduleEdit(editConversion.config, candidateGenericSections)
    const localIssues = [...editConversion.issues, ...localValidation.issues]
    if (localIssues.length) {
      setEditError(describeEditValidationFailure(action, localIssues, setup))
      editOperationRef.current = false
      return false
    }
    setEditValidationPending(true)
    try {
      const occupancyIssues = await validateSavedOccupancy(candidate)
      if (occupancyIssues.length) {
        setEditError(describeEditValidationFailure(action, occupancyIssues, setup))
        return false
      }
      setDraftSections(candidate)
      return true
    } catch (error) {
      setEditError(`${action} Saved timetable teacher occupancy could not be verified: ${error instanceof Error ? error.message : 'the occupancy service is unavailable.'}`)
      return false
    } finally {
      setEditValidationPending(false)
      editOperationRef.current = false
    }
  }
  const replaceCell = (sectionId: SectionName, day: WeekDay, period: number, choice: ScheduledCell): Promise<boolean> => {
    const source = draftSections ?? result.sections
    const currentCell = source.find((section) => section.sectionId === sectionId)?.schedule[day]?.[period]
    if (isProtectedEditCell(currentCell)) {
      setEditError(currentCell?.kind === 'lab'
        ? 'Cannot edit this cell because it is part of a Lab block.'
        : 'Cannot edit this cell because it is part of Placement.')
      return Promise.resolve(false)
    }
    const action = `Cannot place ${choice.name} at ${day} P${period}.`
    return applyEditCandidate(updateGeneratedTimetableCell(source, sectionId, day, period, choice), action)
  }
  const exchangeCells = (sectionId: SectionName, first: { day: WeekDay; period: number }, second: { day: WeekDay; period: number }): Promise<boolean> => {
    if (first.day === second.day && first.period === second.period) return Promise.resolve(false)
    const source = draftSections ?? result.sections
    const section = source.find((item) => item.sectionId === sectionId)
    const firstCell = section?.schedule[first.day]?.[first.period]
    const secondCell = section?.schedule[second.day]?.[second.period]
    if (isProtectedEditCell(firstCell) || isProtectedEditCell(secondCell)) {
      const protectedCell = isProtectedEditCell(firstCell) ? firstCell : secondCell
      setEditError(protectedCell?.kind === 'lab'
        ? 'Cannot exchange this cell because it is part of a Lab block.'
        : 'Cannot exchange this cell because it is part of Placement.')
      return Promise.resolve(false)
    }
    const action = `Cannot exchange ${firstCell!.name} at ${first.day} P${first.period} with ${secondCell!.name} at ${second.day} P${second.period}.`
    return applyEditCandidate(exchangeGeneratedTimetableCells(source, sectionId, first, second), action)
  }
  const saveEdits = () => {
    if (!draftSections || isLocked || editValidationPending || !draftValidation || draftValidation.issues.length) return
    const validation = validateGenericScheduleEdit(editConversion.config, draftGenericSections)
    if (validation.issues.length) return
    onSave({ ...result, sections: draftSections, validation: validation.summary })
    setDraftSections(null)
    setEditing(false)
    setEditError(null)
  }

  const visibleSection = editing
    ? draftSections?.find((section) => section.sectionId === editSection) ?? generatedSection
    : generatedSection

  const getSectionElement = async (sectionId: SectionName) => {
    setActiveSection(sectionId)
    if (editing) setEditSection(sectionId)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const element = timetableElement.current
    if (!element || element.dataset.officialSection !== sectionId) throw new Error(`Section ${sectionId} timetable is not ready.`)
    const logo = element.querySelector('img')
    if (logo && !logo.complete) await new Promise<void>((resolve, reject) => {
      logo.addEventListener('load', () => resolve(), { once: true })
      logo.addEventListener('error', () => reject(new Error('The MVIT logo could not be loaded.')), { once: true })
    })
    if (logo && logo.naturalWidth === 0) throw new Error('The MVIT logo could not be loaded.')
    return element
  }

  const captureSection = async (element: HTMLElement) => {
    const { default: html2canvas } = await import('html2canvas')
    element.dataset.exportLayout = 'true'
    const clearExportSizing = applyExportSizing(element)
    let capturedCanvas: HTMLCanvasElement
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      capturedCanvas = await html2canvas(element, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        windowWidth: Math.ceil(210 * 96 / 25.4),
        windowHeight: Math.ceil(297 * 96 / 25.4),
        onclone: (_document, clone) => {
          clone.dataset.exportLayout = 'true'
          clone.style.width = '210mm'
          clone.style.height = '297mm'
          clone.style.minHeight = '297mm'
          clone.style.maxWidth = 'none'
          clone.style.boxSizing = 'border-box'
          clone.style.padding = '7mm'
        },
      })
    } finally {
      delete element.dataset.exportLayout
      clearExportSizing()
    }
    return capturedCanvas
  }

  const capturePdfSection = async (element: HTMLElement) => {
    const { default: html2canvas } = await import('html2canvas')
    const subjectRows = element.querySelectorAll('.official-subject-table tbody tr').length
    const pdfSizing = getPdfDocumentSizing(subjectRows)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return html2canvas(element, {
      // 300 dpi at CSS's 96 px/in gives crisp print output while keeping the
      // existing DOM content intact.
      scale: 300 / 96,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: Math.ceil(402 * 96 / 25.4),
      windowHeight: Math.ceil(284 * 96 / 25.4),
      onclone: (_document, clone) => {
        clone.dataset.exportLayout = 'true'
        clone.dataset.pdfLayout = 'true'
        clone.style.width = '402mm'
        clone.style.height = '284mm'
        clone.style.minHeight = '284mm'
        clone.style.maxWidth = 'none'
        clone.style.boxSizing = 'border-box'
        clone.style.padding = '0'
        clone.style.setProperty('--export-grid-height', `${pdfSizing.gridHeight}mm`)
        clone.style.setProperty('--export-subject-height', `${pdfSizing.subjectTableHeight}mm`)
        clone.style.setProperty('--export-subject-row-height', `${pdfSizing.subjectRowHeight}mm`)
        clone.style.setProperty('--export-density-scale', String(pdfSizing.density))
      },
    })
  }

  const withExport = async (sectionId: SectionName, action: (element: HTMLElement) => Promise<void>) => {
    setExporting(sectionId)
    setExportError(null)
    try {
      const element = await getSectionElement(sectionId)
      await action(element)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The timetable could not be exported.')
    } finally {
      setExporting(null)
    }
  }

  const printSection = (sectionId: SectionName) => withExport(sectionId, async (element) => {
    const subjectRows = element.querySelectorAll('.official-subject-table tbody tr').length
    const pdfSizing = getPdfDocumentSizing(subjectRows)
    element.style.setProperty('--export-grid-height', `${pdfSizing.gridHeight}mm`)
    element.style.setProperty('--export-subject-height', `${pdfSizing.subjectTableHeight}mm`)
    element.style.setProperty('--export-subject-row-height', `${pdfSizing.subjectRowHeight}mm`)
    element.style.setProperty('--export-density-scale', String(pdfSizing.density))
    element.dataset.exportLayout = 'true'
    element.dataset.pdfLayout = 'true'
    element.dataset.printTarget = 'true'
    const removeTarget = () => {
      delete element.dataset.printTarget
      delete element.dataset.exportLayout
      delete element.dataset.pdfLayout
      element.style.removeProperty('--export-grid-height')
      element.style.removeProperty('--export-subject-height')
      element.style.removeProperty('--export-subject-row-height')
      element.style.removeProperty('--export-density-scale')
      window.removeEventListener('afterprint', removeTarget)
    }
    window.addEventListener('afterprint', removeTarget, { once: true })
    window.print()
    // Some embedded browsers suppress the print dialog and never dispatch afterprint.
    // In that case window.print() returns immediately, so clear its temporary output state.
    window.setTimeout(removeTarget, 1000)
  })

  const downloadPng = (sectionId: SectionName) => withExport(sectionId, async (element) => {
    const canvas = await captureSection(element)
    const link = document.createElement('a')
    link.download = `MVIT-Timetable-Section-${sectionId}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  })

  const downloadJpg = (sectionId: SectionName) => withExport(sectionId, async (element) => {
    const canvas = await captureSection(element)
    const link = document.createElement('a')
    link.download = `MVIT-Timetable-Section-${sectionId}.jpg`
    link.href = canvas.toDataURL('image/jpeg', 0.95)
    link.click()
  })

  const downloadPdf = (sectionId: SectionName) => withExport(sectionId, async (element) => {
    const canvas = await capturePdfSection(element)
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3', compress: true })
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 9, 6.5, 402, 284, undefined, 'FAST')
    pdf.save(`MVIT-Timetable-Section-${sectionId}.pdf`)
  })

  return <section className="generated-panel official-preview-panel" aria-live="polite">
    <div className="generation-note generation-validation-summary">
      {result.validation.sections.map((section) => <div className="validation-summary-section" key={section.sectionId}>
        <strong>Section {section.sectionId}</strong>
        <span>{section.periodsFilled}/48 periods filled</span>
        <span>Core hours: {section.coreHoursValid ? 'Valid' : 'Invalid'}</span>
        <span>Other subject hours: {section.otherSubjectHoursValid ? 'Valid' : 'Invalid'}</span>
        <span>Lab allocation: {section.labAllocationValid ? 'Valid' : 'Invalid'}</span>
      </div>)}
      <p><strong>GLOBAL:</strong> Teacher clashes across sections: {result.validation.globalTeacherClashes}</p>
    </div>
    <div className="section-output-controls" aria-label="Timetable output controls">
      {sectionIds.map((sectionId) => <div className={`section-output-row${activeSection === sectionId ? ' active' : ''}`} key={sectionId}>
        <strong>Section {sectionId}</strong>
        <button onClick={() => { setActiveSection(sectionId); if (editing) setEditSection(sectionId) }} aria-pressed={activeSection === sectionId}>View</button>
        <button onClick={() => printSection(sectionId)} disabled={exporting !== null}>Print</button>
        <button onClick={() => downloadPdf(sectionId)} disabled={exporting !== null}>{exporting === sectionId ? 'Preparing…' : 'Download PDF'}</button>
        <button onClick={() => downloadPng(sectionId)} disabled={exporting !== null}>{exporting === sectionId ? 'Preparing…' : 'Download PNG'}</button>
        <button onClick={() => downloadJpg(sectionId)} disabled={exporting !== null}>{exporting === sectionId ? 'Preparing…' : 'Download JPG'}</button>
      </div>)}
    </div>
    <div className="timetable-edit-actions">
      {!editing
        ? <button type="button" className="timetable-edit-primary" onClick={beginEditing} disabled={isLocked} title={isLocked ? 'Unlock this timetable version before editing.' : undefined}>Edit Timetable</button>
        : <>
            <button type="button" className="timetable-edit-primary" onClick={saveEdits} disabled={isLocked || editValidationPending || !draftSections || Boolean(draftValidation?.issues.length)}>Save Changes</button>
            <button type="button" className="timetable-edit-secondary" onClick={cancelEditing} disabled={editValidationPending}>Cancel</button>
          </>}
    </div>
    {editing && draftSections && <>
      <TimetableEditPanel
        key={editSection}
        setup={setup}
        sectionId={editSection}
        sectionIds={sectionIds}
        sectionsToEdit={draftSections}
        isValidating={editValidationPending}
        onSectionChange={(sectionId) => { setEditSection(sectionId); setActiveSection(sectionId) }}
        onCellChange={replaceCell}
        onExchange={exchangeCells}
        onProtectedCellDrop={(cell) => setEditError(cell.kind === 'lab' ? 'Cannot edit this cell because it is part of a Lab block.' : 'Cannot edit this cell because it is part of Placement.')}
      />
      {editError && <p className="validation-error" role="alert">{editError}</p>}
      {draftValidation && draftValidation.issues.length > 0 && <div className="timetable-edit-validation" role="alert" aria-live="polite">
        <strong>Draft not valid yet. Resolve these issues before saving:</strong>
        <ul>{draftValidation.issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul>
      </div>}
    </>}
    {exportError && <p className="export-error" role="alert">{exportError}</p>}
    <OfficialTimetable setup={setup} generatedSection={visibleSection} onElement={(element) => { timetableElement.current = element }} />
  </section>
}

function applyExportSizing(element: HTMLElement) {
  const rows = Array.from(element.querySelectorAll('.official-subject-table tbody tr'))
  const longestCell = Math.max(0, ...Array.from(element.querySelectorAll('.official-subject-table td, .official-grid td span'), (cell) => cell.textContent?.trim().length ?? 0))
  const sizing = getDocumentSizing(rows.length, longestCell)
  element.style.setProperty('--document-density', String(sizing.density))
  element.style.setProperty('--document-grid-height', `${sizing.gridHeight}mm`)
  element.style.setProperty('--document-subject-table-height', `${sizing.subjectTableHeight}mm`)
  element.style.setProperty('--document-subject-row-height', `${sizing.subjectRowHeight}mm`)
  return () => {
    element.style.removeProperty('--document-density')
    element.style.removeProperty('--document-grid-height')
    element.style.removeProperty('--document-subject-table-height')
    element.style.removeProperty('--document-subject-row-height')
  }
}

function getDocumentSizing(rowCount: number, longestCell = 0) {
  // A4's 283mm inner height is shared by fixed header/footer areas, the dynamic
  // subject table, and a generous timetable grid. This stays row-driven rather
  // than assuming a fixed number of subjects.
  const safeRowCount = Math.max(1, rowCount)
  const availableForGridAndRows = 205
  const minimumGridHeight = 92
  const subjectRowHeight = Math.max(3.4, Math.min(5.8, (availableForGridAndRows - minimumGridHeight) / safeRowCount))
  const gridHeight = Math.max(minimumGridHeight, availableForGridAndRows - safeRowCount * subjectRowHeight)
  const density = Math.max(0.82, Math.min(1, 1 - Math.max(0, safeRowCount - 18) * 0.012 - Math.max(0, longestCell - 34) * 0.002))
  return { gridHeight, subjectTableHeight: 8 + safeRowCount * subjectRowHeight, subjectRowHeight, density }
}

function getPdfDocumentSizing(rowCount: number) {
  const safeRowCount = Math.max(1, rowCount)
  // The A3 landscape sheet has 205mm available for the six-day grid and the
  // variable-height subject/staff rows after its fixed header and footer.
  const subjectRowHeight = Math.min(7.2, 105 / safeRowCount)
  const gridHeight = Math.max(100, 205 - safeRowCount * subjectRowHeight)
  const density = Math.max(0.78, Math.min(1, subjectRowHeight / 7.2))
  return { gridHeight, subjectTableHeight: 9 + safeRowCount * subjectRowHeight, subjectRowHeight, density }
}

function isCompleteGeneratedResult(result: Extract<TimetableGenerationResult, { ok: true }>, sectionIds: SectionName[]): boolean {
  const schedulesComplete = sectionIds.every((sectionId) => {
    const sectionResult = result.sections.find((section) => section.sectionId === sectionId)
    return Boolean(sectionResult && weekDays.every((day) => periods.every((period) => {
      const cell = sectionResult.schedule[day]?.[period]
      return Boolean(cell?.abbreviation.trim() && cell.teacherId)
    })))
  }) && result.sections.length === sectionIds.length
  const validationPassed = result.validation.globalTeacherClashes === 0
    && sectionIds.every((sectionId) => {
      const summary = result.validation.sections.find((section) => section.sectionId === sectionId)
      return Boolean(summary && summary.periodsFilled === 48 && summary.coreHoursValid && summary.otherSubjectHoursValid && summary.labAllocationValid)
    })
  return schedulesComplete && validationPassed
}

interface SavedTimetableSectionNode {
  name: string
  versions: SavedTimetableNavigationEntry[]
}

interface SavedTimetableSemesterNode {
  name: string
  academicYears: SavedTimetableAcademicYearNode[]
}

interface SavedTimetableAcademicYearNode {
  name: string
  sections: SavedTimetableSectionNode[]
}

interface SavedTimetableYearNode {
  name: string
  semesters: SavedTimetableSemesterNode[]
}

interface SavedTimetableDepartmentNode {
  name: string
  years: SavedTimetableYearNode[]
}

type SavedTimetableSectionsByAcademicYear = Map<string, SavedTimetableNavigationEntry[]>
type SavedTimetableAcademicYears = Map<string, SavedTimetableSectionsByAcademicYear>
type SavedTimetableSemesters = Map<string, SavedTimetableAcademicYears>
type SavedTimetableYears = Map<string, SavedTimetableSemesters>
type SavedTimetableDepartments = Map<string, SavedTimetableYears>

function buildSavedTimetableTree(entries: SavedTimetableNavigationEntry[]): SavedTimetableDepartmentNode[] {
  const departments: SavedTimetableDepartments = new Map()
  for (const entry of entries) {
    let years = departments.get(entry.department)
    if (!years) departments.set(entry.department, years = new Map())
    let semesters = years.get(entry.year)
    if (!semesters) years.set(entry.year, semesters = new Map())
    let sections = semesters.get(entry.semester)
    if (!sections) semesters.set(entry.semester, sections = new Map())
    let sectionYears = sections.get(entry.academicYear)
    if (!sectionYears) sections.set(entry.academicYear, sectionYears = new Map())
    let versions = sectionYears.get(entry.sectionName)
    if (!versions) sectionYears.set(entry.sectionName, versions = [])
    if (!versions.some((version) => version.versionId === entry.versionId)) versions.push(entry)
  }
  const byName = <T extends { name: string },>(left: T, right: T) => left.name.localeCompare(right.name, undefined, { numeric: true })
  return [...departments].map(([name, years]) => ({
    name,
    years: [...years].map(([yearName, semesters]) => ({
      name: yearName,
      semesters: [...semesters].map(([semesterName, sections]) => ({
      name: semesterName,
        academicYears: [...sections].map(([academicYear, academicYearSections]) => ({
          name: academicYear,
          sections: [...academicYearSections].map(([sectionName, versions]) => ({
            name: sectionName,
            versions: versions.sort((left, right) => right.versionNumber - left.versionNumber || right.createdAt.localeCompare(left.createdAt)),
          })).sort(byName),
        })).sort(byName),
      })).sort(byName),
    })).sort(byName),
  })).sort(byName)
}

function App() {
  const [selection, setSelection] = useState<AcademicConfigurationSelection>({
    department: 'CSE', year: 'III / 3rd Year', semester: 'V / 5th Semester',
  })
  const selectionRef = useRef(selection)
  const savedOpenRequestRef = useRef(0)
  selectionRef.current = selection
  const [configurations, setConfigurations] = useState<Record<string, TimetableSetup>>({})
  const [sectionCountInput, setSectionCountInput] = useState('1')
  const [generatedTargetSchedules, setGeneratedTargetSchedules] = useState<Record<string, GenericGeneratedSection[]>>({})
  const selectedConfigurationKey = academicConfigurationKey(selection)
  const storedConfiguration = configurations[selectedConfigurationKey] ?? createEmptyConfiguration(selection, staffForSelection(selection))
  const sectionIds = storedConfiguration.sections.map((section) => section.id)
  useEffect(() => {
    setSectionCountInput(String(sectionIds.length))
  }, [selectedConfigurationKey, sectionIds.length])
  const requestedSectionCount = Number(sectionCountInput)
  const sectionCountInputValid = sectionCountInput.trim() !== ''
    && Number.isSafeInteger(requestedSectionCount)
    && requestedSectionCount > 0
    && requestedSectionCount === sectionIds.length
  const setup = configurationForSections(storedConfiguration, sectionIds)
  const genericScheduling = setup.genericScheduling ?? {}
  const genericTestPolicy = genericScheduling.testPolicy ?? 'off'
  const p1TestSubjectIds = genericScheduling.p1TestSubjectIds ?? []
  const placementActivity = setup.specialActivities.find((item) => ['placement', 'placement training'].includes(item.name.trim().toLocaleLowerCase()))
  const placementEnabled = genericScheduling.placementEnabled ?? true
  const hasConfiguration = Boolean(configurations[selectedConfigurationKey])
  const isGenericConfiguration = true
  const hasCurriculumConfiguration = setup.coreSubjects.length + setup.otherSubjectMaster.length + setup.otherSubjects.length + setup.labMaster.length + setup.specialActivities.length > 0
  const targetNeedsConfiguration = isGenericConfiguration && !hasCurriculumConfiguration
  const genericScheduleConversion = isGenericConfiguration ? toGenericScheduleConfig(setup) : null
  const genericWorkload = configuredWeeklyHours(setup)
  const genericConfigurationIssues = genericScheduleConversion
    ? [
      ...genericScheduleConversion.issues,
      ...validateGenericScheduleConfig(genericScheduleConversion.config).filter((issue) => !issue.startsWith('Configured workload is ')),
      ...(genericWorkloadIssue(genericWorkload) ? [genericWorkloadIssue(genericWorkload)!] : []),
    ]
    : []
  const genericReservedSections = Object.entries(generatedTargetSchedules)
    .filter(([configurationKey]) => configurationKey !== selectedConfigurationKey)
    .flatMap(([, generatedSections]) => generatedSections)
  const genericConfigurationReady = isGenericConfiguration && hasCurriculumConfiguration && genericConfigurationIssues.length === 0
  const configurationIssues = genericConfigurationIssues
  const canGenerate = genericConfigurationReady && sectionCountInputValid
  const updateSetup = (update: (current: TimetableSetup) => TimetableSetup) => {
    if (isGenericConfiguration) {
      setGeneratedTargetSchedules((current) => {
        if (!(selectedConfigurationKey in current)) return current
        const next = { ...current }
        delete next[selectedConfigurationKey]
        return next
      })
      setGenerationResult(null)
      setGenerationId(null)
      setOpenedSavedSetup(null)
      setOpenedSavedVersionId(null)
      setOpenedSavedSectionId(null)
      setVersionError(null)
    }
    setConfigurations((current) => {
      const stored = current[selectedConfigurationKey] ?? createEmptyConfiguration(selection, staffForSelection(selection))
      const visible = configurationForSections(stored, sectionIds)
      const updated = update(visible)
      return { ...current, [selectedConfigurationKey]: updated }
    })
  }
  const updateSectionCount = (sectionCount: number) => {
    const nextSectionIds = getSectionIds(sectionCount)
    if (!nextSectionIds.length) return
    updateSetup((current) => {
      const sectionIdSet = new Set(nextSectionIds)
      return {
        ...current,
        sections: initializeConfiguredSections(current.sections, nextSectionIds),
        sectionSubjectAssignments: current.sectionSubjectAssignments.filter((assignment) => sectionIdSet.has(assignment.sectionId)),
        labAssignments: current.labAssignments.filter((assignment) => sectionIdSet.has(assignment.sectionId)),
        specialActivityAssignments: current.specialActivityAssignments.filter((assignment) => sectionIdSet.has(assignment.sectionId)),
        ...(current.placementException ? {
          placementException: {
            ...current.placementException,
            alternateSubjects: current.placementException.alternateSubjects.filter((alternate) => !alternate.sectionId || sectionIdSet.has(alternate.sectionId)).map((alternate) => ({
              ...alternate,
              teacherAssignments: alternate.teacherAssignments.filter((assignment) => sectionIdSet.has(assignment.sectionId)),
            })),
          },
        } : {}),
      }
    })
  }
  const updateGenericScheduling = (patch: NonNullable<TimetableSetup['genericScheduling']>) => updateSetup((current) => ({
    ...current,
    genericScheduling: { ...current.genericScheduling, ...patch },
  }))
  const updatePlacementExceptionEnabled = (enabled: boolean) => updateSetup((current) => ({
    ...current,
    placementException: {
      enabled,
      allocationMode: current.placementException?.allocationMode
        ?? (current.placementException?.alternateSubjects.some((alternate) => !alternate.sectionId) ? 'custom' : 'random'),
      alternateSubjects: current.placementException?.alternateSubjects ?? [],
    },
  }))
  const updatePlacementExceptionMode = (allocationMode: 'random' | 'custom') => updateSetup((current) => ({
    ...current,
    placementException: {
      enabled: current.placementException?.enabled ?? false,
      allocationMode,
      alternateSubjects: current.placementException?.alternateSubjects ?? [],
    },
  }))
  const updatePlacementAlternateSubject = (sectionId: SectionName, placementPosition: number, selectedValue: string) => updateSetup((current) => {
    const existing = current.placementException?.alternateSubjects ?? []
    const sectionAlternates = existing.flatMap((alternate) => alternate.sectionId
      ? [alternate]
      : current.sections.flatMap((section) => {
        const assignment = alternate.teacherAssignments.find((entry) => entry.sectionId === section.id)
        return [{
          ...alternate,
          sectionId: section.id,
          teacherAssignments: assignment ? [assignment] : [],
        }]
      }))
    const [subjectKind, subjectId] = selectedValue.split(':', 2)
    if ((subjectKind !== 'core' && subjectKind !== 'other') || !subjectId) {
      return {
        ...current,
        placementException: {
          enabled: current.placementException?.enabled ?? false,
          allocationMode: current.placementException?.allocationMode ?? 'custom',
          alternateSubjects: sectionAlternates.filter((entry) => entry.sectionId !== sectionId || entry.placementPosition !== placementPosition),
        },
      }
    }
    const subject = subjectKind === 'core'
      ? current.coreSubjects.find((candidate) => candidate.id === subjectId)
      : current.otherSubjects.find((candidate) => candidate.id === subjectId)
    if (!subject) return current
    const teacherAssignments = current.sections.map((section) => {
      const assignment = current.sectionSubjectAssignments.find((entry) => entry.sectionId === section.id && entry.subjectId === subjectId)
      return {
        sectionId: section.id,
        teacherId: assignment?.teacherId ?? '',
        teacherNameSnapshot: current.staff.find((teacher) => teacher.id === assignment?.teacherId)?.name ?? '',
      }
    })
    const alternate: NonNullable<TimetableSetup['placementException']>['alternateSubjects'][number] = {
      placementPosition,
      sectionId,
      subjectId,
      subjectKind: subjectKind as 'core' | 'other',
      subjectNameSnapshot: subject.name,
      teacherAssignments,
    }
    return {
      ...current,
      placementException: {
        enabled: current.placementException?.enabled ?? false,
        allocationMode: current.placementException?.allocationMode ?? 'custom',
        alternateSubjects: [
          ...sectionAlternates.filter((entry) => entry.sectionId !== sectionId || entry.placementPosition !== placementPosition),
          alternate,
        ].sort((left, right) => left.placementPosition - right.placementPosition),
      },
    }
  })
  const toggleP1TestSubject = (subjectId: string, selected: boolean) => updateSetup((current) => {
    const currentSubjectIds = current.genericScheduling?.p1TestSubjectIds ?? []
    const nextSubjectIds = selected
      ? [...new Set([...currentSubjectIds, subjectId])]
      : currentSubjectIds.filter((id) => id !== subjectId)
    return { ...current, genericScheduling: { ...current.genericScheduling, p1TestSubjectIds: nextSubjectIds } }
  })
  const updateSelection = (patch: Partial<AcademicConfigurationSelection>) => {
    savedOpenRequestRef.current += 1
    setOpeningVersion(false)
    setSelection((current) => ({ ...current, ...patch }))
    setGenerationResult(null)
    setGenerationId(null)
    setOpenedSavedSetup(null)
    setOpenedSavedVersionId(null)
    setOpenedSavedSectionId(null)
    setVersionError(null)
    setCoreAssignmentError(null)
    setLabAssignmentError(null)
    setStaffAssignmentError(null)
    setEditingStaffId(null)
  }
  const [openSection, setOpenSection] = useState<SectionKey | null>('academic')
  const [generationResult, setGenerationResult] = useState<TimetableGenerationResult | null>(null)
  const [generationId, setGenerationId] = useState<string | null>(null)
  const [savedGenerationId, setSavedGenerationId] = useState<string | null>(null)
  const [savedVersions, setSavedVersions] = useState<SavedTimetableVersionSummary[]>([])
  const [savedTimetableNavigation, setSavedTimetableNavigation] = useState<SavedTimetableNavigationEntry[]>([])
  const [expandedSavedDepartments, setExpandedSavedDepartments] = useState<Record<string, boolean>>({})
  const [savedNavigationLoading, setSavedNavigationLoading] = useState(false)
  const [savedNavigationError, setSavedNavigationError] = useState<string | null>(null)
  const [openedSavedVersionId, setOpenedSavedVersionId] = useState<string | null>(null)
  const [openedSavedSectionId, setOpenedSavedSectionId] = useState<string | null>(null)
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null)
  const [selectedSavedVersionId, setSelectedSavedVersionId] = useState('')
  const [openedSavedSetup, setOpenedSavedSetup] = useState<TimetableSetup | null>(null)
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const [openingVersion, setOpeningVersion] = useState(false)
  const [lockingVersion, setLockingVersion] = useState(false)
  const [versionError, setVersionError] = useState<string | null>(null)
  const [coreAssignmentError, setCoreAssignmentError] = useState<string | null>(null)
  const [labAssignmentError, setLabAssignmentError] = useState<string | null>(null)
  const [staffAssignmentError, setStaffAssignmentError] = useState<string | null>(null)
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null)

  const refreshSavedTimetableNavigation = async () => {
    setSavedNavigationLoading(true)
    setSavedNavigationError(null)
    try {
      const { timetables } = await listSavedTimetableNavigation()
      setSavedTimetableNavigation(timetables)
      return timetables
    } catch (error) {
      setSavedNavigationError(error instanceof Error ? error.message : 'Saved timetables could not be loaded.')
      return []
    } finally {
      setSavedNavigationLoading(false)
    }
  }

  useEffect(() => {
    void refreshSavedTimetableNavigation()
  }, [])

  const savedTimetableTree = buildSavedTimetableTree(savedTimetableNavigation)

  useEffect(() => {
    let current = true
    setVersionsLoading(true)
    setVersionError(null)
    listSavedTimetableVersions({
      department: selection.department,
      year: selection.year,
      semester: selection.semester,
      academicYear: academicYearLabel,
    }).then(({ versions }) => {
      if (!current) return
      setSavedVersions(versions)
      setSelectedSavedVersionId((selected) => versions.some((version) => version.versionId === selected)
        ? selected
        : versions[0]?.versionId ?? '')
    }).catch((error: unknown) => {
      if (!current) return
      setVersionError(error instanceof Error ? error.message : 'Saved timetable versions could not be loaded.')
    }).finally(() => {
      if (current) setVersionsLoading(false)
    })
    return () => { current = false }
  }, [selection.department, selection.year, selection.semester])
  const addStaff = () => {
    const id = nextGlobalStaffId(setup.staff)
    setEditingStaffId(id)
    setStaffAssignmentError(null)
    updateSetup((current) => ({ ...current, staff: [...current.staff, { id, name: '' }] }))
  }
  const updateStaff = (id: string, patch: Partial<StaffMember>) => updateSetup((current) => {
    const target = current.staff.find((person) => person.id === id)
    if (!target) return current
    const nextId = patch.id !== undefined ? patch.id.trim() : id
    const updatedStaff = current.staff.map((person) => person.id === id ? { ...person, ...patch, id: nextId || id } : person)
    const replaceTeacherId = (teacherId: string) => teacherId === id ? nextId || id : teacherId
    return {
      ...current,
      staff: updatedStaff,
      sections: current.sections.map((section) => section.classAdvisorId === id ? { ...section, classAdvisorId: replaceTeacherId(section.classAdvisorId) } : section),
      sectionSubjectAssignments: current.sectionSubjectAssignments.map((assignment) => assignment.teacherId === id ? { ...assignment, teacherId: replaceTeacherId(assignment.teacherId) } : assignment),
      labAssignments: current.labAssignments.map((assignment) => assignment.teacherId === id ? { ...assignment, teacherId: replaceTeacherId(assignment.teacherId) } : assignment),
      specialActivityAssignments: current.specialActivityAssignments.map((assignment) => assignment.teacherId === id ? { ...assignment, teacherId: replaceTeacherId(assignment.teacherId) } : assignment),
      ...(current.placementException ? {
        placementException: {
          ...current.placementException,
          alternateSubjects: current.placementException.alternateSubjects.map((alternate) => ({
            ...alternate,
            teacherAssignments: alternate.teacherAssignments.map((assignment) => assignment.teacherId === id ? { ...assignment, teacherId: replaceTeacherId(assignment.teacherId) } : assignment),
          })),
        },
      } : {}),
    }
  })
  const removeStaff = (id: string) => {
    const fixedAssignment = setup.specialActivityAssignments.find((assignment) => assignment.teacherId === id && assignment.activityId !== 'library-mentoring')
    if (fixedAssignment) {
      const activityName = setup.specialActivities.find((item) => item.id === fixedAssignment.activityId)?.name ?? 'a fixed activity'
      setStaffAssignmentError(`${setup.staff.find((person) => person.id === id)?.name ?? 'This staff member'} is assigned to ${activityName} and cannot be removed while that fixed assignment is active.`)
      return
    }
    setStaffAssignmentError(null)
    if (editingStaffId === id) setEditingStaffId(null)
    updateSetup((current) => ({
      ...current,
      staff: current.staff.filter((person) => person.id !== id),
      sections: current.sections.map((section) => section.classAdvisorId === id ? { ...section, classAdvisorId: '' } : section),
      sectionSubjectAssignments: current.sectionSubjectAssignments.filter((assignment) => assignment.teacherId !== id),
      specialActivityAssignments: current.specialActivityAssignments.map((assignment) => assignment.activityId === 'library-mentoring' && assignment.teacherId === id ? { ...assignment, teacherId: '' } : assignment),
      labAssignments: current.labAssignments.map((assignment) => assignment.teacherId === id ? { ...assignment, teacherId: '' } : assignment),
    }))
  }
  const assignTeacher = (sectionId: SectionName, subjectId: string, teacherId: string, enforceCoreRule = false) => {
    const coreSubjectIds = new Set(setup.coreSubjects.map((coreSubjectRow) => coreSubjectRow.id))
    const conflict = enforceCoreRule && teacherId
      ? setup.sectionSubjectAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.subjectId !== subjectId && coreSubjectIds.has(assignment.subjectId) && assignment.teacherId === teacherId)
      : undefined
    if (conflict) {
      const teacherName = setup.staff.find((person) => person.id === teacherId)?.name ?? 'This teacher'
      const existingSubject = setup.coreSubjects.find((item) => item.id === conflict.subjectId)?.name ?? 'another Core / Main subject'
      const requestedSubject = setup.coreSubjects.find((item) => item.id === subjectId)?.name ?? 'this Core / Main subject'
      setCoreAssignmentError(`${teacherName} is already assigned to ${existingSubject} in Section ${sectionId}. Each teacher may teach only one Core / Main subject per section; ${requestedSubject} was not assigned.`)
      return
    }
    setCoreAssignmentError(null)
    updateSetup((current) => {
      const remainingAssignments = current.sectionSubjectAssignments.filter((assignment) => assignment.sectionId !== sectionId || assignment.subjectId !== subjectId)
      const placementException = current.placementException ? {
        ...current.placementException,
        alternateSubjects: current.placementException.alternateSubjects.map((alternate) => alternate.subjectId !== subjectId ? alternate : ({
          ...alternate,
          teacherAssignments: alternate.teacherAssignments.map((assignment) => assignment.sectionId !== sectionId ? assignment : ({
            sectionId,
            teacherId,
            teacherNameSnapshot: current.staff.find((person) => person.id === teacherId)?.name ?? '',
          })),
        })),
      } : undefined
      return {
        ...current,
        sectionSubjectAssignments: teacherId ? [...remainingAssignments, { sectionId, subjectId, teacherId }] : remainingAssignments,
        ...(placementException ? { placementException } : {}),
      }
    })
  }
  const assignCoreTeacherTeam = (sectionId: SectionName, subjectId: string, teacherIds: string[]) => {
    const selectedTeacherIds = teacherIds.filter(Boolean)
    if (new Set(selectedTeacherIds).size !== selectedTeacherIds.length) {
      setCoreAssignmentError('The same staff member cannot be selected twice for one subject.')
      return
    }
    setCoreAssignmentError(null)
    updateSetup((current) => ({
      ...current,
      sectionSubjectAssignments: [
        ...current.sectionSubjectAssignments.filter((assignment) => assignment.sectionId !== sectionId || assignment.subjectId !== subjectId),
        ...selectedTeacherIds.map((teacherId) => ({ sectionId, subjectId, teacherId })),
      ],
    }))
  }
  const updateCoreSubject = (id: string, patch: Partial<CoreSubject>) => updateSetup((current) => {
    const placementException = current.placementException && patch.name !== undefined ? {
      ...current.placementException,
      alternateSubjects: current.placementException.alternateSubjects.map((alternate) =>
        alternate.subjectKind === 'core' && alternate.subjectId === id
          ? { ...alternate, subjectNameSnapshot: patch.name! }
          : alternate),
    } : current.placementException
    return {
      ...current,
      coreSubjects: current.coreSubjects.map((subject) => subject.id === id ? { ...subject, ...patch } : subject),
      ...(placementException ? { placementException } : {}),
    }
  })
  const addCoreSubject = () => updateSetup((current) => ({
    ...current,
    coreSubjects: [...current.coreSubjects, { id: `core-${crypto.randomUUID()}`, code: '', name: '', abbreviation: '', hoursPerWeek: 0 }],
  }))
  const removeCoreSubject = (subjectId: string) => updateSetup((current) => ({
    ...current,
    coreSubjects: current.coreSubjects.filter((subject) => subject.id !== subjectId),
    sectionSubjectAssignments: current.sectionSubjectAssignments.filter((assignment) => assignment.subjectId !== subjectId),
    ...(current.placementException ? {
      placementException: {
        ...current.placementException,
        alternateSubjects: current.placementException.alternateSubjects.filter((alternate) =>
          alternate.subjectKind !== 'core' || alternate.subjectId !== subjectId),
      },
    } : {}),
    genericScheduling: current.genericScheduling ? {
      ...current.genericScheduling,
      p1TestSubjectIds: current.genericScheduling.p1TestSubjectIds?.filter((id) => id !== subjectId),
    } : undefined,
  }))
  const addOtherSubject = () => updateSetup((current) => ({
    ...current,
    otherSubjects: [...current.otherSubjects, { id: `other-${crypto.randomUUID()}`, code: '', name: '', abbreviation: '', hoursPerWeek: 0 }],
  }))
  const updateOtherSubject = (id: string, patch: Partial<OtherSubject>) => updateSetup((current) => {
    const placementException = current.placementException && patch.name !== undefined ? {
      ...current.placementException,
      alternateSubjects: current.placementException.alternateSubjects.map((alternate) =>
        alternate.subjectKind === 'other' && alternate.subjectId === id
          ? { ...alternate, subjectNameSnapshot: patch.name! }
          : alternate),
    } : current.placementException
    return {
      ...current,
      otherSubjects: current.otherSubjects.map((subject) => subject.id === id ? { ...subject, ...patch } : subject),
      ...(placementException ? { placementException } : {}),
    }
  })
  const updateLab = (id: string, patch: Partial<LabDefinition>) => updateSetup((current) => ({
    ...current,
    labMaster: current.labMaster.map((lab) => lab.id === id ? { ...lab, ...patch } : lab),
  }))
  const addLab = () => updateSetup((current) => {
    const lab: LabDefinition = { id: `lab-${crypto.randomUUID()}`, code: '', name: '', abbreviation: '', weeklyPeriods: 0, blockDuration: 0 }
    return {
      ...current,
      labMaster: [...current.labMaster, lab],
      labAssignments: [...current.labAssignments, ...sectionIds.map((sectionId) => ({ labId: lab.id, sectionId, teacherId: '' }))],
    }
  })
  const removeLab = (labId: string) => updateSetup((current) => ({
    ...current,
    labMaster: current.labMaster.filter((lab) => lab.id !== labId),
    labAssignments: current.labAssignments.filter((assignment) => assignment.labId !== labId),
  }))
  const assignLabTeacher = (labId: string, sectionId: SectionName, teacherId: string) => {
    const conflict = teacherId
      ? setup.labAssignments.find((assignment) => assignment.sectionId === sectionId && assignment.labId !== labId && assignment.teacherId === teacherId)
      : undefined
    if (conflict) {
      const teacherName = setup.staff.find((person) => person.id === teacherId)?.name ?? 'This teacher'
      const existingLab = setup.labMaster.find((item) => item.id === conflict.labId)?.name ?? 'another lab'
      const requestedLab = setup.labMaster.find((item) => item.id === labId)?.name ?? 'this lab'
      setLabAssignmentError(`${teacherName} is already assigned to ${existingLab} in Section ${sectionId}. Each teacher may teach only one Lab per section; ${requestedLab} was not assigned.`)
      return
    }
    setLabAssignmentError(null)
    updateSetup((current) => ({
      ...current,
      labAssignments: [
        ...current.labAssignments.filter((assignment) => assignment.labId !== labId || assignment.sectionId !== sectionId),
        { labId, sectionId, teacherId },
      ],
    }))
  }
  const updateSpecialActivity = (id: string, patch: Partial<SpecialActivity>) => updateSetup((current) => ({
    ...current,
    specialActivities: current.specialActivities.map((item) => item.id === id ? { ...item, ...patch } : item),
    ...(patch.hoursPerWeek !== undefined && current.specialActivities.some((item) => item.id === id && ['placement', 'placement training'].includes(item.name.trim().toLocaleLowerCase())) && current.placementException ? {
      placementException: {
        ...current.placementException,
        alternateSubjects: current.placementException.alternateSubjects.filter((alternate) => alternate.placementPosition <= patch.hoursPerWeek!),
      },
    } : {}),
  }))
  const addSpecialActivity = () => updateSetup((current) => ({
    ...current,
    specialActivities: [...current.specialActivities, { id: `activity-${crypto.randomUUID()}`, name: '', hoursPerWeek: 0 }],
  }))
  const removeSpecialActivity = (activityId: string) => updateSetup((current) => {
    const removedActivity = current.specialActivities.find((item) => item.id === activityId)
    const isPlacement = removedActivity && ['placement', 'placement training'].includes(removedActivity.name.trim().toLocaleLowerCase())
    return {
      ...current,
      specialActivities: current.specialActivities.filter((item) => item.id !== activityId),
      specialActivityAssignments: current.specialActivityAssignments.filter((assignment) => assignment.activityId !== activityId),
      ...(isPlacement && current.genericScheduling ? {
        genericScheduling: { ...current.genericScheduling, placementEnabled: undefined },
      } : {}),
    }
  })
  const assignSpecialActivity = (activityId: string, sectionId: SectionName, teacherId: string) => updateSetup((current) => ({
    ...current,
    specialActivityAssignments: [
      ...current.specialActivityAssignments.filter((assignment) => assignment.activityId !== activityId || assignment.sectionId !== sectionId),
      { activityId, sectionId, teacherId },
    ],
  }))
  const toggle = (id: SectionKey) => setOpenSection((current) => current === id ? null : id)
  const removeSubject = (list: 'otherSubjects', id: string) => updateSetup((current) => ({
    ...current,
    [list]: current[list].filter((row) => row.id !== id),
    sectionSubjectAssignments: current.sectionSubjectAssignments.filter((assignment) => assignment.subjectId !== id),
    ...(current.placementException ? {
      placementException: {
        ...current.placementException,
        alternateSubjects: current.placementException.alternateSubjects.filter((alternate) =>
          alternate.subjectKind !== 'other' || alternate.subjectId !== id),
      },
    } : {}),
  }))
  const updateSection = (id: SectionName, patch: Partial<Section>) => updateSetup((current) => {
    return {
      ...current,
      sections: current.sections.map((section) => section.id === id ? { ...section, ...patch } : section),
    }
  })
  const generate = async () => {
    if (!canGenerate) return
    savedOpenRequestRef.current += 1
    setOpeningVersion(false)
    const generationSelectionKey = selectedConfigurationKey
    setGenerationId(null)
    setGenerationResult(null)
    setOpenedSavedSetup(null)
    setOpenedSavedVersionId(null)
    setOpenedSavedSectionId(null)
    setVersionError(null)
    const inputIssues = [
      ...(genericScheduleConversion?.issues ?? []),
      ...(genericScheduleConversion ? validateGenericScheduleConfig(genericScheduleConversion.config) : []),
    ]
    if (inputIssues.length) {
      setGenerationResult({ ok: false, code: 'INVALID_INPUT', message: 'Timetable configuration has incomplete or invalid fields.', blockingConstraints: inputIssues })
      return
    }
    if (!genericScheduleConversion) {
      setGenerationResult({
        ok: false,
        code: 'INVALID_INPUT',
        message: 'No generic schedule configuration is available.',
        blockingConstraints: [],
      })
      return
    }

    let result: GenericTimetableGenerationResult
    try {
      const generated = await generateGenericTimetableOnServer({
        configuration: genericScheduleConversion.config,
        reservedSections: genericReservedSections,
      })
      if (academicConfigurationKey(selectionRef.current) !== generationSelectionKey) return
      result = generated.result
      const generatedPlacementException = generated.placementException
      if (result.ok && generatedPlacementException?.allocationMode === 'random') {
        setConfigurations((current) => ({
          ...current,
          [generationSelectionKey]: {
            ...(current[generationSelectionKey] ?? setup),
            placementException: {
              enabled: generatedPlacementException.enabled,
              allocationMode: generatedPlacementException.allocationMode,
              alternateSubjects: generatedPlacementException.alternateSubjects.map((alternate) => ({
                placementPosition: alternate.placementPosition,
                ...(alternate.sectionId ? { sectionId: alternate.sectionId as SectionName } : {}),
                subjectId: alternate.subjectId,
                subjectKind: alternate.subjectKind,
                subjectNameSnapshot: alternate.subjectNameSnapshot,
                teacherAssignments: alternate.teacherAssignments.map((assignment) => ({
                  sectionId: assignment.sectionId as SectionName,
                  teacherId: assignment.teacherId,
                  teacherNameSnapshot: assignment.teacherNameSnapshot,
                })),
              })),
            },
          },
        }))
      }
    } catch (error) {
      if (academicConfigurationKey(selectionRef.current) !== generationSelectionKey) return
      result = {
        ok: false,
        code: 'UNSATISFIABLE',
        message: 'Timetable generation failed, so no timetable was returned.',
        blockingConstraints: [error instanceof Error ? error.message : 'The timetable generation service is unavailable.'],
      }
    }
    if (academicConfigurationKey(selectionRef.current) !== generationSelectionKey) return
    if (result.ok) {
      if (isGenericConfiguration) {
        setGeneratedTargetSchedules((current) => ({
          ...current,
          [selectedConfigurationKey]: result.sections as GenericGeneratedSection[],
        }))
      }
      setGenerationId(crypto.randomUUID())
    }
    setGenerationResult(result)
  }
  const outputSetup = openedSavedSetup ?? setup
  const outputSectionIds = outputSetup.sections.map((section) => section.id)
  const completeGeneration = generationResult?.ok && isCompleteGeneratedResult(generationResult, outputSectionIds) ? generationResult : null
  const incompleteGenerationMessage = generationResult?.ok && !completeGeneration
    ? 'The scheduler response did not include exactly 48 assigned teaching cells for each selected section. No partial timetable is displayed.'
    : null
  const saveCurrentGeneration = async () => {
    if (!completeGeneration || !generationId || savingVersion || generationId === savedGenerationId) return
    const selectionKey = selectedConfigurationKey
    setSavingVersion(true)
    setVersionError(null)
    try {
      const setupSnapshot = outputSetup
      const configuration = toGenericScheduleConfig(setupSnapshot).config
      const saved = await saveTimetableVersion({
        configuration,
        generationId,
        sections: completeGeneration.sections,
        setupSnapshot,
        validation: completeGeneration.validation,
      })
      if (academicConfigurationKey(selectionRef.current) !== selectionKey) return
      setSavedVersions(saved.timetableVersions)
      setSelectedSavedVersionId(saved.timetableVersions.find((version) => version.generationId === saved.generationId)?.versionId
        ?? saved.timetableVersions[0]?.versionId ?? '')
      setSavedGenerationId(saved.generationId)
      void refreshSavedTimetableNavigation()
    } catch (error) {
      if (academicConfigurationKey(selectionRef.current) === selectionKey) {
        setVersionError(error instanceof Error ? error.message : 'The timetable was not saved. Please try again.')
      }
    } finally {
      setSavingVersion(false)
    }
  }

  const openSavedTimetableVersion = async (requestedVersionId = selectedSavedVersionId) => {
    if (!requestedVersionId || openingVersion) return
    const requestToken = ++savedOpenRequestRef.current
    setOpeningVersion(true)
    setVersionError(null)
    try {
      const saved = await loadSavedTimetableVersion(requestedVersionId)
      if (savedOpenRequestRef.current !== requestToken) return
      if (!saved.setupSnapshot?.academic || !Array.isArray(saved.sections) || saved.sections.length === 0) {
        throw new Error('This saved version is missing the data required to reopen it.')
      }
      const sectionToOpen = saved.sections[0]
      const { versions } = await listSavedTimetableVersions({
        department: saved.setupSnapshot.academic.department,
        year: saved.setupSnapshot.academic.year,
        semester: saved.setupSnapshot.academic.semester,
        academicYear: saved.setupSnapshot.academic.academicYear,
      })
      if (savedOpenRequestRef.current !== requestToken) return
      const setupToShow = { ...saved.setupSnapshot, sections: saved.setupSnapshot.sections.filter((section) => section.id === sectionToOpen.sectionId) }
      setSavedVersions(versions)
      setSelectedSavedVersionId(saved.versionId)
      setOpenedSavedSetup(setupToShow)
      setGenerationResult({ ok: true, sections: [sectionToOpen], searchNodes: 0, validation: saved.validation })
      setGenerationId(saved.generationId)
      setSavedGenerationId(saved.generationId)
      setOpenedSavedVersionId(saved.versionId)
      setOpenedSavedSectionId(sectionToOpen.sectionId)
    } catch (error) {
      if (savedOpenRequestRef.current === requestToken) {
        setVersionError(error instanceof Error ? error.message : 'The saved timetable could not be opened.')
      }
    } finally {
      if (savedOpenRequestRef.current === requestToken) setOpeningVersion(false)
    }
  }

  const deleteSavedVersion = async (entry: SavedTimetableNavigationEntry) => {
    if (entry.status !== 'SAVED' || deletingVersionId) return
    const confirmed = window.confirm(`Delete Version ${entry.versionNumber}?\nThis saved timetable will be permanently removed.`)
    if (!confirmed) return

    const identity = {
      department: entry.department,
      year: entry.year,
      semester: entry.semester,
      academicYear: entry.academicYear,
    }
    setDeletingVersionId(entry.versionId)
    setVersionError(null)
    try {
      await deleteSavedTimetableVersion(entry.versionId)
      const [remainingNavigation, { versions }] = await Promise.all([
        refreshSavedTimetableNavigation(),
        listSavedTimetableVersions(identity),
      ])
      const current = selectionRef.current
      if (current.department === identity.department && current.year === identity.year
        && current.semester === identity.semester && identity.academicYear === academicYearLabel) {
        setSavedVersions(versions)
        setSelectedSavedVersionId((selected) => versions.some((version) => version.versionId === selected)
          ? selected
          : versions[0]?.versionId ?? '')
      }
      if (openedSavedVersionId === entry.versionId) {
        const remainingVersion = remainingNavigation.find((version) => version.generationId === entry.generationId
          && version.sectionName === openedSavedSectionId && version.department === identity.department
          && version.year === identity.year && version.semester === identity.semester
          && version.academicYear === identity.academicYear)
          ?? remainingNavigation.find((version) => version.generationId === entry.generationId
            && version.department === identity.department && version.year === identity.year
            && version.semester === identity.semester && version.academicYear === identity.academicYear)
        if (remainingVersion) {
          void openSavedTimetableVersion(remainingVersion.versionId)
        } else {
          setOpenedSavedSetup(null)
          setOpenedSavedVersionId(null)
          setOpenedSavedSectionId(null)
          setGenerationResult(null)
          setGenerationId(null)
          setSavedGenerationId(null)
        }
      }
    } catch (error) {
      setVersionError(error instanceof Error ? error.message : 'The saved timetable version could not be deleted.')
    } finally {
      setDeletingVersionId(null)
    }
  }

  const selectedSavedVersion = savedVersions.find((version) => version.versionId === selectedSavedVersionId)
  const openedSavedVersion = savedTimetableNavigation.find((version) => version.versionId === openedSavedVersionId)
    ?? savedVersions.find((version) => version.versionId === openedSavedVersionId)
  const openedVersionLocked = openedSavedVersion?.status === 'LOCKED'
  const validateEditedScheduleOccupancy = async (candidateSections: GeneratedSection[]): Promise<string[]> => {
    const identity = outputSetup.academic
    const [navigation, occupancy] = await Promise.all([
      listSavedTimetableNavigation(),
      loadSavedTeacherUnavailableSlots({
        identity: {
          department: identity.department,
          year: identity.year,
          semester: identity.semester,
          academicYear: identity.academicYear,
        },
        staff: outputSetup.staff,
      }),
    ])
    const openedVersion = navigation.timetables.find((entry) => entry.versionId === openedSavedVersionId)
    if (openedVersion?.status === 'LOCKED') return ['This timetable version is locked. Unlock it before editing.']

    const candidateIds = new Set(candidateSections.map((section) => section.sectionId))
    const activeSiblingEntries = openedSavedVersionId || openedSavedSectionId
      ? navigation.timetables.filter((entry) => entry.isActive
        && entry.department === identity.department
        && entry.year === identity.year
        && entry.semester === identity.semester
        && entry.academicYear === identity.academicYear
        && !candidateIds.has(entry.sectionName))
      : []
    const siblingVersions = await Promise.all(activeSiblingEntries.map((entry) => loadSavedTimetableVersion(entry.versionId)))
    const reservedSections = siblingVersions.flatMap((version) => version.sections)
    const editSetup = setupForEditedSections(outputSetup)
    const converted = toGenericScheduleConfig(editSetup)
    if (converted.issues.length) return converted.issues
    return validateGenericScheduleEdit(
      converted.config,
      genericSectionsForEdit(editSetup, candidateSections),
      reservedSections,
      occupancy.unavailableSlots,
      occupancy.alternateWeekUnavailableSlots,
    ).issues
  }
  const toggleSavedVersionLock = async () => {
    if (!selectedSavedVersion || lockingVersion || versionsLoading || openingVersion) return
    setLockingVersion(true)
    setVersionError(null)
    try {
      const updated = await setSavedTimetableVersionLock(selectedSavedVersion.versionId, selectedSavedVersion.status !== 'LOCKED')
      setSavedVersions((current) => current.map((version) => version.versionId === updated.versionId ? updated.savedVersion : version))
      setSelectedSavedVersionId(selectedSavedVersion.versionId)
      void refreshSavedTimetableNavigation()
    } catch (error) {
      setVersionError(error instanceof Error ? error.message : 'The saved timetable lock state could not be changed.')
    } finally {
      setLockingVersion(false)
    }
  }
  return <div className="app-shell">
    <header className="topbar">
      <img className="college-logo" src="/college_banner.png" alt="Manakula Vinayagar Institute of Technology banner" style={{ display: 'block', width: 'min(350px, calc(100vw - 34px))', height: 64, objectFit: 'fill' }} />
      <div className="college-name">Manakula Vinayagar Institute of Technology</div>
    </header>

    <div className="workspace-layout">
      <aside className="saved-timetable-sidebar" aria-label="Saved Timetables">
        <div className="saved-timetable-sidebar-heading">
          <h2>Saved Timetables</h2>
          {savedNavigationLoading && <span aria-label="Loading saved timetables">…</span>}
        </div>
        {savedNavigationError
          ? <p className="saved-timetable-sidebar-message" role="alert">{savedNavigationError}</p>
          : savedTimetableTree.length === 0
            ? <p className="saved-timetable-sidebar-message">{savedNavigationLoading ? 'Loading…' : 'No saved timetables'}</p>
            : <nav className="saved-timetable-tree" aria-label="Saved timetable versions">
                <ul>
                  {savedTimetableTree.map((department) => {
                    const expanded = Boolean(expandedSavedDepartments[department.name])
                    return <li key={department.name}>
                    <button
                      type="button"
                      className="saved-timetable-tree-label saved-timetable-department saved-timetable-department-toggle"
                      aria-expanded={expanded}
                      onClick={() => setExpandedSavedDepartments((current) => ({ ...current, [department.name]: !current[department.name] }))}
                    ><span className="saved-timetable-department-indicator" aria-hidden="true">{expanded ? '▾' : '▸'}</span>{department.name}</button>
                    {expanded && <ul>{department.years.map((year) => <li key={year.name}>
                      <span className="saved-timetable-tree-label">{year.name}</span>
                      <ul>{year.semesters.map((semester) => <li key={semester.name}>
                        <span className="saved-timetable-tree-label">{semester.name}</span>
                        <ul>{semester.academicYears.map((academicYear) => <li key={academicYear.name}>
                          <span className="saved-timetable-tree-label saved-timetable-academic-year">{academicYear.name}</span>
                          <ul>{academicYear.sections.map((section) => <li key={section.name}>
                            <span className="saved-timetable-tree-label saved-timetable-section">Section {section.name}</span>
                            <ul className="saved-timetable-versions">{section.versions.map((version) => <li className="saved-timetable-version-row" key={version.versionId}>
                              <button
                                type="button"
                                className={`saved-timetable-version${openedSavedVersionId === version.versionId ? ' active' : ''}`}
                                aria-pressed={openedSavedVersionId === version.versionId}
                                title={`${version.status} · ${version.createdAt}`}
                                disabled={openingVersion}
                                onClick={() => void openSavedTimetableVersion(version.versionId)}
                              >
                                {version.status === 'LOCKED' && <LockKeyhole size={11} aria-hidden="true" />}
                                <span>Version {version.versionNumber}</span>
                                <span className={`saved-timetable-status ${version.status.toLowerCase()}`}>{version.status}</span>
                              </button>
                              <button
                                type="button"
                                className="saved-timetable-delete"
                                aria-label={`Delete Version ${version.versionNumber}`}
                                title={version.status === 'LOCKED' ? 'Unlock this version before deleting it.' : `Delete Version ${version.versionNumber}`}
                                disabled={version.status !== 'SAVED' || openingVersion || deletingVersionId !== null}
                                onClick={() => void deleteSavedVersion(version)}
                              >Delete</button>
                            </li>)}</ul>
                          </li>)}</ul>
                        </li>)}</ul>
                      </li>)}</ul>
                    </li>)}</ul>}
                    </li>
                  })}
                </ul>
              </nav>}
      </aside>
      <main className="main-content">
      <div className="page-intro"><p className="eyebrow">ACADEMIC PLANNING</p><h1>College Timetable Generator</h1><p className="subtitle">Timetable Generator for Mrs. R. Indumathi</p><div className="intro-college"><GraduationCap size={17} /> Manakula Vinayagar Institute of Technology</div></div>
      <div className="section-list">
        <Accordion id="academic" number="01" title="Academic Details" description="Select the academic configuration for this timetable." icon={GraduationCap} open={openSection === 'academic'} onToggle={toggle}>
          <div className="academic-details-grid">
            <Field label="Department" value={selection.department} choices={departments.map((department) => ({ value: department, label: department }))} onChange={(department) => updateSelection({ department })} />
            <label className="field"><span>Academic Year</span><input value={academicYearLabel} readOnly /></label>
            <Field label="Year" value={selection.year} choices={yearOptions} onChange={(year) => updateSelection({ year })} />
            <Field label="Semester" value={selection.semester} choices={semesterOptions} onChange={(semester) => updateSelection({ semester })} />
          </div>
          {!hasConfiguration && <p className="configuration-status-note" role="status">No academic configuration has been saved for {selection.department} · {yearOptions.find(({ value }) => value === selection.year)?.label} · {semesterOptions.find(({ value }) => value === selection.semester)?.label}. Input areas start blank; add the academic data for this selection to enable generation.</p>}
        </Accordion>
        <Accordion id="staff" number="02" title="Staff Members" description="Add and manage the teaching staff for this timetable." icon={Users} count={`${setup.staff.length} staff`} open={openSection === 'staff'} onToggle={toggle}>
          {staffAssignmentError && <p className="validation-error" role="alert">{staffAssignmentError}</p>}
          <div className="table-wrap"><div className="subtable-heading"><h3>Staff Members</h3><button className="text-button" onClick={addStaff}><Plus size={15} /> Add Staff</button></div><table><thead><tr><th className="row-number">#</th><th>Staff ID</th><th>Staff Name</th><th aria-label="Actions" /></tr></thead><tbody>{setup.staff.map((person, i) => {
            const editing = editingStaffId === person.id
            return <tr key={person.id}><td className="row-number">{i + 1}</td><td>{editing
              ? <input aria-label={`Staff ID ${i + 1}`} value={person.id} onChange={(e) => updateStaff(person.id, { id: e.target.value })} placeholder="ST001" />
              : person.id}</td><td>{editing
              ? <input aria-label={`Staff name ${i + 1}`} value={person.name} onChange={(e) => updateStaff(person.id, { name: e.target.value })} placeholder="Full name" />
              : person.name}</td><td><div className="staff-row-actions">{editing
                ? <><button className="text-button" onClick={() => setEditingStaffId(null)} disabled={!person.name.trim() || !person.id.trim()}>Save</button><button className="icon-button" aria-label={`Cancel editing ${person.name || 'staff member'}`} onClick={() => { if (!person.name.trim() || !person.id.trim()) removeStaff(person.id); else setEditingStaffId(null) }}>Cancel</button></>
                : <button className="text-button" onClick={() => setEditingStaffId(person.id)}>Edit</button>}
                <button className="icon-button danger" aria-label={`Delete ${person.name || 'staff member'}`} onClick={() => removeStaff(person.id)}><Trash2 size={15} /></button>
              </div></td></tr>
          })}</tbody></table></div>
        </Accordion>
        <Accordion id="sections" number="03" title="Sections" description="Assign class advisors from the Staff Members list." icon={Users} count={getSectionCountLabel(sectionIds.length)} open={openSection === 'sections'} onToggle={toggle}>
          <div className="field-grid"><label className="field"><span>Number of Sections</span><input aria-label="Number of Sections" type="number" min={1} step={1} required value={sectionCountInput} onChange={(event) => {
            const value = event.target.value
            setSectionCountInput(value)
            const count = Number(value)
            if (value.trim() && Number.isSafeInteger(count) && count > 0) updateSectionCount(count)
          }} /></label></div>
          {!sectionCountInputValid && <p className="validation-error" role="alert">Enter a positive whole number of sections.</p>}
          <div className="section-grid">{setup.sections.map((section) => {
            return <div className="section-card" key={section.id}><div className="section-card-title"><span>Section {section.id}</span><span className="section-tag">{setup.academic.department} · {yearOptions.find(({ value }) => value === setup.academic.year)?.label}</span></div><label className="field"><span>Class advisor · Staff Master</span><TeacherSelector className="teacher-selector--field" staff={setup.staff} value={section.classAdvisorId} ariaLabel={`Class advisor for Section ${section.id}`} placeholder="Search by teacher name or ID" onChange={(value) => updateSection(section.id, { classAdvisorId: value })} /></label><Field label="Students" type="number" value={section.studentCount} min={1} max={200} onChange={(v) => updateSection(section.id, { studentCount: Number(v) })} /></div>
          })}</div>
        </Accordion>
        <Accordion id="coreSubjects" number="04" title="Core / Main Subjects" description="Configured subjects with section-specific teacher assignments." icon={BookOpen} count={`${setup.coreSubjects.length} subjects`} open={openSection === 'coreSubjects'} onToggle={toggle}>
          <CoreSubjectTable rows={setup.coreSubjects} staff={setup.staff} assignments={setup.sectionSubjectAssignments} onAssign={assignTeacher} onAssignTeam={assignCoreTeacherTeam} onUpdate={updateCoreSubject} onAdd={addCoreSubject} onRemove={removeCoreSubject} sectionIds={sectionIds} />
          {coreAssignmentError && <p className="validation-error" role="alert">{coreAssignmentError}</p>}
          <div className="info-note"><span className="info-mark">i</span><span><strong>Teacher assignment rule</strong> · A teacher may teach only one Core / Main subject within a section. Teachers can be assigned to different subjects in other sections.</span></div>
        </Accordion>
        <Accordion id="otherSubjects" number="05" title="Other Subjects" description="Configure optional subjects, weekly hours and section-specific staff." icon={BookOpen} count={`${setup.otherSubjects.length} subjects`} open={openSection === 'otherSubjects'} onToggle={toggle}>
          <OtherSubjectTable rows={setup.otherSubjects} staff={setup.staff} assignments={setup.sectionSubjectAssignments} onAssign={(sectionId, subjectId, teacherId) => assignTeacher(sectionId, subjectId, teacherId)} onUpdate={updateOtherSubject} onAdd={addOtherSubject} onRemove={(id) => removeSubject('otherSubjects', id)} sectionIds={sectionIds} />
        </Accordion>
        <Accordion id="labs" number="06" title="Labs" description="Configured labs with section-specific teachers." icon={FlaskConical} count={`${setup.labMaster.length} configured labs`} open={openSection === 'labs'} onToggle={toggle}>
          <LabAssignmentTable rows={setup.labAssignments} master={setup.labMaster} staff={setup.staff} onAssign={assignLabTeacher} onUpdate={updateLab} onAdd={addLab} onRemove={removeLab} sectionIds={sectionIds} />
          {labAssignmentError && <p className="validation-error" role="alert">{labAssignmentError}</p>}
          {setup.labMaster.length > 0 && <div className="info-note"><span className="info-mark">i</span><span>Lab blocks use Hours/Week and are scheduled continuously, up to 4 periods per block.</span></div>}
        </Accordion>
        <Accordion id="specialActivities" number="07" title="Special Activities" description={isGenericConfiguration ? 'Configure optional activities, Placement and section-specific staff.' : 'Fixed activities and advisor-led library / mentoring.'} icon={Star} count={`${setup.specialActivities.length} activities`} open={openSection === 'specialActivities'} onToggle={toggle}>
          <SpecialActivitiesTable rows={setup.specialActivities} staff={setup.staff} assignments={setup.specialActivityAssignments} onUpdate={updateSpecialActivity} onAssign={assignSpecialActivity} onAdd={addSpecialActivity} onRemove={removeSpecialActivity} sectionIds={sectionIds} showPlacementControls={isGenericConfiguration} />
          {isGenericConfiguration && (placementActivity || setup.placementException?.enabled) && <PlacementExceptionControls enabled={setup.placementException?.enabled ?? false} placementExists={Boolean(placementActivity && placementEnabled)} blockDuration={Math.min(placementActivity?.hoursPerWeek ?? 0, 4)} exception={setup.placementException} coreSubjects={setup.coreSubjects} otherSubjects={setup.otherSubjects} sections={setup.sections} onEnabledChange={updatePlacementExceptionEnabled} onModeChange={updatePlacementExceptionMode} onSubjectChange={updatePlacementAlternateSubject} />}
          {setup.specialActivities.length > 0 && <div className="info-note"><span className="info-mark">i</span><span>Activity teachers are selectable per section from this configuration’s Staff Members list.</span></div>}
        </Accordion>
        <Accordion id="rules" number="08" title="Scheduling Rules" description="Scheduling configuration for the selected academic programme." icon={Settings2} count={genericConfigurationReady ? 'Configured' : 'Not configured'} open={openSection === 'rules'} onToggle={toggle}>
          <section className="rule-group">
            <div className="rule-group-heading"><span>Configurable scheduling preferences</span><span className="rule-badge optional">GENERIC RULES</span></div>
            <div className="field-grid">
              <Field label="Allow Special Activities on Consecutive Days" value={genericScheduling.allowConsecutiveSpecialActivityDays === true ? 'on' : 'off'} choices={[{ value: 'on', label: 'ON' }, { value: 'off', label: 'OFF' }]} onChange={(value) => updateGenericScheduling({ allowConsecutiveSpecialActivityDays: value === 'on' })} />
              <Field label="Test Policy" value={genericTestPolicy} choices={[{ value: 'on', label: 'Test ON' }, { value: 'off', label: 'Test OFF' }]} onChange={(value) => updateGenericScheduling({ testPolicy: value as 'on' | 'off' })} />
              <Field label="Core Subjects in P1" value={genericScheduling.allowCoreSubjectsInP1 === false ? 'deny' : 'allow'} choices={[{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Do not allow' }]} onChange={(value) => updateGenericScheduling({ allowCoreSubjectsInP1: value === 'allow' })} />
              <Field label="Other Subjects in P1" value={genericScheduling.allowOtherSubjectsInP1 === false ? 'deny' : 'allow'} choices={[{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Do not allow' }]} onChange={(value) => updateGenericScheduling({ allowOtherSubjectsInP1: value === 'allow' })} />
            </div>
            {genericTestPolicy === 'on' && <fieldset className="check-group compact-grid">
              <legend>Eligible Test / Core Subjects</legend>
              {setup.coreSubjects.length === 0
                ? <span className="field-hint">Add Core / Main Subjects to select test subjects.</span>
                : setup.coreSubjects.map((subject) => <label className="checkbox-label" key={subject.id}>
                  <input type="checkbox" checked={p1TestSubjectIds.includes(subject.id)} onChange={(event) => toggleP1TestSubject(subject.id, event.target.checked)} />
                  {subject.name || subject.code || 'Unnamed subject'}
                </label>)}
            </fieldset>}
            <div className="info-note"><span className="info-mark">i</span><span>Tests use only selected Core / Main Subjects and count toward their weekly hours; Other Subjects cannot be tests. Normal Special Activities cannot use P1, and at most one normal Special Activity may be scheduled per section per day. Consecutive activity days follow the setting above.</span></div>
            <div className="info-note"><span className="info-mark">i</span><span>Configured Workload: <strong>{genericWorkload} / 48</strong></span></div>
            {genericWorkloadIssue(genericWorkload) && <p className="validation-error" role="alert">{genericWorkloadIssue(genericWorkload)}</p>}
            {genericTestPolicy === 'on' && p1TestSubjectIds.length === 0 && <p className="validation-error" role="alert">Select at least one Core / Main Subject for P1 tests, or turn Test off.</p>}
          </section>
        </Accordion>
      </div>

      <div className="generate-area">
        <button className="generate-button" onClick={generate} disabled={!canGenerate}><Sparkles size={18} /> {getGenerateTimetableLabel(sectionIds)}</button>
        <p>{targetNeedsConfiguration
          ? 'Add curriculum rows and assign staff to configure this timetable.'
          : canGenerate
            ? `Generate and validate all ${sectionIds.length} configured section${sectionIds.length === 1 ? '' : 's'} with the generic scheduling rules.`
            : `${setup.academic.department} generation is blocked until its configured workload, required fields and staff assignments are valid.`}</p>
        {!targetNeedsConfiguration && configurationIssues.length > 0 && <div className="generation-error" role="status"><strong>{setup.academic.department} configuration validation</strong><ul>{configurationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
        <div className="timetable-version-actions" aria-label="Save and open timetable versions">
          {completeGeneration && generationId && <button type="button" className="timetable-version-save" onClick={saveCurrentGeneration} disabled={savingVersion || generationId === savedGenerationId}>
            {savingVersion ? 'Saving…' : generationId === savedGenerationId ? 'Saved' : 'Save Timetable'}
          </button>}
          <label>Saved versions
            <select aria-label="Saved timetable version" value={selectedSavedVersionId} onChange={(event) => setSelectedSavedVersionId(event.target.value)} disabled={versionsLoading || savedVersions.length === 0}>
              {savedVersions.length === 0
                ? <option value="">{versionsLoading ? 'Loading…' : 'No saved versions'}</option>
                : savedVersions.map((version) => <option key={version.versionId} value={version.versionId}>Version {version.versionNumber} · Section {version.sectionName} · {version.createdAt}{version.status === 'LOCKED' ? ' · LOCKED' : ''}</option>)}
            </select>
          </label>
          {selectedSavedVersion && <button type="button" className="timetable-version-open" onClick={toggleSavedVersionLock} disabled={lockingVersion || versionsLoading || openingVersion || savingVersion}>
            {lockingVersion ? 'Updating…' : selectedSavedVersion.status === 'LOCKED' ? 'Unlock Version' : 'Lock Version'}
          </button>}
          <button type="button" className="timetable-version-open" onClick={() => void openSavedTimetableVersion()} disabled={!selectedSavedVersionId || openingVersion || versionsLoading}>
            {openingVersion ? 'Opening…' : 'Open Version'}
          </button>
        </div>
        {versionError && <p className="timetable-version-error" role="alert">{versionError}</p>}
      </div>

      {completeGeneration
        ? <>
            <GeneratedTimetablePreview setup={outputSetup} result={completeGeneration} preferredSectionId={openedSavedSectionId} isLocked={openedVersionLocked} validateSavedOccupancy={validateEditedScheduleOccupancy} onSave={(updatedResult) => {
              setGenerationResult(updatedResult)
              setGenerationId(crypto.randomUUID())
              setOpenedSavedVersionId(null)
              setGeneratedTargetSchedules((current) => ({ ...current, [selectedConfigurationKey]: updatedResult.sections as GenericGeneratedSection[] }))
              setVersionError(null)
            }} />
            <TeacherTimetableFeature setup={outputSetup} sections={completeGeneration.sections} />
          </>
        : generationResult
          ? <div className="generation-error" role="alert"><strong>Timetable could not be generated with the current constraints.</strong>{!generationResult.ok ? <ul>{generationResult.blockingConstraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul> : <p>{incompleteGenerationMessage}</p>}</div>
          : <p className="no-timetable-placeholder">No timetable generated yet.</p>}
      <ConsolidatedFacultyTimetable />
      </main>
    </div>
    <footer className="footer"><span>© {new Date().getFullYear()} Manakula Vinayagar Institute of Technology, Puducherry</span><span>College Timetable Generator <i /> {selection.department} Department</span></footer>
  </div>
}

export default App
