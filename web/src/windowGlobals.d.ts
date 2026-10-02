// The one page global the app exposes: the SSE connection, so end-to-end specs
// can push a snapshot through the same `onmessage` handler a real SSE message
// takes (see data/sseBridge.ts and e2e/fixtures/snapshotStub.ts).
declare global {
  interface Window {
    es?: EventSource
  }
}

export {}
