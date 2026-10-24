import { createContext, useContext, type CSSProperties } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { ChainStageId } from '../../../pipelineStages'
import { STAGE_TONE_VARS } from '../../../stageView'
import type { StageChainModel, StageChainNode, WaveDot } from './stageChainModel'

// One stage of the pipeline chart: a 50px circle (filled when done or
// current, dashed when not started) with its name and status line below.
// Node objects handed to React Flow keep their identity across renders, so
// the changing content (state, selection, subtitles) reaches this component
// through context rather than node data.

export interface PipelineChartContextValue {
  model: StageChainModel
  onSelect: (tabId: ChainStageId) => void
}

export const PipelineChartContext = createContext<PipelineChartContextValue | null>(null)
export type StageFlowNode = Node<Record<string, never>, 'stage'>

// Handles sit at the circle's centre line (see .pipeline-handle in app.css);
// the loop handles sit below the label block, so the rework loop never
// crosses text.
export const SOURCE_HANDLE_ID = 'flow-out'
export const TARGET_HANDLE_ID = 'flow-in'
export const LOOP_SOURCE_HANDLE_ID = 'loop-out'
export const LOOP_TARGET_HANDLE_ID = 'loop-in'

function toneStyle(node: StageChainNode): CSSProperties {
  const vars = STAGE_TONE_VARS[node.tone]
  return { '--node-c': vars.c, '--node-soft': vars.soft, '--node-ink': vars.ink } as CSSProperties // React's CSSProperties has no index for custom properties
}

function CircleGlyph({ node }: { node: StageChainNode }) {
  switch (node.state) {
    case 'done':
      return <span className="stage-node-check" data-testid="stage-node-check" aria-hidden="true">✓</span>
    case 'current':
      return (
        <span className="stage-node-pulse" aria-hidden="true">
          {[0, 1, 2].map((dot) => <span key={dot} className="stage-node-pulse-dot" data-testid="stage-node-pulse-dot" style={{ animationDelay: `${dot * 0.2}s` }} />)}
        </span>
      )
    case 'todo':
      return null
  }
}

function WaveDots({ groups }: { groups: WaveDot[][] }) {
  return (
    <span className="stage-node-dots">
      {groups.map((group) => (
        <span key={group.map((dot) => dot.milestoneId).join('+')} className="stage-node-dot-group" data-testid="stage-node-dot-group">
          {group.map((dot) => <span key={dot.milestoneId} className="stage-node-dot" data-testid="stage-node-dot" data-milestone-id={dot.milestoneId} data-status={dot.status} />)}
        </span>
      ))}
    </span>
  )
}

export function StageCircleNode({ id }: NodeProps<StageFlowNode>) {
  const context = useContext(PipelineChartContext)
  const node = context?.model.nodes.find((candidate) => candidate.id === id)
  if (!context || !node) return null
  return (
    <>
      <Handle id={TARGET_HANDLE_ID} type="target" position={Position.Left} isConnectable={false} className="pipeline-handle pipeline-handle-left" />
      <button
        type="button"
        className="stage-chain-node pipeline-node"
        data-testid={`stage-chain-${node.id}`}
        data-state={node.state}
        data-selected={node.isSelected ? 'true' : 'false'}
        data-task-stage={node.isTaskStage ? 'true' : undefined}
        aria-current={node.isSelected ? 'step' : 'false'}
        style={toneStyle(node)}
        onClick={() => context.onSelect(node.tabId)}
      >
        <span className="stage-node-orb">
          {node.state === 'current' && <span className="stage-node-halo" data-testid="stage-node-halo" />}
          {node.isSelected && <span className="stage-node-ring" data-testid="stage-node-ring" />}
          <span className="stage-node-circle" data-testid="stage-node-circle"><CircleGlyph node={node} /></span>
        </span>
        <span className="flow-label-block" data-testid="flow-label-block">
          <span className="stage-node-name" data-testid="stage-node-name">{node.label}</span>
          <span className="stage-node-sub" data-testid="stage-node-sub">{node.sub}</span>
          {node.dotGroups && <WaveDots groups={node.dotGroups} />}
        </span>
      </button>
      <Handle id={SOURCE_HANDLE_ID} type="source" position={Position.Right} isConnectable={false} className="pipeline-handle pipeline-handle-right" />
      <Handle id={LOOP_TARGET_HANDLE_ID} type="target" position={Position.Bottom} isConnectable={false} className="pipeline-handle pipeline-handle-bottom" />
      <Handle id={LOOP_SOURCE_HANDLE_ID} type="source" position={Position.Bottom} isConnectable={false} className="pipeline-handle pipeline-handle-bottom" />
    </>
  )
}
