// The design's single empty-state card, shared by every board tab and every
// reason a tab can be empty (nothing at all, or nothing matching the current
// project filter).
export function EmptyState() {
  return <div className="board-empty-state" data-testid="board-empty-state">Nothing here in the selected projects.</div>
}
