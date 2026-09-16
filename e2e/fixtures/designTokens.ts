// The Claude Design "Pipelinely Dashboard v2" palette, as getComputedStyle
// actually reports it.
//
// Every spec in the design-v2 alignment suite asserts resolved colours rather
// than "looks bluish" — that is the only way a test distinguishes "the design
// token landed" from "some token landed". getComputedStyle always returns
// rgb()/rgba() regardless of how the value was authored, so the literals here
// are the rgb() forms of the hex values in the design's own `<style>` block
// (Pipelinely Dashboard v2.dc.html lines 15-25, light theme).
//
// One shared module rather than a copy per spec: six spec files need the same
// dozen colours, and a second copy is a second thing to update the day a token
// value changes.
//
// LIGHT ONLY. Every spec that imports this pins `test.use({ colorScheme:
// 'light' })`, matching the precedent in pipelinely-brand.spec.ts — without
// that pin the three-state theme system's "no explicit choice" branch resolves
// against whatever the machine running the suite reports, and every assertion
// below would flip on a dark-mode box.

export const TOKEN = {
  bg: 'rgb(241, 244, 244)', // #f1f4f4
  surface: 'rgb(255, 255, 255)', // #ffffff
  surface2: 'rgb(236, 239, 240)', // #eceff0
  surfaceMute: 'rgb(241, 244, 244)', // #f1f4f4
  border: 'rgb(222, 228, 228)', // #dee4e4
  border2: 'rgb(207, 215, 215)', // #cfd7d7
  ink: 'rgb(28, 36, 38)', // #1c2426
  text2: 'rgb(93, 106, 109)', // #5d6a6d
  text3: 'rgb(102, 115, 117)', // #667375
  accent: 'rgb(109, 148, 168)', // #6d94a8
  accentSoft: 'rgb(227, 236, 240)', // #e3ecf0
  accentInk: 'rgb(51, 86, 106)', // #33566a
  sage: 'rgb(148, 169, 141)', // #94a98d
  sageSoft: 'rgb(230, 236, 227)', // #e6ece3
  sageInk: 'rgb(70, 96, 63)', // #46603f
  amber: 'rgb(189, 154, 99)', // #bd9a63
  amberSoft: 'rgb(243, 235, 221)', // #f3ebdd
  amberInk: 'rgb(109, 83, 38)', // #6d5326
  drift: 'rgb(176, 113, 139)', // #b0718b
  driftSoft: 'rgb(247, 230, 236)', // #f7e6ec
  driftInk: 'rgb(138, 63, 92)', // #8a3f5c
  grid: 'rgb(226, 232, 232)', // #e2e8e8
} as const

// The design's page wrapper, verbatim:
//   max-width:1180px; margin:0 auto; padding:14px clamp(16px,2.6vw,32px) 64px
// (Pipelinely Dashboard v2.dc.html line 133, Pipelinely Pipeline.dc.html line
// 125, Pipelinely Milestone.dc.html — all three pages share it).
export const PAGE_COLUMN = {
  maxWidth: '1180px',
  paddingTop: '14px',
  paddingBottom: '64px',
} as const

// Viewports the design itself is specified at. 860px is the design's ONE
// breakpoint (README "Responsive rule"); 641px is this repo's own extra
// breakpoint for the compact stepper, which is deliberately kept (see
// docs/design-drift.md, DRIFT-2).
export const DESKTOP = { width: 1280, height: 900 }
export const NARROW = { width: 900, height: 900 }
export const MOBILE = { width: 375, height: 812 }

// Wide enough that the 240px sidebar plus the 1180px column plus its gutters
// still leave slack on both sides. At DESKTOP (1280px) the main area is only
// 1040px, so the column fills it edge to edge and "is it centred?" has no
// observable answer — every centring assertion would pass vacuously. 1600px
// leaves ~90px of slack per side, which is what makes the check real.
export const WIDE = { width: 1600, height: 900 }

// At a 1280px-wide viewport the gutter's `2.6vw` term is 33.28px, so the
// clamp pins to its 32px maximum. Pinning the viewport is what makes this a
// single expected value rather than a range.
export const DESKTOP_GUTTER = '32px'

// Reads one resolved CSS property off the first match of `selector`.
// Playwright's own `evaluate` is per-locator, so this is the one-line shape
// every spec below would otherwise repeat inline.
export async function cssOf(
  locator: import('@playwright/test').Locator,
  property: string
): Promise<string> {
  return locator.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property
  )
}
