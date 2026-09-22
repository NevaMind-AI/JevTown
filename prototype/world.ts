import { abilitySettings } from './abilities.js';
import { initialEntities, EntityState, scriptedEntities } from './entities.js';
import {
  decodeState,
  encodeState,
  equal,
  validateEntities,
  LegacyState,
} from './entityRecording.js';
import {
  advanceSchedules,
  initialSchedules,
  npcOnDuty,
  npcResting,
  npcObstacles,
  SchedulePhase,
} from './schedules.js';
import { collectFact, Fact, StepProgress } from './taskFacts.js';
import {
  Condition,
  Content,
  DialogueText,
  loadContent,
  mapBlocked,
  mapEdgeBlocked,
  portalAt,
} from './content.js';
type Position = { x: number; y: number };
export type State = {
  schedules?: Record<string, SchedulePhase>;
  clock?: { realSecondsPerTick: number; elapsedMs: number };
  clues?: string[];
  seated?: { entity: string; returnPosition: Position };
  commerce?: {
    inventory: Record<string, number>;
    stock: Record<string, Record<string, number>>;
    nextRestock?: Record<string, number>;
  };
  entities: Record<string, EntityState>;
  sceneId: string;
  vars: Record<string, boolean>;
  activeEntity: string | null;
  interactionRevision: number;
  time: number;
  balance: number;
  storyTime: number;
  dialogue: boolean;
  dialogueTopic?: string;
  greetedEntities?: string[];
  dialogueSeed?: number;
  player: Position;
  orientation: number;
  tasks: Record<
    string,
    { activated?: true; completed: string[]; steps: Record<string, StepProgress> }
  >;
  npc: { id: string; position: Position; interactions: number; reply: string | null };
  moving: null | { target: Position; arrivesAt: number; durationMs?: number };
};
type Command =
  | { requestId: string; type: 'setClockSpeed'; seconds: number }
  | { requestId: string; type: 'waitUntil'; time: number }
  | { requestId: string; type: 'advanceStoryTime'; seconds: number }
  | {
      requestId: string;
      type: 'buy' | 'sell';
      target: string;
      item: string;
      quantity: number;
      revision: number;
    }
  | { requestId: string; type: 'choose'; choice: string; revision: number; hours?: number }
  | { requestId: string; type: 'teleport'; sceneId: string; x: number; y: number }
  | { requestId: string; type: 'move'; dx: number; dy: number; sprint?: boolean }
  | { requestId: string; type: 'interact'; target: string }
  | {
      requestId: string;
      type: 'cancel' | 'closeDialogue' | 'trade' | 'nextScene' | 'stand';
    };
type Result = { ok: true } | { ok: false; error: string };
export type Snapshot = {
  format: 'memory-world-snapshot-1';
  sequence: number;
  requests: [string, { fingerprint: string; result: Result; sequence: number }][];
};
type Advance = { type: 'advance'; ms: number; steps?: [ms: number, count: number][] };
export function validAdvance(ms: number, steps?: Advance['steps']) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return false;
  if (steps === undefined) return ms <= 60000;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100000) return false;
  let duration = 0,
    count = 0;
  for (const step of steps) {
    if (
      !Array.isArray(step) ||
      step.length !== 2 ||
      !Number.isSafeInteger(step[0]) ||
      step[0] < 1 ||
      step[0] > 60000 ||
      !Number.isSafeInteger(step[1]) ||
      step[1] < 1
    )
      return false;
    duration += step[0] * step[1];
    count += step[1];
  }
  return count <= 100000 && duration === ms;
}
export type Event = {
  sequence: number;
  recordedAt: number;
  cause: Command | Advance;
  result: Result;
  state: State | LegacyState;
};

// Fixed one-room fixture. Movement takes one simulated second per tile.
export class MemoryWorld {
  private state!: State;
  private events: Event[] = [];
  private historyBytes = 0;
  private startSequence = 0;
  private initialState!: State | LegacyState;
  private pendingAdvance: Advance & { count: number; steps: [number, number][] } = {
    type: 'advance',
    ms: 0,
    count: 0,
    steps: [],
  };
  recordingStats() {
    return {
      startSequence: this.startSequence,
      eventCount: this.events.length,
      bytes: this.historyBytes,
      end: this.startSequence + this.events.length,
      elapsedMs: this.state.time - this.initialState.time,
      pendingMs: this.pendingAdvance.ms,
    };
  }
  // Call only after this prefix has committed to storage (or was fully replay-validated).
  releaseRecording(through: number) {
    const count = through - this.startSequence;
    if (!Number.isSafeInteger(through) || count < 0 || count > this.events.length)
      throw new Error('Invalid persisted recording boundary');
    if (count) this.initialState = structuredClone(this.events[count - 1].state);
    this.events = this.events.slice(count);
    this.startSequence = through;
    this.historyBytes = this.events.reduce(
      (sum, event) => sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    this.capacityReached = false;
  }
  private capacityReached = false;
  recordingCapacityReached() {
    return this.capacityReached;
  }
  // ponytail: keep per-run deduplication in memory; use disk-backed lookup if command history outgrows it.
  private requests = new Map<string, Snapshot['requests'][number][1]>();

  constructor(
    private clock = Date.now,
    private random = Math.random,
    private map = {
      width: 5,
      height: 5,
      objectTiles: [] as number[][][],
      spawn: { x: 1, y: 1 },
      npc: { x: 3, y: 1 },
      stepMs: 1000,
    },
    private rules:
      | 'memory-world-1'
      | 'memory-world-2'
      | 'memory-world-3'
      | 'memory-world-4' = 'memory-world-4',
  ) {
    this.reset();
  }

  private content?: Content;
  load(scenes: unknown[], story: unknown, npcs?: unknown) {
    const content = loadContent(scenes, story, npcs);
    if (this.content) throw new Error('Content already loaded; create a new run');
    this.content = content;
    this.reset();
  }

  getEntity(id: string) {
    if (!Object.hasOwn(this.state.entities, id)) return undefined;
    const actor = this.state.entities[id];
    const definition = this.content?.scenes.flatMap((s) => s.entities).find((e) => e.id === id);
    return structuredClone({
      ...definition,
      id,
      name: actor.name,
      character: actor.appearance.character,
      sprite: actor.appearance.sprite,
      appearance: actor.appearance,
      location: actor.sceneId ? { sceneId: actor.sceneId, position: actor.position } : null,
      state: actor,
      capabilities: {
        ...(definition?.movable ? { movement: true } : {}),
        ...(Object.hasOwn(this.content?.story.interactions ?? {}, id) ? { dialogue: true } : {}),
        ...(Object.hasOwn(abilitySettings(this.content).shops ?? {}, id) ? { shop: true } : {}),
        ...(Object.hasOwn(abilitySettings(this.content).schedules ?? {}, id)
          ? { schedule: true }
          : {}),
      },
    });
  }

  scene(id = this.state.sceneId) {
    const scene = structuredClone(this.content?.scenes.find((s) => s.id === id));
    if (scene)
      scene.entities = Object.entries(this.state.entities)
        .filter(([, actor]) => actor.sceneId === id)
        .map(([entityId, actor]) => ({
          ...this.getEntity(entityId)!,
          position: [...actor.position],
        }));
    return scene;
  }
  private conditionMatches(condition: Condition | undefined, state = this.state) {
    if (!condition) return true;
    if ('var' in condition) return state.vars[condition.var] === condition.equals;
    const task = this.content!.story.tasks!.find((t) => t.id === condition.task)!;
    const progress = state.tasks[task.id];
    return (
      (!task.trigger || progress.activated === true) &&
      task.steps.find((s) => !progress.completed.includes(s.id))?.id === condition.step
    );
  }
  private dialogueText(dialogue: DialogueText, draft: State) {
    const reply = dialogue.replies?.find((r) => this.conditionMatches(r.when, draft)) ?? dialogue;
    if (!reply.variants) return reply.text;
    draft.dialogueSeed =
      (Math.imul(draft.dialogueSeed ?? draft.time ^ draft.storyTime, 1664525) + 1013904223) >>> 0;
    return reply.variants[Math.floor((draft.dialogueSeed / 4294967296) * reply.variants.length)];
  }
  choices() {
    const entity = this.scene()?.entities.find((e) => e.id === this.state.activeEntity);
    const choices = entity ? (this.content!.story.interactions[entity.id]?.choices ?? []) : [];
    return structuredClone(
      choices.filter((c) => c.topic === this.state.dialogueTopic && this.conditionMatches(c.when)),
    );
  }
  nearby() {
    return (
      this.scene()
        ?.entities.filter((e) => {
          if (!npcOnDuty(this.state, e.id) || npcResting(this.content!, this.state, e.id))
            return false;
          const dx = this.state.player.x - e.position[0],
            dy = this.state.player.y - e.position[1];
          const actor = this.state.entities[e.id];
          const available = !actor.path.length && !actor.transit;
          return (
            available &&
            !e.portal &&
            (e.seat || Object.hasOwn(this.content!.story.interactions, e.id)) &&
            (Math.abs(dx) + Math.abs(dy) === 1 ||
              e.interactionOffsets?.some(([x, y]) => x === dx && y === dy))
          );
        })
        .sort((a, b) => Number(!!a.seat) - Number(!!b.seat)) ?? []
    );
  }

  seatUnavailable(id: string) {
    const scene = this.scene(),
      chair = scene?.entities.find((e) => e.id === id);
    if (!chair?.seat) return false;
    return Object.values(this.state.entities).some(
      (actor) =>
        actor.sceneId === scene!.id &&
        actor.activity?.seatedOn &&
        (actor.activity?.seatedOn === id ||
          (chair.seat!.table !== undefined &&
            scene!.entities.find((e) => e.id === actor.activity?.seatedOn)?.seat?.table ===
              chair.seat!.table)),
    );
  }

  private itemQuantity(id: string) {
    const inventory = this.state.commerce?.inventory;
    return inventory && Object.hasOwn(inventory, id) ? inventory[id] : 0;
  }
  inventoryView() {
    let relicIndex = 0;
    return (this.content?.story.items ?? []).map((item) => {
      if (item.kind === 'relic') relicIndex++;
      return {
        ...structuredClone(item),
        ...(item.kind === 'relic' ? { slot: item.slot ?? relicIndex } : {}),
        quantity: this.itemQuantity(item.id),
      };
    });
  }
  clueView() {
    return (this.state.clues ?? []).map((id) =>
      structuredClone(this.content!.story.clues!.find((clue) => clue.id === id)!),
    );
  }
  shopView() {
    const id = this.state.activeEntity;
    const shops = abilitySettings(this.content).shops;
    const shop =
      id && this.state.dialogue && shops && Object.hasOwn(shops, id) ? shops[id] : undefined;
    if (!id || !shop || !this.state.commerce) return null;
    return {
      id,
      name: shop.name,
      offers: shop.offers.map((offer) => ({
        ...structuredClone(this.content!.story.items!.find((item) => item.id === offer.item)!),
        buySeconds: offer.buySeconds,
        sellSeconds: offer.sellSeconds,
        stock: this.state.commerce!.stock[id][offer.item],
        owned: this.itemQuantity(offer.item),
      })),
    };
  }

  reset() {
    this.state = {
      ...(this.content?.story.clock?.realSecondsPerTick !== undefined
        ? {
            clock: {
              realSecondsPerTick: this.content.story.clock.realSecondsPerTick,
              elapsedMs: 0,
            },
          }
        : {}),
      ...(this.content?.story.clues?.length ? { clues: [] } : {}),
      ...(this.content?.story.items?.length
        ? {
            commerce: {
              inventory: Object.fromEntries(
                this.content.story.items
                  .filter((item) => item.initiallyOwned)
                  .map((item) => [item.id, 1]),
              ),
              stock: Object.fromEntries(
                Object.entries(abilitySettings(this.content).shops ?? {}).map(([id, shop]) => [
                  id,
                  Object.fromEntries(shop.offers.map((offer) => [offer.item, offer.stock])),
                ]),
              ),
            },
          }
        : {}),
      entities: this.content ? initialEntities(this.content) : {},
      sceneId: this.content?.story.start.scene ?? 'fixture',
      vars: structuredClone(this.content?.story.vars ?? {}),
      activeEntity: null,
      interactionRevision: 0,
      time: 0,
      balance: this.content?.story.clock?.initialBalanceSeconds ?? 7 * 3600,
      storyTime: this.content?.story.clock?.startTimeSeconds ?? 18 * 3600,
      dialogue: false,
      player: { ...this.map.spawn },
      orientation: 90,
      tasks: Object.fromEntries(
        (this.content?.story.tasks ?? []).map((t) => [t.id, { completed: [], steps: {} }]),
      ),
      npc: { id: 'n07', position: { ...this.map.npc }, interactions: 0, reply: null },
      moving: null,
    };
    if (this.content) {
      const scene = this.content.scenes.find((s) => s.id === this.state.sceneId)!;
      const [x, y] = scene.anchors[this.content.story.start.anchor];
      this.state.player = { x, y };
    }
    if (this.state.commerce) {
      const schedule = Object.fromEntries(
        Object.entries(abilitySettings(this.content).shops ?? {})
          .filter(([, shop]) => shop.restock)
          .map(([id, shop]) => [id, this.state.storyTime + shop.restock!.intervalSeconds]),
      );
      if (Object.keys(schedule).length) this.state.commerce.nextRestock = schedule;
    }
    if (this.content) initialSchedules(this.content, this.state);
    this.activateTasks(this.state);
    this.events = [];
    this.historyBytes = 0;
    this.startSequence = 0;
    this.capacityReached = false;
    this.requests.clear();
    this.initialState = this.recordedState();
    this.pendingAdvance = { type: 'advance', ms: 0, count: 0, steps: [] };
  }

  // Recording layout follows the run's rules; callers and rendering always inspect canonical entities.
  recordedState() {
    return this.content ? encodeState(this.content, this.state, this.rules) : this.inspect();
  }

  inspect() {
    return structuredClone(this.state);
  }
  // afterSequence is an exclusive global cursor, including after a saved prefix is released.
  history(afterSequence = this.startSequence) {
    return structuredClone(this.events.slice(Math.max(0, afterSequence - this.startSequence)));
  }

  // Internal checkpoint: restore only data captured from this world's committed state.
  // Not a file import API. Persistence needs content/log binding and input validation.
  checkpoint() {
    const state = this.inspect();
    const requests = structuredClone(this.requests);
    const events = this.events.slice();
    const historyBytes = this.historyBytes;
    const startSequence = this.startSequence;
    const initialState = structuredClone(this.initialState);
    const pendingAdvance = structuredClone(this.pendingAdvance);
    return () => {
      this.state = structuredClone(state);
      this.requests = structuredClone(requests);
      this.events = events.slice();
      this.historyBytes = historyBytes;
      this.startSequence = startSequence;
      this.initialState = structuredClone(initialState);
      this.pendingAdvance = structuredClone(pendingAdvance);
      this.capacityReached = false;
    };
  }

  // The caller binds this local snapshot to its recording/content before restoration.
  restoreSnapshot(input: State | LegacyState, snapshot: Snapshot) {
    const state = this.content
      ? decodeState(this.content, input, this.rules)
      : (structuredClone(input) as State);
    if (this.content) validateEntities(this.content, state);
    if (
      snapshot?.format !== 'memory-world-snapshot-1' ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence < 0 ||
      !Array.isArray(snapshot.requests)
    )
      throw new Error('Invalid snapshot');
    const requests = new Map<string, Snapshot['requests'][number][1]>();
    for (const entry of snapshot.requests) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid snapshot request');
      const [id, cached] = entry;
      if (
        !cached ||
        !Number.isSafeInteger(cached.sequence) ||
        cached.sequence < 1 ||
        cached.sequence > snapshot.sequence ||
        requests.has(id) ||
        typeof cached.result?.ok !== 'boolean' ||
        (!cached.result.ok && typeof cached.result.error !== 'string')
      )
        throw new Error('Invalid snapshot request');
      const command = parseCommand(JSON.parse(cached.fingerprint));
      if (command.requestId !== id || JSON.stringify(command) !== cached.fingerprint)
        throw new Error('Invalid snapshot request fingerprint');
      requests.set(id, structuredClone(cached));
    }
    if (
      state.dialogueSeed !== undefined &&
      (!Number.isSafeInteger(state.dialogueSeed) ||
        state.dialogueSeed < 0 ||
        state.dialogueSeed > 4294967295)
    )
      throw new Error('Invalid dialogue random state');
    if (
      state.greetedEntities !== undefined &&
      (!Array.isArray(state.greetedEntities) ||
        new Set(state.greetedEntities).size !== state.greetedEntities.length ||
        state.greetedEntities.some(
          (id) =>
            typeof id !== 'string' ||
            !Object.hasOwn(this.content?.story.interactions ?? {}, id) ||
            !this.content!.story.interactions[id].firstText,
        ))
    )
      throw new Error('Invalid greeting state');
    if (
      state.clues !== undefined &&
      (!Array.isArray(state.clues) ||
        new Set(state.clues).size !== state.clues.length ||
        state.clues.some((id) => !this.content?.story.clues?.some((clue) => clue.id === id)))
    )
      throw new Error('Invalid clue state');
    if (this.content?.story.clock?.realSecondsPerTick !== undefined) {
      if (
        !state.clock ||
        !Number.isSafeInteger(state.clock.realSecondsPerTick) ||
        state.clock.realSecondsPerTick < 1 ||
        state.clock.realSecondsPerTick > 3600 ||
        !Number.isSafeInteger(state.clock.elapsedMs) ||
        state.clock.elapsedMs < 0 ||
        state.clock.elapsedMs >= state.clock.realSecondsPerTick * 1000
      )
        throw new Error('Invalid clock state');
    } else if (state.clock !== undefined) throw new Error('Unexpected clock state');
    if (abilitySettings(this.content).schedules) {
      const schedules = abilitySettings(this.content).schedules!;
      if (
        !state.schedules ||
        typeof state.schedules !== 'object' ||
        Array.isArray(state.schedules) ||
        Object.keys(state.schedules).length !== Object.keys(schedules).length
      )
        throw new Error('Invalid schedule state');
      for (const [id, config] of Object.entries(schedules)) {
        const phase = state.schedules[id],
          actor = state.entities[id];
        if (
          !Object.hasOwn(state.schedules, id) ||
          !['active', 'leaving', 'away', 'returning'].includes(phase)
        )
          throw new Error('Invalid schedule phase');
        if (actor.sceneId !== (phase === 'away' ? '' : config.scene))
          throw new Error('Invalid scheduled scene');
        if (phase === 'away' && (actor.moving || actor.path.length))
          throw new Error('Absent NPC cannot move');
      }
    } else if (state.schedules !== undefined) throw new Error('Unexpected schedule state');
    this.state = structuredClone(state);
    this.requests = requests;
    this.events = [];
    this.historyBytes = 0;
    this.startSequence = snapshot.sequence;
    this.initialState = this.recordedState();
    this.pendingAdvance = { type: 'advance', ms: 0, count: 0, steps: [] };
    this.capacityReached = false;
  }

  recording(eventCount?: number) {
    if (!this.content) throw new Error('Recording requires a content-driven world');
    if (eventCount === undefined) {
      if (!this.flushSteps()) throw new Error('录制内存容量已满，请先保存已有事件。');
      eventCount = this.events.length;
    }
    if (
      !Number.isSafeInteger(eventCount) ||
      eventCount < 0 ||
      eventCount > this.events.length ||
      (!eventCount && this.events.length)
    )
      throw new Error('Invalid recording prefix length');
    const events = this.events.slice(0, eventCount);
    const end = this.startSequence + eventCount;
    return structuredClone({
      format: 'remaining-time-run-1' as const,
      ...(this.startSequence ? { startSequence: this.startSequence } : {}),
      rules: this.rules,
      content: this.content,
      config: { stepMs: this.map.stepMs, npc: this.map.npc },
      eventCount,
      events,
      ...({ initialState: this.initialState } as { initialState?: State | LegacyState }),
      finalState: events.at(-1)?.state ?? this.initialState,
      ...({
        snapshot: {
          format: 'memory-world-snapshot-1',
          sequence: end,
          requests: [...this.requests].filter(([, entry]) => entry.sequence <= end),
        },
      } as { snapshot?: Snapshot }),
    });
  }

  execute(input: unknown): Result {
    let command: Command;
    try {
      command = parseCommand(input);
      if (
        this.rules === 'memory-world-1' &&
        command.type === 'move' &&
        command.sprint !== undefined
      )
        throw new Error('Sprint requires memory-world-2');
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    const fingerprint = JSON.stringify(command);
    const previous = this.requests.get(command.requestId);
    if (previous) {
      return previous.fingerprint === fingerprint
        ? structuredClone(previous.result)
        : { ok: false, error: 'requestId already used for another command' };
    }
    if (this.capacityReached || !this.flushSteps())
      return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
    const draft = this.inspect();
    let result: Result;
    let facing: number | undefined;
    try {
      if (command.type === 'stand') {
        if (!draft.seated) throw new Error('Player is not seated');
        const p = draft.seated.returnPosition;
        if (
          mapBlocked(this.scene()!.map, p.x, p.y) ||
          scriptedEntities(draft)
            .map(([, actor]) => actor)
            .some(
              (e) =>
                e.sceneId === draft.sceneId &&
                ((e.position[0] === p.x && e.position[1] === p.y) ||
                  (e.moving?.target.x === p.x && e.moving?.target.y === p.y)),
            )
        )
          throw new Error('Seat exit is occupied');
        draft.player = { ...p };
        delete draft.seated;
      } else if (command.type === 'cancel') {
        draft.moving = null;
      } else if (command.type === 'closeDialogue') {
        draft.dialogue = false;
        delete draft.dialogueTopic;
        draft.activeEntity = null;
        draft.interactionRevision++;
      } else if (command.type === 'choose') {
        if (!this.content || !draft.dialogue || command.revision !== draft.interactionRevision)
          throw new Error('Stale interaction');
        const entity = this.scene()!.entities.find((e) => e.id === draft.activeEntity);
        if (!entity) throw new Error('Unknown entity');
        const choiceId = command.choice;
        const choice = this.choices().find((c) => c.id === choiceId);
        if (!choice) throw new Error('Choice unavailable');
        if (
          command.hours !== undefined &&
          !choice.effects.some((e) => e.op === 'sleep' && 'selectHours' in e)
        )
          throw new Error('此选项不支持自选睡眠时长');
        this.applyChoice(draft, entity, choice, command.hours);
        if (choice.opens === undefined)
          this.progressTasks(draft, {
            event: 'choice.confirmed',
            fields: { entityId: entity.id, choiceId: choice.id },
          });
      } else if (command.type === 'buy' || command.type === 'sell') {
        const targetId = command.target,
          itemId = command.item;
        if (
          draft.moving ||
          !draft.dialogue ||
          draft.activeEntity !== targetId ||
          !this.nearby().some((e) => e.id === targetId)
        )
          throw new Error('请先与商人交谈');
        if (command.revision !== draft.interactionRevision)
          throw new Error('交易状态已更新，请重试');
        const shops = abilitySettings(this.content).shops;
        const offer =
          shops && Object.hasOwn(shops, targetId)
            ? shops[targetId].offers.find((o) => o.item === itemId)
            : undefined;
        if (!offer || !draft.commerce) throw new Error('商人不交易这件物品');
        const owned = this.itemQuantity(command.item);
        const stock = draft.commerce.stock[command.target][command.item];
        const buying = command.type === 'buy';
        const amount = (buying ? offer.buySeconds : offer.sellSeconds) * command.quantity;
        if (buying && stock < command.quantity) throw new Error('商店库存不足');
        if (!buying && owned < command.quantity) throw new Error('背包数量不足');
        if (buying && draft.balance < amount) throw new Error('生命余额不足');
        const inventory = owned + (buying ? command.quantity : -command.quantity);
        const remaining = stock + (buying ? -command.quantity : command.quantity);
        const balance = draft.balance + (buying ? -amount : amount);
        if (
          !Number.isSafeInteger(amount) ||
          !Number.isSafeInteger(balance) ||
          inventory > 9999 ||
          remaining > 9999
        )
          throw new Error('交易超出余额或数量上限');
        draft.balance = balance;
        if (inventory) draft.commerce.inventory[command.item] = inventory;
        else delete draft.commerce.inventory[command.item];
        draft.commerce.stock[command.target][command.item] = remaining;
        draft.interactionRevision++;
      } else if (command.type === 'trade') {
        if (this.content) throw new Error('Use story choices for transactions');
        if (!draft.dialogue) throw new Error('Talk to N-07 before trading');
        if (!Number.isSafeInteger(draft.balance - 1800)) throw new Error('Balance overflow');
        draft.balance -= 1800;
        draft.npc.reply = 'Room service confirmed. Cost: 0:30:00.';
      } else if (command.type === 'setClockSpeed') {
        if (!draft.clock) throw new Error('当前存档未启用分段时钟');
        draft.clock.elapsedMs = Math.floor(
          (draft.clock.elapsedMs * command.seconds) / draft.clock.realSecondsPerTick,
        );
        draft.clock.realSecondsPerTick = command.seconds;
      } else if (command.type === 'waitUntil') {
        this.waitUntil(draft, command.time);
      } else if (command.type === 'advanceStoryTime') {
        this.advanceStoryClock(draft, command.seconds);
      } else if (command.type === 'teleport') {
        const { sceneId, x, y } = command;
        const scene = this.content?.scenes.find((candidate) => candidate.id === sceneId);
        if (!scene) throw new Error(`未知场景: ${sceneId}`);
        if (x < 0 || x >= scene.map.width || y < 0 || y >= scene.map.height)
          throw new Error('坐标超出场景范围');
        draft.sceneId = scene.id;
        draft.player = { x, y };
        draft.moving = null;
        draft.seated = undefined;
        draft.dialogue = false;
        draft.activeEntity = null;
      } else if (command.type === 'nextScene') {
        if (draft.moving || draft.dialogue)
          throw new Error('Finish moving or close dialogue first');
        if (draft.storyTime >= 24 * 3600) throw new Error('The story has reached midnight');
        this.advanceStoryClock(draft, 3600);
      } else if (command.type === 'move') {
        if (draft.seated) throw new Error('请先起身');
        if (draft.dialogue) throw new Error('Close dialogue before moving');
        if (draft.moving) throw new Error('Player is moving; advance simulation first');
        const target = { x: draft.player.x + command.dx, y: draft.player.y + command.dy };
        if (this.rules !== 'memory-world-1')
          facing = draft.orientation = movementOrientation(draft.player, target);
        const scene = this.scene();
        if (
          scene &&
          mapEdgeBlocked(scene.map, [draft.player.x, draft.player.y], [target.x, target.y])
        )
          throw new Error('Destination is blocked');
        const portal = scene && portalAt(scene, target.x, target.y);
        if (portal) {
          const interaction = this.content!.story.interactions[portal.id];
          const choice = interaction?.choices.find((c) => this.conditionMatches(c.when, draft));
          if (!choice) throw new Error(interaction?.text ?? '入口尚未开放');
          this.applyChoice(draft, portal, choice);
        } else {
          const sceneBlocked =
            scene &&
            (mapBlocked(scene.map, target.x, target.y) ||
              scene.entities.some(
                (e) =>
                  (e.position[0] === target.x && e.position[1] === target.y) ||
                  (draft.entities[e.id]?.moving?.target.x === target.x &&
                    draft.entities[e.id]?.moving?.target.y === target.y),
              ));
          if (
            sceneBlocked ||
            (!scene &&
              (target.x < 0 ||
                target.x >= this.map.width ||
                target.y < 0 ||
                target.y >= this.map.height ||
                this.map.objectTiles.some((layer) => layer[target.x]?.[target.y] !== -1) ||
                (target.x === draft.npc.position.x && target.y === draft.npc.position.y)))
          ) {
            throw new Error('Destination is blocked');
          }
          const durationMs = this.map.stepMs / (command.sprint ? 2 : 1);
          if (!Number.isSafeInteger(Math.ceil(draft.time + durationMs)))
            throw new Error('Simulation time overflow');
          draft.moving = {
            target,
            arrivesAt: draft.time + durationMs,
            ...(this.rules !== 'memory-world-1' ? { durationMs } : {}),
          };
        }
      } else if (command.type === 'interact') {
        if (draft.seated) throw new Error('请先起身');
        if (draft.moving) throw new Error('Player is moving; advance simulation first');
        if (this.content) {
          const targetId = command.target;
          const entity = this.nearby().find((e) => e.id === targetId);
          if (!entity) throw new Error('Target is out of reach');
          if (entity.seat) {
            if (this.seatUnavailable(entity.id)) throw new Error('这桌已有客人，请选择空桌');
            if (draft.dialogue) throw new Error('Close dialogue before sitting');
            draft.seated = { entity: entity.id, returnPosition: { ...draft.player } };
            draft.player = { x: entity.position[0], y: entity.position[1] };
            draft.orientation = entity.seat.orientation;
          } else {
            const npcPosition = { x: entity.position[0], y: entity.position[1] };
            const actor = draft.entities[entity.id];
            if (!actor.activity?.seatedOn)
              actor.orientation = movementOrientation(npcPosition, draft.player);
            draft.orientation = movementOrientation(draft.player, npcPosition);
            draft.activeEntity = entity.id;
            draft.interactionRevision++;
            draft.dialogue = true;
            delete draft.dialogueTopic;
            const interaction = this.content.story.interactions[entity.id];
            draft.npc.reply = this.dialogueText(interaction, draft);
            if (interaction.firstText && !draft.greetedEntities?.includes(entity.id)) {
              draft.npc.reply = interaction.firstText + '\n\n' + draft.npc.reply;
              (draft.greetedEntities ??= []).push(entity.id);
            }
            draft.npc.interactions++;
          }
          this.progressTasks(draft, {
            event: 'interaction.started',
            fields: { entityId: entity.id },
          });
        } else {
          if (command.target !== draft.npc.id) throw new Error('Unknown interaction target');
          const distance =
            Math.abs(draft.player.x - draft.npc.position.x) +
            Math.abs(draft.player.y - draft.npc.position.y);
          if (distance !== 1) throw new Error('Target is out of reach');
          const sample = this.random();
          if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
            throw new Error('Invalid random sample');
          draft.dialogue = true;
          draft.npc.interactions++;

          draft.npc.reply =
            sample < 0.5 ? 'Welcome to room 404.' : 'The inheritance cabinet is waiting.';
        }
      }
      if (draft.moving) draft.orientation = movementOrientation(draft.player, draft.moving.target);
      if (this.content) advanceSchedules(this.content, draft);
      this.activateTasks(draft);
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: (error as Error).message };
    }
    // Record first so a failed clock/serialization cannot leave a partial state update.
    // A rejected idle move may turn, but none of its other draft effects may commit.
    const next = result.ok
      ? draft
      : facing === undefined
        ? this.state
        : { ...this.state, orientation: facing };
    if (!this.record(command, result, next))
      return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
    this.state = next;
    this.requests.set(command.requestId, {
      fingerprint,
      result: structuredClone(result),
      sequence: this.startSequence + this.events.length,
    });
    return structuredClone(result);
  }

  gameTime(state = this.state) {
    const c = state.clock;
    return (
      state.storyTime +
      (c
        ? (c.elapsedMs * this.content!.story.clock!.gameSecondsPerTick!) /
          (c.realSecondsPerTick * 1000)
        : 0)
    );
  }

  private sleepTarget(effect: import('./content.js').Sleep, state: State, hours?: number) {
    const now = this.gameTime(state);
    if ('selectHours' in effect) {
      if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 24)
        throw new Error('请选择1至24个整小时的睡眠时长');
      return Math.ceil(now) + hours * 3600;
    }
    return 'seconds' in effect
      ? Math.ceil(now) + effect.seconds
      : (Math.floor(now / 86400) + 1) * 86400 + effect.nextDayAt;
  }

  sleepView(choiceId: string): { time?: number; selectHours?: true } | undefined {
    const effect = this.choices()
      .find((c) => c.id === choiceId)
      ?.effects.find((e) => e.op === 'sleep');
    if (effect?.op !== 'sleep') return;
    return 'selectHours' in effect
      ? { selectHours: true }
      : { time: this.sleepTarget(effect, this.state) };
  }

  private waitUntil(draft: State, time: number) {
    if (!this.content) throw new Error('Waiting requires content');
    if (draft.moving || draft.dialogue) throw new Error('请先结束移动或交谈');
    const seconds = time - draft.storyTime;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800)
      throw new Error('只能等待未来1秒至7天');
    if (draft.balance < seconds) throw new Error('剩余生命不足以等待到该时刻');
    const start = draft.time,
      story = draft.storyTime;
    const period = (draft.clock?.realSecondsPerTick ?? 1) * 1000,
      quantum = draft.clock ? this.content.story.clock!.gameSecondsPerTick! : 1,
      pending = draft.clock?.elapsedMs ?? 0;
    const duration = Math.ceil((seconds * period - pending * quantum) / quantum),
      end = start + duration;
    if (duration <= 0) throw new Error('目标时刻已在本段累计时间内，请选择更晚的时刻');
    if (!Number.isSafeInteger(end)) throw new Error('Simulation time overflow');
    draft.balance -= seconds;
    if (draft.clock) draft.clock.elapsedMs = 0;
    const accrued = Math.floor((pending * quantum) / period);
    if (accrued) this.advanceStoryClock(draft, accrued);
    this.advanceState(draft, 0, false);
    let steps = 0;
    while (draft.time < end) {
      // ponytail: bound work for very slow debug clocks; split longer waits until scheduling is optimized.
      if (draft.clock && ++steps > 200000)
        throw new Error('等待涉及过多活动，请选择更近的时刻或提高时间流速');
      const phase = pending + draft.time - start - ((draft.storyTime - story) * period) / quantum;
      const next = this.nextWaitTick(draft, end, phase, period / quantum);
      this.advanceStoryClock(
        draft,
        story +
          Math.min(seconds, Math.floor(((pending + next - start) * quantum) / period)) -
          draft.storyTime,
      );
      this.advanceState(draft, next - draft.time, false);
    }
  }

  // Waiting visits service deadlines without recording or cloning an intermediate world per tick.
  private nextWaitTick(state: State, end: number, phase: number, realMsPerGameSecond = 1000) {
    const now = state.time,
      candidates = [end];
    for (const [id, schedule] of Object.entries(abilitySettings(this.content).schedules ?? {})) {
      for (const hour of [schedule.sleepAt, schedule.wakeAt]) {
        let boundary = Math.floor(state.storyTime / 86400) * 86400 + hour;
        if (boundary <= state.storyTime) boundary += 86400;
        candidates.push(
          Math.ceil(now + (boundary - state.storyTime) * realMsPerGameSecond - phase),
        );
      }
      const status = state.schedules![id];
      if (
        (status === 'leaving' ||
          status === 'returning' ||
          (status === 'away' && !npcResting(this.content!, state, id))) &&
        state.entities[id]
      )
        candidates.push(now + this.map.stepMs);
    }
    for (const [, actor] of scriptedEntities(state))
      if (actor.moving) candidates.push(actor.moving.arrivesAt);
    return Math.min(end, Math.max(now + 1, Math.min(...candidates)));
  }

  private advanceStoryClock(draft: State, seconds: number) {
    if (!Number.isSafeInteger(draft.storyTime + seconds)) throw new Error('Story time overflow');
    draft.storyTime += seconds;
    for (const [id, due] of Object.entries(draft.commerce?.nextRestock ?? {})) {
      if (draft.storyTime < due) continue;
      const shop = abilitySettings(this.content).shops![id],
        interval = shop.restock!.intervalSeconds;
      // Skip missed periods in one calculation; replenishment never accumulates surplus.
      const next = due + (Math.floor((draft.storyTime - due) / interval) + 1) * interval;
      if (!Number.isSafeInteger(next)) throw new Error('Restock time overflow');
      for (const offer of shop.offers) {
        const stock = draft.commerce!.stock[id];
        stock[offer.item] = Math.max(stock[offer.item], offer.stock);
      }
      draft.commerce!.nextRestock![id] = next;
      if (draft.activeEntity === id) draft.interactionRevision++;
    }
  }

  private applyChoice(
    draft: State,
    entity: import('./content.js').Entity,
    choice: import('./content.js').Choice,
    hours?: number,
  ) {
    if (choice.opens !== undefined) {
      if (
        !draft.dialogue ||
        draft.activeEntity !== entity.id ||
        !this.nearby().some((e) => e.id === entity.id)
      )
        throw new Error('Target is out of reach');
      const interaction = this.content!.story.interactions[entity.id];
      const topic = choice.opens === 'root' ? interaction : interaction.topics![choice.opens];
      if (choice.opens === 'root') delete draft.dialogueTopic;
      else draft.dialogueTopic = choice.opens;
      draft.npc.reply = this.dialogueText(topic, draft);
      draft.interactionRevision++;
      return;
    }
    for (const effect of choice.effects) {
      if (effect.op === 'set') draft.vars[effect.var] = effect.value;
      else if (effect.op === 'sleep') {
        if (
          draft.seated ||
          !draft.dialogue ||
          draft.activeEntity !== entity.id ||
          !this.nearby().some((e) => e.id === entity.id)
        )
          throw new Error('请站在床边选择休息');
        const time = this.sleepTarget(effect, draft, hours);
        draft.dialogue = false;
        draft.activeEntity = null;
        this.waitUntil(draft, time);
      } else if (effect.op === 'pay_time') {
        if (!Number.isSafeInteger(draft.balance - effect.seconds))
          throw new Error('Balance overflow');
        draft.balance -= effect.seconds;
      } else if (
        effect.op === 'give_item' ||
        effect.op === 'pickup_item' ||
        effect.op === 'take_item'
      ) {
        const inventory = draft.commerce?.inventory;
        if (!inventory) throw new Error('Inventory unavailable');
        const quantity =
          (Object.hasOwn(inventory, effect.item) ? inventory[effect.item] : 0) +
          (effect.op === 'take_item' ? -effect.quantity : effect.quantity);
        if (quantity < 0) throw new Error('未持有足够的任务物品');
        if (quantity > 9999) throw new Error('背包数量已达上限，请先腾出位置');
        if (effect.op === 'pickup_item') {
          const actor = draft.entities[entity.id];
          if (
            !actor ||
            actor.sceneId !== draft.sceneId ||
            actor.moving ||
            actor.path.length ||
            actor.transit
          )
            throw new Error('物件已不在原处');
          actor.sceneId = '';
        }
        if (quantity) inventory[effect.item] = quantity;
        else delete inventory[effect.item];
      } else if (effect.op === 'grant_clue') {
        if (!this.content!.story.clues?.some((clue) => clue.id === effect.clue))
          throw new Error('Unknown relic clue');
        draft.clues ??= [];
        if (!draft.clues.includes(effect.clue)) draft.clues.push(effect.clue);
      } else if (effect.op === 'move_entity') {
        const actor = draft.entities[effect.entity];
        if (!actor || actor.sceneId !== draft.sceneId || actor.path.length || actor.transit)
          throw new Error('Entity unavailable for movement');
        if (
          draft.activeEntity &&
          draft.activeEntity !== entity.id &&
          draft.activeEntity === effect.entity
        )
          throw new Error('Entity is interacting');
        if (
          Math.abs(actor.position[0] - effect.path[0][0]) +
            Math.abs(actor.position[1] - effect.path[0][1]) !==
          1
        )
          throw new Error('Path must start next to entity');
        actor.path = structuredClone(effect.path);
        actor.transit = effect.via ? { via: effect.via, arrival: effect.arrival! } : null;
        this.startEntityStep(draft, effect.entity, draft.time);
      } else {
        const destination = this.content!.scenes.find((s) => s.id === entity.portal?.scene);
        const point = destination?.anchors[entity.portal!.anchor];
        if (!destination || !point) throw new Error('Destination unavailable');
        if (
          scriptedEntities(draft)
            .map(([, actor]) => actor)
            .some(
              (e) =>
                e.sceneId === destination.id &&
                ((e.position[0] === point[0] && e.position[1] === point[1]) ||
                  (e.moving?.target.x === point[0] && e.moving?.target.y === point[1])),
            )
        )
          throw new Error('Arrival occupied');
        draft.sceneId = destination.id;
        this.progressTasks(draft, { event: 'scene.entered', fields: { sceneId: destination.id } });
        draft.player = { x: point[0], y: point[1] };
        draft.moving = null;
      }
    }
    draft.dialogue = false;
    delete draft.dialogueTopic;
    draft.activeEntity = null;
    draft.interactionRevision++;
  }

  private activateTasks(draft: State) {
    for (const task of this.content?.story.tasks ?? []) {
      if (!task.trigger || draft.tasks[task.id].activated) continue;
      const reached = this.conditionMatches(task.trigger, draft);
      if (reached) draft.tasks[task.id].activated = true;
    }
  }

  taskViews() {
    return (this.content?.story.tasks ?? [])
      .filter(
        (t) =>
          !t.trigger ||
          (this.state.tasks[t.id].activated &&
            (this.state.tasks[t.id].completed.length < t.steps.length || t.completion)),
      )
      .map((task) => {
        const progress = this.state.tasks[task.id],
          index = task.steps.findIndex((step) => !progress.completed.includes(step.id));
        const current = index < 0 ? task.completion : task.steps[index];
        return {
          id: task.id,
          title: task.title,
          background: current?.background ?? task.background,
          description: current?.description ?? task.description,
          steps: structuredClone(task.steps.slice(0, index < 0 ? task.steps.length : index + 1)),
          completed: [...progress.completed],
          progress: structuredClone(progress.steps),
        };
      });
  }

  private progressTasks(draft: State, fact: Fact) {
    for (const task of this.content?.story.tasks ?? []) {
      const progress = draft.tasks[task.id];
      if (task.trigger && !progress.activated) continue;
      const step = task.steps.find((s) => !progress.completed.includes(s.id));
      if (!step) continue;
      const next = collectFact(
        step.condition,
        progress.steps[step.id] ?? { count: 0, values: [] },
        fact,
      );
      progress.steps[step.id] = next;
      if (next.count >= step.condition.count) progress.completed.push(step.id);
    }
  }

  private startEntityStep(draft: State, id: string, time: number) {
    const actor = draft.entities[id];
    if (actor.moving || !actor.path.length) return;
    const [x, y] = actor.path[0];
    const scene = this.content!.scenes.find((s) => s.id === actor.sceneId)!;
    const blocked =
      mapBlocked(scene.map, x, y) ||
      mapEdgeBlocked(scene.map, actor.position, [x, y]) ||
      scriptedEntities(draft).some(
        ([other, e]) =>
          other !== id &&
          e.sceneId === actor.sceneId &&
          ((e.position[0] === x && e.position[1] === y) ||
            (e.moving?.target.x === x && e.moving?.target.y === y)),
      ) ||
      (Object.values(scene.anchors).some((p) => p[0] === x && p[1] === y) &&
        !(actor.transit && actor.path.length === 1) &&
        npcOnDuty(draft, id)) ||
      (!!abilitySettings(this.content).schedules?.[id] &&
        npcObstacles(this.content!, draft, actor.sceneId, id).some(
          (p) => p[0] === x && p[1] === y,
        )) ||
      (draft.sceneId === actor.sceneId &&
        ((draft.seated?.returnPosition.x === x && draft.seated.returnPosition.y === y) ||
          (draft.player.x === x && draft.player.y === y) ||
          (draft.moving?.target.x === x && draft.moving?.target.y === y)));
    if (blocked) return;
    if (!Number.isSafeInteger(time + this.map.stepMs)) throw new Error('Simulation time overflow');
    actor.orientation = movementOrientation(
      { x: actor.position[0], y: actor.position[1] },
      { x, y },
    );
    actor.moving = { target: { x, y }, arrivesAt: time + this.map.stepMs };
  }

  // Live simulation steps accumulate timer-only progress until a change, command or save boundary.
  step(ms: number): Result {
    if (this.capacityReached) return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
    if (!validAdvance(ms) || !Number.isSafeInteger(this.state.time + ms))
      return { ok: false, error: 'Invalid simulation step' };
    const draft = this.inspect();
    try {
      this.advanceState(draft, ms);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    const before = {
      ...this.state,
      time: draft.time,
      ...(this.state.clock && draft.clock
        ? { clock: { ...this.state.clock, elapsedMs: draft.clock.elapsedMs } }
        : {}),
    };
    const pending = structuredClone(this.pendingAdvance);
    pending.ms += ms;
    pending.count++;
    if (pending.steps.at(-1)?.[0] === ms) pending.steps[pending.steps.length - 1][1]++;
    else pending.steps.push([ms, 1]);
    // Bound replay work per event to the same 100,000-step validation budget.
    if (!equal(before, draft) || pending.count === 100000) {
      const { count, ...cause } = pending;
      if (!this.record(cause, { ok: true }, draft))
        return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
      this.pendingAdvance = { type: 'advance', ms: 0, count: 0, steps: [] };
    } else this.pendingAdvance = pending;
    this.state = draft;
    return { ok: true };
  }

  private flushSteps() {
    if (!this.pendingAdvance.count) return true;
    const { count, ...cause } = this.pendingAdvance;
    if (!this.record(cause, { ok: true }, this.state)) return false;
    this.pendingAdvance = { type: 'advance', ms: 0, count: 0, steps: [] };
    return true;
  }

  advance(ms: number, steps?: Advance['steps']): Result {
    if (this.capacityReached) return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
    if (!validAdvance(ms, steps) || !Number.isSafeInteger(this.state.time + ms)) {
      return {
        ok: false,
        error: 'Advance must be an integer between 1 and 60000 ms within the safe time range',
      };
    }
    if (!this.flushSteps()) return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
    const draft = this.inspect();
    try {
      for (const [duration, count] of steps ?? [[ms, 1]])
        for (let i = 0; i < count; i++) this.advanceState(draft, duration);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    if (!this.record({ type: 'advance', ms, ...(steps ? { steps } : {}) }, { ok: true }, draft))
      return { ok: false, error: '录制内存容量已满，当前运行已暂停。' };
    this.state = draft;
    return { ok: true };
  }

  private advanceState(draft: State, ms: number, runClock = true) {
    const before = draft.time;
    // ponytail: discrete tile movement; continuous paths belong in the playable prototype.
    if (draft.moving && draft.time + ms >= draft.moving.arrivesAt) {
      draft.orientation = movementOrientation(draft.player, draft.moving.target);
      this.progressTasks(draft, {
        event: 'movement.completed',
        fields: { direction: ['right', 'down', 'left', 'up'][draft.orientation / 90] },
      });
      draft.player = draft.moving.target;
      draft.moving = null;
    }
    // ponytail: at most one arrival per tick; large advances do not fast-forward entire routes.
    for (const [id, actor] of scriptedEntities(draft)) {
      if (actor.moving && actor.moving.arrivesAt <= draft.time + ms) {
        actor.position = actor.path.shift()!;
        actor.moving = null;
      }
      if (!actor.path.length && actor.transit) {
        const door = this.content!.scenes.flatMap((s) => s.entities).find(
          (e) => e.id === actor.transit!.via,
        )!;
        const allowed =
          !mapEdgeBlocked(
            this.content!.scenes.find((s) => s.id === actor.sceneId)!.map,
            actor.position,
            door.position,
          ) &&
          this.content!.story.interactions[door.id].choices.some((c) =>
            this.conditionMatches(c.when, draft),
          );
        const destination = this.content!.scenes.find((s) => s.id === door.portal!.scene)!;
        const [x, y] = destination.anchors[actor.transit.arrival];
        const occupied =
          scriptedEntities(draft).some(
            ([other, e]) =>
              other !== id &&
              e.sceneId === destination.id &&
              ((e.position[0] === x && e.position[1] === y) ||
                (e.moving?.target.x === x && e.moving?.target.y === y)),
          ) ||
          (draft.sceneId === destination.id &&
            ((draft.seated?.returnPosition.x === x && draft.seated.returnPosition.y === y) ||
              (draft.player.x === x && draft.player.y === y) ||
              (draft.moving?.target.x === x && draft.moving?.target.y === y)));
        if (allowed && !occupied) {
          actor.sceneId = destination.id;
          actor.position = [x, y];
          actor.transit = null;
        }
      }
      this.startEntityStep(draft, id, draft.time + ms);
    }
    draft.time += ms;
    {
      const rate = runClock ? this.content?.story.clock?.rate : 0;
      if (runClock && draft.clock) {
        const period = draft.clock.realSecondsPerTick * 1000,
          total = draft.clock.elapsedMs + ms;
        const seconds = Math.floor(total / period) * this.content!.story.clock!.gameSecondsPerTick!;
        draft.clock.elapsedMs = total % period;
        if (!Number.isSafeInteger(draft.balance - seconds)) throw new Error('Balance overflow');
        if (seconds) {
          this.advanceStoryClock(draft, seconds);
          draft.balance -= seconds;
        }
      }
      if (rate) {
        // Derive the fractional carry from simulation time, including across saves and short movement steps.
        const seconds =
          (Math.floor(draft.time / 1000) - Math.floor(before / 1000)) * rate +
          Math.floor(((draft.time % 1000) * rate) / 1000) -
          Math.floor(((before % 1000) * rate) / 1000);
        if (!Number.isSafeInteger(draft.balance - seconds)) throw new Error('Balance overflow');
        if (seconds) this.advanceStoryClock(draft, seconds);
        draft.balance -= seconds;
      }
      if (this.content) advanceSchedules(this.content, draft);
    }
    this.activateTasks(draft);
  }

  private record(cause: Event['cause'], result: Result, state: State) {
    const recordedAt = this.clock();
    if (!Number.isFinite(recordedAt)) throw new Error('Invalid clock value');
    const event = {
      sequence: this.startSequence + this.events.length + 1,
      recordedAt,
      cause,
      result,
      state: this.content ? encodeState(this.content, state, this.rules) : state,
    };
    // Serialized payload budget, not a JS heap measurement. Storage releases committed prefixes.
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (this.events.length >= 100000 || this.historyBytes + bytes > 16 * 1024 * 1024) {
      this.capacityReached = true;
      return false;
    }
    this.events.push(structuredClone(event));
    this.historyBytes += bytes;
    return true;
  }
}

// Character uses clockwise degrees: right 0, down 90, left 180, up 270.
function movementOrientation(from: Position, to: Position): number {
  return to.x > from.x ? 0 : to.x < from.x ? 180 : to.y > from.y ? 90 : 270;
}

export function parseCommand(input: unknown): Command {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected command object');
  const value = input as Record<string, unknown>;
  if (
    typeof value.requestId !== 'string' ||
    !value.requestId.trim() ||
    value.requestId.length > 128
  ) {
    throw new Error('requestId must be a nonempty string of at most 128 characters');
  }
  if (
    value.type === 'setClockSpeed' &&
    Object.keys(value).sort().join() === 'requestId,seconds,type' &&
    Number.isSafeInteger(value.seconds) &&
    (value.seconds as number) >= 1 &&
    (value.seconds as number) <= 3600
  )
    return { requestId: value.requestId, type: 'setClockSpeed', seconds: value.seconds as number };
  if (
    value.type === 'waitUntil' &&
    Object.keys(value).sort().join() === 'requestId,time,type' &&
    Number.isSafeInteger(value.time) &&
    (value.time as number) >= 0
  )
    return { requestId: value.requestId, type: 'waitUntil', time: value.time as number };
  if (
    value.type === 'advanceStoryTime' &&
    Object.keys(value).sort().join() === 'requestId,seconds,type' &&
    Number.isSafeInteger(value.seconds) &&
    (value.seconds as number) >= 1 &&
    (value.seconds as number) <= 604800
  ) {
    return {
      requestId: value.requestId,
      type: 'advanceStoryTime',
      seconds: value.seconds as number,
    };
  }
  if (
    (value.type === 'buy' || value.type === 'sell') &&
    Object.keys(value).sort().join() === 'item,quantity,requestId,revision,target,type' &&
    typeof value.target === 'string' &&
    value.target.length <= 4000 &&
    typeof value.item === 'string' &&
    value.item.length <= 4000 &&
    Number.isInteger(value.quantity) &&
    (value.quantity as number) >= 1 &&
    (value.quantity as number) <= 99 &&
    Number.isSafeInteger(value.revision)
  ) {
    return {
      requestId: value.requestId,
      type: value.type,
      target: value.target,
      item: value.item,
      quantity: value.quantity as number,
      revision: value.revision as number,
    };
  }
  if (
    value.type === 'choose' &&
    (Object.keys(value).sort().join() === 'choice,requestId,revision,type' ||
      (Object.keys(value).sort().join() === 'choice,hours,requestId,revision,type' &&
        Number.isInteger(value.hours) &&
        (value.hours as number) >= 1 &&
        (value.hours as number) <= 24)) &&
    typeof value.choice === 'string' &&
    Number.isSafeInteger(value.revision)
  ) {
    return {
      requestId: value.requestId,
      type: 'choose',
      choice: value.choice,
      revision: value.revision as number,
      ...(value.hours !== undefined ? { hours: value.hours as number } : {}),
    };
  }
  if (
    value.type === 'teleport' &&
    Object.keys(value).sort().join() === 'requestId,sceneId,type,x,y' &&
    typeof value.sceneId === 'string' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.y)
  ) {
    return {
      requestId: value.requestId,
      type: 'teleport',
      sceneId: value.sceneId,
      x: value.x,
      y: value.y,
    };
  }
  if (
    value.type === 'move' &&
    (Object.keys(value).sort().join() === 'dx,dy,requestId,type' ||
      (Object.keys(value).sort().join() === 'dx,dy,requestId,sprint,type' &&
        typeof value.sprint === 'boolean')) &&
    typeof value.dx === 'number' &&
    typeof value.dy === 'number' &&
    Number.isInteger(value.dx) &&
    Number.isInteger(value.dy) &&
    Math.abs(value.dx) + Math.abs(value.dy) === 1
  ) {
    return {
      requestId: value.requestId,
      type: 'move',
      dx: value.dx,
      dy: value.dy,
      ...(value.sprint !== undefined ? { sprint: value.sprint as boolean } : {}),
    };
  }
  if (
    value.type === 'interact' &&
    Object.keys(value).sort().join() === 'requestId,target,type' &&
    typeof value.target === 'string'
  ) {
    return { requestId: value.requestId, type: 'interact', target: value.target };
  }
  if (
    (value.type === 'cancel' ||
      value.type === 'closeDialogue' ||
      value.type === 'trade' ||
      value.type === 'nextScene' ||
      value.type === 'stand') &&
    Object.keys(value).sort().join() === 'requestId,type'
  ) {
    return { requestId: value.requestId, type: value.type };
  }
  throw new Error('Invalid command or extra fields');
}

export function formatTime(seconds: number): string {
  if (!Number.isSafeInteger(seconds)) throw new Error('Time must be safe integer seconds');
  const value = Math.abs(seconds);
  return `${seconds < 0 ? '-' : ''}${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
