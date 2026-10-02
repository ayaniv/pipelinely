// React Flow measures nodes with ResizeObserver and reads a DOMMatrix for its
// viewport transform — neither exists in jsdom. Imported for its side effects
// by every component test that mounts a <ReactFlow>, per React Flow's own
// testing guide. jsdom never reports a real size, so edges (which need
// measured handle bounds) are not drawn in these tests — the browser specs
// in e2e/react-pipeline-graph.spec.ts own that.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22 = 1
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)
    if (scale) this.m22 = Number(scale[1])
  }
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
// @ts-expect-error -- jsdom has no DOMMatrixReadOnly; the stub covers only the m22 scale React Flow reads
globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub

export {}
