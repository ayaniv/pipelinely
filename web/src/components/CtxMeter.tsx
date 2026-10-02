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
  testIds?: CtxMeterTestIds
}

export function CtxMeter({ ctx, testIds }: CtxMeterProps) {
  const hot = ctxIsHot(ctx)
  return (
    <>
      <span className="card-ctx-label" data-testid="card-ctx-label">ctx</span>
      <div className="card-ctx-track" data-testid={testIds?.track} style={{ background: hot ? 'var(--amberSoft)' : 'var(--surface2)' }}>
        <div className="card-ctx-fill" data-testid={testIds?.fill} style={{ width: ctx === null ? '0%' : `${ctx}%`, background: hot ? 'var(--amber)' : 'var(--accent)' }} />
      </div>
      <span className="card-ctx-pct" data-testid={testIds?.pct} style={{ color: hot ? 'var(--amberInk)' : 'var(--text2)' }}>
        {ctx === null ? '—' : `${ctx}%`}
      </span>
    </>
  )
}
