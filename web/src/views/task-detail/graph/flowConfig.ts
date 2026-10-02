import '@xyflow/react/dist/base.css'
import type { CSSProperties } from 'react'
import type { ReactFlowProps } from '@xyflow/react'

// Both graphs are display-only views of pipeline state — there is no
// workflow editor and no persisted node positions — so everything React Flow can do
// to edit or navigate a canvas is switched off here, once, for both graphs —
// selection lives in the pipeline (the stage / milestone that's open), not in
// React Flow, and keyboard/touch behaviour is the page's own (native buttons,
// native scrolling).
export const DISPLAY_ONLY_FLOW_PROPS: Partial<ReactFlowProps> = {
  nodesDraggable: false,
  nodesConnectable: false,
  nodesFocusable: false,
  edgesFocusable: false,
  elementsSelectable: false,
  panOnDrag: false,
  panOnScroll: false,
  zoomOnScroll: false,
  zoomOnPinch: false,
  zoomOnDoubleClick: false,
  preventScrolling: false,
  disableKeyboardA11y: true,
  deleteKeyCode: null,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  panActivationKeyCode: null,
  zoomActivationKeyCode: null,
  // The "React Flow" corner credit would sit on top of a 76px-tall rail, so it's
  // hidden and credited in README.md's Credits section instead. xyflow asks
  // non-Pro users to credit them somewhere — revisit if that ever needs to be
  // an in-app About screen.
  proOptions: { hideAttribution: true },
  minZoom: 1,
  maxZoom: 1,
  defaultViewport: { x: 0, y: 0, zoom: 1 },
}

// React Flow marks a node pointer-events:none unless it's draggable, selectable
// or has its own handler — all switched off above — which lets the pane swallow
// clicks meant for the real buttons inside each node.
export const NODE_HOSTS_BUTTONS_STYLE: CSSProperties = { pointerEvents: 'all' }
