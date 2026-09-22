import { jest } from '@jest/globals';
import { observeElementSize } from '../../../src/hooks/useElementSize';

test('remeasures container changes without a window resize and disconnects', () => {
  const original = globalThis.ResizeObserver;
  let notify: () => void = () => {};
  const observe = jest.fn();
  const disconnect = jest.fn();
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      notify = callback;
    }
    observe = observe;
    disconnect = disconnect;
    unobserve = jest.fn();
  } as unknown as typeof ResizeObserver;
  try {
    const element = { clientWidth: 800, clientHeight: 480 };
    const update = jest.fn();
    const cleanup = observeElementSize(element as HTMLElement, update);
    expect(observe).toHaveBeenCalledWith(element);
    expect(update).toHaveBeenLastCalledWith({ width: 800, height: 480 });
    element.clientWidth = 1184;
    notify();
    expect(update).toHaveBeenLastCalledWith({ width: 1184, height: 480 });
    element.clientWidth = 800;
    element.clientHeight = 600;
    notify();
    expect(update).toHaveBeenLastCalledWith({ width: 800, height: 600 });
    cleanup();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.ResizeObserver = original;
  }
});
