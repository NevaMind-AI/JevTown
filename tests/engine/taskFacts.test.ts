import { collectFact, TaskCondition } from '../../prototype/taskFacts';

test('generic filters, counts and distinct collections', () => {
  const condition: TaskCondition = {
    event: 'interaction.started',
    where: { entityId: 'n07' },
    count: 2,
  };
  let progress = { count: 0, values: [] as string[] };
  progress = collectFact(condition, progress, {
    event: 'interaction.started',
    fields: { entityId: 'other' },
  });
  expect(progress.count).toBe(0);
  for (let i = 0; i < 3; i++)
    progress = collectFact(condition, progress, {
      event: 'interaction.started',
      fields: { entityId: 'n07' },
    });
  expect(progress.count).toBe(2);
  const distinct: TaskCondition = { event: 'scene.entered', collect: 'sceneId', count: 2 };
  progress = { count: 0, values: [] };
  for (const sceneId of ['room', 'room', 'corridor'])
    progress = collectFact(distinct, progress, { event: 'scene.entered', fields: { sceneId } });
  expect(progress).toEqual({ count: 2, values: ['room', 'corridor'] });
});
