import { Container } from '@pixi/react';
import { Character } from './Character.tsx';
import { orientationDegrees } from '../../engine/util/geometry.ts';
import { characters } from '../../data/characters.ts';
import { toast } from 'react-toastify';
import { Player as ServerPlayer } from '../../engine/aiTown/player.ts';
import { GameId } from '../../engine/aiTown/ids.ts';
import { playerLocation } from '../../engine/aiTown/location.ts';
import { PlayerDescription } from '../../engine/aiTown/playerDescription.ts';
import { WorldMap } from '../../engine/aiTown/worldMap.ts';
import { GameSnapshot } from '../hooks/gameSnapshot.ts';

export type SelectedElement =
  | { kind: 'player'; id: GameId<'players'> }
  | { kind: 'entity'; id: GameId<'entities'> };
export type SelectElement = (element?: SelectedElement) => void;

const logged = new Set<string>();

export const Player = ({
  game,
  isViewer,
  player,
  scale = 1,
  onClick,
}: {
  game: GameSnapshot;
  isViewer: boolean;
  player: ServerPlayer;
  /** The map's `playerScale`: how much bigger than a 32px tile a person is drawn here. */
  scale?: number;
  onClick: SelectElement;
}) => {
  const playerCharacter = game.playerDescriptions.get(player.id)?.character;
  if (!playerCharacter) {
    throw new Error(`Player ${player.id} has no character`);
  }
  const character = characters.find((c) => c.name === playerCharacter);

  // The player's position as the simulation last left it. There is no buffer to replay: under
  // docs/11 §1 whoever renders this is also running the tick, so the current value *is* the
  // authoritative one (docs/11 §2.3 deletes the sample-and-replay path outright).
  const location = playerLocation(player);
  if (!character) {
    if (!logged.has(playerCharacter)) {
      logged.add(playerCharacter);
      toast.error(`Unknown character ${playerCharacter}`);
    }
    return null;
  }

  const isSpeaking = !![...game.world.conversations.values()].find(
    (c) => c.isTyping?.playerId === player.id,
  );
  const isThinking =
    !isSpeaking &&
    !![...game.world.agents.values()].find(
      (a) => a.playerId === player.id && !!a.inProgressOperation,
    );
  const tileDim = game.worldMap.tileDim;
  const facing = { dx: location.dx, dy: location.dy };
  const x = location.x * tileDim + tileDim / 2;
  const y = location.y * tileDim + tileDim / 2;
  // Position on the container and draw the character at its origin, so `scale` scales the sprite
  // and not the coordinate. A map whose art was drawn for a taller figure than a 32px tile sheet
  // says so with `playerScale` — `dev`'s rooms all do — and this is what honours it.
  // `zIndex` is the sprite's feet, which is what sorts a character against the room's art layers.
  return (
    <Container x={x} y={y} scale={scale} zIndex={y}>
      <Character
        x={0}
        y={0}
        orientation={orientationDegrees(facing)}
        isMoving={location.speed > 0}
        isThinking={isThinking}
        isSpeaking={isSpeaking}
        emoji={
          player.activity && player.activity.until > Date.now() ? player.activity?.emoji : undefined
        }
        isViewer={isViewer}
        textureUrl={character.textureUrl}
        spritesheetData={character.spritesheetData}
        speed={character.speed}
        onClick={() => {
          onClick({ kind: 'player', id: player.id });
        }}
      />
    </Container>
  );
};
