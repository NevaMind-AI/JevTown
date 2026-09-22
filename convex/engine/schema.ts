import { defineTable } from 'convex/server';
import { Infer, v } from 'convex/values';

const input = v.object({
  // Inputs are scoped to a single engine.
  engineId: v.id('engines'),

  // Monotonically increasing input number within a world starting at 0.
  number: v.number(),

  // Name of the input handler to run.
  name: v.string(),
  // Dynamically typed arguments and return value for the input handler. We'll
  // provide type safety at a higher layer.
  args: v.any(),
  returnValue: v.optional(
    v.union(
      v.object({
        kind: v.literal('ok'),
        value: v.any(),
      }),
      v.object({
        kind: v.literal('error'),
        message: v.string(),
      }),
    ),
  ),

  // Timestamp when the server received the input. This timestamp is best-effort,
  // since we don't guarantee strict monotonicity here. So, an input may not get
  // assigned to the engine step whose time interval contains this timestamp.
  received: v.number(),
});

export const engine = v.object({
  // What is the current simulation time for the engine? Monotonically increasing.
  currentTime: v.optional(v.number()),
  // What was `currentTime` for the preceding step of the engine?
  lastStepTs: v.optional(v.number()),

  // How far has the engine processed in the input queue?
  processedInputNumber: v.optional(v.number()),

  running: v.boolean(),

  // Monotonically increasing counter that serializes all engine runs. If we ever
  // end up with two steps overlapping in time, this counter will force them to
  // conflict.
  generationNumber: v.number(),
});
export type Engine = Infer<typeof engine>;

// One row per committed step, recording the wall-clock-derived boundary that step landed on.
// `runStep` derives its tick count from the `now` it was handed, so replaying against a synthetic
// clock moves the boundaries and diverges anything that keys off them — `beginStep`'s historical
// buffers today, god verdict application later (docs/05 §7.6, §10; docs/08 §3 A0).
const step = v.object({
  engineId: v.id('engines'),
  // Serializes steps: `generationNumber` is incremented once per committed step.
  generationNumber: v.number(),
  lastStepTs: v.optional(v.number()),
  currentTime: v.optional(v.number()),
});

export const engineTables = {
  inputs: defineTable(input).index('byInputNumber', ['engineId', 'number']),
  engines: defineTable(engine),
  // Append-only and never read by the engine. Grows at one row per second per running world; see
  // docs/05 §13 A6 on retention, which A9 has to answer alongside `inputs`.
  steps: defineTable(step).index('byGenerationNumber', ['engineId', 'generationNumber']),
};
