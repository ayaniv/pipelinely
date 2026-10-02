// The design's top-bar "spent today" pill — org-level, so it is driven by
// every active task, not the board's own project/state-filtered subset.
export function SpendPill({ spend }: { spend: number }) {
  return (
    <div className="header-pill header-spend" data-testid="header-spend">
      <span className="header-spend-value" id="header-spend-value">${spend.toFixed(2)}</span>
      <span className="header-spend-label">spent today</span>
    </div>
  )
}
