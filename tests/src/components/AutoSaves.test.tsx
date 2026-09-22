import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { loadPackage } from '../../../prototype/package';
import { restoreSnapshot } from '../../../prototype/replay';
import { MemoryWorld } from '../../../prototype/world';
import { jest } from '@jest/globals';
import type { SaveHead } from '../../../src/lib/autosaves';

// ESM mocks apply only to modules imported after registration.
jest.unstable_mockModule('../../../src/lib/autosaves', () => ({
  catalogue: jest.fn(),
  continuePlayback: jest.fn(),
  playSlot: jest.fn(),
  replaceTimeline: jest.fn(),
  restoreSlot: jest.fn(),
  saveChunk: jest.fn(),
}));
// Collect the hook's effects so the test can run them without a DOM renderer.
const effects: React.EffectCallback[] = [];
jest.unstable_mockModule('react', () => ({
  ...React,
  default: React,
  useEffect: (effect: React.EffectCallback) => void effects.push(effect),
}));

test('full room recordings save partial batches continuously and retain progress on write failure', async () => {
  const { saveChunk } = await import('../../../src/lib/autosaves');
  const { useAutoSaves } = await import('../../../src/components/AutoSaves');
  const read = async (path: string) =>
    JSON.parse(
      readFileSync(
        path.startsWith('maps/')
          ? `src/content/remaining-time/${path}`
          : `public/content/remaining-time/${path}`,
        'utf8',
      ),
    );
  const content = await loadPackage(await read('manifest.json'), read);
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  const cleanups: (() => void)[] = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  jest.useFakeTimers();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {} } });
  const save = jest.mocked(saveChunk);
  let head: SaveHead = { revision: 'empty', slot: 0, sequence: 0 };
  save.mockImplementation(async (run, expected) => {
    expect(expected).toEqual(head);
    expect(run.startSequence ?? 0).toBe(head.sequence);
    head = {
      revision: `saved-${head.slot + 1}`,
      slot: head.slot + 1,
      sequence: head.sequence + run.eventCount,
    };
    return head;
  });
  let controls!: ReturnType<typeof useAutoSaves>;
  function Harness() {
    controls = useAutoSaves(
      world,
      true,
      head,
      () => {},
      () => {},
    );
    return null;
  }
  const fill = () => {
    for (let i = 0; i < 1000 && !world.recordingCapacityReached(); i++) world.advance(1);
    expect(world.recordingCapacityReached()).toBe(true);
    expect(world.recordingStats().eventCount).toBeGreaterThan(0);
    expect(world.recordingStats().eventCount).toBeLessThan(1000);
  };
  try {
    renderToStaticMarkup(<Harness />);
    for (const effect of effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    for (let i = 0; i < 599; i++) expect(world.step(100).ok).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    expect(world.step(100).ok).toBe(true);
    const idleEndpoint = world.inspect();
    let finishWrite!: () => void;
    save.mockImplementationOnce(
      (run, expected) =>
        new Promise((resolve) => {
          finishWrite = () => {
            head = { revision: 'idle-save', slot: 1, sequence: expected.sequence + run.eventCount };
            resolve(head);
          };
        }),
    );
    await jest.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].eventCount).toBeLessThan(10);
    expect(world.step(17).ok).toBe(true);
    finishWrite();
    await jest.advanceTimersByTimeAsync(0);
    expect(restoreSnapshot(save.mock.calls[0][0]).inspect()).toEqual(idleEndpoint);
    expect(world.inspect().time).toBe(idleEndpoint.time + 17);
    expect(world.recordingStats().pendingMs).toBe(17);
    expect(world.recordingStats().elapsedMs).toBe(17);

    for (let batch = 0; batch < 2; batch++) {
      fill();
      const before = world.inspect();
      const end = world.recordingStats().end;
      await jest.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(batch + 2);
      expect(head.sequence).toBe(end);
      expect(world.recordingStats().eventCount).toBe(0);
      expect(world.recordingCapacityReached()).toBe(false);
      expect(world.inspect()).toEqual(before);
      expect(restoreSnapshot(save.mock.calls[batch + 1][0]).inspect()).toEqual(before);
      expect(world.advance(1).ok).toBe(true);
    }
    fill();
    const stats = world.recordingStats();
    const before = world.inspect();
    save.mockRejectedValueOnce(new Error('Disk full'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(4);
    expect(world.recordingStats()).toEqual(stats);
    expect(world.inspect()).toEqual(before);
    expect(world.recordingCapacityReached()).toBe(true);

    // Manual saving retries failures and also persists progress below automatic thresholds.
    const manual = controls.menu.props.children[0];
    await manual.props.onClick();
    expect(world.recordingStats().eventCount).toBe(0);
    expect(world.recordingCapacityReached()).toBe(false);
    world.step(17);
    const endpoint = world.inspect();
    await manual.props.onClick();
    expect(world.recordingStats().pendingMs).toBe(0);
    expect(restoreSnapshot(save.mock.calls.at(-1)![0]).inspect()).toEqual(endpoint);
    const savedCount = save.mock.calls.length;
    await manual.props.onClick();
    expect(save).toHaveBeenCalledTimes(savedCount);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}, 30000);
