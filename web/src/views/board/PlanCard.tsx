import type { Task } from '../../../../src/types'
import { BranchIcon } from '../../components/icons'

// A task's milestone progress as
// a donut, shown beside its session card. Nothing for a task without a
// parsed plan (or with an empty one).

const DONUT_RADIUS = 28
const DONUT_CENTER = 36
const DONUT_SIZE = 72
const DONUT_COLORS: Record<string, string> = { working: 'var(--bl)', waiting: 'var(--am)', done: 'var(--sg)' }
const DEFAULT_DONUT_COLOR = 'var(--bl)'

export function PlanCard({ task }: { task: Task }) {
  const plan = task.plan
  if (!plan || plan.total === 0) return null

  const circumference = 2 * Math.PI * DONUT_RADIUS
  const progress = circumference * (plan.done / plan.total)
  return (
    <div className={`card card-plan card-${task.status}`} data-testid="plan-card">
      <div className="card-stripe" />
      <div className="card-body">
        <div className="plan-card-title">{task.title}</div>
        {task.branch && <div className="card-branch"><BranchIcon /> {task.branch}</div>}
        <div className="donut-wrap">
          <svg width={DONUT_SIZE} height={DONUT_SIZE} viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}>
            <circle className="donut-bg" cx={DONUT_CENTER} cy={DONUT_CENTER} r={DONUT_RADIUS} />
            <circle
              className="donut-progress"
              cx={DONUT_CENTER}
              cy={DONUT_CENTER}
              r={DONUT_RADIUS}
              stroke={DONUT_COLORS[task.status] || DEFAULT_DONUT_COLOR}
              strokeDasharray={`${progress.toFixed(2)} ${circumference.toFixed(2)}`}
              transform={`rotate(-90 ${DONUT_CENTER} ${DONUT_CENTER})`}
            />
            <text className="donut-text" data-testid="plan-card-progress" x={DONUT_CENTER} y={DONUT_CENTER} textAnchor="middle" dominantBaseline="central">{plan.done}/{plan.total}</text>
          </svg>
          <div className="donut-label">{plan.done} of {plan.total} milestones</div>
        </div>
      </div>
    </div>
  )
}
