// The one viewport rule both charts share (REQUEST-v4.md §2 "Layout /
// viewport"): shrink to fit down to a floor, centre what fits, and otherwise
// pull a focus point to the middle without showing empty space past either
// end. Pure maths, so React Flow's own fitView (which pads and re-centres on
// its own terms) is never involved.

// The brief: no text renders below about 10px effective size.
export const MIN_EFFECTIVE_TEXT_PX = 10

// The lowest zoom a chart may reach: the brief's floor, raised when the
// chart's smallest text would otherwise drop under MIN_EFFECTIVE_TEXT_PX.
export function zoomFloor(briefFloor: number, smallestTextPx: number): number {
  return Math.min(1, Math.max(briefFloor, MIN_EFFECTIVE_TEXT_PX / smallestTextPx))
}

export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface FlowViewportInput {
  containerWidth: number
  contentBounds: ContentBounds
  pad: number
  minZoom: number
  // Flow x of the point to bring to the middle when the content does not fit.
  focusX: number
}

export interface FlowViewport {
  zoom: number
  x: number
  y: number
  boxHeight: number
  fits: boolean
}

export function computeFlowViewport({ containerWidth, contentBounds, pad, minZoom, focusX }: FlowViewportInput): FlowViewport {
  const { x: boundsX, y: boundsY, width: contentWidth, height: contentHeight } = contentBounds
  // A container nobody has measured yet draws at full size; the real width
  // arrives a frame later and the effect re-applies.
  const isMeasured = containerWidth > 0 && contentWidth > 0
  const ratio = isMeasured ? (containerWidth - 2 * pad) / contentWidth : 1
  const zoom = isMeasured ? Math.min(1, Math.max(minZoom, ratio)) : 1
  // Compared with the zoom itself, not recomputed from pixels: when the ratio
  // IS the zoom, floating-point rounding must not flip it to "doesn't fit".
  const fits = isMeasured && ratio >= zoom

  const leftAligned = pad - boundsX * zoom
  const rightAligned = containerWidth - pad - (boundsX + contentWidth) * zoom
  const x = fits
    ? (containerWidth - contentWidth * zoom) / 2 - boundsX * zoom
    : isMeasured
      ? Math.min(leftAligned, Math.max(rightAligned, containerWidth / 2 - focusX * zoom))
      : leftAligned

  return { zoom, x, y: pad - boundsY * zoom, boxHeight: Math.round(contentHeight * zoom + 2 * pad), fits }
}
