import * as PIXI from 'pixi.js';
import { MutableRefObject } from 'react';
import { Viewport } from 'pixi-viewport';
import Button from './Button';
import recenterImg from '../../../assets/recenter.svg';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { ServerGame } from '../../hooks/serverGame';

// Recenters the viewport on the human player's avatar. Only rendered while the user is in the
// game — there is nothing to center on otherwise.
export default function CenterOnPlayerButton(props: {
  worldId: Id<'worlds'>;
  game: ServerGame;
  viewportRef: MutableRefObject<Viewport | undefined>;
}) {
  const humanTokenIdentifier = useQuery(api.world.userStatus, { worldId: props.worldId }) ?? null;
  const humanPlayer = [...props.game.world.players.values()].find(
    (p) => p.human === humanTokenIdentifier,
  );

  if (!humanPlayer) {
    return null;
  }

  const recenter = () => {
    const viewport = props.viewportRef.current;
    if (!viewport) {
      return;
    }
    const { tileDim } = props.game.worldMap;
    // Position only: keep whatever zoom the user has chosen.
    viewport.animate({
      position: new PIXI.Point(humanPlayer.position.x * tileDim, humanPlayer.position.y * tileDim),
      time: 500,
    });
  };

  return (
    <Button onClick={recenter} title="Center the view on your character" imgUrl={recenterImg}>
      Locate
    </Button>
  );
}
