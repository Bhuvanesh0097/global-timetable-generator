import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodeTest from 'node:test'
import { formatSavedVersionTimestamp } from '../src/saved-version-display.ts'

nodeTest('saved version timestamps show local dates and AM/PM times for multiple versions', () => {
  const versions = [
    { versionId: 'version-a', createdAt: '2026-10-05T09:13:27.629Z' },
    { versionId: 'version-b', createdAt: '2026-10-05T20:05:00.000Z' },
  ]
  const displayValues = versions.map(({ createdAt }) => formatSavedVersionTimestamp(createdAt))
  const expectedValues = versions.map(({ createdAt }) => {
    const date = new Date(createdAt)
    const dateLabel = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }).format(date)
    const timeLabel = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(date)
    return `${dateLabel}, ${timeLabel}`
  })

  assert.deepEqual(displayValues, expectedValues)
  assert.equal(displayValues.length, 2)
  for (const displayValue of displayValues) {
    assert.match(displayValue, /^\d{2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} (AM|PM)$/)
    assert.doesNotMatch(displayValue, /T\d{2}:\d{2}/)
  }
  assert.deepEqual(versions.map(({ versionId }) => versionId), ['version-a', 'version-b'])
})

nodeTest('saved version selector and sidebar present the formatted timestamp without changing version lookup', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.match(app, /title=\{`\$\{version\.status\} · \$\{formatSavedVersionTimestamp\(version\.createdAt\)\}`\}/)
  assert.match(app, /Version \{version\.versionNumber\} · Section \{version\.sectionName\} · \{formatSavedVersionTimestamp\(version\.createdAt\)\}/)
  assert.match(app, /onClick=\{\(\) => void openSavedTimetableVersion\(version\.versionId\)\}/)
})
