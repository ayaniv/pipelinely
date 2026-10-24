// The label+track+pct trio a ctx row always opens with, shared by the session card,
// the milestone card and the task-detail header, so the hot/cold coloring
// rule lives in exactly one place.

// The design's one hot-context rule, applied at every meter (top bar, card,
// task-detail header, checklist row).
const CTX_HOT_THRESHOLD = 60

export function ctxIsHot(ctx: number | null): boolean {
  return ctx !== null && ctx > CTX_HOT_THRESHOLD
}

export interface CtxMeterTestIds {
  track?: string
  fill?: string
  pct?: string
}

export interface CtxMeterProps {
  ctx: number | null
  // The fill's colour, when the meter carries a stage tone; otherwise it is
  // amber when hot and the accent when not. A stage-toned meter (card, table
  // row) also keeps its surface2 track when hot, as in the design.
  fillColor?: string
  testIds?: CtxMeterTestIds
  // Off where a column header already names the meter (the Active table's Ctx column).
  isLabelled?: boolean
}

export function CtxMeter({ ctx, fillColor, testIds, isLabelled = true }: CtxMeterProps) {
  const hot = ctxIsHot(ctx)
  return (
    <>
      {isLabelled && <span className="card-ctx-label" data-testid="card-ctx-label">ctx</span>}
      <div className="card-ctx-track" data-testid={testIds?.track} style={{ background: hot && !fillColor ? 'var(--amberSoft)' : 'var(--surface2)' }}>
        <div className="card-ctx-fill" data-testid={testIds?.fill} style={{ width: ctx === null ? '0%' : `${ctx}%`, background: fillColor ?? (hot ? 'var(--amber)' : 'var(--accent)') }} />
      </div>
      <span className="card-ctx-pct" data-testid={testIds?.pct} style={{ color: hot ? 'var(--amberInk)' : 'var(--text2)' }}>
        {ctx === null ? '—' : `${ctx}%`}
      </span>
    </>
  )
}
