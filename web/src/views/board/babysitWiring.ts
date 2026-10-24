// The one place that says whether the Push forward toolbar control is real.
// `pushForward()` submits the /pipelinely-babysit skill through POST /babysit, so
// the pill renders. Call sites ask this, never a raw value; turning the pill
// off again stays a one-line change here.
const BABYSIT_WIRED = true

export function isBabysitWired(): boolean {
  return BABYSIT_WIRED
}
