import { useEffect } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import type { Logger } from '../../../log'
import type { FlowViewport } from './flowViewport'

// Applies the hand-computed viewport (flowViewport.ts) through the React Flow
// instance, never through a `key` or fitView, so a selection or a live
// snapshot never re-mounts a chart or moves a user's pan. Shared by the
// pipeline chart and the wave graph.

export interface ViewportControllerProps {
  // The latest computed viewport, read when the effect fires rather than
  // listed as a dependency: the focus point moves with the current stage, and
  // a snapshot tick must not drag the viewport back under a user's pan.
  viewportRef: { current: FlowViewport }
  shapeKey: string
  log: Logger
  // The chart's own tag for the log line, so a failure names its graph.
  graphName: string
}

export function ViewportController({ viewportRef, shapeKey, log, graphName }: ViewportControllerProps) {
  const { setViewport } = useReactFlow()
  // The pan/zoom engine is created after the first render; applying a
  // viewport before then is a silent no-op.
  const isPanZoomReady = useStore((state) => state.panZoom !== null)
  useEffect(() => {
    if (!isPanZoomReady) return
    const { x, y, zoom } = viewportRef.current
    setViewport({ x, y, zoom }).catch((err: unknown) => log(`[${graphName}] could not apply the viewport`, err))
  }, [shapeKey, isPanZoomReady, setViewport, viewportRef, log, graphName])
  return null
}
