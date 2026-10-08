import type { CollegeBreakDefinition, CollegePeriodTiming, CollegeTimingMode, CollegeTimings } from './college-timings.ts'
import { calculateCollegeTimings, collegeWeekdays, validateCollegeTimings } from './college-timings.ts'

interface CollegeTimingsPanelProps {
  value: CollegeTimings
  onChange: (value: CollegeTimings) => void
}

function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function formatDuration(totalMinutes: number | null): string {
  if (totalMinutes === null) return '—'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours} hr ${minutes} min` : `${minutes} min`
}

function numberInputValue(value: string): number {
  return value.trim() ? Number(value) : 0
}

function customRowsForCount(rows: readonly CollegePeriodTiming[] | undefined, count: number): CollegePeriodTiming[] {
  const current = new Map((rows ?? []).map((row) => [row.period, row]))
  return Array.from({ length: Number.isSafeInteger(count) && count > 0 ? count : 0 }, (_, index) =>
    current.get(index + 1) ?? { period: index + 1, startTime: '', endTime: '' })
}

export function CollegeTimingsPanel({ value, onChange }: CollegeTimingsPanelProps) {
  const issues = validateCollegeTimings(value)
  const derived = issues.length === 0 ? calculateCollegeTimings(value) : null
  const regularBreaks = value.breaks.filter((entry) => entry.kind === 'break')
  const lunch = value.breaks.find((entry) => entry.kind === 'lunch')
  const firstPeriod = derived?.periodTimings[0]
  const lastPeriod = derived?.periodTimings.at(-1)
  const dailyDuration = firstPeriod && lastPeriod
    ? minutesFromTime(lastPeriod.endTime) - minutesFromTime(firstPeriod.startTime)
    : null
  const weeklyDuration = dailyDuration === null ? null : dailyDuration * value.workingWeekdays.length
  const weeklyCapacity = derived?.weeklyCapacity ?? '—'

  const updateBreak = (target: CollegeBreakDefinition, patch: Partial<CollegeBreakDefinition>) => {
    onChange({
      ...value,
      breaks: value.breaks.map((entry) => entry === target ? { ...entry, ...patch } : entry),
    })
  }

  const updateLunch = (patch: Partial<CollegeBreakDefinition>) => {
    onChange({
      ...value,
      breaks: value.breaks.map((entry) => entry.kind === 'lunch' ? { ...entry, ...patch } : entry),
    })
  }

  const updatePeriodCount = (periodsPerDay: number) => {
    onChange({
      ...value,
      periodsPerDay,
      ...(value.timingMode === 'custom'
        ? { customPeriodTimings: customRowsForCount(value.customPeriodTimings, periodsPerDay) }
        : {}),
    })
  }

  const updateWorkingDayCount = (requestedCount: number) => {
    if (!Number.isFinite(requestedCount)) return
    const count = Math.max(1, Math.min(collegeWeekdays.length, Math.trunc(requestedCount)))
    const selected = new Set(value.workingWeekdays)
    const nextWorkingWeekdays = collegeWeekdays.filter((weekday) => selected.has(weekday))

    if (count < nextWorkingWeekdays.length) {
      nextWorkingWeekdays.splice(count)
    } else {
      for (const weekday of collegeWeekdays) {
        if (nextWorkingWeekdays.length >= count) break
        if (!selected.has(weekday)) nextWorkingWeekdays.push(weekday)
      }
    }

    onChange({ ...value, workingWeekdays: nextWorkingWeekdays })
  }

  const updateTimingMode = (timingMode: CollegeTimingMode) => {
    if (timingMode === 'automatic') {
      const { customPeriodTimings: _customPeriodTimings, ...automatic } = value
      onChange({ ...automatic, timingMode })
      return
    }

    const automaticValue = { ...value, timingMode: 'automatic' as const }
    const automaticIssues = validateCollegeTimings(automaticValue)
    const automaticRows = automaticIssues.length === 0
      ? calculateCollegeTimings(automaticValue).periodTimings
      : []
    onChange({
      ...value,
      timingMode,
      customPeriodTimings: customRowsForCount(automaticRows.length ? automaticRows : value.customPeriodTimings, value.periodsPerDay),
    })
  }

  const updateCustomPeriod = (period: number, patch: Partial<CollegePeriodTiming>) => {
    const customPeriodTimings = customRowsForCount(value.customPeriodTimings, value.periodsPerDay)
      .map((entry) => entry.period === period ? { ...entry, ...patch } : entry)
    onChange({
      ...value,
      ...(period === 1 && patch.startTime !== undefined ? { collegeStartTime: patch.startTime } : {}),
      customPeriodTimings,
    })
  }

  const addBreak = () => {
    const occupiedPositions = new Set(value.breaks.map((entry) => entry.afterPeriod))
    const afterPeriod = Array.from({ length: Math.max(0, value.periodsPerDay - 1) }, (_, index) => index + 1)
      .find((period) => !occupiedPositions.has(period))
    if (!afterPeriod) return
    const nextBreakNumber = regularBreaks.length + 1
    onChange({
      ...value,
      breaks: [...value.breaks, { kind: 'break', name: `Break ${nextBreakNumber}`, afterPeriod, durationMinutes: 10 }],
    })
  }

  const updateBreakCount = (requestedCount: number) => {
    const maximumCount = Math.max(0, value.periodsPerDay - 2)
    const count = Math.max(0, Math.min(Math.trunc(requestedCount), maximumCount))
    const nextBreaks = [...value.breaks]
    const currentRegularBreaks = nextBreaks.filter((entry) => entry.kind === 'break')

    if (count < currentRegularBreaks.length) {
      const removedBreaks = new Set(currentRegularBreaks.slice(count))
      for (let index = nextBreaks.length - 1; index >= 0; index -= 1) {
        if (removedBreaks.has(nextBreaks[index])) nextBreaks.splice(index, 1)
      }
    } else {
      const occupiedPositions = new Set(nextBreaks.map((entry) => entry.afterPeriod))
      for (let index = currentRegularBreaks.length; index < count; index += 1) {
        const afterPeriod = Array.from({ length: Math.max(0, value.periodsPerDay - 1) }, (_, position) => position + 1)
          .find((period) => !occupiedPositions.has(period))
        if (!afterPeriod) break
        occupiedPositions.add(afterPeriod)
        nextBreaks.push({ kind: 'break', name: `Break ${index + 1}`, afterPeriod, durationMinutes: 10 })
      }
    }

    onChange({ ...value, breaks: nextBreaks })
  }

  return <>
    <div className="field-grid">
      <label className="field"><span>Working Days</span><input aria-label="Working Days" type="number" min={1} max={collegeWeekdays.length} step={1} value={value.workingWeekdays.length} onChange={(event) => updateWorkingDayCount(numberInputValue(event.target.value))} /></label>
      <label className="field"><span>Periods Per Day</span><input aria-label="Periods Per Day" type="number" min={1} step={1} value={value.periodsPerDay} onChange={(event) => updatePeriodCount(numberInputValue(event.target.value))} /></label>
      <label className="field"><span>Period Duration (minutes)</span><input aria-label="Period Duration (minutes)" type="number" min={1} step={1} value={value.periodDurationMinutes} onChange={(event) => onChange({ ...value, periodDurationMinutes: numberInputValue(event.target.value) })} /></label>
      <label className="field"><span>College Start Time</span><input aria-label="College Start Time" type="time" value={value.collegeStartTime} onChange={(event) => onChange({ ...value, collegeStartTime: event.target.value })} /></label>
      <label className="field"><span>Break Count</span><input aria-label="Break Count" type="number" min={0} max={Math.max(0, value.periodsPerDay - 2)} step={1} value={regularBreaks.length} onChange={(event) => updateBreakCount(numberInputValue(event.target.value))} /></label>
      <label className="field"><span>Timing Mode</span><select aria-label="Timing Mode" value={value.timingMode} onChange={(event) => updateTimingMode(event.target.value as CollegeTimingMode)}>
        <option value="automatic">Automatic</option>
        <option value="custom">Custom</option>
      </select></label>
      <label className="field"><span>Teacher Maximum Weekly Teaching Periods</span><input aria-label="Teacher Maximum Weekly Teaching Periods" type="number" min={1} step={1} value={value.teacherMaximumWeeklyPeriods} onChange={(event) => onChange({ ...value, teacherMaximumWeeklyPeriods: numberInputValue(event.target.value) })} /></label>
      <label className="field"><span>Weekly Timetable Capacity</span><input aria-label="Weekly Timetable Capacity" value={weeklyCapacity} readOnly /></label>
      <label className="field"><span>Daily College Duration</span><input aria-label="Daily College Duration" value={formatDuration(dailyDuration)} readOnly /></label>
      <label className="field"><span>Weekly College Duration</span><input aria-label="Weekly College Duration" value={formatDuration(weeklyDuration)} readOnly /></label>
    </div>

    <fieldset className="check-group compact-grid">
      <legend>Working Weekday Selection</legend>
      {collegeWeekdays.map((day) => <label className="checkbox-label" key={day}>
        <input
          type="checkbox"
          checked={value.workingWeekdays.includes(day)}
          onChange={(event) => {
            const selected = new Set(value.workingWeekdays)
            if (event.target.checked) selected.add(day)
            else selected.delete(day)
            onChange({ ...value, workingWeekdays: collegeWeekdays.filter((weekday) => selected.has(weekday)) })
          }}
        />
        {day}
      </label>)}
    </fieldset>

    <section className="rule-group">
      <div className="rule-group-heading"><span>Break Definitions</span><span className="rule-badge optional">EXCLUDING LUNCH</span></div>
      {regularBreaks.length === 0 && <p className="field-hint">No additional breaks are configured.</p>}
      {regularBreaks.map((entry, index) => <div className="field-grid" key={`${index}-${entry.afterPeriod}`}>
        <label className="field"><span>Break {index + 1} Name</span><input aria-label={`Break ${index + 1} Name`} value={entry.name} onChange={(event) => updateBreak(entry, { name: event.target.value })} /></label>
        <label className="field"><span>Break {index + 1} After Period</span><input aria-label={`Break ${index + 1} After Period`} type="number" min={1} max={value.periodsPerDay - 1} step={1} value={entry.afterPeriod} onChange={(event) => updateBreak(entry, { afterPeriod: numberInputValue(event.target.value) })} /></label>
        <label className="field"><span>Break {index + 1} Duration (minutes)</span><input aria-label={`Break ${index + 1} Duration (minutes)`} type="number" min={1} step={1} value={entry.durationMinutes} onChange={(event) => updateBreak(entry, { durationMinutes: numberInputValue(event.target.value) })} /></label>
        <div className="field"><span aria-hidden="true">&nbsp;</span><button type="button" className="text-button" onClick={() => onChange({
          ...value,
          breaks: value.breaks.filter((candidate) => !(candidate.kind === 'break' && candidate === entry)),
        })}>Remove Break</button></div>
      </div>)}
      <button type="button" className="text-button" onClick={addBreak} disabled={value.periodsPerDay < 2 || value.breaks.length >= value.periodsPerDay - 1}>Add Break</button>
    </section>

    <section className="rule-group">
      <div className="rule-group-heading"><span>Lunch (exactly one)</span><span className="rule-badge hard">REQUIRED</span></div>
      {lunch && <div className="field-grid">
        <label className="field"><span>Lunch After Period</span><input aria-label="Lunch After Period" type="number" min={1} max={value.periodsPerDay - 1} step={1} value={lunch.afterPeriod} onChange={(event) => updateLunch({ afterPeriod: numberInputValue(event.target.value) })} /></label>
        <label className="field"><span>Lunch Duration (minutes)</span><input aria-label="Lunch Duration (minutes)" type="number" min={1} step={1} value={lunch.durationMinutes} onChange={(event) => updateLunch({ durationMinutes: numberInputValue(event.target.value) })} /></label>
      </div>}
    </section>

    {value.timingMode === 'custom'
      ? <section className="rule-group">
          <div className="rule-group-heading"><span>Custom Period Timings</span></div>
          <div className="field-grid">
            {customRowsForCount(value.customPeriodTimings, value.periodsPerDay).map((period) => <div className="section-card" key={period.period}>
              <strong>Period {period.period}</strong>
              <label className="field"><span>Start Time</span><input aria-label={`P${period.period} Start Time`} type="time" value={period.startTime} onChange={(event) => updateCustomPeriod(period.period, { startTime: event.target.value })} /></label>
              <label className="field"><span>End Time</span><input aria-label={`P${period.period} End Time`} type="time" value={period.endTime} onChange={(event) => updateCustomPeriod(period.period, { endTime: event.target.value })} /></label>
            </div>)}
          </div>
        </section>
      : <section className="rule-group">
          <div className="rule-group-heading"><span>Automatic Period Timings</span></div>
          {derived && <div className="table-wrap timing-table"><table><thead><tr><th>Period</th><th>Start</th><th>End</th></tr></thead><tbody>
            {derived.periodTimings.map((period) => <tr key={period.period}><td>P{period.period}</td><td>{period.startTime}</td><td>{period.endTime}</td></tr>)}
          </tbody></table></div>}
        </section>}

    {issues.map((issue) => <p className="validation-error" role="alert" key={issue}>{issue}</p>)}
    <p className="field-hint">College Timings are held in this section’s configuration state only. They are not connected to generation yet.</p>
  </>
}
