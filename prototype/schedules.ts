import { abilitySettings } from './abilities.js';
import type { Content } from './content.js';
import { scriptedEntities } from './entities.js';
import { npcPath } from './pathfinding.js';
import type { State } from './world.js';
export type NpcSchedule = {
  scene: string;
  sleepAt: number;
  wakeAt: number;
  entrance: number[];
  home: number[];
};
export type SchedulePhase = 'active' | 'leaving' | 'away' | 'returning';
export const npcPresent = (state: State, id: string) => state.schedules?.[id] !== 'away';
export const npcOnDuty = (state: State, id: string) =>
  !state.schedules?.[id] || state.schedules[id] === 'active';
export function npcResting(content: Content, state: State, id: string) {
  const config = abilitySettings(content).schedules?.[id];
  if (!config) return false;
  const clock = state.clock;
  const time =
    (state.storyTime +
      (clock
        ? (clock.elapsedMs * content.story.clock!.gameSecondsPerTick!) /
          (clock.realSecondsPerTick * 1000)
        : 0)) %
    86400;
  return config.sleepAt < config.wakeAt
    ? time >= config.sleepAt && time < config.wakeAt
    : time >= config.sleepAt || time < config.wakeAt;
}
// Reserve both ends of a step, including the player's seat exit.
export function npcObstacles(content: Content, state: State, scene: string, except?: string) {
  const tiles = scriptedEntities(state)
    .filter(([id, a]) => id !== except && a.sceneId === scene)
    .flatMap(([, a]) => [
      a.position,
      ...(a.moving ? [[a.moving.target.x, a.moving.target.y]] : []),
    ]);
  if (state.sceneId === scene) {
    tiles.push([state.player.x, state.player.y]);
    if (state.moving) tiles.push([state.moving.target.x, state.moving.target.y]);
    if (state.seated) tiles.push([state.seated.returnPosition.x, state.seated.returnPosition.y]);
  }
  return tiles;
}
export function initialSchedules(content: Content, state: State) {
  if (!abilitySettings(content).schedules) return;
  state.schedules = {};
  for (const [id] of Object.entries(abilitySettings(content).schedules!)) {
    const away = npcResting(content, state, id);
    state.schedules[id] = away ? 'away' : 'active';
    if (away && state.entities[id]) state.entities[id].sceneId = '';
  }
}
export function advanceSchedules(content: Content, state: State) {
  for (const [id, config] of Object.entries(abilitySettings(content).schedules ?? {})) {
    const actor = state.entities[id];
    if (!actor) continue;
    const resting = npcResting(content, state, id),
      phase = state.schedules![id];
    if (resting && state.dialogue && state.activeEntity === id) {
      state.dialogue = false;
      state.activeEntity = null;
      delete state.dialogueTopic;
      state.interactionRevision++;
    }
    if (phase === 'active') {
      if (!resting || actor.moving || ('transit' in actor && actor.transit)) continue;
      state.schedules![id] = 'leaving';
      actor.path = [];
    } else if (phase === 'away') {
      if (resting) continue;
      const scene = content.scenes.find((s) => s.id === config.scene)!,
        blocked = npcObstacles(content, state, config.scene, id);
      if (blocked.some((p) => same(p, config.entrance))) continue;
      const path = npcPath(scene, config.entrance, [config.home], blocked);
      if (path === null) continue;
      actor.position = [...config.entrance];
      actor.path = path;
      actor.moving = null;
      actor.orientation = 270;
      if ('sceneId' in actor) actor.sceneId = config.scene;
      state.schedules![id] = 'returning';
    } else if (!actor.moving) {
      if (phase === 'returning' && resting) {
        state.schedules![id] = 'leaving';
        actor.path = [];
      } else if (phase === 'leaving' && !resting) {
        state.schedules![id] = 'returning';
        actor.path = [];
      }
    }
    if (actor.moving) continue;
    const current = state.schedules![id];
    if (current !== 'leaving' && current !== 'returning') continue;
    const goal = current === 'leaving' ? config.entrance : config.home;
    if (same(actor.position, goal)) {
      actor.path = [];
      state.schedules![id] = current === 'leaving' ? 'away' : 'active';
      if ('sceneId' in actor && current === 'leaving') actor.sceneId = '';
      if (current === 'returning') actor.orientation = 90;
      continue;
    }
    const scene = content.scenes.find((s) => s.id === config.scene)!;
    actor.path =
      npcPath(scene, actor.position, [goal], npcObstacles(content, state, config.scene, id)) ?? [];
  }
}
const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
