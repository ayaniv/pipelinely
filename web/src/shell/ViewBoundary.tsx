import { Component, type ReactNode } from 'react'

export interface ViewBoundaryProps {
  view: string
  children: ReactNode
  // Visible content for the crashed state; the empty alert stays the default
  // for views whose absence is already obvious.
  fallback?: ReactNode
}

interface ViewBoundaryState {
  hasError: boolean
}

// One boundary per view so a crash in one doesn't
// take the rest of the dashboard down with it — no React error boundary
// can catch a throw inside an event handler or the SSE callback, so
// those stay as observable as they are.
export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ViewBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    console.error(`[view:${this.props.view}] crashed`, error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <div role="alert" data-testid={`view-error-${this.props.view}`}>{this.props.fallback}</div>
    }
    return this.props.children
  }
}
