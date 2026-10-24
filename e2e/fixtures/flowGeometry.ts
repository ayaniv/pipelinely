import type { Locator, Page } from '@playwright/test'

// Measurements shared by the dashboard-v4 chart specs (pipeline chart, wave
// graph) and the top bar spec. REQUEST-v4.md §5's acceptance rules are
// geometric — effective text size, edges never crossing a label, dark mode by
// token swap only, no re-mount on selection — so each is one helper here
// rather than a copy per spec.

// The brief's floor: "no text renders below about 10px effective size". A
// hair under 10 absorbs sub-pixel rounding of the zoom.
export const MIN_EFFECTIVE_TEXT_PX = 9.95

export interface TextSample {
  text: string
  effectivePx: number
}

// Every element under `root` that owns a non-empty text node, with its font
// size multiplied by whatever scale the chart's viewport applies to it. HTML
// is measured as rendered width / layout width; SVG text through its screen
// matrix.
export async function effectiveTextSizes(root: Locator): Promise<TextSample[]> {
  return root.evaluate((rootEl) => {
    const samples: Array<{ text: string; effectivePx: number }> = []
    for (const el of Array.from(rootEl.querySelectorAll<Element>('*'))) {
      const ownText = Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim()
      if (!ownText) continue
      const fontPx = parseFloat(getComputedStyle(el).fontSize)
      let scale = 1
      if (el instanceof SVGGraphicsElement) {
        scale = el.getScreenCTM()?.a ?? 1
      } else if (el instanceof HTMLElement && el.offsetWidth > 0) {
        scale = el.getBoundingClientRect().width / el.offsetWidth
      }
      samples.push({ text: ownText.slice(0, 40), effectivePx: fontPx * scale })
    }
    return samples
  })
}

export interface EdgeLabelCrossing {
  edgeId: string
  labelIndex: number
}

// Walks every edge path under `root` that carries `data-edge-id` (the
// `flow-edge` gradient edges AND the rework loop, whose testid is its own) in
// 2px steps and reports every edge that enters the text of any node label
// block (`[data-testid="flow-label-block"]`). "Text" is each text node's own
// box (a Range over it), not the block's: a task card's block is 130px wide
// but its centred title is narrower, and the design's own lower branches pass
// through the block's empty bottom-left corner (measured in
// Pipelinely Pipeline.dc.html: wave 2 -> M7 clips M6's block, never its
// text). Text rects are shrunk by 1px so an edge that merely touches one is
// not a crossing.
export async function edgeLabelCrossings(root: Locator): Promise<EdgeLabelCrossing[]> {
  return root.evaluate((rootEl) => {
    const labels: DOMRect[] = []
    for (const block of Array.from(rootEl.querySelectorAll('[data-testid="flow-label-block"]'))) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) if (rect.width > 0 && rect.height > 0) labels.push(rect)
      }
    }
    const crossings: Array<{ edgeId: string; labelIndex: number }> = []
    for (const path of Array.from(rootEl.querySelectorAll<SVGPathElement>('path[data-edge-id]'))) {
      const matrix = path.getScreenCTM()
      if (!matrix) continue
      const length = path.getTotalLength()
      for (let at = 0; at <= length; at += 2) {
        const local = path.getPointAtLength(at)
        const point = new DOMPoint(local.x, local.y).matrixTransform(matrix)
        const hit = labels.findIndex((r) => point.x > r.left + 1 && point.x < r.right - 1 && point.y > r.top + 1 && point.y < r.bottom - 1)
        if (hit >= 0) {
          crossings.push({ edgeId: path.dataset.edgeId ?? '?', labelIndex: hit })
          break
        }
      }
    }
    return crossings
  })
}

// Resolves any CSS colour expression (a token like `var(--devC)`, or a
// color-mix) to the computed string the browser reports for it, via a probe
// element on the page — so a spec compares against the CURRENT theme's token
// instead of hard-coding either theme's hex.
export async function resolvedColor(page: Page, cssColor: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('span')
    probe.style.color = value
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return resolved
  }, cssColor)
}

// The alpha channel of a computed colour string: rgb()/rgba(), or the CSS
// Color 4 forms (`color(srgb r g b / a)`, `oklab(l a b / a)`) Chromium reports
// for a color-mix. Opaque when no alpha is present.
export function alphaOf(color: string): number {
  const slash = color.match(/\/\s*([\d.]+)\s*\)$/)
  if (slash) return parseFloat(slash[1])
  const rgba = color.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/)
  if (rgba) return parseFloat(rgba[1])
  return 1
}

// Tags a DOM node with a marker property. A later `readMountMarker` that
// still finds it proves React kept the same element — a re-mount would have
// replaced the node and lost the property.
const MOUNT_MARKER = '__v4MountMarker'

export async function setMountMarker(locator: Locator): Promise<void> {
  await locator.evaluate((el, key) => { Reflect.set(el, key, 'kept') }, MOUNT_MARKER)
}

export async function readMountMarker(locator: Locator): Promise<string | null> {
  return locator.evaluate((el, key) => {
    const value: unknown = Reflect.get(el, key)
    return typeof value === 'string' ? value : null
  }, MOUNT_MARKER)
}

// React Flow's own pan/zoom transform on the chart's viewport layer — the
// chart's "scroll position". Read off the library's viewport element, the one
// DOM node React Flow writes the transform to.
export async function flowViewportTransform(chart: Locator): Promise<string> {
  return chart.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform)
}

// The zoom React Flow is rendering at (the transform matrix's x scale).
export async function flowZoom(chart: Locator): Promise<number> {
  return chart.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
}
