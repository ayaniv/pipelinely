import type { Task } from '../../../src/types'
import { STAGE_TONE_VARS, type StageTone } from '../stageView'
import { miniStageNodes } from '../taskScope'

// The decorative-only mini stage rail (session/dev card's 16px-node row), NOT
// the interactive stage chain. Reads only the three fields the rail needs, so
// a milestone card can pass its child's — or a stand-in for an undispatched
// one.

const NODE_LABEL: Record<string, string> = { planning: 'Plan', dev: 'Dev', cr: 'CR', qa: 'QA', merge: 'Merge' }

export interface MiniStageRailProps {
  task: Pick<Task, 'status' | 'stage' | 'stageHistory'>
  stageIds: string[]
  // The stage colour the rail is drawn in; the accent when omitted.
  tone?: StageTone
  // Names each node under the rail (Needs-you cards only).
  showLabels?: boolean
}

export function MiniStageRail({ task, stageIds, tone, showLabels = false }: MiniStageRailProps) {
  const toneVars = tone ? STAGE_TONE_VARS[tone] : null
  const nodes = miniStageNodes(task, stageIds, toneVars?.c)
  return (
    <>
      {nodes.map((n) => (
        <div key={n.label} style={{ display: 'flex', alignItems: 'center', flex: n.flex, minWidth: 0 }}>
          {n.hasConnector && <div data-testid="mini-stage-connector" style={{ flex: '1 1 auto', height: 2, minWidth: 8, background: n.connector }} />}
          <div title={n.label} style={{ position: 'relative', width: 16, height: 16, flex: 'none' }}>
            <div
              data-testid="mini-stage-node"
              data-stage={n.label}
              data-state={n.isDone ? 'done' : n.isCurrent ? 'current' : 'todo'}
              style={{ position: 'absolute', inset: 0, boxSizing: 'border-box', borderRadius: 999, border: n.ring, background: n.bg }}
            >
              {n.isCurrent && <div style={{ position: 'absolute', inset: 3, borderRadius: 999, background: n.color }} />}
            </div>
            {n.isCurrent && (
              <div style={{ position: 'absolute', inset: -3, borderRadius: 999, border: `1.5px solid ${n.color}`, animation: 'breathe 2.8s ease-in-out infinite' }} />
            )}
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 800, color: n.fg }}>
              {n.glyph}
            </div>
            {showLabels && (
              <span
                className="mini-stage-label"
                data-testid="mini-stage-label"
                data-current={String(n.isCurrent)}
                style={n.isCurrent && toneVars ? { color: toneVars.ink } : undefined}
              >
                {NODE_LABEL[n.label] ?? n.label}
              </span>
            )}
          </div>
        </div>
      ))}
    </>
  )
}
