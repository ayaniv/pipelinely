import type { Task } from '../../src/types'
import { buildWaves } from './waveModel'

// The Dev panel header's meta line: "wave 2 of 3 · 1 of 4 merged · started
// 08:40". The start time is the running wave's earliest first TIMELINE entry
// (the way milestoneActual reads a child's start), left out while no child of
// that wave has one rather than guessed.

function formatClock(isoTime: string): string | null {
  const time = new Date(isoTime)
  return Number.isNaN(time.getTime()) ? null : time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function wavePanelMeta(task: Pick<Task, 'milestones'>): string {
  const milestones = task.milestones ?? []
  const waves = buildWaves(milestones)
  const mergedCount = milestones.filter((milestone) => milestone.state === 'done').length
  const runningWave = waves.find((wave) => wave.state !== 'complete')
  const mergedText = `${mergedCount} of ${milestones.length} merged`
  if (!runningWave) return `${waves.length} ${waves.length === 1 ? 'wave' : 'waves'} · ${mergedText}`

  const startTimes = runningWave.cards
    .map((card) => card.milestone.task?.stageHistory[0]?.at)
    .filter((at): at is string => at !== undefined)
    .map((at) => new Date(at).getTime())
    .filter((time) => !Number.isNaN(time))
  const earliest = startTimes.length ? formatClock(new Date(Math.min(...startTimes)).toISOString()) : null
  return [`wave ${runningWave.wave} of ${waves.length}`,mergedText, ...(earliest ? [`started ${earliest}`] : [])].join(' · ')
}
