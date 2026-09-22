import closeImg from '../../assets/close.svg';
import { GameId } from '../../engine/aiTown/ids';
import { GameSnapshot } from '../hooks/gameSnapshot';
import { SelectElement } from './Player';
import { StateDocument } from './StateDocument';

/**
 * A fixed entity's panel: what it is, what state it is in, and the last exchange it took part in.
 *
 * Its `description` is immutable and its state is not (docs/05 §4.2), so they are shown as
 * different things — the top half never changes, the bottom half is the whole point.
 */
export default function EntityDetails({
  game,
  entityId,
  state,
  turns,
  setSelectedElement,
}: {
  game: GameSnapshot;
  entityId: GameId<'entities'>;
  /** The entity's current prose document, from the store (docs/05 §8). */
  state?: string;
  /** The last exchange it took part in, oldest turn first. */
  turns?: { actorId: string; speaker: 'actor' | 'target'; text: string }[];
  setSelectedElement: SelectElement;
}) {
  const entity = game.world.entities.get(entityId);
  const description = game.entityDescriptions.get(entityId);

  if (!entity || !description) {
    return null;
  }
  const name = entity.name ?? description.name ?? entityId;
  return (
    <>
      <div className="flex gap-4">
        <div className="box w-full">
          <h2 className="bg-brown-700 p-2 font-display text-2xl sm:text-4xl tracking-wider shadow-solid text-center">
            {name}
          </h2>
        </div>
        <a
          className="button text-white shadow-solid text-2xl cursor-pointer pointer-events-auto"
          onClick={() => setSelectedElement(undefined)}
        >
          <h2 className="h-full bg-clay-700">
            <img className="w-5 h-5" src={closeImg} />
          </h2>
        </a>
      </div>

      <div className="text-sm text-brown-200 mt-2">
        {description.kind === 'actor' ? 'Something that answers' : 'Something you can act on'}
        {' · '}
        {entity.physics.blocksMovement ? 'solid' : 'you can walk past it'}
        {' · at '}
        {entity.anchor}
      </div>

      <p className="desc my-4">{description.description}</p>

      <div className="my-4">
        <StateDocument state={state} />
      </div>

      {turns && turns.length > 0 && (
        <div className="mt-6">
          <h3 className="uppercase tracking-wider text-brown-200 text-sm">Last exchange</h3>
          <div className="mt-2 space-y-2">
            {turns.map((turn, i) => (
              <p key={i} className="text-sm leading-tight">
                <span className="text-brown-200">
                  {turn.speaker === 'target'
                    ? name
                    : game.playerDescriptions.get(turn.actorId as GameId<'players'>)?.name ??
                      turn.actorId}
                  :{' '}
                </span>
                {turn.text}
              </p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
