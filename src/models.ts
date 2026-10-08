import type { CollegeTimings } from './college-timings.ts'

export type SectionName = string

export interface StaffMember {
  /** Stable person identity; reuse this ID across department-local staff lists for the same person. */
  id: string
  name: string
}

export interface Section {
  id: SectionName
  classAdvisorId: StaffMember['id'] | ''
  studentCount: number
}

export interface Subject {
  id: string
  code: string
  name: string
  hoursPerWeek: number
}

export interface CoreSubject extends Subject {
  abbreviation: string
}

export interface OtherSubjectDefinition {
  code: string
  name: string
  abbreviation: string
  hoursPerWeek: number
}

export interface OtherSubject extends Subject {
  abbreviation: string
}

export interface SpecialActivity {
  id: string
  name: string
  hoursPerWeek: number
  /** Optional continuous block duration for the department-neutral scheduler. */
  blockDuration?: number
  /** Optional allowed start periods for continuous activity blocks. */
  allowedStartPeriods?: number[]
}

export interface SectionSubjectAssignment {
  sectionId: SectionName
  subjectId: string
  teacherId: StaffMember['id']
}

export interface SpecialActivityAssignment {
  sectionId: SectionName
  activityId: string
  teacherId: StaffMember['id'] | ''
}

export interface LabDefinition {
  id: string
  code: string
  name: string
  abbreviation: string
  weeklyPeriods: number
  /** Optional configured block duration for the department-neutral scheduler. */
  blockDuration?: number
  /** Optional allowed start periods for continuous lab blocks. */
  allowedStartPeriods?: number[]
}

export interface LabAssignment {
  labId: LabDefinition['id']
  sectionId: SectionName
  teacherId: StaffMember['id'] | ''
}

export interface AcademicDetails {
  department: string
  academicYear: string
  year: string
  semester: string
}

export type WeekDay = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'

export interface TimetableSetup {
  academic: AcademicDetails
  /** Optional institution timing snapshot; omitted values retain the current 6-day/8-period defaults. */
  collegeTimings?: CollegeTimings
  /** Optional CSE scheduler profile controls; omitted values retain existing 3rd-Year defaults. */
  schedulerProfile?: {
    placement: 'required' | 'not-used'
    p1CoreTests?: boolean
  }
  /** Optional, persisted controls for configurations scheduled by the generic engine. */
  genericScheduling?: {
    placementEnabled?: boolean
    placementWeeklyPeriods?: number
    testPolicy?: 'on' | 'off'
    p1TestSubjectIds?: string[]
    allowCoreSubjectsInP1?: boolean
    allowOtherSubjectsInP1?: boolean
    allowConsecutiveSpecialActivityDays?: boolean
  }
  /** Placement positions can optionally be paired with subjects for the alternate week. */
  placementException?: {
    enabled: boolean
    allocationMode?: 'random' | 'custom'
    alternateSubjects: Array<{
      placementPosition: number
      sectionId?: SectionName
      subjectId: string
      subjectKind: 'core' | 'other'
      subjectNameSnapshot: string
      teacherAssignments: Array<{
        sectionId: SectionName
        teacherId: StaffMember['id']
        teacherNameSnapshot: string
      }>
    }>
  }
  staff: StaffMember[]
  sections: Section[]
  coreSubjects: CoreSubject[]
  otherSubjectMaster: OtherSubjectDefinition[]
  otherSubjects: OtherSubject[]
  labMaster: LabDefinition[]
  labAssignments: LabAssignment[]
  specialActivities: SpecialActivity[]
  sectionSubjectAssignments: SectionSubjectAssignment[]
  specialActivityAssignments: SpecialActivityAssignment[]
}

export function getSectionClassAdvisor(setup: TimetableSetup, sectionId: SectionName): StaffMember | undefined {
  const advisorId = setup.sections.find((section) => section.id === sectionId)?.classAdvisorId
  return advisorId ? setup.staff.find((staffMember) => staffMember.id === advisorId) : undefined
}
