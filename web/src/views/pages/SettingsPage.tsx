import type { ChangeEvent } from 'react'
import { postAutoMode, postCreaturePlacement, postQaStartPolicy, postWeeklyFocusEnabled } from '../../api/actions'
import { DEFAULT_QA_START_POLICY } from '../../../../src/nextAction'
import type { CreaturePlacement, QaStartPolicy } from '../../../../src/types'
import { useCreaturePlacement } from '../../data/creaturePlacement'
import { useWeeklyFocusEnabled } from '../../data/weeklyFocusEnabled'
import { useAutoSubmit } from '../../data/autoSubmit'
import { useSnapshot } from '../../data/snapshot'
import { FullPage } from './FullPage'
import { useOptimisticSetting } from './useOptimisticSetting'

const postOptions = { fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args), log: (...args: Parameters<typeof console.error>) => console.error(...args) }
const saveAutoMode = (next: boolean) => postAutoMode(next, postOptions)
const saveCreaturePlacement = (next: CreaturePlacement) => postCreaturePlacement(next, postOptions)
const saveWeeklyFocusEnabled = (next: boolean) => postWeeklyFocusEnabled(next, postOptions)
const saveQaStartPolicy = (next: QaStartPolicy) => postQaStartPolicy(next, postOptions)

// A real page (own /settings URL, board hidden behind it), not a popup: the
// only place auto mode's state can be changed, so it needs to read as a
// destination, not a transient overlay.
export function SettingsPage() {
  const { data } = useSnapshot()
  const { hasRemoteSession } = useAutoSubmit()
  const snapshotAutoMode = data?.settings.autoMode ?? false
  const creaturePlacement = useCreaturePlacement()
  const isWeeklyFocusEnabled = useWeeklyFocusEnabled()
  // A server that predates the setting reports none, which means ask.
  const snapshotQaStartPolicy = data?.settings.qaStartPolicy ?? DEFAULT_QA_START_POLICY

  const [displayedAutoMode, requestAutoMode] = useOptimisticSetting(snapshotAutoMode, saveAutoMode)
  const [displayedPlacement, requestPlacement] = useOptimisticSetting(creaturePlacement, saveCreaturePlacement)
  const [displayedQaStartPolicy, requestQaStartPolicy] = useOptimisticSetting(snapshotQaStartPolicy, saveQaStartPolicy)
  const [displayedWeeklyFocusEnabled, requestWeeklyFocusEnabled] = useOptimisticSetting(isWeeklyFocusEnabled, saveWeeklyFocusEnabled)

  const handleAutoModeChange = (event: ChangeEvent<HTMLInputElement>) => requestAutoMode(event.target.checked)
  const handleQaStartPolicyChange = (event: ChangeEvent<HTMLInputElement>) => requestQaStartPolicy(event.target.checked ? 'cockpit-ai-ui-preapproved' : 'ask-every-time')
  const handleCreaturesChange = (event: ChangeEvent<HTMLInputElement>) => requestPlacement(event.target.checked ? 'header' : 'off')
  const handleWeeklyFocusChange = (event: ChangeEvent<HTMLInputElement>) => requestWeeklyFocusEnabled(event.target.checked)

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
      <div className="page-row">
        <div className="page-row-text">
          <span className="page-row-label">Start QA without asking</span>
          <span className="page-row-desc">Let unattended runs start QA for cockpit-ai tasks whose VERIFY runs only the Playwright ui project — never integration or vm. Off means QA asks every time. This is the only thing that counts as that consent.</span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            id="settings-qa-preapproval-switch"
            data-testid="settings-qa-preapproval-switch"
            aria-label="Toggle starting QA without asking"
            checked={displayedQaStartPolicy === 'cockpit-ai-ui-preapproved'}
            onChange={handleQaStartPolicyChange}
          />
          <span className="switch-track"><span className="switch-thumb" /></span>
        </label>
      </div>
      <div className="page-row">
        <div className="page-row-text">
          <span className="page-row-label">Task creatures</span>
          <span className="page-row-desc">Give every task a small, permanent creature so you can tell your sessions apart at a glance.</span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            id="settings-creatures-switch"
            data-testid="settings-creatures-switch"
            aria-label="Toggle task creatures"
            checked={displayedPlacement === 'header'}
            onChange={handleCreaturesChange}
          />
          <span className="switch-track"><span className="switch-thumb" /></span>
        </label>
      </div>
      <div className="page-row">
        <div className="page-row-text">
          <span className="page-row-label">Weekly focus</span>
          <span className="page-row-desc" data-testid="settings-weekly-focus-description">Show the &ldquo;focus for this week&rdquo; pane and check new tasks against it. Turn off to hide the pane and skip the &ldquo;does this fit the focus&rdquo; check.</span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            id="settings-weekly-focus-switch"
            data-testid="settings-weekly-focus-switch"
            aria-label="Toggle weekly focus"
            checked={displayedWeeklyFocusEnabled}
            onChange={handleWeeklyFocusChange}
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
