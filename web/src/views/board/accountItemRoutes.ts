import { matchShellRoute, stripTrailingSlash, type ShellRouteId } from '../../shell/routes'

// The one list the type is derived from, so adding an account item cannot
// leave the type and the runtime check disagreeing.
const ACCOUNT_ITEM_IDS = ['settings', 'usage', 'docs', 'help'] as const satisfies readonly ShellRouteId[]
export type AccountItemId = (typeof ACCOUNT_ITEM_IDS)[number]

const isAccountItem = (id: ShellRouteId | null): id is AccountItemId =>
  id !== null && (ACCOUNT_ITEM_IDS as readonly string[]).includes(id)

// Which account-menu item the page at `pathname` is, or null for any other
// page (a board tab, a task, an unknown path). It reads the URL on purpose:
// useActiveBoardTab keeps the last board tab behind overlays like /docs, so
// it can't say which page is actually showing.
export function accountItemForPath(pathname: string): AccountItemId | null {
  const id = matchShellRoute(stripTrailingSlash(pathname))
  return isAccountItem(id) ? id : null
}
