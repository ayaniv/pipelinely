import { CTX_WARN_THRESHOLD, costClass, costIsHigh, formatTokens, modelClass, modelShort } from '../format'
import { scopeTotals, type Scope } from '../taskScope'

// The stat tiles every scope (a task, a fan-out roll-up, one milestone) shows,
// drawn from one scope value so the numbers can never disagree between
// surfaces: StatGrid is the CTX/SESS/Model/Tokens/Cost grid (the wave
// overview's project summary), InlineCardMetrics the compact TOK/COST pair on
// a milestone card's footer row.

export interface StatGridProps {
  scope: Scope
  // The caller's own call: pass true only for a live surface. Even then the
  // CTX number only turns warning-coloured when the scope's CTX is LIVE and
  // past the warn threshold — a high number left over from a session that
  // already ended needs nobody's attention.
  allowWarn?: boolean
}

export function StatGrid({ scope, allowWarn = false }: StatGridProps) {
  const { rows, inp, out, cost, costStr } = scopeTotals(scope)
  const { ctx } = scope
  const isWarning = allowWarn && scope.ctxLive && ctx !== null && ctx >= CTX_WARN_THRESHOLD

  return (
    <>
      <div className="stat-cell">
        <div className="stat-label">CTX</div>
        {ctx === null ? (
          <div className="stat-value cost-dash" data-testid="ctx-value">—</div>
        ) : (
          <>
            <div className={`ctx-stat-value${isWarning ? ' ctx-high' : ''}`} data-testid="ctx-value">{ctx}%</div>
            {scope.ctxSub && <div className="stat-sub" data-testid="ctx-sub">{scope.ctxSub}</div>}
          </>
        )}
      </div>
      <div className="stat-cell">
        <div className="stat-label">SESS</div>
        <div className="stat-value" data-testid="sess-count">{rows.length || 1}</div>
      </div>
      <div className="stat-cell">
        <div className="stat-label">Model</div>
        <div className={`stat-value ${modelClass(scope.model)}`}>{modelShort(scope.model)}</div>
      </div>
      <div className="stat-cell">
        <div className="stat-label">Tokens</div>
        <div className="stat-value">{formatTokens(inp + out)}</div>
      </div>
      <div className="stat-cell">
        <div className="stat-label">Cost</div>
        <div className={`stat-value ${cost === null ? 'cost-dash' : costClass(cost, scope.model)}`}>{costStr}</div>
      </div>
    </>
  )
}

// The card's compact footer row — TOK and COST only. The card draws its own
// CTX meter in its ctx row, so the scope's CTX is deliberately left out here.
export function InlineCardMetrics({ scope }: { scope: Scope }) {
  const { inp, out, cost, costStr } = scopeTotals(scope)
  return (
    <>
      <span className="card-metric">
        <span className="card-metric-label" data-testid="card-tok-label">TOK</span>
        <span className="footer-stat">{formatTokens(inp + out)}</span>
      </span>
      <span className="card-metric">
        <span className="card-metric-label" data-testid="card-cost-label">COST</span>
        <span className={`footer-stat${costIsHigh(cost) ? ' cost-high' : ''}`} data-testid="card-cost">{costStr}</span>
      </span>
    </>
  )
}
