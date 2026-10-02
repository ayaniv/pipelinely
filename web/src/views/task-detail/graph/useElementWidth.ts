import { useEffect, useRef, useState, type RefObject } from 'react'

// Tracks an element's content-box width with a ResizeObserver rather than a
// window resize listener: the graph needs its *container's* width, which
// changes for reasons a window resize never reports (a sidebar toggling, the
// stepper's own media query un-hiding it). 0 until first measured.
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const elementRef = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    setWidth(Math.floor(element.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [elementRef, width]
}
