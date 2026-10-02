import { useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Logger } from '../log'

// A portal into an element the app frame (shell/AppFrame.tsx) owns — how a
// view renders inside a region of the page whose surrounding layout belongs to
// the frame (the sidebar's tab bar, the header's chrome, a panel's body)
// without the frame having to know what goes in it. The container's id is the
// whole contract.
//
// `classToggles` covers CSS that keys off a class on the container itself
// (e.g. #global-progress's `is-visible`) — applied in a layout effect so there
// is no painted frame with the old state, and reverted on unmount so the
// container goes back to what the frame declared.

export interface FrameSlotProps {
  containerId: string
  children: ReactNode
  classToggles?: Record<string, boolean>
  log?: Logger
}

export function FrameSlot({ containerId, children, classToggles, log = console.error }: FrameSlotProps) {
  const container = document.getElementById(containerId)

  useLayoutEffect(() => {
    if (!container) {
      log('[frame-slot] container not found in the app frame — its view cannot render', containerId)
      return
    }
    const toggles = Object.entries(classToggles ?? {})
    for (const [className, isOn] of toggles) container.classList.toggle(className, isOn)
    return () => {
      for (const [className] of toggles) container.classList.remove(className)
    }
  }, [container, containerId, classToggles, log])

  return container ? createPortal(children, container) : null
}
