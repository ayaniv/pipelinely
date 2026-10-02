import { useConnectionStatus, type ConnectionStatus } from '../../data/connectionStatus'

// The dot's is-live / is-error class, one place so the dot and its halo
// can't disagree. 'connecting' (nothing heard yet) is neither.
function dotClassFor(status: ConnectionStatus): string {
  switch (status) {
    case 'live': return 'is-live'
    case 'reconnecting': return 'is-error'
    case 'connecting': return ''
  }
}

export function LivePill() {
  const status = useConnectionStatus()
  const dotClass = dotClassFor(status)
  return (
    <div className="header-pill header-live" data-testid="header-live">
      <span className="live-dot-wrap">
        <span className={`live-dot ${dotClass}`.trim()} id="live-dot" data-testid="header-live-dot" />
        <span className={`live-dot-halo ${dotClass}`.trim()} id="live-dot-halo" data-testid="header-live-halo" />
      </span>
      <span className={`header-status-text${status === 'live' ? ' is-live' : ''}`} id="connection-status" data-testid="header-live-text">{status}</span>
    </div>
  )
}
