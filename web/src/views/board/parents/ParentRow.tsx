import type { MouseEvent } from 'react'
import type { CreaturePlacement, Task } from '../../../../../src/types'
import { useClientState } from '../../../data/clientState'
import { ChevronRightIcon } from '../../../components/icons'
import { Creature } from '../../../components/Creature'
import { nextWaveAction, nextWaveButtonState } from '../../../nextWave'
import { parentProgress, toParentView, waveButtonFor, type ParentMilestone, type ParentWave } from '../../../parentModel'
import type { OpenTask } from '../../../shell/appNavigation'
import { taskUrl } from '../../../shell/routes'
import { openOnPlainClick } from '../rowOpenGuard'
import { MilestoneStateIcon } from './MilestoneStateIcon'
import { ParentWaveButton } from './ParentWaveButton'

// One Parent tasks row: collapsed it is the parent's creature, title, project,
// a milestone icon per child grouped by wave, the progress and the wave
// button; open it adds a column per wave listing every milestone. A parent
// never runs on its own, so nothing here is a stage, a status or a pipeline.

const CREATURE_WIDTH_PX = 22
const CREATURE_HEIGHT_PX = 20
const DEV_STAGE_ID = 'dev'

const milestoneLabel = (milestone: ParentMilestone) => `${milestone.id} · ${milestone.title} · ${milestone.state}`

export interface ParentRowProps {
  task: Task
  isOpen: boolean
  onToggle: (slug: string) => void
  onRunWave: (task: Task, wave: number) => void
  onOpenPlan: OpenTask
  // The Settings switch that hides every creature hides this one too.
  creaturePlacement: CreaturePlacement
  // Off the canonical instance a dispatch is refused with a 403 that no board
  // surface shows, so Run wave stays disabled there.
  isCanonical: boolean
}

function WaveIcons({ waves }: { waves: ParentWave[] }) {
  return (
    <div className="parent-icons" data-testid="parent-icons">
      {waves.map((wave) => (
        <span className="parent-icon-wave" data-testid="parent-icon-wave" data-wave={wave.wave} title={`Wave ${wave.wave}`} key={wave.wave}>
          {wave.milestones.map((milestone) => <MilestoneStateIcon key={milestone.id} state={milestone.state} label={milestoneLabel(milestone)} />)}
        </span>
      ))}
    </div>
  )
}

function ExpandedWaves({ slug, waves, onOpenPlan }: { slug: string; waves: ParentWave[]; onOpenPlan: OpenTask }) {
  const handleOpenPlan = (event: MouseEvent<HTMLAnchorElement>) => openOnPlainClick(event, () => onOpenPlan(slug, { stage: DEV_STAGE_ID }))
  return (
    <div className="parent-expanded" data-testid="parent-expanded">
      {waves.map((wave) => (
        <div className="parent-wave-col" data-testid="parent-wave-col" data-wave={wave.wave} key={wave.wave}>
          <div className="parent-wave-eyebrow" data-testid="parent-wave-eyebrow">WAVE {wave.wave}</div>
          {wave.milestones.map((milestone) => (
            <div className="parent-milestone-line" data-testid="parent-milestone-line" data-state={milestone.state} key={milestone.id}>
              <MilestoneStateIcon state={milestone.state} label={milestoneLabel(milestone)} />
              <span className="parent-milestone-id" data-testid="parent-milestone-id">{milestone.id}</span>
              <span className="parent-milestone-title" data-testid="parent-milestone-title">{milestone.title}</span>
            </div>
          ))}
        </div>
      ))}
      <a className="parent-open-plan" data-testid="parent-open-plan" href={taskUrl(slug, DEV_STAGE_ID)} onClick={handleOpenPlan}>Open milestone plan →</a>
    </div>
  )
}

export function ParentRow({ task, isOpen, onToggle, onRunWave, onOpenPlan, creaturePlacement, isCanonical }: ParentRowProps) {
  // Re-renders the button when its wave starts or finishes staging.
  useClientState()
  const parent = toParentView(task)
  const { done, total } = parentProgress(parent.waves)
  const waveAction = nextWaveAction(task)
  const waveButton = waveButtonFor(waveAction, task.milestones ?? [])

  return (
    <div className={`parent-row${isOpen ? ' is-open' : ''}`} data-testid="parent-row" data-slug={parent.slug}>
      <div className="parent-row-head" data-testid="parent-row-head" onClick={() => onToggle(parent.slug)}>
        <span className="parent-creature">
          {parent.creature && creaturePlacement === 'header' && <Creature creature={parent.creature} size={CREATURE_WIDTH_PX} heightPx={CREATURE_HEIGHT_PX} hasVisor={false} isWorking={false} />}
        </span>
        <div className="parent-main">
          <div className="parent-line">
            <span className="parent-title" data-testid="parent-title" title={parent.title}>{parent.title}</span>
            {parent.project && <span className="parent-project" data-testid="parent-project">{parent.project}</span>}
          </div>
          <WaveIcons waves={parent.waves} />
        </div>
        <span className="parent-progress" data-testid="parent-progress">{done} / {total} done</span>
        {waveButton.kind === 'none' ? <span /> : <ParentWaveButton button={waveButton} runState={nextWaveButtonState(task.slug, waveAction, isCanonical)} onRun={(wave) => onRunWave(task, wave)} />}
        <button
          type="button"
          className={`parent-chevron${isOpen ? ' is-open' : ''}`}
          data-testid="parent-chevron"
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${parent.title}`}
        >
          <ChevronRightIcon />
        </button>
      </div>
      {isOpen && <ExpandedWaves slug={parent.slug} waves={parent.waves} onOpenPlan={onOpenPlan} />}
    </div>
  )
}
