import { v } from 'convex/values';
import { inputHandler } from './inputHandler';
import { Entity, EntityPhysics, EntityPhysicsPatch, entityPhysicsPatch } from './entity';
import { Player } from './player';
import { Agent } from './agent';
import { AgentDescription } from './agentDescription';
import { EntityDescription } from './entityDescription';
import { parseGameId } from './ids';
import { Game } from './game';
import { parseStateDocument, physicsPatchFrom } from '../prose/stateDocument';
import { COMMON_KNOWLEDGE_ID } from '../prose/contract';

/**
 * Inputs that create and mutate entities and their prose state.
 *
 * Three of the four handlers docs/05 §9.2 names live here. The fourth, `agentDecideAction`,
 * belongs with the agent loop it drives (`docs/09-agent-loop.md`) and lands with A6 — applying an
 * `approach` sets a `pendingInteraction` that nothing would yet consume.
 *
 * None of these write to the database. A handler updates the world document and queues the prose
 * through `game.queueProseWrite`; `Game.saveDiff` performs the writes in the mutation that
 * commits the step.
 */

/**
 * docs/05 §5.3: common knowledge has exactly one writer, the god. Every other path refuses the
 * reserved id here rather than anywhere further in, so the rule holds for any caller that reaches
 * an input — including one written later that never read this file.
 */
function refuseCommonKnowledge(id: string) {
  if (id === COMMON_KNOWLEDGE_ID) {
    throw new Error(`"${COMMON_KNOWLEDGE_ID}" is common knowledge; only the god may write it`);
  }
}

function requireEntity(game: Game, id: string): Entity {
  const entity = game.world.entities.get(parseGameId('entities', id));
  if (!entity) {
    throw new Error(`Couldn't find entity: ${id}`);
  }
  return entity;
}

/** docs/05 §4.3: authors never write `interactable`; it is derived from having state. */
function initialPhysics(blocksMovement: boolean, hasState: boolean): EntityPhysics {
  return { blocksMovement, interactable: hasState };
}

export const entityInputs = {
  /**
   * Creates any tier. Unlike `createAgent`'s `{descriptionIndex}`, which is a pointer into a
   * compiled artifact, this carries its content — so the input log stays self-contained and
   * recompiling `data/characters.ts` cannot silently re-mean history (docs/07 §6.2).
   */
  createEntity: inputHandler({
    args: {
      kind: v.union(v.literal('actor'), v.literal('prop')),
      mobile: v.boolean(),
      name: v.optional(v.string()),
      character: v.optional(v.string()),
      sprite: v.optional(v.string()),
      anchor: v.optional(v.string()),
      description: v.optional(v.string()),
      behavior: v.optional(v.string()),
      initialState: v.optional(v.string()),
      blocksMovement: v.optional(v.boolean()),
    },
    handler: (game, now, args) => {
      const hasState = !!args.initialState;
      if (args.kind === 'actor' && args.mobile) {
        // Tier (a): a Player + Agent pair, the only tier that can be invited, walk toward you,
        // or initiate (docs/05 §3.1 as amended).
        const playerId = Player.join(
          game,
          now,
          args.name ?? 'Unnamed',
          args.character ?? 'f1',
          args.description ?? '',
          undefined,
          args.anchor,
        );
        const agentId = game.allocId('agents');
        game.world.agents.set(
          agentId,
          new Agent({
            id: agentId,
            playerId,
            inProgressOperation: undefined,
            lastConversation: undefined,
            lastInviteAttempt: undefined,
            toRemember: undefined,
          }),
        );
        game.agentDescriptions.set(
          agentId,
          new AgentDescription({
            agentId,
            identity: args.description ?? '',
            behavior: args.behavior,
          }),
        );
        game.descriptionsModified = true;
        if (args.initialState) {
          game.world.players.get(playerId)!.stateVersion = 1;
          game.queueProseWrite({
            entityId: playerId,
            version: 1,
            state: args.initialState,
            source: 'self',
            reason: 'Initial state from the world file.',
          });
        }
        return { id: playerId, agentId };
      }

      // Tiers (b) and (c): one fixed-entity collection, distinguished only by `kind`, which
      // nothing about targeting or approach reads.
      const id = game.allocId('entities');
      const entity = new Entity({
        id,
        kind: args.kind,
        name: args.name,
        sprite: args.sprite,
        anchor: args.anchor!,
        physics: initialPhysics(args.blocksMovement ?? false, hasState),
        stateVersion: args.initialState ? 1 : 0,
      });
      game.world.entities.set(id, entity);
      game.entityDescriptions.set(
        id,
        new EntityDescription({
          entityId: id,
          kind: args.kind,
          name: args.name,
          // One field for every tier: a fixed actor and a prop are both described, not personified.
          description: args.description ?? '',
          behavior: args.behavior,
        }),
      );
      game.descriptionsModified = true;
      if (entity.physics.blocksMovement) {
        game.collisionOverlay.add(game.worldMap.anchorTiles(entity.anchor));
      }
      if (args.initialState) {
        game.queueProseWrite({
          entityId: id,
          version: 1,
          state: args.initialState,
          source: 'self',
          reason: 'Initial state from the world file.',
        });
      }
      return { id };
    },
  }),

  /** docs/05 §6.1: one call rewrote this entity's own prose and emitted its physics projection. */
  entityUpdateState: inputHandler({
    args: {
      entityId: v.string(),
      state: v.optional(v.string()),
      stateRef: v.optional(v.string()),
      physics: v.optional(v.object(entityPhysicsPatch)),
      memory: v.optional(v.array(v.string())),
      reason: v.string(),
      tags: v.optional(v.any()),
      operationId: v.optional(v.string()),
    },
    handler: (game, now, args) => {
      refuseCommonKnowledge(args.entityId);
      return applyStateUpdate(game, args, 'self');
    },
  }),

  /**
   * docs/05 §6.2: the acting agent's call also rewrote the prop it acted on. This is where a
   * locked door becomes an open one, and it is why physics rides alongside the prose — the same
   * call that decides Alice forces the door must tell the pathfinder it no longer blocks.
   */
  entityUpdateTarget: inputHandler({
    args: {
      actorId: v.string(),
      entityId: v.string(),
      state: v.optional(v.string()),
      stateRef: v.optional(v.string()),
      physics: v.optional(v.object(entityPhysicsPatch)),
      reason: v.string(),
      tags: v.optional(v.any()),
      operationId: v.optional(v.string()),
    },
    handler: (game, now, args) => {
      refuseCommonKnowledge(args.entityId);
      return applyStateUpdate(game, args, 'interaction');
    },
  }),

  /**
   * docs/05 §7.6: god writes apply at a step boundary, after every other write in that step,
   * last-write-wins. The engine gets that ordering for free — a verdict is one input, and inputs
   * within a tick apply in log order, so a verdict that was formed after an interaction concluded
   * is necessarily numbered after it.
   */
  godVerdict: inputHandler({
    args: {
      batchId: v.string(),
      writes: v.array(
        v.object({
          entityId: v.string(),
          state: v.optional(v.string()),
          stateRef: v.optional(v.string()),
          physics: v.optional(v.object(entityPhysicsPatch)),
          reason: v.string(),
        }),
      ),
      // docs/05 §5.3: the world's common knowledge, which only the god may write. It rides in the
      // same verdict as the entity writes rather than in an input of its own so that one judgement
      // lands as one atomic step-boundary application under one `batchId` — a separate input could
      // tear against the entity writes formed from the same evidence.
      world: v.optional(v.object({ state: v.string(), reason: v.string() })),
      operationId: v.optional(v.string()),
    },
    handler: (game, now, args) => {
      let applied = 0;
      for (const write of args.writes) {
        try {
          applyStateUpdate(game, { ...write, batchId: args.batchId }, 'god');
          applied += 1;
        } catch (e) {
          // One bad entity id must not discard the rest of a verdict.
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`God verdict ${args.batchId} skipped ${write.entityId}: ${message}`);
        }
      }
      let world = false;
      if (args.world) {
        applyCommonKnowledgeUpdate(game, args.world, args.batchId);
        world = true;
      }
      return { applied, world };
    },
  }),
};

/**
 * The physics a write asserts, as a patch over what the entity has now.
 *
 * The document is the source: the model writes `<blocked/>` or `<unblocked/>` inside the state it
 * was already writing, and this reads it back out. Deriving here rather than in the calling action
 * is what makes it true of **every** writer — an entity's own update, an actor's update of a prop,
 * and a god verdict, which emits no physics of its own and until now could rewrite a door's prose
 * while leaving the pathfinder believing the old thing. Parsing is pure, so a mutation may do it
 * and replay reproduces it exactly.
 *
 * `args.physics` stays as an explicit override for a writer that knows something the text does not
 * — including the `stateRef` path, where the document is a hash and there is nothing here to read.
 */
function physicsPatchFor(args: {
  state?: string;
  physics?: EntityPhysicsPatch;
}): EntityPhysicsPatch {
  const derived =
    args.state !== undefined ? physicsPatchFrom(parseStateDocument(args.state).document) : {};
  return { ...derived, ...(args.physics ?? {}) };
}

function applyStateUpdate(
  game: Game,
  args: {
    entityId: string;
    state?: string;
    stateRef?: string;
    physics?: EntityPhysicsPatch;
    memory?: string[];
    reason: string;
    tags?: unknown;
    batchId?: string;
  },
  source: 'self' | 'interaction' | 'god',
) {
  // Tier (a) keeps its prose under its player id, which is the id everything else already
  // references; `Player` carries the same `stateVersion` counter an `Entity` does.
  const isPlayer = args.entityId.startsWith('p:');
  const player = isPlayer
    ? game.world.players.get(parseGameId('players', args.entityId))
    : undefined;
  if (isPlayer && !player) {
    throw new Error(`Couldn't find player: ${args.entityId}`);
  }
  const entity = isPlayer ? undefined : requireEntity(game, args.entityId);

  let physicsBefore: EntityPhysics | undefined;
  let physicsAfter: EntityPhysics | undefined;
  if (entity) {
    const next: EntityPhysics = { ...entity.physics, ...physicsPatchFor(args) };
    // The tag is a level, not an edge — a switchable entity writes the true one every time — so
    // most writes assert exactly what is already true. Only a real change is applied and audited.
    if (
      next.blocksMovement !== entity.physics.blocksMovement ||
      next.interactable !== entity.physics.interactable
    ) {
      physicsBefore = { ...entity.physics };
      physicsAfter = next;
      game.setEntityPhysics(entity, next);
    }
  }

  let version: number | undefined;
  if (args.state !== undefined || args.stateRef !== undefined) {
    if (entity) {
      entity.stateVersion += 1;
      version = entity.stateVersion;
    } else {
      player!.stateVersion = (player!.stateVersion ?? 0) + 1;
      version = player!.stateVersion;
    }
  }

  game.queueProseWrite({
    entityId: args.entityId,
    version,
    state: args.state,
    stateRef: args.stateRef,
    memory: args.memory,
    physicsBefore,
    physicsAfter,
    source,
    reason: args.reason,
    batchId: args.batchId,
    tags: args.tags,
  });
  return { version: version ?? null };
}

/**
 * docs/05 §5.3: the world's common knowledge, stored in the prose tier under a reserved id.
 *
 * It takes the same path an entity's state takes — version allocated here, prose queued for
 * `saveDiff` — and differs in exactly two ways, both of which follow from its not being an entity:
 * the counter lives on the world rather than on an `Entity`, and there is no physics to derive,
 * because it occupies no tiles.
 */
function applyCommonKnowledgeUpdate(
  game: Game,
  write: { state: string; reason: string },
  batchId: string,
) {
  game.world.commonKnowledgeVersion += 1;
  game.queueProseWrite({
    entityId: COMMON_KNOWLEDGE_ID,
    version: game.world.commonKnowledgeVersion,
    state: write.state,
    source: 'god',
    reason: write.reason,
    batchId,
  });
}
