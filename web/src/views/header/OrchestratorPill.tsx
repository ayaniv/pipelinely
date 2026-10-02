import { postOrchestratorHandover, postOrchestratorTab, type PostActionOptions } from '../../api/actions'
import { CtxMeter, ctxIsHot } from '../../components/CtxMeter'
import { HandoverPill } from '../../components/HandoverPill'
import { HomeIcon } from '../../components/icons'
import { useActionFlash } from '../../components/useActionFlash'
import { READ_ONLY_INSTANCE_TITLE } from '../../components/readOnly'

// The header's merged home/ctx/Handover control (Claude Design v3, Pipelinely
// Dashboard v3.dc.html lines 126-138). The design wraps the home icon, "ctx"
// label, meter and percentage in ONE clickable link — there is no separate
// home segment — so the button carries all four as its flex children. The
// home affordance is a navigation control, not something ctx should gate, so
// it always renders — unlike the meter and Handover segments beside it, which
// stay conditional on ctx being known and hot respectively. ctx === null
// means no ORCHESTRATOR_METRICS file (no orchestrator running, which is
// normal), so only the meter trio is skipped rather than showing a
// misleading 0%.

export interface OrchestratorPillProps extends Partial<PostActionOptions> {
  ctx: number | null
  isCanonical: boolean
}

export function OrchestratorPill({ ctx, isCanonical, fetchImpl = fetch, log = console.error }: OrchestratorPillProps) {
  const { flash, showOutcome, isPending, run } = useActionFlash()

  // aria-label overrides the button's accessible name entirely, so without
  // the ctx value folded in here a screen-reader user tabbing to this control
  // would lose the "ctx N%" information nested inside it.
  const homeLabel = `Bring back the orchestrator tab${ctx !== null ? ` (context ${ctx}%)` : ''}`
  const isFlashing = flash.label !== null

  const handleHomeClick = () => run(async () => {
    const result = await postOrchestratorTab({ fetchImpl, log })
    showOutcome(result)
  })

  return (
    <div className="header-pill header-ctx" data-testid="header-ctx">
      <button
        type="button"
        className={['header-ctx-home', flash.className, isFlashing ? 'is-flashing' : ''].filter(Boolean).join(' ')}
        id="orchestrator-tab-btn"
        data-testid="orchestrator-tab-btn"
        aria-label={homeLabel}
        disabled={!isCanonical || isPending}
        title={isCanonical ? undefined : READ_ONLY_INSTANCE_TITLE}
        onClick={handleHomeClick}
      >
        <HomeIcon className="header-ctx-home-icon" testId="header-ctx-home-icon" />
        {ctx !== null && (
          <span className="header-ctx-body" data-testid="header-ctx-body">
            <CtxMeter ctx={ctx} testIds={{ track: 'header-ctx-meter', fill: 'header-ctx-fill', pct: 'header-ctx-value' }} />
          </span>
        )}
        <span className="header-ctx-home-status" data-testid="orchestrator-tab-status" hidden={!isFlashing}>{flash.label}</span>
      </button>
      {ctxIsHot(ctx) && <HandoverPill testId="header-handover" send={postOrchestratorHandover} fetchImpl={fetchImpl} log={log} />}
    </div>
  )
}
