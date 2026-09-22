import { loadContent } from '../../prototype/content';
import { validateVisual, visualPlacement } from '../../prototype/assets';
import { MemoryWorld } from '../../prototype/world';
import { replayRecording } from '../../prototype/replay';
import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';

test('JSON visual sizing, anchors and offsets share one placement rule', () => {
  const visual = {
    image: 'assets/objects/cup.png',
    size: [24, 32],
    anchor: [0.5, 1],
    offset: [3, -8],
  };
  validateVisual(visual);
  const placement = visualPlacement(visual, [80, 96], 105);
  expect(placement).toEqual({
    x: 83,
    y: 88,
    anchor: { x: 0.5, y: 1 },
    width: 24,
    height: 32,
    zIndex: 105,
  });
  expect(placement.x - placement.anchor.x * placement.width!).toBe(71);
  expect(placement.y - placement.anchor.y * placement.height!).toBe(56);
});

test('new sprite entities load and interact without registering a character name', () => {
  const scenes = structuredClone([room, corridor]);
  const target = scenes[0].entities.find((e) => e.id === 'n07')!;
  Object.assign(target, {
    character: 'sprite',
    sprite: { image: 'assets/objects/cup.png', size: [24, 32], anchor: [0.5, 1], offset: [16, 32] },
  });
  const pack = loadContent(scenes, story);
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(pack.scenes, pack.story, pack.npcs);
  world.execute({ requestId: 'move', type: 'move', dx: 1, dy: 0 });
  world.advance(1000);
  expect(world.execute({ requestId: 'talk', type: 'interact', target: 'n07' }).ok).toBe(true);
  expect(replayRecording(world.recording()).inspect()).toEqual(world.inspect());
  for (const override of [
    { size: [0, 32] },
    { size: [4096, 1] },
    { anchor: [2, 0] },
    { offset: [NaN, 0] },
    { offset: [0] },
    { image: 'assets/../secret.png' },
  ]) {
    const bad = structuredClone(scenes);
    Object.assign((bad[0].entities[0] as any).sprite, override);
    expect(() => loadContent(bad, story)).toThrow();
  }
  const missing = structuredClone(scenes);
  delete (missing[0].entities[0] as any).sprite;
  expect(() => loadContent(missing, story)).toThrow('Sprite visual required');
});
