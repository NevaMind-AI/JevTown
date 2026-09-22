import { v } from 'convex/values';
import { MutationCtx, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { agentId, conversationId, playerId } from '../../engine/aiTown/ids';
import { insertInput } from './insertInput';

/**
 * The Convex half of `engine/aiTown/agent.ts`.
 *
 * The engine names an operation and queues its arguments (`Agent.startOperation`); this module is
 * what turns that name into a scheduled Convex action. It lives here rather than in the engine so
 * the engine has no runtime host -- see docs/11 §4.1. Under frontend authority this becomes a
 * browser-side dispatch table and the module goes away with the rest of `convex/`.
 */
export async function runAgentOperation(ctx: MutationCtx, operation: string, args: any) {
  let reference;
  switch (operation) {
    case 'agentRememberConversation':
      reference = internal.aiTown.agentOperations.agentRememberConversation;
      break;
    case 'agentGenerateMessage':
      reference = internal.aiTown.agentOperations.agentGenerateMessage;
      break;
    case 'agentDecide':
      reference = internal.aiTown.agentOperations.agentDecide;
      break;
    case 'agentInteract':
      reference = internal.aiTown.agentOperations.agentInteract;
      break;
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
  await ctx.scheduler.runAfter(0, reference, args);
}

export const agentSendMessage = internalMutation({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    agentId,
    playerId,
    text: v.string(),
    messageUuid: v.string(),
    leaveConversation: v.boolean(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('messages', {
      conversationId: args.conversationId,
      author: args.playerId,
      text: args.text,
      messageUuid: args.messageUuid,
      worldId: args.worldId,
    });
    await insertInput(ctx, args.worldId, 'agentFinishSendingMessage', {
      conversationId: args.conversationId,
      agentId: args.agentId,
      timestamp: Date.now(),
      leaveConversation: args.leaveConversation,
      operationId: args.operationId,
    });
  },
});
