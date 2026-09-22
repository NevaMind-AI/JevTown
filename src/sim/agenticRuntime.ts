import { Game, GameStateDiff, ProseWrite } from '../../engine/aiTown/game';
import { World } from '../../engine/aiTown/world';
import { EngineInput, runTicks } from '../../engine/runtime';
import { InputArgs, InputNames } from '../../engine/aiTown/inputs';
import {
  AgentContext,
  ArchivedConversation,
  InputQueue,
  WorldDescription,
} from '../../agent/ports';
import { GameId } from '../../engine/aiTown/ids';
import { AgentStoreSnapshot, InMemoryAgentStore } from '../../agent/store/memoryStore';
import { runAgentOperation } from '../../agent/operations';
import { godStep } from '../../agent/god';
import { GameWorldReader } from './worldReader';

/**
 * The agentic world, running in the tab.
 *
 * This is the driver that `convex/aiTown/main.ts` used to be, minus the four host calls. It owns
 * game time, the input log, and the queue of operations the simulation asks for; it does not own
 * the wall clock, because whoever calls `advance` does (see §4.5 below).
 *
 * The ordering problem docs/10 §4.1 spends a section on does not arise here. There is one queue,
 * in one runtime, with one clock: an input gets its `idx` and its game time at the moment it is
 * accepted, and nothing can arrive behind it afterwards.
 */

/** How often the god looks at what has happened, in game time (docs/05 §7.5). */
const GOD_INTERVAL = 30_000;

/**
 * An event as it enters the log.
 *
 * `idx` is assigned here and never by a store (docs/11 §4.2): a server-assigned sequence quietly
 * restores server ordering, and a batch retried after a timeout would assign a second range to
 * the same events. Both clocks are kept, because neither is reconstructible from the other later
 * (docs/11 §6.1).
 */
export interface LoggedEvent {
  idx: number;
  name: string;
  args: unknown;
  gameTime: number;
  wallTime: number;
}

export interface AgenticRuntimeSnapshot {
  format: 'agentic-runtime-1';
  worldId: string;
  currentTime: number;
  nextIdx: number;
  world: ReturnType<Game['world']['serialize']>;
  store: AgentStoreSnapshot;
}

export interface AgenticRuntimeOptions {
  game: Game;
  store?: InMemoryAgentStore;
  description: WorldDescription;
  /** Game time this world starts at. Never zero — see the note on `runTicks`'s falsy test. */
  startTime: number;
  /**
   * What runs an agent operation. Defaults to the real one; a test passes a stub so the loop can
   * be exercised without a model, which is the only way this is testable at all.
   */
  runOperation?: (ctx: AgentContext, name: string, args: any) => Promise<void>;
  runGod?: (ctx: AgentContext) => Promise<void>;
  /** Off by default: a world with no god config has nothing for it to do. */
  godEnabled?: boolean;
}

export class AgenticRuntime {
  readonly game: Game;
  readonly store: InMemoryAgentStore;
  readonly context: AgentContext;

  private currentTime: number;
  private nextIdx = 0;
  private pending: EngineInput[] = [];
  private log: LoggedEvent[] = [];
  private lastGodStep: number;
  private readonly runOperation: NonNullable<AgenticRuntimeOptions['runOperation']>;
  private readonly runGod: NonNullable<AgenticRuntimeOptions['runGod']>;
  private readonly godEnabled: boolean;

  constructor(options: AgenticRuntimeOptions) {
    this.game = options.game;
    this.store = options.store ?? new InMemoryAgentStore();
    this.currentTime = options.startTime;
    this.lastGodStep = options.startTime;
    this.runOperation = options.runOperation ?? runAgentOperation;
    this.runGod = options.runGod ?? godStep;
    this.godEnabled = options.godEnabled ?? false;

    const inputs: InputQueue = {
      send: async (name, args) => this.send(name, args),
    };
    this.context = {
      world: new GameWorldReader(this.game, options.description),
      store: this.store,
      inputs,
    };
  }

  get time(): number {
    return this.currentTime;
  }

  /** The log so far. Phase 5 ships this in batches; for now it is what a save writes out. */
  events(): readonly LoggedEvent[] {
    return this.log;
  }

  /**
   * Accept an input.
   *
   * Stamped with the current game time rather than a wall clock, so the tick it lands on is a
   * property of the simulation and not of when a promise happened to resolve.
   */
  send<Name extends InputNames>(name: Name, args: InputArgs<Name>): number {
    const idx = this.nextIdx++;
    this.log.push({ idx, name, args, gameTime: this.currentTime, wallTime: Date.now() });
    this.pending.push({ number: idx, name, args, received: this.currentTime });
    return idx;
  }

  /**
   * Advance the world by `elapsed` milliseconds of game time.
   *
   * **The caller must have consumed that time unconditionally before deciding to pass it here.**
   * That is docs/11 §4.5, and it is the invariant that stops a laptop waking from sleep from
   * simulating the gap — which, with agents attached, means firing a burst of model calls for
   * hours nobody was present for. `LocalGame` already consumes elapsed time before its own
   * visibility bail and caps each tick at 160ms; this rides on exactly that budget.
   */
  advance(elapsed: number) {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return;
    const now = this.currentTime + elapsed;
    const result = runTicks(this.game, {
      previousCurrentTime: this.currentTime,
      now,
      inputs: this.pending,
      processedInputNumber: undefined,
    });
    // Everything handed in was for this window; anything that arrives later gets the next one.
    this.pending = [];
    this.currentTime = result.currentTs;
    this.drain(this.game.takeDiff());
    if (this.godEnabled && this.currentTime - this.lastGodStep >= GOD_INTERVAL) {
      this.lastGodStep = this.currentTime;
      void this.step(() => this.runGod(this.context), 'god');
    }
  }

  /**
   * Apply what the tick left behind.
   *
   * This is `Game.saveDiff` with the database taken out: archive what left the world, write the
   * prose the input handlers queued, and start the operations they asked for.
   */
  private drain(diff: GameStateDiff) {
    this.archiveDepartures(diff);
    for (const write of diff.proseWrites ?? []) {
      this.applyProseWrite(write);
    }
    for (const operation of diff.agentOperations) {
      const args = operation.args as { operationId: string };
      void this.step(
        () => this.runOperation(this.context, operation.name, args as any),
        `${operation.name}:${args?.operationId}`,
      );
    }
  }

  /**
   * An operation, with its failure contained.
   *
   * An operation that throws must not take the loop with it. The engine already handles an
   * operation that never reports back: `Agent.tick` times it out after `ACTION_TIMEOUT` and
   * decides again, so a swallowed failure costs one wasted decision rather than a stuck agent.
   */
  private async step(work: () => Promise<void>, label: string) {
    try {
      await work();
    } catch (error) {
      console.error(`Agent operation ${label} failed:`, error);
    }
  }

  private applyProseWrite(write: ProseWrite) {
    const before = this.store.readEntityStateSync(write.entityId) ?? '';
    const content =
      write.state ?? (write.stateRef ? this.store.readBlob(write.stateRef) : undefined);
    if (write.version !== undefined && content !== undefined) {
      this.store.appendEntityState(write.entityId, write.version, content);
      this.store.appendAudit({
        entityId: write.entityId,
        field: 'state',
        source: write.source,
        before,
        after: content,
        reason: write.reason,
        inputNumber: write.inputNumber,
        batchId: write.batchId,
        tags: write.tags,
      });
    }
    if (write.physicsAfter) {
      this.store.appendAudit({
        entityId: write.entityId,
        field: 'physics',
        source: write.source,
        before: JSON.stringify(write.physicsBefore ?? {}),
        after: JSON.stringify(write.physicsAfter),
        reason: write.reason,
        inputNumber: write.inputNumber,
        batchId: write.batchId,
      });
    }
    if (write.memory?.length) {
      // Recorded only, exactly as before: the searchable copy is written by the operation, which
      // is the only side that can produce an embedding. The log has the content, which is what
      // docs/05 §9.1 requires.
      this.store.appendAudit({
        entityId: write.entityId,
        field: 'memory',
        source: write.source,
        before: '',
        after: write.memory.join('\n'),
        reason: write.reason,
        inputNumber: write.inputNumber,
        batchId: write.batchId,
      });
    }
  }

  /**
   * Archive whatever left the world document this step.
   *
   * The engine keeps its state small by deleting finished conversations and departed players, and
   * the agent layer still needs both: "when did A and B last talk" reads the archive, and a
   * partner who has left still has to have a name.
   */
  private archiveDepartures(diff: GameStateDiff) {
    const survivingConversations = new Set(diff.world.conversations.map((c) => c.id));
    for (const conversation of this.knownConversations) {
      if (survivingConversations.has(conversation.id)) continue;
      this.store.archiveConversation({
        id: conversation.id,
        creator: conversation.creator,
        created: conversation.created,
        ended: this.currentTime,
        numMessages: conversation.numMessages,
        participants: conversation.participants,
      });
    }
    this.knownConversations = diff.world.conversations.map((c) => ({
      id: c.id as GameId<'conversations'>,
      creator: c.creator as GameId<'players'>,
      created: c.created,
      numMessages: c.numMessages,
      participants: c.participants.map((p) => p.playerId as GameId<'players'>),
    }));

    const surviving = new Set<string>(diff.world.players.map((p) => p.id));
    for (const [playerId, name] of this.knownPlayerNames) {
      if (!surviving.has(playerId)) this.store.rememberPlayerName(playerId, name);
    }
    this.knownPlayerNames = new Map(
      diff.world.players.map((p) => [
        p.id as string,
        this.game.playerDescriptions.get(p.id as GameId<'players'>)?.name ?? p.id,
      ]),
    );
  }

  private knownConversations: Omit<ArchivedConversation, 'ended'>[] = [];
  private knownPlayerNames = new Map<string, string>();

  // ---------------------------------------------------------------- persistence

  /**
   * Everything needed to bring this world back.
   *
   * World state and the store travel together but stay separate documents, for the reason
   * docs/11 §7.2 gives: they have different write rhythms and different authors. The log is not
   * in here — it is appended, so a save writes the new events rather than the whole history.
   */
  snapshot(): AgenticRuntimeSnapshot {
    return {
      format: 'agentic-runtime-1',
      worldId: this.game.worldId,
      currentTime: this.currentTime,
      nextIdx: this.nextIdx,
      world: this.game.world.serialize(),
      store: this.store.snapshot(),
    };
  }

  /**
   * Put a snapshot back into a freshly created world.
   *
   * Descriptions, the map and the collision overlay are not in the snapshot because they are not
   * state: they are what the world file and the map compile to, so a caller rebuilds them the
   * usual way and hands the result here. What the snapshot carries is what actually moved.
   */
  restore(snapshot: AgenticRuntimeSnapshot) {
    if (snapshot?.format !== 'agentic-runtime-1') {
      throw new Error('Unsupported agentic runtime snapshot');
    }
    this.game.world = new World(structuredClone(snapshot.world));
    this.game.rebuildCollisionOverlay();
    this.currentTime = snapshot.currentTime;
    this.lastGodStep = snapshot.currentTime;
    this.nextIdx = snapshot.nextIdx;
    this.pending = [];
    this.log = [];
    this.knownConversations = [];
    this.knownPlayerNames = new Map();
    this.store.restoreFrom(snapshot.store);
  }
}
