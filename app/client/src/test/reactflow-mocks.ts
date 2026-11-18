/**
 * The browser pieces React Flow and Radix need that jsdom lacks, after React
 * Flow's testing guide (reactflow.dev/learn/advanced-use/testing): a
 * ResizeObserver that reports each element once, DOMMatrixReadOnly for the
 * zoom, element sizes from their inline style, getBBox, and pointer capture
 * and scrollIntoView for Radix Select. Runs once per test file.
 *
 * Click boxes and links on the canvas with fireEvent.click, not user-event:
 * user-event's mousedown has no event.view, which d3-zoom's pan handler reads.
 */
class ResizeObserverMock implements ResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    // React Flow 12.12 reads contentRect and Radix reads borderBoxSize, which the testing guide's entry leaves out.
    const contentRect = target.getBoundingClientRect();
    const size = [{ inlineSize: contentRect.width, blockSize: contentRect.height }];
    const entry = { target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
    setTimeout(() => this.callback([entry], this), 0);
  }

  unobserve(): void {}

  disconnect(): void {}
}

class DOMMatrixReadOnlyMock {
  m22: number;

  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

function pixels(value: string): number {
  const n = Number(value.replace("px", ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

let installed = false;

export function mockReactFlow(): void {
  if (installed) return;
  installed = true;
  Object.defineProperty(window, "ResizeObserver", { value: ResizeObserverMock, configurable: true, writable: true });
  Object.defineProperty(window, "DOMMatrixReadOnly", { value: DOMMatrixReadOnlyMock, configurable: true, writable: true });
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return pixels(this.style.height);
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return pixels(this.style.width);
      },
    },
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
  for (const name of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
    if (!(name in Element.prototype)) Object.defineProperty(Element.prototype, name, { configurable: true, value: () => false });
  }
  if (!("scrollIntoView" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  }
}
