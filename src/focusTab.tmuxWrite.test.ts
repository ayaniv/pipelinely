import { describe, it, expect, beforeEach, vi } from 'vitest'

const execaMock = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa: execaMock }))

import { resolveActivePaneId, sendKeysToPane, TMUX_WRITE_TIMEOUT_MS } from './focusTab.js'

// Every case runs against a mocked execa: nothing here can reach a real tmux.
describe('sendKeysToPane', () => {
  beforeEach(() => {
    execaMock.mockReset()
    execaMock.mockResolvedValue({ stdout: '' })
  })

  it('runs exactly `tmux send-keys -t %3 -l 1` as argv with a timeout and no shell', async () => {
    await sendKeysToPane('%3', ['-l', '1'])
    expect(execaMock).toHaveBeenCalledTimes(1)
    expect(execaMock).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '%3', '-l', '1'], { timeout: TMUX_WRITE_TIMEOUT_MS })
    expect(execaMock.mock.calls[0][2]).not.toHaveProperty('shell')
  })

  it.each(['=worker-x:', '%3; rm -rf /', 'worker-x', '%', '%3 ', ''])('refuses the target %j without calling tmux', async (target) => {
    await expect(sendKeysToPane(target, ['Escape'])).rejects.toThrow(/pane id/)
    expect(execaMock).not.toHaveBeenCalled()
  })

  it('propagates a tmux failure to the caller', async () => {
    execaMock.mockRejectedValue(new Error('tmux: no such pane'))
    await expect(sendKeysToPane('%3', ['Escape'])).rejects.toThrow('tmux: no such pane')
  })
})

describe('resolveActivePaneId', () => {
  beforeEach(() => {
    execaMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('asks for the pane id of the exactly-named session and parses it', async () => {
    execaMock.mockResolvedValue({ stdout: '%12\n' })
    expect(await resolveActivePaneId('worker-foo')).toBe('%12')
    expect(execaMock).toHaveBeenCalledWith('tmux', ['display-message', '-p', '-t', '=worker-foo:', '#{pane_id}'], { timeout: TMUX_WRITE_TIMEOUT_MS })
  })

  it('returns null and logs when tmux fails', async () => {
    execaMock.mockRejectedValue(new Error("can't find session"))
    expect(await resolveActivePaneId('worker-foo')).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })

  it('returns null when the output is not a pane id', async () => {
    execaMock.mockResolvedValue({ stdout: 'garbage' })
    expect(await resolveActivePaneId('worker-foo')).toBeNull()
  })

  it('returns null without calling tmux for an unsafe session name', async () => {
    expect(await resolveActivePaneId('worker-foo; rm')).toBeNull()
    expect(execaMock).not.toHaveBeenCalled()
  })
})
