// 'YYYY-MM-DD' in local time (not UTC) — grouping follows the developer's own
// calendar day, not a timezone offset from it. Shared by the server (the Done
// tab's date groups, and POST /shelve/:slug which dates the BACKLOG.md entry it
// writes the same way) and the dashboard client (the You tab's heatmap cells).
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
