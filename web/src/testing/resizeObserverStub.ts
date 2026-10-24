// jsdom has no ResizeObserver. A no-op is enough for components that only need
// the constructor to exist (React Flow, the virtualizer).
export class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
