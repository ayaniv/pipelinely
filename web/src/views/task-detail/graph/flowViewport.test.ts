import { describe, expect, test } from 'vitest'
import { MIN_EFFECTIVE_TEXT_PX, computeFlowViewport, zoomFloor } from './flowViewport'

// dashboard-v4-inner-view M1. The one viewport rule both charts share
// (REQUEST-v4.md §2 "Layout / viewport", §3 "Viewport, same approach"):
// zoom = clamp(floor, (w − 2·pad) / contentWidth, 1); centre when it fits,
// otherwise pull the focus point to the middle without showing past either end.

const BOUNDS = { x: 0, y: 0, width: 862, height: 108 }

describe('zoomFloor', () => {
  test('keeps the brief\'s floor when the smallest text stays above 10px at it', () => {
    expect(zoomFloor(0.8, 13)).toBe(0.8)
  })

  test('raises the floor so the smallest text never renders below 10px', () => {
    expect(zoomFloor(0.8, 10.5)).toBeCloseTo(MIN_EFFECTIVE_TEXT_PX / 10.5, 6)
    expect(10.5 * zoomFloor(0.88, 10.5)).toBeGreaterThanOrEqual(MIN_EFFECTIVE_TEXT_PX)
  })

  test('never asks for more than zoom 1', () => {
    expect(zoomFloor(0.8, 8)).toBe(1)
  })
})

describe('computeFlowViewport', () => {
  test('content that fits is drawn at zoom 1 and centred', () => {
    const viewport = computeFlowViewport({ containerWidth: 1100, contentBounds: BOUNDS, pad: 24, minZoom: 0.8, focusX: 0 })
    expect(viewport.fits).toBe(true)
    expect(viewport.zoom).toBe(1)
    expect(viewport.x).toBe((1100 - 862) / 2)
    expect(viewport.y).toBe(24)
  })

  test('the box is the scaled content height plus padding, rounded', () => {
    const viewport = computeFlowViewport({ containerWidth: 800, contentBounds: BOUNDS, pad: 24, minZoom: 0.8, focusX: 0 })
    expect(viewport.boxHeight).toBe(Math.round(108 * viewport.zoom + 48))
  })

  test('zoom shrinks toward the floor before the content stops fitting', () => {
    const viewport = computeFlowViewport({ containerWidth: 800, contentBounds: BOUNDS, pad: 24, minZoom: 0.8, focusX: 0 })
    expect(viewport.zoom).toBeCloseTo((800 - 48) / 862, 6)
    expect(viewport.fits).toBe(true)
  })

  test('below the floor it stops fitting and centres the focus point where it can', () => {
    const viewport = computeFlowViewport({ containerWidth: 600, contentBounds: BOUNDS, pad: 24, minZoom: 0.95, focusX: 431 })
    expect(viewport.fits).toBe(false)
    expect(viewport.zoom).toBe(0.95)
    expect(viewport.x).toBeCloseTo(300 - 431 * 0.95, 6)
  })

  test('a focus near the start left-aligns the content at the padding instead of showing empty space', () => {
    const viewport = computeFlowViewport({ containerWidth: 600, contentBounds: BOUNDS, pad: 24, minZoom: 0.95, focusX: 75 })
    expect(viewport.x).toBe(24)
  })

  test('a focus near the end right-aligns it the same way', () => {
    const viewport = computeFlowViewport({ containerWidth: 600, contentBounds: BOUNDS, pad: 24, minZoom: 0.95, focusX: 862 })
    expect(viewport.x).toBeCloseTo(600 - 24 - 862 * 0.95, 6)
  })

  test('content that starts left of the origin (the wave graph\'s root) is offset by its bounds', () => {
    const viewport = computeFlowViewport({ containerWidth: 2000, contentBounds: { x: -80, y: -300, width: 900, height: 600 }, pad: 28, minZoom: 0.95, focusX: 0 })
    expect(viewport.x).toBe((2000 - 900) / 2 + 80)
    expect(viewport.y).toBe(28 + 300)
  })

  test('an unmeasured container (width 0) draws at zoom 1 and is not reported as fitting', () => {
    const viewport = computeFlowViewport({ containerWidth: 0, contentBounds: BOUNDS, pad: 24, minZoom: 0.8, focusX: 0 })
    expect(viewport.zoom).toBe(1)
    expect(viewport.fits).toBe(false)
  })
})
