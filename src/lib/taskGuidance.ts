import type { Scene, Task } from '../../prototype/content';

// Follow room connections; local movement and interaction still use the normal reach checks.
export function taskGuidance(scenes: Scene[], current: Scene, step?: Task['steps'][number]) {
  if (!step?.marker) return undefined;
  const targetId = step.condition.where?.entityId;
  const targetScene = scenes.find((scene) => scene.entities.some((e) => e.id === targetId));
  if (!targetScene) return undefined;
  if (targetScene.id === current.id) {
    const entity = current.entities.find((e) => e.id === targetId);
    return entity ? { entity, marker: step.marker, label: entity.name } : undefined;
  }
  const queue = [{ scene: current, exit: undefined as Scene['entities'][number] | undefined }];
  const seen = new Set([current.id]);
  for (const { scene, exit } of queue) {
    for (const door of scene.entities) {
      if (!door.portal || seen.has(door.portal.scene)) continue;
      const next = scenes.find((s) => s.id === door.portal!.scene);
      if (!next) continue;
      const firstExit = exit ?? door;
      if (next.id === targetScene.id)
        return { entity: firstExit, marker: '!' as const, label: `出口 → ${targetScene.name}` };
      seen.add(next.id);
      queue.push({ scene: next, exit: firstExit });
    }
  }
  return undefined;
}
