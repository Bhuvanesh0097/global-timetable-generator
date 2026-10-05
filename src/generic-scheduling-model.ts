/**
 * Department-neutral scheduling input. This model is intentionally separate
 * from the legacy department profiles so new schedules can be described by
 * data without adding curriculum branches to the existing engines.
 */

export const genericTimetableDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export type GenericWeekDay = typeof genericTimetableDays[number]
export const genericPeriodsPerDay = 8
export const genericStudentSlotsPerWeek = genericTimetableDays.length * genericPeriodsPerDay

export const genericTimetableBreaks = [
  { afterPeriod: 2, label: 'BREAK' },
  { afterPeriod: 4, label: 'LUNCH' },
  { afterPeriod: 6, label: 'BREAK' },
] as const

export interface GenericStaff {
  id: string
  name: string
}

export interface GenericTeacherAssignment {
  sectionId: string
  teacherId: string
}

export interface GenericSection {
  id: string
  /** Class advisor is metadata only and is not required to teach a period. */
  classAdvisorId?: string
}

interface GenericAssignedWork {
  id: string
  code?: string
  abbreviation?: string
  name: string
  teacherAssignments: GenericTeacherAssignment[]
  /** Optional teaching-period block length. Omitted rows are single periods. */
  blockDuration?: number
  /** Optional allowed starting period numbers for multi-period blocks. */
  allowedStartPeriods?: number[]
}

export interface GenericSubject extends GenericAssignedWork {
  weeklyHours: number
}

export interface GenericOtherSubject extends GenericAssignedWork {
  weeklyHours: number
  enabled?: boolean
}

export interface GenericLab extends GenericAssignedWork {
  weeklyPeriods: number
  enabled?: boolean
}

export interface GenericActivity extends GenericAssignedWork {
  weeklyPeriods: number
  enabled: boolean
}

export interface GenericPlacementConfig extends GenericAssignedWork {
  enabled: boolean
  weeklyPeriods: number
}

export interface GenericPlacementAlternateTeacherAssignment {
  sectionId: string
  teacherId: string
  teacherNameSnapshot: string
}

export interface GenericPlacementAlternateSubject {
  /** One-based position within each continuous Placement block. */
  placementPosition: number
  /** Omitted for legacy selections shared by every section. */
  sectionId?: string
  subjectId: string
  subjectKind: 'core' | 'other'
  subjectNameSnapshot: string
  teacherAssignments: GenericPlacementAlternateTeacherAssignment[]
}

export interface GenericPlacementExceptionConfig {
  enabled: boolean
  allocationMode?: 'random' | 'custom'
  alternateSubjects: GenericPlacementAlternateSubject[]
}

export interface GenericScheduledAlternateSubject {
  placementPosition: number
  subjectId: string
  subjectKind: 'core' | 'other'
  code: string
  abbreviation: string
  name: string
  teacherId: string
  teacherNameSnapshot: string
}

export interface GenericP1TestConfig {
  enabled: boolean
  /** Defaults to all subjects when omitted. */
  subjectIds?: string[]
  /** Number of P1 test periods per selected subject; each uses its normal weeklyHours. */
  testsPerSubject?: number
  /** Append “(T)” to each generated test cell’s abbreviation; defaults to true. */
  markAsTest?: boolean
  /** Require all six weekly P1 slots to be tests, rather than allowing ordinary work in remaining P1 slots. */
  reserveEveryP1ForTest?: boolean
}

export interface GenericSchedulingRules {
  /** Optional occurrence limits. Undefined means the engine does not impose that limit. */
  coreDailyMaximum?: number
  /** Normal Core/Other runs are capped at two; explicit multi-period blocks keep their configured length. */
  coreConsecutiveMaximum?: number
  /** Optional consecutive cap for other subjects; defaults to two. */
  subjectConsecutiveMaximum?: number
  itemDailyMaximum?: number
  labsPerDayMaximum?: number
  labsOnDistinctDays?: boolean
  /** Normal core subjects may use P1 unless explicitly disabled. Tests are controlled separately. */
  allowCoreSubjectsInP1?: boolean
  /** Other Subjects may use P1 unless explicitly disabled; they are never marked as tests. */
  allowOtherSubjectsInP1?: boolean
  /** When false or omitted, normal Special Activities cannot occupy adjacent days. */
  allowConsecutiveSpecialActivityDays?: boolean
  /** Blocks avoid the P4/P5 lunch boundary by default. */
  blocksAvoidLunch?: boolean
  /** A lab definition represents one shared physical resource across sections when true. */
  preventConcurrentUseOfSameLab?: boolean
  p1Tests?: GenericP1TestConfig
  /** Search guard, not a curriculum rule. Defaults to 300,000 explored states. */
  searchNodeLimit?: number
}

export interface GenericScheduleConfig {
  /** Optional stable identity when multiple configurations are generated together. */
  configurationId?: string
  department: string
  academicYear: string
  year: string
  semester: string
  sections: GenericSection[]
  staff: GenericStaff[]
  subjects: GenericSubject[]
  otherSubjects?: GenericOtherSubject[]
  labs?: GenericLab[]
  placement?: GenericPlacementConfig
  placementException?: GenericPlacementExceptionConfig
  specialActivities?: GenericActivity[]
  rules?: GenericSchedulingRules
  /** Number of randomized candidates to score; defaults to five. */
  candidateCount?: number
  /** Optional reproducibility seed for randomized candidate generation. */
  randomSeed?: number
}

/** Teacher slots already occupied by another saved timetable. */
export interface GenericUnavailableTeacherSlot {
  teacherId: string
  day: GenericWeekDay
  period: number
  existing?: {
    department: string
    year: string
    semester: string
    section: string
    subject: string
  }
}

/** Generate multiple department/year configurations as one global teacher-clash problem. */
export interface GenericScheduleGroupInput {
  schedules: GenericScheduleConfig[]
  /** Previously accepted schedules which new candidates must not clash with or duplicate. */
  reservedSections?: GenericGeneratedSection[]
  /** Saved timetable occupancy for the normal week, loaded before candidate generation. */
  unavailableTeacherSlots?: GenericUnavailableTeacherSlot[]
  /** Saved timetable occupancy for alternate Placement weeks, loaded before candidate generation. */
  alternateWeekUnavailableTeacherSlots?: GenericUnavailableTeacherSlot[]
  /** Number of randomized global candidates to score; defaults to five. */
  candidateCount?: number
  /** Optional reproducibility seed shared by the global candidate search. */
  randomSeed?: number
}

/** One profile or a global group of profiles, all handled by the same engine. */
export type GenericSchedulerInput = GenericScheduleConfig | GenericScheduleGroupInput

export interface GenericScheduledCell {
  itemId: string
  /** Shared identifier for cells placed together as one multi-period block. */
  blockId?: string
  code: string
  abbreviation: string
  name: string
  teacherId: string
  kind: 'core' | 'other' | 'lab' | 'activity'
  /** True only for configured P1 tests; tests consume normal core-subject workload. */
  isCoreTest?: boolean
  /** Alternate-week subject occupying this Placement cell's exact position. */
  alternateSubject?: GenericScheduledAlternateSubject
}

export interface GenericGeneratedSection {
  sectionId: string
  profileId: string
  department: string
  academicYear: string
  year: string
  semester: string
  schedule: Record<GenericWeekDay, Record<number, GenericScheduledCell>>
}

export interface GenericSectionValidationSummary {
  sectionId: string
  profileId: string
  department: string
  periodsFilled: number
  coreHoursValid: boolean
  otherSubjectHoursValid: boolean
  labAllocationValid: boolean
}

export interface GenericTimetableValidationSummary {
  sections: GenericSectionValidationSummary[]
  globalTeacherClashes: number
}

export type GenericTimetableGenerationResult =
  | { ok: true; sections: GenericGeneratedSection[]; searchNodes: number; validation: GenericTimetableValidationSummary }
  | {
    ok: false
    code:
      | 'INVALID_INPUT'
      | 'UNSATISFIABLE'
      | 'SEARCH_LIMIT'
      | 'SCHEDULER_CAPACITY'
      | 'SCHEDULER_TIMEOUT'
      | 'SCHEDULER_QUEUE_TIMEOUT'
      | 'SCHEDULER_WORKER_FAILED'
      | 'SCHEDULER_UNAVAILABLE'
    message: string
    blockingConstraints: string[]
  }
