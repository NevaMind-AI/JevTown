export const factFields = {
  'movement.completed': ['direction'],
  'interaction.started': ['entityId'],
  'choice.confirmed': ['entityId', 'choiceId'],
  'scene.entered': ['sceneId'],
} as const;
export type Fact = { event: keyof typeof factFields; fields: Record<string, string> };
export type TaskCondition = {
  event: keyof typeof factFields;
  where?: Record<string, string>;
  collect?: string;
  count: number;
  items?: { value: string; label: string }[];
};
export type StepProgress = { count: number; values: string[] };

// collect counts distinct values; without it every matching fact counts once.
export function collectFact(
  condition: TaskCondition,
  previous: StepProgress,
  fact: Fact,
): StepProgress {
  if (
    condition.event !== fact.event ||
    Object.entries(condition.where ?? {}).some(([key, value]) => fact.fields[key] !== value)
  )
    return previous;
  const value = condition.collect ? fact.fields[condition.collect] : undefined;
  if (
    condition.collect &&
    (value === undefined || (condition.items && !condition.items.some((i) => i.value === value)))
  )
    return previous;
  const values =
    value === undefined || previous.values.includes(value)
      ? previous.values
      : [...previous.values, value];
  return {
    count: Math.min(condition.count, condition.collect ? values.length : previous.count + 1),
    values,
  };
}
