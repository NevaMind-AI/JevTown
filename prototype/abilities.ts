import type { Shop, Story } from './content.js';
import type { NpcSchedule } from './schedules.js';

export type Npc = {
  id: string;
  name: string;
  character: string;
  image?: string;
  abilities: {
    movement?: true;
    dialogue?: true;
    shop?: Shop;
    schedule?: NpcSchedule;
  };
};
export const abilityFields = ['shops', 'schedules'] as const;
type Settings = Pick<Story, (typeof abilityFields)[number]>;

// Existing systems consume a view; NPC definitions remain the sole configuration source.
// Old recordings keep their original Story layout and use the same execution paths.
export function abilitySettings(content?: { npcs?: Record<string, Npc>; story?: Story }): Settings {
  if (!content?.npcs) return content?.story ?? {};
  const settings: Settings = {};
  for (const npc of Object.values(content.npcs)) {
    const { id, abilities: a } = npc;
    if (a.shop) (settings.shops ??= {})[id] = a.shop;
    if (a.schedule) (settings.schedules ??= {})[id] = a.schedule;
  }
  return settings;
}
