import type { GenericActivity, GenericScheduleConfig } from './generic-scheduling-model.ts'
import type { TimetableSetup } from './models'
import { validateCollegeTimings } from './college-timings.ts'

function isPlacementActivity(name: string): boolean {
  return ['placement', 'placement training'].includes(name.trim().toLocaleLowerCase())
}

function sectionAssignments(setup: TimetableSetup, subjectId: string) {
  return setup.sectionSubjectAssignments
    .filter((assignment) => assignment.subjectId === subjectId)
    .map(({ sectionId, teacherId }) => ({ sectionId, teacherId }))
}

function labAssignments(setup: TimetableSetup, labId: string) {
  return setup.labAssignments
    .filter((assignment) => assignment.labId === labId)
    .map(({ sectionId, teacherId }) => ({ sectionId, teacherId }))
}

function activityAssignments(setup: TimetableSetup, activityId: string) {
  return setup.specialActivityAssignments
    .filter((assignment) => assignment.activityId === activityId)
    .map(({ sectionId, teacherId }) => ({ sectionId, teacherId }))
}

export interface GenericScheduleSetupConversion {
  config: GenericScheduleConfig
  issues: string[]
}

/** Adapt the existing configuration tables to the department-neutral scheduling input. */
export function toGenericScheduleConfig(setup: TimetableSetup): GenericScheduleSetupConversion {
  const scheduling = setup.genericScheduling
  const placementRows = setup.specialActivities.filter((activity) => isPlacementActivity(activity.name))
  const otherActivities = setup.specialActivities.filter((activity) => !isPlacementActivity(activity.name))
  const issues = placementRows.length > 1
    ? ['Only one Special Activities row may be named Placement or Placement Training.']
    : []
  if (setup.collegeTimings) issues.push(...validateCollegeTimings(setup.collegeTimings))
  const testPolicy = scheduling?.testPolicy ?? 'off'
  if (testPolicy === 'on' && !(scheduling?.p1TestSubjectIds?.length)) {
    issues.push('Select at least one Core / Main Subject for P1 tests, or turn Test off.')
  }
  const placementRow = placementRows[0]
  const placementWeeklyPeriods = scheduling?.placementWeeklyPeriods ?? placementRow?.hoursPerWeek ?? 0
  const placementBlockDuration = placementRow?.blockDuration ?? (placementWeeklyPeriods > 0 ? placementWeeklyPeriods : undefined)
  const specialActivities: GenericActivity[] = otherActivities.map((activity) => ({
    id: activity.id,
    name: activity.name,
    enabled: true,
    weeklyPeriods: activity.hoursPerWeek,
    ...(activity.blockDuration ? { blockDuration: activity.blockDuration } : {}),
    ...(activity.allowedStartPeriods ? { allowedStartPeriods: [...activity.allowedStartPeriods] } : {}),
    teacherAssignments: activityAssignments(setup, activity.id),
  }))

  return {
    config: {
      ...(setup.collegeTimings ? { collegeTimings: setup.collegeTimings } : {}),
      department: setup.academic.department,
      academicYear: setup.academic.academicYear,
      year: setup.academic.year,
      semester: setup.academic.semester,
      sections: setup.sections.map((section) => ({
        id: section.id,
        ...(section.classAdvisorId ? { classAdvisorId: section.classAdvisorId } : {}),
      })),
      staff: setup.staff.map(({ id, name }) => ({ id, name })),
      subjects: setup.coreSubjects.map((subject) => ({
        id: subject.id,
        code: subject.code,
        abbreviation: subject.abbreviation,
        name: subject.name,
        weeklyHours: subject.hoursPerWeek,
        teacherAssignments: sectionAssignments(setup, subject.id),
      })),
      otherSubjects: setup.otherSubjects.map((subject) => ({
        id: subject.id,
        code: subject.code,
        abbreviation: subject.abbreviation,
        name: subject.name,
        weeklyHours: subject.hoursPerWeek,
        teacherAssignments: sectionAssignments(setup, subject.id),
      })),
      labs: setup.labMaster.map((lab) => ({
        id: lab.id,
        code: lab.code,
        abbreviation: lab.abbreviation,
        name: lab.name,
        weeklyPeriods: lab.weeklyPeriods,
        ...(lab.blockDuration ? { blockDuration: lab.blockDuration } : {}),
        ...(lab.allowedStartPeriods ? { allowedStartPeriods: [...lab.allowedStartPeriods] } : {}),
        teacherAssignments: labAssignments(setup, lab.id),
      })),
      ...(placementRow ? {
        placement: {
          id: 'placement',
          code: '',
          abbreviation: placementRow.name,
          name: placementRow.name,
          enabled: scheduling?.placementEnabled ?? true,
          weeklyPeriods: placementWeeklyPeriods || placementRow.hoursPerWeek,
          ...(placementBlockDuration ? { blockDuration: placementBlockDuration } : {}),
          ...(placementRow.allowedStartPeriods ? { allowedStartPeriods: [...placementRow.allowedStartPeriods] } : {}),
          teacherAssignments: activityAssignments(setup, placementRow.id),
        },
      } : {}),
      ...(setup.placementException ? {
        placementException: {
          enabled: setup.placementException.enabled,
          ...(setup.placementException.allocationMode ? { allocationMode: setup.placementException.allocationMode } : {}),
          alternateSubjects: setup.placementException.alternateSubjects.map((alternate) => ({
            placementPosition: alternate.placementPosition,
            ...(alternate.sectionId ? { sectionId: alternate.sectionId } : {}),
            subjectId: alternate.subjectId,
            subjectKind: alternate.subjectKind,
            subjectNameSnapshot: alternate.subjectNameSnapshot,
            teacherAssignments: alternate.teacherAssignments.map(({ sectionId, teacherId, teacherNameSnapshot }) => ({
              sectionId,
              teacherId,
              teacherNameSnapshot,
            })),
          })),
        },
      } : {}),
      specialActivities,
      rules: {
        coreDailyMaximum: 2,
        coreConsecutiveMaximum: 2,
        subjectConsecutiveMaximum: 2,
        allowCoreSubjectsInP1: scheduling?.allowCoreSubjectsInP1 ?? true,
        allowOtherSubjectsInP1: scheduling?.allowOtherSubjectsInP1 ?? true,
        ...(scheduling?.allowConsecutiveSpecialActivityDays !== undefined ? {
          allowConsecutiveSpecialActivityDays: scheduling.allowConsecutiveSpecialActivityDays,
        } : {}),
        p1Tests: {
          enabled: testPolicy === 'on',
          ...(testPolicy === 'on' ? { subjectIds: scheduling?.p1TestSubjectIds ?? [] } : {}),
        },
      },
      candidateCount: 2,
    },
    issues,
  }
}

export function randomizeGenericPlacementAlternates(
  config: GenericScheduleConfig,
  random: () => number = Math.random,
): GenericScheduleSetupConversion {
  const exception = config.placementException
  if (!exception?.enabled || exception.allocationMode !== 'random') return { config, issues: [] }
  const duration = config.placement?.blockDuration
  if (!Number.isInteger(duration) || !duration || duration < 1 || duration > 4) {
    return { config, issues: ['Random Placement allocation requires a valid Placement block duration from 1 to 4 periods.'] }
  }

  const staffById = new Map(config.staff.map((staff) => [staff.id, staff]))
  const subjects = [
    ...config.subjects.map((subject) => ({ subject, subjectKind: 'core' as const })),
    ...(config.otherSubjects ?? []).filter((subject) => subject.enabled !== false)
      .map((subject) => ({ subject, subjectKind: 'other' as const })),
  ]
  const alternateSubjects: NonNullable<GenericScheduleConfig['placementException']>['alternateSubjects'] = []
  const issues: string[] = []
  for (const section of config.sections) {
    const selected = new Map<string, number>()
    const previous: Array<{ key: string; subjectKind: 'core' | 'other' }> = []
    for (let placementPosition = 1; placementPosition <= duration; placementPosition += 1) {
      const available = subjects.flatMap(({ subject, subjectKind }) => {
        const assignment = subject.teacherAssignments.find((entry) => entry.sectionId === section.id && staffById.has(entry.teacherId))
        if (!assignment || !subject.id.trim() || !subject.name.trim()) return []
        const teacher = staffById.get(assignment.teacherId)!
        const key = `${subjectKind}:${subject.id}`
        return [{ subject, subjectKind, assignment, teacher, key }]
      })
      const candidates = available.filter(({ subject, subjectKind, key }) => {
        const dailyMaximum = subjectKind === 'core' ? config.rules?.coreDailyMaximum : config.rules?.itemDailyMaximum
        if (dailyMaximum !== undefined && (selected.get(key) ?? 0) >= dailyMaximum) return false
        const consecutiveMaximum = subjectKind === 'core'
          ? config.rules?.coreConsecutiveMaximum ?? config.rules?.subjectConsecutiveMaximum ?? 2
          : config.rules?.subjectConsecutiveMaximum ?? 2
        const runLimit = Math.max(Math.min(consecutiveMaximum, 2), 1)
        let run = 0
        for (let index = previous.length - 1; index >= 0 && previous[index].key === key; index -= 1) run += 1
        return run < runLimit && subject.weeklyHours > 0
      })
      if (!candidates.length) {
        issues.push(`Section ${section.id} has no available alternate subject for Placement position ${placementPosition} under the configured subject limits.`)
        break
      }
      const randomIndex = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))
      const { subject, subjectKind, assignment, teacher, key } = candidates[randomIndex]
      selected.set(key, (selected.get(key) ?? 0) + 1)
      previous.push({ key, subjectKind })
      alternateSubjects.push({
        placementPosition,
        sectionId: section.id,
        subjectId: subject.id,
        subjectKind,
        subjectNameSnapshot: subject.name,
        teacherAssignments: [{ sectionId: section.id, teacherId: assignment.teacherId, teacherNameSnapshot: teacher.name }],
      })
    }
  }
  if (issues.length) return { config, issues }
  return {
    config: { ...config, placementException: { ...exception, allocationMode: 'custom', alternateSubjects } },
    issues: [],
  }
}
