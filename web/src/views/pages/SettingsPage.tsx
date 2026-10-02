import { useEffect, useState, type ChangeEvent } from 'react'
import { postAutoMode } from '../../api/actions'
import { useAutoSubmit } from '../../data/autoSubmit'
import { useSnapshot } from '../../data/snapshot'
import { FullPage } from './FullPage'

// A real page (own /settings URL, board hidden behind it), not a popup: the
// only place auto mode's state can be changed, so it needs to read as a
// destination, not a transient overlay.
export function SettingsPage() {
  const { data } = useSnapshot()
  const { hasRemoteSession } = useAutoSubmit()
  const snapshotAutoMode = data?.settings.autoMode ?? false

  // The switch answers the click immediately, before the server has
  // confirmed. `requestedAutoMode` holds that unconfirmed value: a failed
  // write clears it (reverting to what the server last reported), and it
  // also clears once a snapshot agrees — after which the snapshot is the
  // source of truth again, including for a change made from a second open
  // tab.
  const [requestedAutoMode, setRequestedAutoMode] = useState<boolean | null>(null)
  const displayedAutoMode = requestedAutoMode ?? snapshotAutoMode

  useEffect(() => {
    if (requestedAutoMode !== null && requestedAutoMode === snapshotAutoMode) setRequestedAutoMode(null)
  }, [requestedAutoMode, snapshotAutoMode])

  const handleAutoModeChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked
    setRequestedAutoMode(next)
    if (!(await postAutoMode(next, { fetchImpl: fetch, log: console.error }))) setRequestedAutoMode(null)
  }

  return (
    <FullPage pageId="settings-page" title="Settings">
      <div className="page-row">
        <div className="page-row-text">
          <span className="page-row-label">Auto mode</span>
          <span className="page-row-desc">Automatically advance mechanical pipeline handoffs — dev → CR → QA — without a manual click. Triage decisions and merge always wait for you.</span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            id="settings-auto-mode-switch"
            data-testid="settings-auto-mode-switch"
            aria-label="Toggle auto mode"
            checked={displayedAutoMode}
            onChange={handleAutoModeChange}
          />
          <span className="switch-track"><span className="switch-thumb" /></span>
        </label>
      </div>
      {hasRemoteSession && (
        // A real form post, not a fetch: the server answers with a redirect to
        // the login page and clears the cookie in one navigation.
        <form className="page-row" method="post" action="/remote-logout">
          <div className="page-row-text">
            <span className="page-row-label">Remote session</span>
            <span className="page-row-desc">This device is signed in with the remote-access token. Sign out to require the token again.</span>
          </div>
          <button type="submit" data-testid="remote-logout-btn">Sign out of this device</button>
        </form>
      )}
    </FullPage>
  )
}
