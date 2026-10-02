import type { Task } from '../../../src/types'
import { miniStageNodes } from '../taskScope'

// The decorative-only mini stage rail (session/dev card's 16px-node row), NOT
// the interactive stage chain. Reads only the three fields the rail needs, so
// a milestone card can pass its child's — or a stand-in for an undispatched
// one.

export interface MiniStageRailProps {
  task: Pick<Task, 'status' | 'stage' | 'stageHistory'>
  stageIds: string[]
}

export function MiniStageRail({ task, stageIds }: MiniStageRailProps) {
  const nodes = miniStageNodes(task, stageIds)
  return (
    <>
      {nodes.map((n) => (
        <div key={n.label} style={{ display: 'flex', alignItems: 'center', flex: n.flex, minWidth: 0 }}>
          {n.hasConnector && <div style={{ flex: '1 1 auto', height: 2, minWidth: 8, background: n.connector }} />}
          <div
            title={n.label}
            data-testid="mini-stage-node"
            data-stage={n.label}
            data-state={n.isDone ? 'done' : n.isCurrent ? 'current' : 'todo'}
            style={{ display: 'flex', alignItems: 'center', flex: 'none' }}
          >
            <div style={{ position: 'relative', width: 16, height: 16, flex: 'none' }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 999, border: n.ring, background: n.bg }} />
              {n.isCurrent && (
                <div style={{ position: 'absolute', inset: -3, borderRadius: 999, border: '1.5px solid var(--accent)', animation: 'breathe 2.8s ease-in-out infinite' }} />
              )}
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 800, color: n.fg }}>
                {n.glyph}
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  )
}
