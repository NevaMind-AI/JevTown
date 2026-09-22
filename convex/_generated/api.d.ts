/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent_conversation from "../agent/conversation.js";
import type * as agent_decide from "../agent/decide.js";
import type * as agent_embeddingsCache from "../agent/embeddingsCache.js";
import type * as agent_god from "../agent/god.js";
import type * as agent_interact from "../agent/interact.js";
import type * as agent_memory from "../agent/memory.js";
import type * as agent_promptContext from "../agent/promptContext.js";
import type * as agent_stateUpdate from "../agent/stateUpdate.js";
import type * as agent_tracing from "../agent/tracing.js";
import type * as aiTown_agentDriver from "../aiTown/agentDriver.js";
import type * as aiTown_agentOperations from "../aiTown/agentOperations.js";
import type * as aiTown_gameStore from "../aiTown/gameStore.js";
import type * as aiTown_insertInput from "../aiTown/insertInput.js";
import type * as aiTown_main from "../aiTown/main.js";
import type * as crons from "../crons.js";
import type * as engine_engineStore from "../engine/engineStore.js";
import type * as http from "../http.js";
import type * as init from "../init.js";
import type * as messages from "../messages.js";
import type * as music from "../music.js";
import type * as prose_store from "../prose/store.js";
import type * as testing from "../testing.js";
import type * as util_langfuse from "../util/langfuse.js";
import type * as util_llm from "../util/llm.js";
import type * as world from "../world.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agent/conversation": typeof agent_conversation;
  "agent/decide": typeof agent_decide;
  "agent/embeddingsCache": typeof agent_embeddingsCache;
  "agent/god": typeof agent_god;
  "agent/interact": typeof agent_interact;
  "agent/memory": typeof agent_memory;
  "agent/promptContext": typeof agent_promptContext;
  "agent/stateUpdate": typeof agent_stateUpdate;
  "agent/tracing": typeof agent_tracing;
  "aiTown/agentDriver": typeof aiTown_agentDriver;
  "aiTown/agentOperations": typeof aiTown_agentOperations;
  "aiTown/gameStore": typeof aiTown_gameStore;
  "aiTown/insertInput": typeof aiTown_insertInput;
  "aiTown/main": typeof aiTown_main;
  crons: typeof crons;
  "engine/engineStore": typeof engine_engineStore;
  http: typeof http;
  init: typeof init;
  messages: typeof messages;
  music: typeof music;
  "prose/store": typeof prose_store;
  testing: typeof testing;
  "util/langfuse": typeof util_langfuse;
  "util/llm": typeof util_llm;
  world: typeof world;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
