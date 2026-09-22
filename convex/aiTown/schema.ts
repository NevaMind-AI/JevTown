import { v } from 'convex/values';
import { defineTable } from 'convex/server';
import { serializedPlayer } from '../../engine/aiTown/player';
import { serializedPlayerDescription } from '../../engine/aiTown/playerDescription';
import { serializedAgent } from '../../engine/aiTown/agent';
import { serializedAgentDescription } from '../../engine/aiTown/agentDescription';
import { serializedEntityDescription } from '../../engine/aiTown/entityDescription';
import { serializedWorld } from '../../engine/aiTown/world';
import { serializedWorldMap } from '../../engine/aiTown/worldMap';
import { serializedConversation } from '../../engine/aiTown/conversation';
import { conversationId, playerId } from '../../engine/aiTown/ids';

export const aiTownTables = {
  // This table has a single document that stores all players, conversations, and agents. This
  // data is small and changes regularly over time.
  worlds: defineTable({ ...serializedWorld }),

  // Worlds can be started or stopped by the developer or paused for inactivity, and this
  // infrequently changing document tracks this world state.
  worldStatus: defineTable({
    worldId: v.id('worlds'),
    isDefault: v.boolean(),
    engineId: v.id('engines'),
    lastViewed: v.number(),
    status: v.union(v.literal('running'), v.literal('stoppedByDeveloper'), v.literal('inactive')),
  }).index('worldId', ['worldId']),

  // This table contains the map data for a given world. Since it's a bit larger than the player
  // state and infrequently changes, we store it in a separate table.
  maps: defineTable({
    worldId: v.id('worlds'),
    ...serializedWorldMap,
  }).index('worldId', ['worldId']),

  // Human readable text describing players and agents that's stored in separate tables, just like `maps`.
  playerDescriptions: defineTable({
    worldId: v.id('worlds'),
    ...serializedPlayerDescription,
  }).index('worldId', ['worldId', 'playerId']),
  agentDescriptions: defineTable({
    worldId: v.id('worlds'),
    ...serializedAgentDescription,
  }).index('worldId', ['worldId', 'agentId']),
  entityDescriptions: defineTable({
    worldId: v.id('worlds'),
    ...serializedEntityDescription,
  }).index('worldId', ['worldId', 'entityId']),

  // World-level prose from the world file: `world_rules` verbatim for every actor, and the god's
  // configuration including the `hidden_rules` no actor ever sees (docs/05 §2, §7 as amended).
  worldDescriptions: defineTable({
    worldId: v.id('worlds'),
    worldRules: v.string(),
    godPersona: v.optional(v.string()),
    godHiddenRules: v.optional(v.string()),
    maxTranscriptTurns: v.optional(v.number()),
    godGateEnabled: v.optional(v.boolean()),
  }).index('worldId', ['worldId']),

  //The game engine doesn't want to track players that have left or conversations that are over, since
  // it wants to keep its managed state small. However, we may want to look at old conversations in the
  // UI or from the agent code. So, whenever we delete an entry from within the world's document, we
  // "archive" it within these tables.
  archivedPlayers: defineTable({ worldId: v.id('worlds'), ...serializedPlayer }).index('worldId', [
    'worldId',
    'id',
  ]),
  archivedConversations: defineTable({
    worldId: v.id('worlds'),
    id: conversationId,
    creator: playerId,
    created: v.number(),
    ended: v.number(),
    lastMessage: serializedConversation.lastMessage,
    numMessages: serializedConversation.numMessages,
    participants: v.array(playerId),
  }).index('worldId', ['worldId', 'id']),
  archivedAgents: defineTable({ worldId: v.id('worlds'), ...serializedAgent }).index('worldId', [
    'worldId',
    'id',
  ]),

  // The agent layer wants to know what the last (completed) conversation was between two players,
  // so this table represents a labelled graph indicating which players have talked to each other.
  participatedTogether: defineTable({
    worldId: v.id('worlds'),
    conversationId,
    player1: playerId,
    player2: playerId,
    ended: v.number(),
  })
    .index('edge', ['worldId', 'player1', 'player2', 'ended'])
    .index('conversation', ['worldId', 'player1', 'conversationId'])
    .index('playerHistory', ['worldId', 'player1', 'ended']),
};
