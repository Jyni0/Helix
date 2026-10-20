import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Node's own (file-less) localStorage shadows jsdom's: use an in-memory one.
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}
if (!globalThis.localStorage || typeof globalThis.localStorage.clear !== "function") {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

Object.assign(navigator, { clipboard: { writeText: async () => {}, readText: async () => "" } });

// jsdom has no layout engine: give elements a size so the virtualized list renders rows.
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get: () => 900 },
  offsetWidth: { configurable: true, get: () => 360 },
  clientHeight: { configurable: true, get: () => 900 },
  clientWidth: { configurable: true, get: () => 360 },
});
Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, bottom: 900, right: 360, width: 360, height: 900, toJSON: () => ({}) } as DOMRect;
};
Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo;

class ResizeObserverStub {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    // Report one size right away (the virtualized lists need one).
    const entry = { target, contentRect: target.getBoundingClientRect(), borderBoxSize: [{ inlineSize: 360, blockSize: 900 }], contentBoxSize: [{ inlineSize: 360, blockSize: 900 }] };
    this.cb([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

window.matchMedia ??= vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

// CodeMirror measures text through Range rects, which jsdom lacks.
Range.prototype.getClientRects = function () {
  return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
};
Range.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
};
