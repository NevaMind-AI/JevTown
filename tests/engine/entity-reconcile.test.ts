import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { loadContent, type Content } from '../../prototype/content';
import { placedAppearance } from '../../prototype/entities';
import { reconcileEntities, validateEntities } from '../../prototype/entityRecording';
import { MemoryWorld } from '../../prototype/world';
import type { State } from '../../prototype/world';

const content = (): Content => loadContent([room, corridor], story);

/** A state as a save would hold it, taken from a world that has actually run. */
function savedState(): State {
  const world = new MemoryWorld();
  world.load([room, corridor], story);
  return structuredClone(world.inspect());
}

describe('reconcileEntities', () => {
  test('a save that matches its content is left alone', () => {
    const state = savedState();
    const before = structuredClone(state);
    expect(reconcileEntities(content(), state)).toEqual({ added: [], dropped: [] });
    expect(state).toEqual(before);
  });

  test('an entity the content no longer has is dropped, not refused', () => {
    const state = savedState();
    state.entities['ghost'] = structuredClone(state.entities.n07);
    expect(reconcileEntities(content(), state)).toEqual({ added: [], dropped: ['ghost'] });
    expect(state.entities.ghost).toBeUndefined();
    expect(() => validateEntities(content(), state)).not.toThrow();
  });

  test('an entity the content has gained is created as the content places it', () => {
    const state = savedState();
    delete state.entities.n07;
    const loaded = content();
    expect(reconcileEntities(loaded, state)).toEqual({ added: ['n07'], dropped: [] });
    expect(state.entities.n07.position).toEqual([5, 5]);
    expect(state.entities.n07.sceneId).toBe('room');
    expect(() => validateEntities(loaded, state)).not.toThrow();
  });

  test('an entity in both must still match: a renamed one is a hard failure', () => {
    const state = savedState();
    state.entities.n07.name = 'Somebody else';
    expect(reconcileEntities(content(), state)).toEqual({ added: [], dropped: [] });
    expect(() => validateEntities(content(), state)).toThrow('Invalid entity snapshot');
  });

  test('a dialogue open on a dropped entity is closed rather than left dangling', () => {
    const state = savedState();
    state.entities['ghost'] = structuredClone(state.entities.n07);
    state.dialogue = true;
    state.activeEntity = 'ghost';
    state.dialogueTopic = 'anything';
    const revision = state.interactionRevision;
    reconcileEntities(content(), state);
    expect(state.activeEntity).toBeNull();
    expect(state.dialogue).toBe(false);
    expect(state.dialogueTopic).toBeUndefined();
    expect(state.interactionRevision).toBe(revision + 1);
  });

  test('a player seated on a dropped chair is stood back up where they sat down', () => {
    const state = savedState();
    state.entities['chair'] = structuredClone(state.entities.n07);
    state.seated = { entity: 'chair', returnPosition: { x: 3, y: 5 } };
    state.player = { x: 7, y: 7 };
    reconcileEntities(content(), state);
    expect(state.seated).toBeUndefined();
    expect(state.player).toEqual({ x: 3, y: 5 });
  });

  test('the strict checks survive as post-conditions', () => {
    // Nothing reconcile leaves behind may fail validation, which is what makes the loosening a
    // reordering rather than a hole.
    const state = savedState();
    state.entities['ghost'] = structuredClone(state.entities.n07);
    delete state.entities.n07;
    const loaded = content();
    expect(reconcileEntities(loaded, state)).toEqual({ added: ['n07'], dropped: ['ghost'] });
    expect(() => validateEntities(loaded, state)).not.toThrow();
  });
});

describe('placedAppearance', () => {
  const art = { well: { image: 'assets/low-deck/door-tag-317.png' } };

  test('a mobile actor is drawn as its character', () => {
    expect(placedAppearance({ character: 'f4' })).toEqual({ character: 'f4' });
  });

  test('a sprite name resolves against the content vocabulary', () => {
    expect(placedAppearance({ sprite: 'well' }, art)).toEqual({
      character: 'sprite',
      sprite: { image: 'assets/low-deck/door-tag-317.png' },
    });
  });

  test('the resolved art is copied, so a placement cannot mutate the vocabulary', () => {
    const appearance = placedAppearance({ sprite: 'well' }, art)!;
    appearance.sprite!.image = 'assets/other/thing.png';
    expect(art.well.image).toBe('assets/low-deck/door-tag-317.png');
  });

  test('an unknown sprite name draws nothing rather than something wrong', () => {
    expect(placedAppearance({ sprite: 'well' })).toBeUndefined();
    expect(placedAppearance({ sprite: 'door_closed' }, art)).toBeUndefined();
  });

  test('an unknown character is refused, and so is an entity with neither', () => {
    expect(placedAppearance({ character: 'f9' })).toBeUndefined();
    expect(placedAppearance({ character: 'door' })).toBeUndefined();
    expect(placedAppearance({})).toBeUndefined();
  });
});

describe('story.sprites', () => {
  const load = (sprites: unknown) =>
    loadContent([room, corridor], { ...story, sprites } as typeof story);

  test('a named visual loads', () => {
    expect(() => load({ well: { image: 'assets/low-deck/door-tag-317.png' } })).not.toThrow();
  });

  test('a bad image path is refused at load, not at draw time', () => {
    expect(() => load({ well: { image: '../secrets.png' } })).toThrow('Invalid art image');
  });

  test('a visual with unknown fields is refused', () => {
    expect(() => load({ well: { image: 'assets/a/b.png', tint: 2 } })).toThrow();
  });
});
