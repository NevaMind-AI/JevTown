import { readFileSync } from 'node:fs';
import { loadPackage } from '../../prototype/package';
import { MemoryWorld } from '../../prototype/world';
import { taskGuidance } from '../../src/lib/taskGuidance';
import { loadContent, mapBlocked, portalAt, Scene } from '../../prototype/content';
import { replayRecording, restoreSnapshot } from '../../prototype/replay';

const readPackage = async (name: string) => {
  const read = async (path: string) =>
    JSON.parse(
      readFileSync(
        /^(maps|animations)\//.test(path)
          ? `src/content/${name}/${path}`
          : `public/content/${name}/${path}`,
        'utf8',
      ),
    );
  return loadPackage(await read('manifest.json'), read);
};

function route(scene: Scene, start: number[], goal: string | number[]) {
  const queue = [[start]],
    seen = new Set([start.join()]);
  const blocked = new Set(scene.entities.filter((e) => !e.portal).map((e) => e.position.join()));
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i],
      [x, y] = path[path.length - 1];
    const door = portalAt(scene, x, y);
    if (typeof goal === 'string' ? door?.id === goal : x === goal[0] && y === goal[1])
      return path.slice(1);
    if (path.length > 1 && door) continue;
    for (const point of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (
        seen.has(point.join()) ||
        blocked.has(point.join()) ||
        mapBlocked(scene.map, point[0], point[1])
      )
        continue;
      seen.add(point.join());
      queue.push([...path, point]);
    }
  }
  throw new Error(`No route through ${scene.id} to ${goal}`);
}

test('all 54 room doors allow entry and return with NPCs present', async () => {
  const content = await readPackage('remaining-time');
  expect(content.scenes).toHaveLength(26);
  expect(content.story.start).toEqual({ scene: 'unit-404', anchor: 'start' });
  expect(content.scenes.find((s) => s.id === 'unit-404')!.map.art).toHaveLength(18);
  let doors = 0;
  for (const scene of content.scenes) {
    for (const door of scene.entities.filter((entity) => entity.portal)) {
      const world = new MemoryWorld();
      world.load(content.scenes, { ...content.story, start: { scene: scene.id, anchor: 'start' } });
      for (const [index, [x, y]] of route(scene, scene.anchors.start, door.id).entries()) {
        const before = world.inspect().player;
        const result = world.execute({
          requestId: String(index),
          type: 'move',
          dx: x - before.x,
          dy: y - before.y,
        });
        if (!result.ok) throw new Error(`${door.id}: ${result.error}`);
        expect(world.advance(1000).ok).toBe(true);
      }
      const destination = content.scenes.find((s) => s.id === door.portal!.scene)!;
      const [x, y] = destination.anchors[door.portal!.anchor];
      expect(world.inspect().sceneId).toBe(destination.id);
      expect(world.inspect().player).toEqual({ x, y });
      const reverse = destination.entities.find(
        (entity) => entity.id === `${destination.id}.${door.portal!.anchor.slice('from-'.length)}`,
      )!;
      for (const [index, [rx, ry]] of route(destination, [x, y], reverse.id).entries()) {
        const before = world.inspect().player;
        const result = world.execute({
          requestId: `return-${index}`,
          type: 'move',
          dx: rx - before.x,
          dy: ry - before.y,
        });
        if (!result.ok) throw new Error(`${reverse.id}: ${result.error}`);
        expect(world.advance(1000).ok).toBe(true);
      }
      expect(world.inspect().sceneId).toBe(scene.id);
      const [returnX, returnY] = scene.anchors[reverse.portal!.anchor];
      expect(world.inspect().player).toEqual({ x: returnX, y: returnY });
      doors++;
    }
  }
  expect(doors).toBe(54);
});

test('404 doorway stays passable without triggering from the approach', async () => {
  const content = await readPackage('remaining-time');
  const room = content.scenes.find((scene) => scene.id === 'unit-404')!;
  expect(mapBlocked(room.map, 19, 33)).toBe(true);
  for (const [x, y] of [
    [3, 26],
    [36, 26],
    [10, 28],
    [19, 28],
  ])
    expect(mapBlocked(room.map, x, y)).toBe(false);
  for (const [x, y] of [
    [2, 26],
    [37, 26],
    [10, 29],
    [14, 28],
    [24, 28],
  ])
    expect(mapBlocked(room.map, x, y)).toBe(true);
  for (let x = 17; x <= 21; x++) {
    for (let y = 29; y <= 32; y++) expect(mapBlocked(room.map, x, y)).toBe(false);
    expect(portalAt(room, x, 30)).toBeUndefined();
    expect(portalAt(room, x, 31)?.id).toBe('unit-404.return');
  }
  expect(room.anchors['from-return']).toEqual([19, 28]);
});

test('404 bed is reachable from spawn, range-gated and supports saved sleep', async () => {
  const content = await readPackage('remaining-time');
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  const bed = 'unit-404.bed';
  expect(world.scene()!.map.art!.some((art) => art.image === 'assets/unit-404/bed.png')).toBe(
    false,
  );
  expect(world.nearby().some((entity) => entity.id === bed)).toBe(false);
  expect(world.execute({ requestId: 'far-bed', type: 'interact', target: bed }).ok).toBe(false);
  let request = 0;
  for (const [x, y] of [
    [8, 25],
    [8, 24],
    [8, 23],
  ]) {
    while (world.inspect().player.x !== x || world.inspect().player.y !== y) {
      const player = world.inspect().player;
      expect(
        world.execute({
          requestId: `bed-walk-${++request}`,
          type: 'move',
          dx: Math.sign(x - player.x),
          dy: player.x === x ? Math.sign(y - player.y) : 0,
        }).ok,
      ).toBe(true);
      expect(world.advance(1000).ok).toBe(true);
    }
    if (y < 25) expect(world.nearby().some((entity) => entity.id === bed)).toBe(true);
  }
  expect(world.execute({ requestId: 'bed-blocked', type: 'move', dx: -1, dy: 0 }).ok).toBe(false);
  expect(world.execute({ requestId: 'bed-interact', type: 'interact', target: bed }).ok).toBe(true);
  expect(world.sleepView('sleep')).toEqual({ selectHours: true });
  const before = world.inspect(),
    target = Math.ceil(world.gameTime()) + 8 * 3600;
  const command = {
    requestId: 'bed-sleep',
    type: 'choose',
    choice: 'sleep',
    hours: 8,
    revision: before.interactionRevision,
  };
  expect(world.execute(command).ok).toBe(true);
  const after = world.inspect();
  expect(after.storyTime).toBe(target);
  expect(after.balance).toBe(before.balance - (target - before.storyTime));
  expect(after.player).toEqual(before.player);
  expect(world.execute(command).ok).toBe(true);
  expect(world.inspect()).toEqual(after);
  const run = world.recording();
  expect(replayRecording(run).inspect()).toEqual(after);
  expect(restoreSnapshot(run).inspect()).toEqual(after);
});

test('outdoor portals stay inside entrances and the kitchen exit spans its opening', async () => {
  const content = await readPackage('remaining-time');
  const deck = content.scenes.find((scene) => scene.id === 'low-deck')!;
  for (const x of [6, 7, 14, 15, 19, 20, 38, 39]) expect(portalAt(deck, x, 10)).toBeUndefined();
  for (const x of [4, 5, 6, 42, 43]) {
    for (const y of [17, 18, 19]) expect(mapBlocked(deck.map, x, y)).toBe(false);
    expect(portalAt(deck, x, 19)).toBeUndefined();
    expect(portalAt(deck, x, 17)).toBeDefined();
  }
  for (const [x, y] of [
    [9, 17],
    [9, 18],
    [37, 17],
    [37, 18],
  ])
    expect(portalAt(deck, x, y)).toBeUndefined();
  const kitchen = content.scenes.find((scene) => scene.id === 'low-kitchen')!;
  for (let x = 21; x <= 26; x++) expect(portalAt(kitchen, x, 29)?.id).toBe('low-kitchen.return');
});

test('S01 guides all six steps from 404 and finishes only after storing the real tag', async () => {
  const content = await readPackage('remaining-time');
  const task = content.story.tasks![0];
  expect(task.steps.map((step) => step.id)).toEqual([
    'observe',
    'ask_ash',
    'read_record',
    'verify',
    'pickup',
    'store',
  ]);
  let world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  let request = 0;
  const send = (command: Record<string, unknown>) => {
    const result = world.execute({ requestId: `s01-${++request}`, ...command });
    if (!result.ok) throw new Error(JSON.stringify({ command, result }));
  };
  const choose = (choice: string) =>
    send({ type: 'choose', choice, revision: world.inspect().interactionRevision });
  const walk = (path: number[][]) => {
    for (const [x, y] of path) {
      const player = world.inspect().player;
      send({ type: 'move', dx: x - player.x, dy: y - player.y });
      expect(world.advance(1000).ok).toBe(true);
    }
  };
  const reach = (id: string) => {
    const scene = world.scene()!,
      player = world.inspect().player;
    const entity = scene.entities.find((e) => e.id === id)!;
    if (entity.portal) return walk(route(scene, [player.x, player.y], id));
    const offsets = [[0, 1], [1, 0], [-1, 0], [0, -1], ...(entity.interactionOffsets ?? [])];
    for (const [dx, dy] of offsets) {
      const point = [entity.position[0] + dx, entity.position[1] + dy];
      if (
        mapBlocked(scene.map, point[0], point[1]) ||
        portalAt(scene, point[0], point[1]) ||
        scene.entities.some((e) => e.position.join() === point.join())
      )
        continue;
      let path: number[][];
      try {
        path = route(scene, [player.x, player.y], point);
      } catch {
        continue;
      }
      walk(path);
      expect(world.nearby().some((e) => e.id === id)).toBe(true);
      return;
    }
    throw new Error(`Unreachable S01 objective: ${id}`);
  };
  const tag = 'low-deck.door-tag-317';
  expect(world.taskViews()).toHaveLength(1);
  expect(world.execute({ requestId: 'far-tag', type: 'interact', target: tag }).ok).toBe(false);
  // The cabinet cannot be used to skip the investigation.
  reach('unit-404.cabinet');
  send({ type: 'interact', target: 'unit-404.cabinet' });
  expect(world.choices().some((c) => c.id === 'store_tag')).toBe(false);
  send({ type: 'closeDialogue' });
  for (const [index, step] of task.steps.entries()) {
    const view = world.taskViews()[0];
    expect(view.completed).toHaveLength(index);
    expect(view.steps.at(-1)?.id).toBe(step.id);
    expect(view.background).toBe(step.background);
    expect(view.description).toBe(step.description);
    let guide = taskGuidance(content.scenes, world.scene()!, step)!;
    expect(guide).toBeDefined();
    if (guide.entity.portal) {
      expect(guide.marker).toBe('!');
      reach(guide.entity.id);
      guide = taskGuidance(content.scenes, world.scene()!, step)!;
    }
    expect(guide.entity.id).toBe(step.condition.where!.entityId);
    expect(guide.marker).toBe(step.marker);
    reach(guide.entity.id);
    send({ type: 'interact', target: guide.entity.id });
    if (step.id === 'ask_ash') choose('ask_door_tag');
    const before = world.inspect().tasks;
    send({ type: 'closeDialogue' });
    expect(world.inspect().tasks).toEqual(before);
    send({ type: 'interact', target: guide.entity.id });
    if (step.id === 'ask_ash') choose('ask_door_tag');
    if (step.id === 'observe')
      expect(world.choices().some((c) => c.id === 'pickup_tag')).toBe(false);
    const command = {
      requestId: `confirm-${step.id}`,
      type: 'choose',
      choice: step.condition.where!.choiceId,
      revision: world.inspect().interactionRevision,
    };
    expect(world.execute(command).ok).toBe(true);
    const after = world.inspect();
    expect(world.execute(command).ok).toBe(true);
    expect(world.inspect()).toEqual(after);
    expect(world.taskViews()[0].completed).toHaveLength(index + 1);
    if (step.id === 'ask_ash') {
      expect(world.taskViews()[0].steps.at(-1)?.id).toBe('read_record');
      expect(world.inspect().vars.s01_stored).toBe(false);
    }
    if (step.id === 'pickup') {
      expect(world.inventoryView().find((i) => i.id === 's01-door-tag')?.quantity).toBe(1);
      expect(world.scene()!.entities.some((e) => e.id === tag)).toBe(false);
      expect(world.getEntity(tag)?.location).toBeNull();
      expect(world.execute({ requestId: 'picked-up-tag', type: 'interact', target: tag }).ok).toBe(
        false,
      );
      // Restore here and actually continue through delivery with the saved object ownership.
      world = restoreSnapshot(world.recording());
      expect(world.getEntity(tag)?.location).toBeNull();
    }
  }
  expect(world.inspect().vars.s01_stored).toBe(true);
  expect(world.inventoryView().find((i) => i.id === 's01-door-tag')?.quantity).toBe(0);
  expect(world.taskViews()[0].completed).toHaveLength(6);
  expect(taskGuidance(content.scenes, world.scene()!, undefined)).toBeUndefined();
  send({ type: 'interact', target: 'unit-404.cabinet' });
  expect(world.choices().some((c) => c.id === 'store_tag')).toBe(false);
  expect(world.inspect().npc.reply).toContain('已放入此柜');
  send({ type: 'closeDialogue' });
  const recording = world.recording();
  expect(replayRecording(recording).inspect()).toEqual(world.inspect());
  expect(restoreSnapshot(recording).inspect()).toEqual(world.inspect());
});

test('S01 item delivery rejects missing inventory atomically and validates new fields', async () => {
  const content = await readPackage('remaining-time');
  const cabinet = content.scenes
    .find((s) => s.id === 'unit-404')!
    .entities.find((e) => e.id === 'unit-404.cabinet')!;
  const scene = content.scenes.find((s) => s.id === 'unit-404')!;
  scene.anchors.test = [cabinet.position[0], cabinet.position[1] + 1];
  content.story.start = { scene: scene.id, anchor: 'test' };
  content.story.interactions[cabinet.id].choices.push({
    id: 'missing-item',
    text: 'test',
    effects: [
      { op: 'set', var: 's01_stored', value: true },
      { op: 'take_item', item: 's01-door-tag', quantity: 1 },
    ],
  });
  const world = new MemoryWorld();
  world.load(content.scenes, content.story, content.npcs);
  expect(world.execute({ requestId: 'open', type: 'interact', target: cabinet.id }).ok).toBe(true);
  const before = world.inspect();
  expect(
    world.execute({
      requestId: 'missing',
      type: 'choose',
      choice: 'missing-item',
      revision: before.interactionRevision,
    }).ok,
  ).toBe(false);
  expect(world.inspect()).toEqual(before);
  for (const quantity of [0, -1, 100, 1.5]) {
    const story = structuredClone(content.story);
    const effect = story.interactions[cabinet.id].choices.at(-1)!.effects[1] as {
      quantity: number;
    };
    effect.quantity = quantity;
    expect(() => loadContent(content.scenes, story)).toThrow();
  }
  const story = structuredClone(content.story);
  story.tasks![0].steps[0].condition.where!.entityId = 'unknown-target';
  expect(() => loadContent(content.scenes, story)).toThrow();
});
