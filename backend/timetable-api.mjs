import { createHash, randomUUID } from 'node:crypto'
import { runGenericTimetableGeneration } from './generic-scheduler-worker-pool.mjs'
import { randomizeGenericPlacementAlternates } from '../src/generic-schedule-adapter.ts'

const maximumBodyBytes = 2 * 1024 * 1024
const defaultMaximumRetainedGenerationJobs = 1024
const defaultGenerationJobRetentionMs = 10 * 60 * 1000
const supportedDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const maximumTeacherWeeklyPeriods = 48
const randomPlacementAllocationAttempts = 8
const setupArrayFields = [
  'staff', 'sections', 'coreSubjects', 'otherSubjectMaster', 'otherSubjects', 'labMaster',
  'labAssignments', 'specialActivities', 'sectionSubjectAssignments', 'specialActivityAssignments',
]

function logGenerationEvent(event, details) {
  console.info(JSON.stringify({ event, ...details }))
}

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

function readJsonBody(request, requestName = 'save request') {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    request.on('data', (chunk) => {
      length += chunk.length
      if (length > maximumBodyBytes) {
        reject(new Error(`The ${requestName} is too large.`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error(`The ${requestName} is not valid JSON.`))
      }
    })
    request.on('error', reject)
  })
}

function identityFromQuery(url) {
  const identity = {
    department: url.searchParams.get('department') ?? '',
    year: url.searchParams.get('year') ?? '',
    semester: url.searchParams.get('semester') ?? '',
    academicYear: url.searchParams.get('academicYear') ?? '',
  }
  if (Object.values(identity).some((field) => !field.trim())) {
    throw new Error('Department, year, semester and academic year are required.')
  }
  return identity
}

function generationIdentity(configuration) {
  const identity = {
    department: configuration?.department,
    year: configuration?.year,
    semester: configuration?.semester,
    academicYear: configuration?.academicYear,
  }
  if (Object.values(identity).some((field) => typeof field !== 'string' || !field.trim())) {
    throw new Error('Department, year, semester and academic year are required for timetable generation.')
  }
  if (!Array.isArray(configuration.sections) || configuration.sections.length === 0
    || !Array.isArray(configuration.staff)
    || configuration.staff.some((teacher) => !teacher || !String(teacher.id ?? '').trim()
      || !String(teacher.name ?? teacher.canonicalName ?? '').trim())) {
    throw new Error('Timetable generation requires configured sections and staff with stable teacher IDs.')
  }
  return identity
}

function generationStaff(configuration) {
  const teacherIds = new Set()
  const items = [
    ...(Array.isArray(configuration.subjects) ? configuration.subjects : []),
    ...(Array.isArray(configuration.otherSubjects) ? configuration.otherSubjects : []),
    ...(Array.isArray(configuration.labs) ? configuration.labs : []),
    ...(configuration.placement ? [configuration.placement] : []),
    ...(Array.isArray(configuration.specialActivities) ? configuration.specialActivities : []),
  ]
  for (const item of items) {
    for (const assignment of Array.isArray(item?.teacherAssignments) ? item.teacherAssignments : []) {
      if (assignment?.teacherId) teacherIds.add(assignment.teacherId)
    }
  }
  for (const alternate of Array.isArray(configuration.placementException?.alternateSubjects)
    ? configuration.placementException.alternateSubjects : []) {
    for (const assignment of Array.isArray(alternate?.teacherAssignments) ? alternate.teacherAssignments : []) {
      if (assignment?.teacherId) teacherIds.add(assignment.teacherId)
    }
  }
  return configuration.staff.filter((teacher) => teacherIds.has(teacher.id))
}

function timetableSectionKey(identity, sectionId) {
  return [identity.department, identity.year, identity.semester, identity.academicYear, sectionId].join('\u0000')
}

function weeklyPeriodCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function addTeacherPeriods(target, teacherId, periods) {
  const count = weeklyPeriodCount(periods)
  if (!teacherId || !count) return
  target.set(teacherId, (target.get(teacherId) ?? 0) + count)
}

function configuredTeacherWorkload(configuration) {
  const normal = new Map()
  const alternate = new Map()
  const countRows = (rows, field, enabled) => {
    for (const section of configuration.sections) {
      for (const row of rows ?? []) {
        if (!enabled(row)) continue
        const assignment = row.teacherAssignments?.find((entry) => entry.sectionId === section.id)
        const periods = weeklyPeriodCount(row[field])
        addTeacherPeriods(normal, assignment?.teacherId, periods)
        addTeacherPeriods(alternate, assignment?.teacherId, periods)
      }
    }
  }

  countRows(configuration.subjects, 'weeklyHours', () => true)
  countRows(configuration.otherSubjects, 'weeklyHours', (row) => row.enabled !== false)
  countRows(configuration.labs, 'weeklyPeriods', (row) => row.enabled !== false)
  countRows(configuration.specialActivities, 'weeklyPeriods', (row) => row.enabled === true)

  const placement = configuration.placement
  if (placement?.enabled) {
    const periods = weeklyPeriodCount(placement.weeklyPeriods)
    const duration = weeklyPeriodCount(placement.blockDuration) || periods
    const exception = configuration.placementException
    for (const section of configuration.sections) {
      const baseTeacherId = placement.teacherAssignments?.find((entry) => entry.sectionId === section.id)?.teacherId
      addTeacherPeriods(normal, baseTeacherId, periods)

      let remaining = periods
      while (remaining > 0) {
        const blockLength = Math.min(duration, remaining)
        for (let position = 1; position <= blockLength; position += 1) {
          const alternateDefinition = exception?.enabled
            ? exception.alternateSubjects?.find((row) => row.placementPosition === position && row.sectionId === section.id)
              ?? exception.alternateSubjects?.find((row) => row.placementPosition === position && !row.sectionId)
            : undefined
          const alternateTeacherId = alternateDefinition?.teacherAssignments?.find((entry) => entry.sectionId === section.id)?.teacherId
          addTeacherPeriods(alternate, alternateTeacherId || baseTeacherId, 1)
        }
        remaining -= blockLength
      }
    }
  }

  return { normal, alternate }
}

function addReservedSectionWorkload(totals, section) {
  for (const dayCells of Object.values(section.schedule ?? {})) {
    for (const cell of Object.values(dayCells ?? {})) {
      if (!cell?.teacherId) continue
      addTeacherPeriods(totals.normal, cell.teacherId, 1)
      addTeacherPeriods(totals.alternate, cell.alternateSubject?.teacherId || cell.teacherId, 1)
    }
  }
}

function mergeWorkloadTotals(target, source) {
  for (const [teacherId, periods] of source) {
    addTeacherPeriods(target, teacherId, periods)
  }
}

function teacherWorkloadViolations(totals, teacherNames) {
  const teacherIds = new Set([...totals.normal.keys(), ...totals.alternate.keys()])
  return [...teacherIds].flatMap((teacherId) => {
    const normalPeriods = totals.normal.get(teacherId) ?? 0
    const alternatePeriods = totals.alternate.get(teacherId) ?? 0
    const week = alternatePeriods > normalPeriods ? 'alternate' : 'normal'
    const assignedPeriods = Math.max(normalPeriods, alternatePeriods)
    if (assignedPeriods <= maximumTeacherWeeklyPeriods) return []
    return [{
      teacherId,
      teacherName: teacherNames.get(teacherId) ?? teacherId,
      assignedPeriods,
      maximum: maximumTeacherWeeklyPeriods,
      exceededAmount: assignedPeriods - maximumTeacherWeeklyPeriods,
      week,
    }]
  }).sort((left, right) => left.teacherId.localeCompare(right.teacherId))
}

function teacherWorkloadErrorMessage(violations) {
  const details = violations.map(({ teacherName, assignedPeriods, exceededAmount }) =>
    `${teacherName} is assigned ${assignedPeriods} periods, exceeding the weekly limit of ${maximumTeacherWeeklyPeriods} by ${exceededAmount} period${exceededAmount === 1 ? '' : 's'}.`)
  return `Teacher Workload Limit Exceeded:\n${details.join('\n')}\nReduce the teacher's assigned workload before generating.`
}

function activeSectionWorkloadKey(section) {
  return timetableSectionKey(section, section.sectionId)
}

function preflightTeacherWorkload({ configuration, reservedSections, activeSections, knownTeachers, randomPlacementAllocations }) {
  const identity = {
    department: configuration.department,
    year: configuration.year,
    semester: configuration.semester,
    academicYear: configuration.academicYear,
  }
  const candidateKeys = new Set(configuration.sections.map(({ id }) => timetableSectionKey(identity, id)))
  const reservedKeys = new Set(reservedSections
    .filter((section) => !candidateKeys.has(timetableSectionKey(section, section.sectionId)))
    .map((section) => timetableSectionKey(section, section.sectionId)))
  const replacedKeys = new Set([...candidateKeys, ...reservedKeys])
  const teacherNames = new Map((knownTeachers ?? []).map((teacher) => [
    teacher.id,
    teacher.canonicalName ?? teacher.name ?? teacher.id,
  ]))
  for (const teacher of configuration.staff ?? []) {
    if (teacher?.id) teacherNames.set(teacher.id, teacher.canonicalName ?? teacher.name ?? teacher.id)
  }
  const base = { normal: new Map(), alternate: new Map() }

  for (const section of activeSections ?? []) {
    for (const period of section.normal ?? []) {
      if (!teacherNames.has(period.teacherId) && period.teacherName) teacherNames.set(period.teacherId, period.teacherName)
    }
    for (const period of section.alternate ?? []) {
      if (!teacherNames.has(period.teacherId) && period.teacherName) teacherNames.set(period.teacherId, period.teacherName)
    }
    if (replacedKeys.has(activeSectionWorkloadKey(section))) continue
    for (const period of section.normal ?? []) {
      addTeacherPeriods(base.normal, period.teacherId, 1)
    }
    for (const period of section.alternate ?? []) {
      addTeacherPeriods(base.alternate, period.teacherId, 1)
    }
  }

  const countedReservedKeys = new Set()
  for (const section of reservedSections) {
    const key = timetableSectionKey(section, section.sectionId)
    if (candidateKeys.has(key) || countedReservedKeys.has(key)) continue
    countedReservedKeys.add(key)
    if (section.teacherNames && typeof section.teacherNames === 'object') {
      for (const [teacherId, name] of Object.entries(section.teacherNames)) {
        if (!teacherNames.has(teacherId) && name) teacherNames.set(teacherId, name)
      }
    }
    addReservedSectionWorkload(base, section)
  }

  const candidates = randomPlacementAllocations?.length ? randomPlacementAllocations : [configuration]
  const validCandidates = []
  let strongestViolation = []
  let strongestExceededAmount = -1
  for (const candidate of candidates) {
    const totals = { normal: new Map(base.normal), alternate: new Map(base.alternate) }
    const candidateTotals = configuredTeacherWorkload(candidate)
    mergeWorkloadTotals(totals.normal, candidateTotals.normal)
    mergeWorkloadTotals(totals.alternate, candidateTotals.alternate)
    const violations = teacherWorkloadViolations(totals, teacherNames)
    if (!violations.length) {
      validCandidates.push(candidate)
      continue
    }
    const exceededAmount = violations.reduce((sum, violation) => sum + violation.exceededAmount, 0)
    if (exceededAmount > strongestExceededAmount) {
      strongestExceededAmount = exceededAmount
      strongestViolation = violations
    }
  }

  return { validCandidates, violations: strongestViolation, teacherNames }
}

function canonicalizeGenerationInput(value) {
  if (Array.isArray(value)) return value.map(canonicalizeGenerationInput)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeGenerationInput(value[key])]))
  }
  return value
}

function generationFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(canonicalizeGenerationInput(input))).digest('hex')
}

function generationConflictMessage(conflicts) {
  return conflicts.map(({ teacherName, day, period, week, existing, candidate }) => [
    `Teacher: ${teacherName}`,
    `Conflict: ${day} P${period}${week === 'alternate' ? ' (alternate week)' : ''}`,
    `Existing: ${existing.department} · ${existing.year} · ${existing.semester} · Section ${existing.section} — ${existing.subject}`,
    `Candidate: ${candidate.department} · ${candidate.year} · ${candidate.semester} · Section ${candidate.section} — ${candidate.subject}`,
  ].join('\n'))
}

/** Same-origin JSON endpoints backed by the PostgreSQL timetable repository. */
export function createTimetableApiMiddleware(repository, {
  runGeneration = runGenericTimetableGeneration,
  maximumRetainedGenerationJobs = defaultMaximumRetainedGenerationJobs,
  generationJobRetentionMs = defaultGenerationJobRetentionMs,
} = {}) {
  const generationJobs = new Map()
  const activeGenerationFingerprints = new Map()

  const pruneGenerationJobs = () => {
    const now = Date.now()
    const expiredBefore = now - generationJobRetentionMs
    const unobservedExpiredBefore = now - Math.max(generationJobRetentionMs, defaultGenerationJobRetentionMs)
    for (const [jobId, job] of generationJobs) {
      const retentionExpired = job.firstPolledAt === undefined
        ? job.finishedAt < unobservedExpiredBefore
        : job.firstPolledAt < expiredBefore
      if (job.status !== 'queued' && job.status !== 'running' && retentionExpired) {
        generationJobs.delete(jobId)
        if (activeGenerationFingerprints.get(job.fingerprint) === jobId) {
          activeGenerationFingerprints.delete(job.fingerprint)
        }
      }
    }
  }

  const runGenerationJob = async (job, { configuration, reservedSections, identity, occupancyStaff, placementAllocations }) => {
    job.status = 'running'
    job.startedAt = Date.now()
    logGenerationEvent('GENERATION_JOB_STARTED', {
      jobId: job.id,
      requestFingerprint: job.fingerprint,
      elapsedMs: job.startedAt - job.createdAt,
      status: job.status,
    })
    try {
      const maximumAttempts = 8
      let lastOccupancyConflicts = []

      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const occupancy = await repository.getTeacherUnavailableOccupancy({
          identity,
          staff: occupancyStaff,
        })
        const generated = await runGeneration({
          configuration,
          reservedSections,
          ...(placementAllocations ? { placementAllocations } : {}),
          unavailableTeacherSlots: occupancy.unavailableSlots,
          alternateWeekUnavailableTeacherSlots: occupancy.alternateWeekUnavailableSlots,
          generationJobId: job.id,
          requestFingerprint: job.fingerprint,
          generationStartedAt: job.startedAt,
        })
        logGenerationEvent('SCHEDULER_RESULT_RECEIVED', {
          jobId: job.id,
          requestFingerprint: job.fingerprint,
          elapsedMs: Date.now() - job.startedAt,
          resultOk: generated?.result?.ok === true,
        })
        if (!generated?.result || typeof generated.result.ok !== 'boolean') {
          throw new Error('The timetable scheduler returned an invalid response.')
        }
        if (!generated.result.ok) {
          job.value = { result: generated.result }
          job.status = 'completed'
          job.finishedAt = Date.now()
          logGenerationEvent('GENERATION_JOB_COMPLETED', {
            jobId: job.id,
            requestFingerprint: job.fingerprint,
            elapsedMs: job.finishedAt - job.startedAt,
            resultOk: false,
            status: job.status,
          })
          return
        }

        lastOccupancyConflicts = await repository.getTeacherGenerationOccupancyConflicts({
          identity,
          sections: generated.result.sections,
          staff: occupancyStaff,
        })
        if (lastOccupancyConflicts.length === 0) {
          job.value = {
            result: generated.result,
            ...(generated.placementException ? { placementException: generated.placementException } : {}),
          }
          job.status = 'completed'
          job.finishedAt = Date.now()
          logGenerationEvent('GENERATION_JOB_COMPLETED', {
            jobId: job.id,
            requestFingerprint: job.fingerprint,
            elapsedMs: job.finishedAt - job.startedAt,
            resultOk: true,
            sectionCount: generated.result.sections.length,
            status: job.status,
          })
          return
        }
      }

      job.value = {
        result: {
          ok: false,
          code: 'UNSATISFIABLE',
          message: 'Every generated candidate conflicts with a saved timetable teacher assignment.',
          blockingConstraints: generationConflictMessage(lastOccupancyConflicts),
        },
      }
      job.status = 'completed'
      logGenerationEvent('GENERATION_JOB_COMPLETED', {
        jobId: job.id,
        requestFingerprint: job.fingerprint,
        elapsedMs: Date.now() - job.startedAt,
        resultOk: false,
        status: job.status,
      })
    } catch (error) {
      job.error = {
        message: error instanceof Error ? error.message : 'The timetable generation service failed.',
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      }
      job.status = 'failed'
      logGenerationEvent('GENERATION_JOB_FAILED', {
        jobId: job.id,
        requestFingerprint: job.fingerprint,
        elapsedMs: Date.now() - job.startedAt,
        status: job.status,
        code: job.error.code ?? 'UNKNOWN',
      })
    } finally {
      job.finishedAt = Date.now()
      if (activeGenerationFingerprints.get(job.fingerprint) === job.id) {
        activeGenerationFingerprints.delete(job.fingerprint)
      }
    }
  }

  return async (request, response, next) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const pathname = url.pathname.replace(/^\/api(?=\/|$)/, '')
    try {
      if (request.method === 'POST' && pathname === '/timetable/generate') {
        const requestReceivedAt = Date.now()
        const body = await readJsonBody(request, 'generation request')
        const { configuration, reservedSections = [] } = body ?? {}
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
          || !Array.isArray(reservedSections)) {
          sendJson(response, 400, { error: 'A scheduler configuration and reserved sections are required.' })
          return
        }
        const identity = generationIdentity(configuration)
        const occupancyStaff = generationStaff(configuration)
        const fingerprint = generationFingerprint({ configuration, reservedSections })
        logGenerationEvent('GENERATION_REQUEST_RECEIVED', {
          requestFingerprint: fingerprint,
          elapsedMs: Date.now() - requestReceivedAt,
        })
        pruneGenerationJobs()
        const existingJobId = activeGenerationFingerprints.get(fingerprint)
        const existingJob = existingJobId ? generationJobs.get(existingJobId) : undefined
        if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
          sendJson(response, 202, { jobId: existingJobId })
          return
        }
        if (existingJobId) activeGenerationFingerprints.delete(fingerprint)
        let randomPlacementAllocations
        const randomPlacement = configuration.placementException?.enabled
          && configuration.placementException.allocationMode === 'random'
        if (randomPlacement) {
          randomPlacementAllocations = []
          for (let attempt = 0; attempt < randomPlacementAllocationAttempts; attempt += 1) {
            const allocation = randomizeGenericPlacementAlternates(configuration)
            if (allocation.issues.length) {
              randomPlacementAllocations = undefined
              break
            }
            randomPlacementAllocations.push(allocation.config)
          }
        }
        const [activeSections, knownTeachers] = await Promise.all([
          repository.getActiveTeacherWeeklyWorkloadSections?.() ?? [],
          repository.getTeachers?.() ?? [],
        ])
        const workload = preflightTeacherWorkload({
          configuration,
          reservedSections,
          activeSections,
          knownTeachers,
          randomPlacementAllocations,
        })
        if (!workload.validCandidates.length) {
          logGenerationEvent('TEACHER_WORKLOAD_LIMIT_REJECTED', {
            requestFingerprint: fingerprint,
            violations: workload.violations.length,
          })
          sendJson(response, 422, {
            error: teacherWorkloadErrorMessage(workload.violations),
            code: 'TEACHER_WORKLOAD_LIMIT_EXCEEDED',
            workloadViolations: workload.violations,
          })
          return
        }
        if (generationJobs.size >= maximumRetainedGenerationJobs) {
          sendJson(response, 503, {
            error: 'The generation job registry is at capacity. Please try again shortly.',
            code: 'SCHEDULER_CAPACITY',
          })
          return
        }
        const jobId = randomUUID()
        const job = { id: jobId, fingerprint, status: 'queued', createdAt: Date.now() }
        generationJobs.set(jobId, job)
        activeGenerationFingerprints.set(fingerprint, jobId)
        logGenerationEvent('GENERATION_JOB_CREATED', {
          jobId,
          requestFingerprint: fingerprint,
          elapsedMs: job.createdAt - requestReceivedAt,
          status: job.status,
        })
        sendJson(response, 202, { jobId })
        setImmediate(() => {
          void runGenerationJob(job, {
            configuration,
            reservedSections,
            identity,
            occupancyStaff,
            ...(randomPlacement && randomPlacementAllocations
              ? { placementAllocations: workload.validCandidates }
              : {}),
          })
        })
        return
      }

      const acceptedGenerationJobMatch = pathname.match(/^\/timetable\/generation-jobs\/([0-9a-f-]{36})\/accepted$/i)
      if (request.method === 'POST' && acceptedGenerationJobMatch) {
        pruneGenerationJobs()
        const job = generationJobs.get(acceptedGenerationJobMatch[1])
        if (!job) {
          sendJson(response, 404, { error: 'That timetable generation request was not found.' })
          return
        }
        if (job.status !== 'completed' || job.value?.result?.ok !== true) {
          sendJson(response, 409, { error: 'Only a completed, valid timetable generation can be acknowledged.' })
          return
        }
        if (!job.frontendResultAcceptedAt) {
          job.frontendResultAcceptedAt = Date.now()
          logGenerationEvent('FRONTEND_RESULT_ACCEPTED', {
            jobId: job.id,
            requestFingerprint: job.fingerprint,
            elapsedMs: job.frontendResultAcceptedAt - job.createdAt,
            resultOk: true,
            sectionCount: job.value.result.sections.length,
            status: job.status,
          })
        }
        sendJson(response, 200, { accepted: true })
        return
      }

      const generationJobMatch = pathname.match(/^\/timetable\/generation-jobs\/([0-9a-f-]{36})$/i)
      if (request.method === 'GET' && generationJobMatch) {
        pruneGenerationJobs()
        const job = generationJobs.get(generationJobMatch[1])
        if (!job) {
          sendJson(response, 404, { error: 'That timetable generation request was not found.' })
          return
        }
        if (job.status === 'completed' && job.firstPolledAt === undefined) job.firstPolledAt = Date.now()
        sendJson(response, 200, {
          status: job.status,
          ...(job.value ? { value: job.value } : {}),
          ...(job.error ? { error: job.error.message, code: job.error.code } : {}),
        })
        if (job.status === 'completed') {
          logGenerationEvent('FRONTEND_POLL_COMPLETED', {
            jobId: job.id,
            requestFingerprint: job.fingerprint,
            elapsedMs: Date.now() - (job.createdAt ?? job.finishedAt),
            resultOk: job.value?.result?.ok === true,
          })
        }
        return
      }

      if (request.method === 'GET' && pathname === '/timetable-versions') {
        const identity = identityFromQuery(url)
        const versions = (await repository.getSavedTimetableNavigation()).filter((version) =>
          version.department === identity.department && version.year === identity.year
          && version.semester === identity.semester && version.academicYear === identity.academicYear)
        sendJson(response, 200, { versions })
        return
      }

      const versionMatch = pathname.match(/^\/timetable-versions\/([^/]+)(?:\/(lock|unlock))?$/)
      if (versionMatch && request.method === 'GET' && !versionMatch[2]) {
        const savedVersion = await repository.getSavedTimetableVersion(decodeURIComponent(versionMatch[1]))
        if (!savedVersion) {
          sendJson(response, 404, { error: 'That saved timetable version was not found.' })
          return
        }
        sendJson(response, 200, savedVersion)
        return
      }

      if (versionMatch && request.method === 'POST' && versionMatch[2]) {
        const versionId = decodeURIComponent(versionMatch[1])
        const status = versionMatch[2] === 'lock' ? 'LOCKED' : 'SAVED'
        const savedTimetableVersion = await repository.setSavedTimetableVersionStatus({ versionId, status })
        const savedVersion = (await repository.getSavedTimetableNavigation()).find((version) => version.versionId === versionId)
        sendJson(response, 200, { versionId, savedTimetableVersion, savedVersion })
        return
      }

      if (request.method === 'DELETE' && versionMatch && !versionMatch[2]) {
        const deletedVersion = await repository.deleteSavedTimetableVersion({
          versionId: decodeURIComponent(versionMatch[1]),
        })
        sendJson(response, 200, { deletedVersion })
        return
      }

      if (request.method === 'GET' && pathname === '/saved-timetables') {
        sendJson(response, 200, { timetables: await repository.getSavedTimetableNavigation() })
        return
      }

      if (request.method === 'POST' && pathname === '/timetable-conflicts') {
        const body = await readJsonBody(request)
        const { identity, sections, staff } = body ?? {}
        if (!identity || !Array.isArray(sections) || !Array.isArray(staff)
          || ['department', 'year', 'semester', 'academicYear'].some((field) => !String(identity[field] ?? '').trim())) {
          sendJson(response, 400, { error: 'Timetable identity, candidate sections and staff identities are required for the saved-occupancy check.' })
          return
        }
        const conflicts = await repository.getTeacherGenerationOccupancyConflicts({ identity, sections, staff })
        sendJson(response, 200, { conflicts })
        return
      }

      if (request.method === 'POST' && pathname === '/timetable-teacher-occupancy') {
        const body = await readJsonBody(request)
        const { identity, staff } = body ?? {}
        if (!identity || !Array.isArray(staff)
          || ['department', 'year', 'semester', 'academicYear'].some((field) => !String(identity[field] ?? '').trim())
          || staff.some((teacher) => !teacher || !String(teacher.id ?? '').trim() || !String(teacher.name ?? teacher.canonicalName ?? '').trim())) {
          sendJson(response, 400, { error: 'Timetable identity and candidate staff identities are required for the saved-occupancy lookup.' })
          return
        }
        const occupancy = await repository.getTeacherUnavailableOccupancy({ identity, staff })
        sendJson(response, 200, occupancy)
        return
      }

      if (request.method === 'POST' && pathname === '/timetable-versions') {
        const body = await readJsonBody(request)
        const { configuration, generationId, sections, setupSnapshot, validation } = body ?? {}
        if (!configuration || typeof configuration !== 'object' || typeof generationId !== 'string' || !generationId.trim()
          || !Array.isArray(configuration.sections) || !Array.isArray(configuration.staff)
          || !Array.isArray(sections) || !setupSnapshot || typeof setupSnapshot !== 'object'
          || !validation || typeof validation !== 'object') {
          sendJson(response, 400, { error: 'A generated timetable, configuration snapshot and generation ID are required.' })
          return
        }
        const identityFields = ['department', 'year', 'semester', 'academicYear']
        if (identityFields.some((field) => !String(configuration[field] ?? '').trim())) {
          sendJson(response, 400, { error: 'Department, year, semester and academic year are required for a saved timetable.' })
          return
        }
        const identity = {
          department: configuration.department,
          year: configuration.year,
          semester: configuration.semester,
          academicYear: configuration.academicYear,
          configurationVersion: configuration.configurationVersion ?? 1,
        }
        if (!setupSnapshot.academic || identityFields.some((field) => setupSnapshot.academic[field] !== identity[field])) {
          sendJson(response, 400, { error: 'The saved setup snapshot must match the timetable department, year, semester and academic year.' })
          return
        }
        if (setupArrayFields.some((field) => !Array.isArray(setupSnapshot[field]))) {
          sendJson(response, 400, { error: 'The saved setup snapshot is incomplete and cannot be reopened safely.' })
          return
        }
        const configuredSectionIds = configuration.sections.map((section) => String(section?.id ?? '').trim())
        if (configuredSectionIds.some((id) => !id) || new Set(configuredSectionIds).size !== configuredSectionIds.length) {
          sendJson(response, 400, { error: 'Configured section IDs must be present and unique.' })
          return
        }
        const requiredSectionIds = new Set(configuredSectionIds)
        const suppliedSectionIds = sections.map((section) => String(section.sectionId))
        if (!requiredSectionIds.size || suppliedSectionIds.length !== requiredSectionIds.size
          || new Set(suppliedSectionIds).size !== suppliedSectionIds.length
          || suppliedSectionIds.some((id) => !requiredSectionIds.has(id))) {
          sendJson(response, 400, { error: 'The saved timetable must include every configured section exactly once.' })
          return
        }
        const setupSectionIds = setupSnapshot.sections.map((section) => String(section?.id ?? '').trim())
        if (setupSectionIds.length !== requiredSectionIds.size || new Set(setupSectionIds).size !== setupSectionIds.length
          || setupSectionIds.some((id) => !requiredSectionIds.has(id))) {
          sendJson(response, 400, { error: 'The saved setup snapshot must include every configured section exactly once.' })
          return
        }
        const configuredTeacherIds = configuration.staff.map((teacher) => String(teacher?.id ?? '').trim())
        if (configuredTeacherIds.some((id) => !id)
          || new Set(configuredTeacherIds).size !== configuredTeacherIds.length
          || configuration.staff.some((teacher) => !String(teacher?.canonicalName ?? teacher?.name ?? '').trim())) {
          sendJson(response, 400, { error: 'Configured teacher IDs and names must be present and unique.' })
          return
        }
        const knownTeacherIds = new Set(configuredTeacherIds)
        for (const section of sections) {
          for (const field of identityFields) {
            if (section[field] !== undefined && section[field] !== identity[field]) {
              sendJson(response, 400, { error: `Section ${section.sectionId} has mismatched ${field} metadata.` })
              return
            }
          }
          const schedule = section.schedule
          if (!schedule || typeof schedule !== 'object' || Object.keys(schedule).length !== supportedDays.length
            || supportedDays.some((day) => !Object.hasOwn(schedule, day))) {
            sendJson(response, 400, { error: `Section ${section.sectionId} must include all six timetable days.` })
            return
          }
          for (const day of supportedDays) {
            const dayCells = schedule[day]
            if (!dayCells || typeof dayCells !== 'object' || Object.keys(dayCells).length !== 8
              || Array.from({ length: 8 }, (_, index) => String(index + 1)).some((period) => !Object.hasOwn(dayCells, period))) {
              sendJson(response, 400, { error: `Section ${section.sectionId} ${day} must include periods 1 through 8 exactly once.` })
              return
            }
            for (const [period, cell] of Object.entries(dayCells)) {
              if (!cell || typeof cell !== 'object' || !String(cell.itemId ?? '').trim()
                || !String(cell.name ?? '').trim() || !String(cell.abbreviation ?? '').trim()
                || !knownTeacherIds.has(String(cell.teacherId ?? '').trim())
                || !['core', 'other', 'lab', 'activity'].includes(cell.kind)) {
                sendJson(response, 400, { error: `Section ${section.sectionId} ${day} P${period} has incomplete timetable data or an unknown teacher.` })
                return
              }
            }
          }
          if (Object.values(schedule).reduce((count, day) => count + Object.keys(day).length, 0) !== 48) {
            sendJson(response, 400, { error: `Section ${section.sectionId} must contain exactly 48 occupied student periods before saving.` })
            return
          }
        }

        const saveResult = await repository.withSaveTransaction(async () => {
          let configurationId = await repository.getTimetableConfigurationByIdentity(identity)
          if (!configurationId) configurationId = await repository.createTimetableConfiguration(configuration)

          // A retried request after a lost response is safe and cannot make a
          // duplicate version for the same generation.
          const existing = await repository.getSavedGeneration(generationId, configurationId)
          const existingSectionIds = new Set((existing?.sections ?? []).map((section) => section.sectionId))
          if (existing && [...requiredSectionIds].some((sectionId) => !existingSectionIds.has(sectionId))) {
            return { statusCode: 409, payload: { error: 'This generation has saved versions for only some sections and cannot be safely retried. Generate and save a new version.' } }
          }
          if (existing?.versions.some((version) => version.status === 'LOCKED')) {
            return { statusCode: 409, payload: { error: 'This timetable version is locked and cannot be overwritten. Generate and save a new version instead.' } }
          }
          if (!existing) {
            await repository.saveGeneratedTimetableData({
              configurationId,
              generationId,
              sections,
              validation,
              setupSnapshot,
              staff: configuration.staff,
            })
          }
          const versions = await repository.getSavedGenerationSummaries(identity)
          const savedVersion = versions.find((version) => version.generationId === generationId)
          const timetableVersions = (await repository.getSavedTimetableNavigation()).filter((version) =>
            version.department === identity.department && version.year === identity.year
            && version.semester === identity.semester && version.academicYear === identity.academicYear)
          return {
            statusCode: existing ? 200 : 201,
            payload: { configurationId, generationId, savedVersion, versions, timetableVersions },
          }
        })
        sendJson(response, saveResult.statusCode, saveResult.payload)
        return
      }

      next?.()
    } catch (error) {
      if (error?.code === 'SCHEDULER_CAPACITY' || error?.code === 'SCHEDULER_UNAVAILABLE') {
        sendJson(response, 503, { error: error.message, code: error.code })
        return
      }
      if (error?.code === 'SCHEDULER_WORKER_FAILED') {
        console.error('Timetable scheduler worker failed:', error)
        sendJson(response, 500, { error: 'The timetable scheduler worker failed. Please try again.', code: error.code })
        return
      }
      const conflict = /locked|unlock|cannot be changed|cannot be deleted|inconsistent section version states/i.test(error?.message ?? '')
      const notFound = /was not found/i.test(error?.message ?? '')
      if (error?.code === 'TEACHER_OCCUPANCY_CONFLICT') {
        sendJson(response, 409, { error: error.message, conflicts: error.conflicts ?? [] })
        return
      }
      const clientError = error instanceof SyntaxError || /required|invalid|unknown|already been saved|must contain|must include|only SAVED|too large|not valid JSON/i.test(error?.message ?? '')
      const statusCode = notFound ? 404 : conflict ? 409
        : clientError || error?.code === 'INVALID_TIMETABLE_DATA' ? 400 : 500
      if (statusCode === 500) console.error('Timetable API request failed:', error)
      sendJson(response, statusCode, {
        error: statusCode === 500 ? 'The timetable request could not be completed.'
          : error instanceof Error ? error.message : 'The timetable could not be saved or loaded.',
      })
    }
  }
}
