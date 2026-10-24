// A group's heading (label, count, rule), shared by the card and table views
// and the Parent tasks section.
export function ActiveGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="active-group-header" data-testid="active-group-header">
      <span className="active-group-label">{label}</span>
      <span className="active-group-count" data-testid="active-group-count">&middot; {count}</span>
      <span className="active-group-rule" />
    </div>
  )
}
