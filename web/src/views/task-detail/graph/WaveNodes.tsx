import { createContext, useContext, type CSSProperties } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Task } from '../../../../../src/types'
import { Creature } from '../../../components/Creature'
import { isTaskWorking, milestoneScope, scopeCost } from '../../../taskScope'
import type { Wave, WaveCard } from '../../../waveModel'
import { ORB_BOX, ROOT_SIZE, orbHandleOffset, type OrbHandleSide, type OrbKind } from './waveGraphLayout'

// The wave graph's four node kinds, all one React Flow node type (`orb`): a
// circle with a label block under it. As in the pipeline chart, node objects
// keep their identity across renders, so everything that changes with a
// snapshot reaches these components through context, and a node's own data is
// only its identity.

export type OrbIdentity =
  | { kind: 'root' }
  | { kind: 'wave'; wave: number }
  | { kind: 'card'; cardId: string; side: 'above' | 'below' }
  | { kind: 'more'; wave: number; count: number }

export type OrbFlowNode = Node<OrbIdentity & Record<string, unknown>, 'orb'>

export interface WaveGraphContextValue {
  task: Task
  waves: Wave[]
  isCreatureShown: boolean
  onOpenCard: (card: WaveCard) => void
  onExpandWave: (wave: number) => void
}

export const WaveGraphContext = createContext<WaveGraphContextValue | null>(null)

const HANDLE_CLASS = 'pipeline-handle wave-handle'

function handleAt(kind: OrbKind, side: OrbHandleSide): CSSProperties {
  return orbHandleOffset(kind, side)
}

function PulseDots() {
  return (
    <span className="stage-node-pulse" aria-hidden="true">
      {[0, 1, 2].map((dot) => <span key={dot} className="stage-node-pulse-dot" data-testid="wave-pulse-dot" style={{ animationDelay: `${dot * 0.2}s` }} />)}
    </span>
  )
}

function LockGlyph() {
  return (
    <svg className="wave-lock-glyph" data-testid="wave-lock" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function BubbleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  )
}

function RootNode() {
  const context = useContext(WaveGraphContext)
  if (!context) return null
  const { task, isCreatureShown } = context
  const creature = isCreatureShown ? task.creature : null
  return (
    <div className="wave-orb wave-root" data-testid="wave-root">
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} className={HANDLE_CLASS} style={handleAt('root', 'out')} />
      <span className={`wave-orb-slot wave-root-blob${creature ? '' : ' is-plain'}`} data-testid="wave-root-blob" style={{ width: ROOT_SIZE, height: ROOT_SIZE }}>
        {creature ? <Creature creature={creature} size={ROOT_SIZE} isWorking={isTaskWorking(task)} /> : null}
      </span>
      <span className="flow-label-block" data-testid="flow-label-block" style={{ height: ORB_BOX.root.labelHeight }}>
        <span className="wave-root-title" data-testid="wave-root-title">{task.title}</span>
        <span className="wave-root-sub" data-testid="wave-root-sub">{creature ? `${creature.name} · ${task.branch}` : task.branch}</span>
      </span>
    </div>
  )
}

function waveSubLabel(wave: Wave): string {
  switch (wave.state) {
    case 'complete':
      return 'complete'
    case 'running':
      return `${wave.doneCount} of ${wave.cards.length} done`
    case 'locked':
      return `starts after wave ${wave.wave - 1}`
  }
}

function WaveGlyph({ wave }: { wave: Wave }) {
  switch (wave.state) {
    case 'complete':
      return <span className="wave-check" data-testid="wave-check" aria-hidden="true">✓</span>
    case 'running':
      return <span className="wave-number" data-testid="wave-number">{wave.wave}</span>
    case 'locked':
      return <LockGlyph />
  }
}

function WaveNode({ waveNumber }: { waveNumber: number }) {
  const wave = useContext(WaveGraphContext)?.waves.find((candidate) => candidate.wave === waveNumber)
  if (!wave) return null
  return (
    <div className="wave-orb wave-node" data-testid={`wave-node-${wave.wave}`} data-state={wave.state}>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} className={HANDLE_CLASS} style={handleAt('wave', 'in')} />
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} className={HANDLE_CLASS} style={handleAt('wave', 'out')} />
      <Handle id="up" type="source" position={Position.Top} isConnectable={false} className={HANDLE_CLASS} style={handleAt('wave', 'up')} />
      <Handle id="down" type="source" position={Position.Bottom} isConnectable={false} className={HANDLE_CLASS} style={handleAt('wave', 'down')} />
      <span className="wave-orb-slot">
        {wave.state === 'running' && <span className="wave-halo" data-testid="wave-halo" />}
        <span className="wave-circle" data-testid="wave-circle"><WaveGlyph wave={wave} /></span>
      </span>
      <span className="flow-label-block" data-testid="flow-label-block" style={{ height: ORB_BOX.wave.labelHeight }}>
        <span className="wave-node-name">Wave {wave.wave}</span>
        <span className="wave-sub" data-testid="wave-sub">{waveSubLabel(wave)}</span>
      </span>
    </div>
  )
}

function CardGlyph({ card }: { card: WaveCard }) {
  switch (card.status) {
    case 'merged':
      return <span className="wave-check" aria-hidden="true">✓</span>
    case 'review':
      return <BubbleGlyph />
    case 'working':
      return <PulseDots />
    case 'queued':
      return <span className="wave-task-id" data-testid="wave-task-id">{card.id}</span>
  }
}

function cardSubLabel(card: WaveCard): string {
  const cost = scopeCost(milestoneScope(card.milestone).rows)
  const parts = [card.id, card.label]
  if (cost !== null) parts.push(`$${cost.toFixed(2)}`)
  return parts.join(' · ')
}

function TaskNode({ cardId, side }: { cardId: string; side: 'above' | 'below' }) {
  const context = useContext(WaveGraphContext)
  const card = context?.waves.flatMap((wave) => wave.cards).find((candidate) => candidate.id === cardId)
  if (!context || !card) return null
  const hasHalo = card.status === 'review' || card.status === 'working'
  return (
    <button type="button" className="wave-orb wave-task" data-testid={`wave-task-${card.id}`} data-status={card.status} data-side={side} onClick={() => context.onOpenCard(card)}>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} className={HANDLE_CLASS} style={handleAt('card', 'in')} />
      <span className="wave-orb-slot">
        {hasHalo && <span className="wave-halo" data-testid="wave-halo" />}
        <span className="wave-circle" data-testid="wave-circle"><CardGlyph card={card} /></span>
      </span>
      <span className="flow-label-block" data-testid="flow-label-block" style={{ height: ORB_BOX.card.labelHeight }}>
        <span className="wave-task-title" data-testid="wave-task-title">{card.milestone.name}</span>
        <span className="wave-task-sub" data-testid="wave-task-sub">{cardSubLabel(card)}</span>
      </span>
    </button>
  )
}

function MoreNode({ waveNumber, count }: { waveNumber: number; count: number }) {
  const context = useContext(WaveGraphContext)
  if (!context) return null
  return (
    <button type="button" className="wave-orb wave-more" data-testid={`wave-more-${waveNumber}`} data-count={count} onClick={() => context.onExpandWave(waveNumber)}>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} className={HANDLE_CLASS} style={handleAt('more', 'in')} />
      <span className="wave-orb-slot">
        <span className="wave-circle"><span className="wave-more-count">+{count}</span></span>
      </span>
      <span className="flow-label-block" data-testid="flow-label-block" style={{ height: ORB_BOX.more.labelHeight }}>
        <span className="wave-task-sub">more in wave {waveNumber}</span>
      </span>
    </button>
  )
}

export function OrbNode({ data }: NodeProps<OrbFlowNode>) {
  switch (data.kind) {
    case 'root':
      return <RootNode />
    case 'wave':
      return <WaveNode waveNumber={data.wave} />
    case 'card':
      return <TaskNode cardId={data.cardId} side={data.side} />
    case 'more':
      return <MoreNode waveNumber={data.wave} count={data.count} />
  }
}
