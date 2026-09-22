import { jest } from '@jest/globals';
import asset from '../../../public/assets/room-npcs/rowan.json';
import { loadRoomNpcAsset, roomNpcFrame, roomNpcId } from '../../../src/lib/roomNpcAnimation';

test('NPC animation stays on the selected action and uses per-frame durations', () => {
  expect(roomNpcId('assets/room-npcs/rowan-idle.png')).toBe('rowan');
  expect(roomNpcId('assets/low-kitchen/stove.png')).toBeUndefined();
  expect(roomNpcFrame(asset, 'idle', 1000)).toBe('idle-1');
  expect(roomNpcFrame(asset, 'idle', 5800)).toBe('idle-1');
  expect(roomNpcFrame(asset, 'idle', 8000)).toBe('idle-0');
  expect(roomNpcFrame(asset, 'talk', 220)).toBe('talk-1');
  expect(roomNpcFrame(asset, 'talk', 880)).toBe('talk-0');
  expect(roomNpcFrame(asset, 'duty-1', 240)).toBe('duty-1-1');
  const once = structuredClone(asset);
  once.animations.talk.loop = false;
  expect(roomNpcFrame(once, 'talk', 880)).toBe('talk-3');
});

test('NPC metadata loading rejects invalid animation timings', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(asset)));
    const signal = new AbortController().signal;
    expect(await loadRoomNpcAsset('rowan', '/ai-town/', signal)).toEqual(asset);
    expect(fetch).toHaveBeenCalledWith('/ai-town/assets/room-npcs/rowan.json', { signal });
    const invalid = structuredClone(asset);
    invalid.animations.idle.duration = 0;
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(invalid)));
    await expect(loadRoomNpcAsset('rowan', '/ai-town/', signal)).rejects.toThrow(
      'Invalid NPC animation',
    );
  } finally {
    fetch.mockRestore();
  }
});
