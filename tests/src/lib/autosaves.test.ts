import { randomUUID } from 'node:crypto';
import { MemoryWorld } from '../../../prototype/world';
import { catalogue, playSlot, restoreSlot, saveChunk } from '../../../src/lib/autosaves';
import room from '../../../content/scenes/room.json';
import corridor from '../../../content/scenes/corridor.json';
import story from '../../../content/story.json';

jest.mock('../../../src/lib/localMode', () => ({ saveDirectory: 'test-saves' }));

test('storage writes two-endpoint segments, restores old files, and rejects corruption before publishing', async () => {
  const files = new Map<string, string>();
  const directory = {
    getDirectoryHandle: async () => directory,
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create)
        throw new DOMException('Missing file', 'NotFoundError');
      return {
        getFile: async () => new Blob([files.get(name)!]),
        createWritable: async () => {
          let text = '';
          return {
            write: async (value: string) => {
              text = value;
            },
            close: async () => {
              files.set(name, text);
            },
            abort: async () => {},
          };
        },
      };
    },
    removeEntry: async (name: string) => {
      files.delete(name);
    },
  };
  const descriptors = ['navigator', 'crypto'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: { getDirectory: async () => directory },
      locks: { request: async (_: string, work: () => unknown) => work() },
    },
  });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID } });
  try {
    const world = new MemoryWorld(
      () => 1,
      () => 0,
    );
    world.load([room, corridor], story);
    let head = (await catalogue()).head;
    world.step(100);
    const first = world.recording();
    head = await saveChunk(first, head);
    world.releaseRecording(head.sequence);
    world.step(200);
    const second = world.recording();
    head = await saveChunk(second, head);
    const slots = (await catalogue()).slots;
    for (const slot of slots) {
      const run = JSON.parse(files.get(slot.file)!);
      expect(run.format).toBe('remaining-time-run-delta-2');
      expect(run.initialState).toBeDefined();
      expect(run.finalState).toBeDefined();
      expect(run.events.every((event: object) => !Object.hasOwn(event, 'state'))).toBe(true);
    }
    const playback = await playSlot(2, head);
    expect(playback.replay.world.inspect()).toEqual(first.finalState);
    playback.replay.seek(playback.replay.total);
    expect(playback.replay.world.inspect()).toEqual(second.finalState);
    const original = files.get(slots[1].file)!;
    const corrupt = JSON.parse(original);
    corrupt.finalState.balance++;
    files.set(slots[1].file, JSON.stringify(corrupt));
    const manifest = files.get('manifest.json');
    await expect(restoreSlot(2, head)).rejects.toThrow('endpoint mismatch');
    expect(files.get('manifest.json')).toBe(manifest);
    files.set(slots[1].file, original);

    // Files from the full-state format can be upgraded using the preceding endpoint.
    for (const [i, run] of [first, second].entries())
      files.set(
        slots[i].file,
        JSON.stringify({ ...run, initialState: undefined, snapshot: undefined }),
      );
    const restored = await restoreSlot(2, head);
    expect(restored.world.inspect()).toEqual(world.inspect());
    expect(JSON.parse(files.get(slots[1].file)!).format).toBe('remaining-time-run-delta-2');
    expect((await catalogue()).head).toEqual(restored.head);
  } finally {
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
