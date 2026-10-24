import { useSnapshot } from './snapshot'

// The one place a call site asks "is the weekly-focus pane on?". On before the
// first snapshot lands, for a server that predates the setting, and for any
// non-boolean value — the same fail-open direction as the server's own parse.
export function useWeeklyFocusEnabled(): boolean {
  const { data } = useSnapshot()
  const weeklyFocusEnabled: unknown = data?.settings.weeklyFocusEnabled
  return typeof weeklyFocusEnabled === 'boolean' ? weeklyFocusEnabled : true
}
