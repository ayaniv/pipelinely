import type { CSSProperties } from 'react'
import type { TaskCreature } from '../../../src/types'

// A task's creature, drawn in CSS alone (no image, no SVG): a coloured body
// with the stored asymmetric shape, a white visor and two dark eyes. The
// visor and eyes size themselves from --creature-size (see .creature in
// app.css), so one size prop scales the whole drawing. isWorking turns on
// the CSS-only bob and blink.

export interface CreatureProps {
  creature: TaskCreature
  size: number
  // Only for a body that is not square (the Parent tasks row's 22x20 blob);
  // the visor and eyes still scale from the width.
  heightPx?: number
  // The Parent tasks row draws a bare blob: two eyes on the colour, no visor.
  hasVisor?: boolean
  isWorking: boolean
}

export function Creature({ creature, size, heightPx = size, hasVisor = true, isWorking }: CreatureProps) {
  const style = {
    width: size,
    height: heightPx,
    backgroundColor: creature.color,
    borderRadius: creature.shape,
    '--creature-size': `${size}px`,
  } as CSSProperties // React's CSSProperties has no index for custom properties
  const eyes = (
    <>
      <span className="creature-eye" data-testid="creature-eye" />
      <span className="creature-eye" data-testid="creature-eye" />
    </>
  )
  return (
    <span className={`creature${isWorking ? ' is-working' : ''}${hasVisor ? '' : ' is-bare'}`} data-testid="creature" data-name={creature.name} title={`${creature.name} is on this task`} style={style}>
      {hasVisor ? <span className="creature-visor" data-testid="creature-visor">{eyes}</span> : eyes}
    </span>
  )
}
