import { randomUUID } from 'node:crypto'
import { execa } from 'execa'
import { detectApprovalPrompt } from './approvalPrompt.js'
import { productionApprovalWatchDeps } from './approvalWatch.js'
import {
  isStrayShellCommand,
  readPaneState,
  sendKeysToPane,
  TMUX_WRITE_TIMEOUT_MS,
  SAFE_TMUX_SESSION_NAME,
} from './focusTab.js'

export type TmuxPaneWriteRefusal =
  | 'unsafe-session-name'
  | 'unsafe-text'
  | 'no-pane'
  | 'stray-shell'
  | 'pane-in-mode'
  | 'no-bracketed-paste'
  | 'dialog-open'

export type TmuxPaneWriteStep = 'resolve' | 'capture' | 'load' | 'paste' | 'submit'

export type TmuxPaneWriteResult =
  | { status: 'ok'; paneId: string }
  | { status: 'refused'; reason: TmuxPaneWriteRefusal }
  | { status: 'failed'; step: TmuxPaneWriteStep; error: string }

// C0 controls other than LF and TAB, plus DEL. An ESC could close the
// bracketed paste early (`\e[201~`) and let the rest be typed raw; a bare CR
// is a submit.
const UNSAFE_TEXT_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(step: TmuxPaneWriteStep, session: string, error: unknown, note = ''): TmuxPaneWriteResult {
  const message = errorMessage(error)
  console.error(`[tmuxPaneWrite] ${step} failed for ${session}${note}: ${message}`)
  return { status: 'failed', step, error: message }
}

// Every refusal is logged: the server log is the only signal that, say,
// Claude Code never turned bracketed paste on.
function refuse(reason: TmuxPaneWriteRefusal, session: string): TmuxPaneWriteResult {
  console.error(`[tmuxPaneWrite] refused to write to ${session}: ${reason}`)
  return { status: 'refused', reason }
}

async function isDialogShowing(paneId: string): Promise<boolean> {
  return detectApprovalPrompt(await productionApprovalWatchDeps.capturePane(paneId)) !== null
}

async function deleteBufferQuietly(bufferName: string): Promise<void> {
  try {
    await execa('tmux', ['delete-buffer', '-b', bufferName], { timeout: TMUX_WRITE_TIMEOUT_MS })
  } catch (error) {
    console.error(`[tmuxPaneWrite] could not delete leftover buffer ${bufferName}: ${errorMessage(error)}`)
  }
}

// Types `text` into the active pane of the tmux session `session` as one
// bracketed paste, optionally followed by Enter as its own keystroke. Never
// uses a shell: every tmux call is argv, the text travels on stdin, and the
// pane is pinned by its `%N` id after one snapshot. Never retries and never
// falls back to anything — a refusal or failure is the caller's to surface.
export async function writeTextToTmuxSession(
  session: string,
  text: string,
  options: { submit: boolean },
): Promise<TmuxPaneWriteResult> {
  if (!SAFE_TMUX_SESSION_NAME.test(session)) return refuse('unsafe-session-name', session)
  if (UNSAFE_TEXT_CHARS.test(text)) return refuse('unsafe-text', session)

  let pane
  try {
    pane = await readPaneState(session)
  } catch (error) {
    return fail('resolve', session, error)
  }
  if (!pane) return refuse('no-pane', session)

  if (isStrayShellCommand(pane.command)) return refuse('stray-shell', session)
  if (pane.isInMode) return refuse('pane-in-mode', session)
  if (!pane.hasBracketedPaste) return refuse('no-bracketed-paste', session)

  try {
    if (await isDialogShowing(pane.paneId)) return refuse('dialog-open', session)
  } catch (error) {
    return fail('capture', session, error)
  }

  const bufferName = `cockpit-dispatch-${randomUUID()}`
  try {
    await execa('tmux', ['load-buffer', '-b', bufferName, '-'], { input: text, timeout: TMUX_WRITE_TIMEOUT_MS })
  } catch (error) {
    return fail('load', session, error)
  }

  try {
    // -p brackets the paste, -r keeps LF as LF, -d drops the buffer. Never
    // -S: without it tmux itself neutralizes ESC/DEL, a second layer behind
    // the unsafe-text refusal above.
    await execa('tmux', ['paste-buffer', '-p', '-d', '-r', '-b', bufferName, '-t', pane.paneId], { timeout: TMUX_WRITE_TIMEOUT_MS })
  } catch (error) {
    // -d only deletes on success, so a failed paste leaves the text behind.
    await deleteBufferQuietly(bufferName)
    return fail('paste', session, error)
  }

  if (!options.submit) return { status: 'ok', paneId: pane.paneId }

  // A mid-turn claude can open a permission dialog between the first check
  // and now; a bare Enter would pick its highlighted option. If the re-check
  // itself fails, Enter is withheld too: we cannot tell, so we do not press.
  try {
    if (await isDialogShowing(pane.paneId)) {
      return fail('submit', session, new Error('staged, not sent: a dialog opened after the paste'))
    }
  } catch (error) {
    return fail('submit', session, new Error(`staged, not sent: could not re-check for a dialog (${errorMessage(error)})`))
  }

  try {
    await sendKeysToPane(pane.paneId, ['Enter'])
  } catch (error) {
    return fail('submit', session, error, ' (the paste landed; Enter may or may not have been pressed)')
  }
  return { status: 'ok', paneId: pane.paneId }
}
