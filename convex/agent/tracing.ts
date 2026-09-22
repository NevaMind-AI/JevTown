// How ai-town's model calls are grouped in Langfuse.
//
// Three shapes, because the code has three:
//
//   - **A conversation** (tier (a)) is not one process. Each turn is its own
//     `agentGenerateMessage` action invocation, and the memory write afterwards is another one
//     again, so there is no in-memory parent to hang children off and nothing shared between them
//     but the conversation id. `forConversation` hashes that id into the trace id, which is enough
//     to reassemble the whole exchange -- turns *and* the state/memory write -- into one trace with
//     no coordination and nothing persisted. The wrapper span is re-emitted each turn with a
//     stretched end time; Langfuse merges on (traceId, spanId), so it converges on the real extent.
//
//   - **An interaction** (tier (b)) is one process: the alternating loop in `interact.ts` runs
//     start to finish inside a single action. So its wrapper span is an honest measured span, and
//     every turn ships in one request at the end.
//
//   - **The god** is deliberately standalone. Its batch already carries a `batchId`, and hashing
//     that gives it a trace of its own that never merges into whatever conversation happened to
//     produce the state it is judging.
//
// Everything degrades to nothing when the keys are unset: `generation()` returns `undefined`,
// which `chatCompletion` treats as "don't trace", and `close()` does no work.

import { ChatTrace } from '../util/llm';
import {
  LangfuseBatch,
  TraceRef,
  langfuseEnabled,
  randomSpanId,
  spanIdForKey,
  traceIdForKey,
} from '../util/langfuse';

type TracerInit = {
  traceId: string;
  rootSpanId: string;
  rootName: string;
  startedAt: number;
  base: Omit<TraceRef, 'traceId' | 'parentSpanId'>;
  /** Re-emitted wrapper spans converge across processes; measured ones are written once. */
  merging: boolean;
};

export class Tracer {
  private readonly batch = new LangfuseBatch();
  private readonly init: TracerInit | null;

  private constructor(init: TracerInit | null) {
    this.init = init;
  }

  /** A disabled tracer. Every method is a no-op and nothing is hashed. */
  static disabled(): Tracer {
    return new Tracer(null);
  }

  /**
   * One trace per conversation, reassembled from the conversation id alone.
   *
   * `startedAt` should be the conversation's `created` timestamp wherever the caller has it. The
   * opening turn does not, and passes its own start instead; later turns do, and correct it when
   * they re-emit the wrapper.
   */
  static async forConversation(opts: {
    worldId: string;
    conversationId: string;
    name: string;
    startedAt?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Tracer> {
    if (!langfuseEnabled()) return Tracer.disabled();
    const key = `conversation:${opts.worldId}:${opts.conversationId}`;
    return new Tracer({
      traceId: await traceIdForKey(key),
      rootSpanId: await spanIdForKey(key),
      rootName: opts.name,
      startedAt: opts.startedAt ?? Date.now(),
      merging: true,
      base: {
        traceName: opts.name,
        sessionId: opts.worldId,
        tags: ['conversation'],
        traceMetadata: {
          worldId: opts.worldId,
          conversationId: opts.conversationId,
          ...opts.metadata,
        },
      },
    });
  }

  /** One trace per actor→entity exchange, measured in-process. */
  static async forInteraction(opts: {
    worldId: string;
    interactionId: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<Tracer> {
    if (!langfuseEnabled()) return Tracer.disabled();
    const key = `interaction:${opts.worldId}:${opts.interactionId}`;
    return new Tracer({
      traceId: await traceIdForKey(key),
      rootSpanId: randomSpanId(),
      rootName: opts.name,
      startedAt: Date.now(),
      merging: false,
      base: {
        traceName: opts.name,
        sessionId: opts.worldId,
        tags: ['interaction'],
        traceMetadata: {
          worldId: opts.worldId,
          interactionId: opts.interactionId,
          ...opts.metadata,
        },
      },
    });
  }

  /**
   * A trace of its own, keyed by whatever the caller considers one unit of work.
   *
   * This is the god's shape, and the shape for anything else that is not part of an exchange --
   * a decision, a reflection. Nothing else ever lands in it.
   */
  static async standalone(opts: {
    worldId: string;
    key: string;
    name: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Tracer> {
    if (!langfuseEnabled()) return Tracer.disabled();
    return new Tracer({
      traceId: await traceIdForKey(`${opts.key}`),
      rootSpanId: randomSpanId(),
      rootName: opts.name,
      startedAt: Date.now(),
      merging: false,
      base: {
        traceName: opts.name,
        sessionId: opts.worldId,
        tags: opts.tags ?? [],
        traceMetadata: { worldId: opts.worldId, ...opts.metadata },
      },
    });
  }

  get enabled(): boolean {
    return this.init !== null;
  }

  /**
   * The `trace` to hand to `chatCompletion`, or `undefined` when tracing is off.
   *
   * Spans accumulate in this tracer's batch and leave on `close()`, so a caller that makes several
   * calls pays for one export rather than one per call.
   */
  generation(name: string, metadata?: Record<string, unknown>): ChatTrace | undefined {
    if (!this.init) return undefined;
    return {
      traceId: this.init.traceId,
      parentSpanId: this.init.rootSpanId,
      ...this.init.base,
      name,
      metadata,
      batch: this.batch,
    };
  }

  /** Write the wrapper span and ship everything collected so far in one request. */
  async close(summary?: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    level?: 'DEFAULT' | 'ERROR';
    statusMessage?: string;
  }): Promise<void> {
    if (!this.init) return;
    this.batch.add(
      { traceId: this.init.traceId, ...this.init.base },
      {
        name: this.init.rootName,
        spanId: this.init.rootSpanId,
        type: 'span',
        startTime: this.init.startedAt,
        endTime: Date.now(),
        input: summary?.input,
        output: summary?.output,
        metadata: {
          ...summary?.metadata,
          // A merging wrapper is rewritten by every turn, so its duration is the conversation's
          // extent so far rather than one process's runtime. Say so in the span itself.
          ...(this.init.merging ? { spansProcesses: true } : {}),
        },
        level: summary?.level,
        statusMessage: summary?.statusMessage,
      },
    );
    await this.batch.flush();
  }
}
