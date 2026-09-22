import { Value } from './util/validators';

/**
 * The loop that advances a game, with nothing around it.
 *
 * This is `AbstractGame.runStep` (upstream `convex/engine/abstractGame.ts`) with its four host
 * calls removed: it no longer loads inputs, no longer saves, no longer reads a wall clock, and no
 * longer owns the engine row. The caller supplies the inputs and the time window and receives the
 * boundary it reached; what that caller is — a Convex action today, `LocalGame`'s interval after
 * docs/11 §1, a replay harness in CI — is not this module's business.
 *
 * The tick arithmetic is unchanged on purpose. Moving a boundary moves which tick an input lands
 * on, and that is a replay divergence (docs/10 §4.1).
 */

export interface EngineInput {
  /** Monotonic within a world. Defines the order; nothing else does. */
  number: number;
  name: string;
  args: any;
  /**
   * When the input was accepted. An input lands on the first tick whose time has reached this,
   * so it is a scheduling hint and not an ordering authority — `number` is the authority.
   */
  received: number;
}

export type InputReturnValue = { kind: 'ok'; value: Value } | { kind: 'error'; message: string };

export interface CompletedInput {
  number: number;
  returnValue: InputReturnValue;
}

/** What `runTicks` needs of a game. `Game` satisfies it; so does a test double. */
export interface TickableGame {
  tickDuration: number;
  maxTicksPerStep: number;
  beginStep(now: number): void;
  handleInput(now: number, name: any, args: any, inputNumber?: number): Value;
  tick(now: number): void;
}

export interface RunTicksOptions {
  /**
   * Where game time stood at the end of the previous step, or `undefined` for a world that has
   * never stepped — in which case this step starts at `now`.
   *
   * Careful: the test below is falsy, not `undefined`, which is upstream's behaviour preserved
   * deliberately. A world whose previous step ended at game time exactly `0` therefore skips to
   * `now` instead of continuing, silently dropping the interval. It cannot happen under Convex,
   * where the engine row is seeded from `Date.now()`, but it is a live hazard once the frontend
   * stamps game time and is free to start a world at 0 (docs/11 §4.2). Decide it in phase 4
   * rather than changing it here, where it would move step boundaries for existing worlds.
   */
  previousCurrentTime: number | undefined;
  /** How far to simulate. Ticking stops before the first tick that would pass this. */
  now: number;
  /** Inputs in `number` order, already filtered to those not yet processed. */
  inputs: EngineInput[];
  /** The highest input number already applied, or `undefined` if none has been. */
  processedInputNumber: number | undefined;
}

export interface RunTicksResult {
  /** Game time this step started at. */
  startTs: number;
  /** Game time this step ended at. This is the world's new `currentTime`. */
  currentTs: number;
  numTicks: number;
  processedInputNumber: number | undefined;
  /** One entry per input applied, in the order applied. */
  completedInputs: CompletedInput[];
}

export function runTicks(game: TickableGame, options: RunTicksOptions): RunTicksResult {
  const { previousCurrentTime, now, inputs, processedInputNumber: alreadyProcessed } = options;

  const startTs = previousCurrentTime ? previousCurrentTime + game.tickDuration : now;
  let currentTs = startTs;
  let inputIndex = 0;
  let numTicks = 0;
  let processedInputNumber = alreadyProcessed;
  const completedInputs: CompletedInput[] = [];

  game.beginStep(currentTs);

  while (numTicks < game.maxTicksPerStep) {
    numTicks += 1;

    // Collect all of the inputs for this tick.
    const tickInputs: EngineInput[] = [];
    while (inputIndex < inputs.length) {
      const input = inputs[inputIndex];
      if (input.received > currentTs) {
        break;
      }
      inputIndex += 1;
      processedInputNumber = input.number;
      tickInputs.push(input);
    }

    // Feed the inputs to the game. A handler that throws fails that input alone: the world keeps
    // running and the error travels back as the input's return value.
    for (const input of tickInputs) {
      let returnValue: InputReturnValue;
      try {
        const value = game.handleInput(currentTs, input.name, input.args, input.number);
        returnValue = { kind: 'ok', value };
      } catch (e: any) {
        console.error(`Input ${input.number} (${input.name}) failed: ${e.message}`);
        returnValue = { kind: 'error', message: e.message };
      }
      completedInputs.push({ number: input.number, returnValue });
    }

    // Simulate the game forward one tick.
    game.tick(currentTs);

    const candidateTs = currentTs + game.tickDuration;
    if (now < candidateTs) {
      break;
    }
    currentTs = candidateTs;
  }

  return { startTs, currentTs, numTicks, processedInputNumber, completedInputs };
}
