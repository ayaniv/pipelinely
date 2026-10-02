import { useLayoutEffect } from 'react'

// Holds a class on <body> for as long as the calling component is mounted and
// `isOn` — the hook behind CSS that hides the board while a full page or a
// task detail is open (`body.full-page-open #board`, `body.detail-open #board`).
// A layout effect: no painted frame with the board still showing behind the
// page that just opened.
export function useBodyClass(className: string, isOn = true): void {
  useLayoutEffect(() => {
    if (!isOn) return
    document.body.classList.add(className)
    return () => document.body.classList.remove(className)
  }, [className, isOn])
}
