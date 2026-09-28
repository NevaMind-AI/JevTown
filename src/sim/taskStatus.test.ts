import {
  currentProseStep,
  proseTaskStates,
  readWorldTasks,
  taskDisagreements,
  unknownKeys,
} from './taskStatus';
import type { Task } from '../../prototype/content';

const TASK: Task = {
  id: 's01-door-tag',
  title: '消磁门牌',
  description: '',
  steps: [
    { id: 'observe', text: 'look', condition: { event: 'interaction.started', count: 1 } },
    { id: 'ask_ash', text: 'ask', condition: { event: 'interaction.started', count: 1 } },
    { id: 'store', text: 'store', condition: { event: 'interaction.started', count: 1 } },
  ],
};

const view = (completed: string[]) => [
  {
    id: TASK.id,
    title: TASK.title,
    background: undefined,
    description: '',
    steps: TASK.steps,
    completed,
    progress: {},
  },
];

describe('reading task progress out of the world-state document', () => {
  test('a named step resolves against the authored task', () => {
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = ask_ash\n</tasks>');

    expect(currentProseStep([TASK], written)?.step?.id).toBe('ask_ash');
  });

  test('`done` finishes the task and moves the waypoint off it', () => {
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = done\n</tasks>');

    expect(proseTaskStates([TASK], written)[0].done).toBe(true);
    expect(currentProseStep([TASK], written)).toBeUndefined();
  });

  test('an unrecognised value leaves the task current with an unknown step', () => {
    // docs/13 §1.6: never a failure, never dropped from the board, never a throw.
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = halfway there\n</tasks>');
    const [state] = proseTaskStates([TASK], written);

    expect(state.done).toBe(false);
    expect(state.step).toBeUndefined();
    expect(state.unrecognised).toBe('halfway there');
    expect(currentProseStep([TASK], written)).toEqual({ taskId: 's01-door-tag', step: undefined });
  });

  test('a task with no line has not started, and is not a disagreement about nothing', () => {
    const written = readWorldTasks('state: x\n<tasks>\n</tasks>');

    expect(proseTaskStates([TASK], written)[0]).toEqual({ taskId: 's01-door-tag', done: false });
  });

  test('no document at all reads as no opinion, which is how a non-agentic session runs', () => {
    expect(readWorldTasks(undefined)).toBeUndefined();
    expect(currentProseStep([TASK], undefined)).toBeUndefined();
    expect(taskDisagreements([TASK], view([]), undefined)).toEqual([]);
  });
});

describe('the oracle', () => {
  test('agreement reports nothing', () => {
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = ask_ash\n</tasks>');

    expect(taskDisagreements([TASK], view(['observe']), written)).toEqual([]);
  });

  test('a model that fell behind is a row, not an error', () => {
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = observe\n</tasks>');

    expect(taskDisagreements([TASK], view(['observe']), written)).toEqual([
      { taskId: 's01-door-tag', prose: 'observe', typed: 'ask_ash' },
    ]);
  });

  test('an unrecognised value is reported as what was written', () => {
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = nearly done\n</tasks>');

    expect(taskDisagreements([TASK], view([]), written)).toEqual([
      { taskId: 's01-door-tag', prose: 'nearly done', typed: 'observe' },
    ]);
  });

  test('a task the typed path has not activated yet has nothing to disagree with', () => {
    const written = readWorldTasks('state: x\n<tasks>\ns01-door-tag = ask_ash\n</tasks>');

    expect(taskDisagreements([TASK], [], written)).toEqual([]);
  });
});

describe('keys that match no authored task (docs/13 §4)', () => {
  test('a near-miss id is reported, and the real task keeps its stale line', () => {
    // The failure merge creates: under replace the real line would have vanished and §1.6 would
    // have rendered "unknown"; under merge it survives and the misspelling is inert.
    const written = readWorldTasks(
      'state: x\n<tasks>\ns01-door-tag = observe\ns01-door-tagg = store\n</tasks>',
    );

    expect(unknownKeys([TASK.id], written)).toEqual(['s01-door-tagg']);
    expect(currentProseStep([TASK], written)?.step?.id).toBe('observe');
  });

  test('a block of only known ids reports nothing, and no block reports nothing', () => {
    expect(
      unknownKeys([TASK.id], readWorldTasks('state: x\n<tasks>\ns01-door-tag = done\n</tasks>')),
    ).toEqual([]);
    expect(unknownKeys([TASK.id], undefined)).toEqual([]);
  });
});
