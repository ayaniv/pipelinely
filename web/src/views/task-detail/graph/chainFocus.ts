// Which way an arrow key moves focus along the stage chain. The chain lays out
// left to right in an LTR document and right to left in an RTL one (the
// dashboard renders Hebrew content), so "next" follows the reading direction.
export type TextDirection = 'ltr' | 'rtl'

export function focusStepForKey(key: string, direction: TextDirection): -1 | 0 | 1 {
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return 0
  const isRightward = key === 'ArrowRight'
  return isRightward === (direction === 'ltr') ? 1 : -1
}
