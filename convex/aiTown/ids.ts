import { v } from 'convex/values';

const IdShortCodes = { agents: 'a', conversations: 'c', players: 'p', operations: 'o', entities: 'e' };
export type IdTypes = keyof typeof IdShortCodes;

export type GameId<T extends IdTypes> = string & { __type: T };

export function parseGameId<T extends IdTypes>(idType: T, gameId: string): GameId<T> {
  const type = gameId[0];
  const match = Object.entries(IdShortCodes).find(([_, value]) => value === type);
  if (!match || match[0] !== idType) {
    throw new Error(`Invalid game ID type: ${type}`);
  }
  const number = parseInt(gameId.slice(2), 10);
  if (isNaN(number) || !Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid game ID number: ${gameId}`);
  }
  return gameId as GameId<T>;
}

export function allocGameId<T extends IdTypes>(idType: T, idNumber: number): GameId<T> {
  const type = IdShortCodes[idType];
  if (!type) {
    throw new Error(`Invalid game ID type: ${idType}`);
  }
  return `${type}:${idNumber}` as GameId<T>;
}

/**
 * Order game ids by their allocation number, not lexicographically: `p:10` sorts after `p:9`.
 * Used wherever iteration order is observable, so that order is a function of state rather than
 * of the history that produced it — a snapshot restore reconstructs state without replaying that
 * history. See docs/05-agentic-world-format.md §10.
 */
export function compareGameIds<T extends IdTypes>(a: GameId<T>, b: GameId<T>): number {
  return parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10);
}

export const conversationId = v.string();
export const playerId = v.string();
export const agentId = v.string();
export const operationId = v.string();
export const entityId = v.string();
