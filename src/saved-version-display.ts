/** Format a stored timestamp for saved-version UI using the user's local timezone. */
export function formatSavedVersionTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return timestamp

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date)
  const timeLabel = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date)
  return `${dateLabel}, ${timeLabel}`
}
