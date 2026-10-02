import type { ConnectionStatus } from '../../data/connectionStatus'

// What a board panel shows until its first snapshot arrives. Without it the
// Backlog/Done/You panels would render nothing (not even the empty state) and
// the badges would read 0 — indistinguishable from a genuinely empty board,
// which is exactly what a server restart or a failed /api/tasks used to look
// like. A stream that is retrying with no snapshot in hand is an error the
// developer must be able to see; anything else is just still loading.

export function SnapshotPlaceholder({ connection }: { connection: ConnectionStatus }) {
  if (connection === 'reconnecting') {
    return <div className="board-empty-state" role="alert" data-testid="snapshot-error">Can't reach the server — retrying…</div>
  }
  return <div className="board-empty-state" role="status" data-testid="snapshot-loading">Loading…</div>
}
