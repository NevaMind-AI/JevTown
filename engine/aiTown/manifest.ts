import { CONVERSATION_COOLDOWN } from '../constants';
import { distance } from '../util/geometry';
import { Agent } from './agent';
import { Game } from './game';
import { Player } from './player';
import { parseGameId } from './ids';

/**
 * What an agent may aim at right now, and how it is described to the model.
 *
 * The governing principle of docs/09 §1: **the engine filters the option set; the model chooses
 * within it.** A target the agent may not approach is simply absent, rather than present with a
 * prompt rule attached — which costs no tokens, needs no validation branch, and cannot fail open
 * when the model ignores an instruction.
 *
 * Three rules about the contents (docs/09 §3):
 *   - No state. Identity, tier, a prop's immutable description, and roughly how far away it is.
 *     An actor learns another entity's state by interacting, never by looking (docs/05 §6.4).
 *   - Distance as a band, not a number. Exact figures invite arithmetic the model is bad at.
 *   - Tiers described, not labelled. "A person", "a door" — never `kind: actor, mobile: false`.
 */

export interface ManifestTarget {
  id: string;
  name: string;
  /** Prose, not a tier name. */
  what: string;
  description?: string;
  distance: 'close' | 'nearby' | 'far';
  where?: string;
}

export interface ManifestPlace {
  id: string;
  description: string;
}

export interface DecisionManifest {
  targets: ManifestTarget[];
  places: ManifestPlace[];
}

function band(tiles: number): ManifestTarget['distance'] {
  if (tiles <= 4) {
    return 'close';
  }
  return tiles <= 15 ? 'nearby' : 'far';
}

export function buildManifest(game: Game, now: number, agent: Agent, player: Player): DecisionManifest {
  const targets: ManifestTarget[] = [];

  // Tier (a). Excluded when already occupied, or when either cooldown says this agent may not
  // start a conversation right now — the cooldowns of docs/09 §2, expressed as filters.
  const justLeftConversation =
    agent.lastConversation !== undefined && now < agent.lastConversation + CONVERSATION_COOLDOWN;
  const recentlyAttemptedInvite =
    agent.lastInviteAttempt !== undefined && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;
  if (!justLeftConversation && !recentlyAttemptedInvite) {
    for (const other of game.world.sortedPlayers()) {
      if (other.id === player.id) {
        continue;
      }
      if (game.world.playerConversation(other)) {
        continue;
      }
      const description = game.playerDescriptions.get(other.id);
      targets.push({
        id: other.id,
        name: description?.name ?? 'Someone',
        what: 'a person',
        distance: band(distance(player.position, other.position)),
      });
    }
  }

  for (const entity of game.world.sortedEntities()) {
    if (!entity.physics.interactable) {
      continue;
    }
    const anchor = game.worldMap.anchor(entity.anchor);
    const entityDescription = game.entityDescriptions.get(entity.id);
    targets.push({
      id: entity.id,
      name: entity.name ?? entityDescription?.name ?? 'Something',
      what: entity.kind === 'actor' ? 'someone who does not move' : 'a thing you can act on',
      // A prop's `description` is immutable and public — unlike its state, it is what anyone
      // walking past would see (docs/05 §4.2).
      description: entity.kind === 'prop' ? entityDescription?.description : undefined,
      distance: anchor
        ? band(distance(player.position, { x: anchor.x, y: anchor.y }))
        : 'far',
      where: entity.anchor,
    });
  }

  return {
    targets,
    places: [...game.worldMap.anchors.values()].map((anchor) => ({
      id: anchor.id,
      description: anchor.description,
    })),
  };
}

/**
 * docs/09 §8: the world moves during a model call, so a chosen target may no longer be legal.
 * Never throws — an input handler that throws marks the input errored, and the noise hides real
 * failures.
 */
export function targetIsStillLegal(game: Game, now: number, player: Player, targetId: string) {
  try {
    return isLegal(game, player, targetId);
  } catch {
    return false;
  }
}

function isLegal(game: Game, player: Player, targetId: string) {
  if (targetId.startsWith('p:')) {
    const other = game.world.players.get(parseGameId('players', targetId));
    if (!other || other.id === player.id) {
      return false;
    }
    return !game.world.playerConversation(other);
  }
  const entity = game.world.entities.get(parseGameId('entities', targetId));
  return !!entity && entity.physics.interactable;
}
