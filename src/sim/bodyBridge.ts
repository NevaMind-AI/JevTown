import type { BodyMove } from '../../engine/aiTown/game';
import type { AgenticRuntime } from './agenticRuntime';

/**
 * What the bridge needs of the world that owns the ground. `MemoryWorld` satisfies it.
 *
 * Structural rather than the class, so a test can stand in and so this module does not reach
 * into the prototype for more than it uses.
 */
export interface GroundWorld {
  inspect(): {
    entities: Record<
      string,
      {
        sceneId: string;
        position: number[];
        orientation: number;
        path: number[][];
        moving: unknown;
      }
    >;
  };
  execute(input: unknown): { ok: true } | { ok: false; error: string };
}

/** `MemoryWorld` faces in degrees: 0 is +x, 90 is +y (down), 180 is -x, 270 is -y. */
export const FACING: Record<number, { dx: number; dy: number }> = {
  0: { dx: 1, dy: 0 },
  90: { dx: 0, dy: 1 },
  180: { dx: -1, dy: 0 },
  270: { dx: 0, dy: -1 },
};

/**
 * The two worlds' one seam for bodies (docs/13 §2).
 *
 * `MemoryWorld` owns every body: it walks them on the scenes, reserves their tiles and records
 * where they went. The agentic world owns what they want. Each frame the host does two things
 * with this, in this order around the agentic step:
 *
 * 1. **`syncIn`** — where every body is, carried into the engine as a `syncBodies` input. An input
 *    rather than a write, so the engine's own log replays it; only bodies that changed since the
 *    last call, so a still room sends nothing.
 * 2. **`applyMoves`** — what agents asked for during the step, carried out as `MemoryWorld`
 *    commands, which resolve an intent against live occupancy and record it. A move that cannot
 *    start is reported back as `bodyMoveFailed`, so an agent is not left waiting on an arrival
 *    that will never come.
 *
 * Bodies are matched by authored id — the engine's `sourceId`, `MemoryWorld`'s entity key —
 * because that is the only name both worlds have for one character.
 */
export class BodyBridge {
  private sent = new Map<string, string>();

  constructor(
    private runtime: AgenticRuntime,
    private world: GroundWorld,
    private requestId: () => string = () => crypto.randomUUID(),
  ) {}

  syncIn() {
    const entities = this.world.inspect().entities;
    const bodies = [];
    for (const player of this.runtime.game.world.sortedPlayers()) {
      const id = player.sourceId;
      if (id === undefined) continue;
      const entity = entities[id];
      // Offstage has no position worth reporting; the engine keeps the last one it was told.
      if (!entity?.sceneId) continue;
      const body = {
        sourceId: id,
        scene: entity.sceneId,
        x: entity.position[0],
        y: entity.position[1],
        // A body waiting on a blocked step is still walking: it has somewhere to be.
        walking: entity.moving !== null || entity.path.length > 0,
        facing: FACING[entity.orientation] ?? FACING[90],
      };
      const fingerprint = JSON.stringify(body);
      if (this.sent.get(id) === fingerprint) continue;
      this.sent.set(id, fingerprint);
      bodies.push(body);
    }
    if (bodies.length) this.runtime.send('syncBodies', { bodies });
  }

  applyMoves() {
    for (const move of this.runtime.takeMoves()) {
      const result = this.world.execute({ requestId: this.requestId(), ...command(move) });
      if (!result.ok) {
        this.runtime.send('bodyMoveFailed', {
          body: move.body,
          kind: move.kind,
          reason: result.error,
        });
      }
    }
  }
}

function command(move: BodyMove) {
  switch (move.kind) {
    case 'approach':
      return { type: 'approachEntity', entity: move.body, target: move.target };
    case 'wander':
      return { type: 'wanderEntity', entity: move.body, anchor: move.anchor };
    case 'stop':
      return { type: 'stopEntity', entity: move.body };
  }
}
