import { Container, Graphics, Text } from '@pixi/react';
import * as PIXI from 'pixi.js';
import { useCallback } from 'react';
import { Entity as ServerEntity } from '../../engine/aiTown/entity.ts';
import { GameSnapshot } from '../hooks/gameSnapshot.ts';
import { SelectElement } from './Player.tsx';

/**
 * A fixed entity — tier (b) or (c) — drawn at its anchor.
 *
 * There is no prop art: `data/gentle.js` predates entities, and its `sprite` names ("well",
 * "door_closed") have no tileset behind them. So an entity is drawn as a marker over the anchor
 * rect it occupies rather than as a picture of itself, which is honest about what the world
 * actually knows and gives the thing a click target. When prop sprites exist, this component is
 * where they go.
 *
 * Z-order, which docs/07 §10 left open: entities draw above the flattened map layers and below
 * players, so a character walking past a door is in front of it.
 */
export const EntityMarker = ({
  game,
  entity,
  isSelected,
  onClick,
}: {
  game: GameSnapshot;
  entity: ServerEntity;
  isSelected: boolean;
  onClick: SelectElement;
}) => {
  const anchor = game.worldMap.anchor(entity.anchor);
  const tileDim = game.worldMap.tileDim;
  const description = game.entityDescriptions.get(entity.id);
  const blocks = entity.physics.blocksMovement;

  const draw = useCallback(
    (g: PIXI.Graphics) => {
      if (!anchor) {
        return;
      }
      const w = anchor.w * tileDim;
      const h = anchor.h * tileDim;
      g.clear();
      // Solid things read as solid: a filled outline rather than a dashed one.
      g.lineStyle(isSelected ? 3 : 2, isSelected ? 0xffd166 : blocks ? 0xe07a5f : 0x8ecae6, 0.9);
      g.beginFill(blocks ? 0xe07a5f : 0x8ecae6, isSelected ? 0.28 : 0.14);
      g.drawRoundedRect(0, 0, w, h, 4);
      g.endFill();
    },
    [anchor, tileDim, blocks, isSelected],
  );

  if (!anchor) {
    return null;
  }
  const name = entity.name ?? description?.name ?? entity.id;
  return (
    <Container
      x={anchor.x * tileDim}
      y={anchor.y * tileDim}
      interactive={true}
      cursor="pointer"
      pointerdown={() => onClick({ kind: 'entity', id: entity.id })}
      hitArea={new PIXI.Rectangle(0, 0, anchor.w * tileDim, anchor.h * tileDim)}
    >
      <Graphics draw={draw} />
      <Text
        x={(anchor.w * tileDim) / 2}
        y={-6}
        scale={0.4}
        text={name}
        anchor={{ x: 0.5, y: 1 }}
        style={
          new PIXI.TextStyle({
            fill: isSelected ? '#ffd166' : '#ffffff',
            fontSize: 24,
            stroke: '#000000',
            strokeThickness: 5,
          })
        }
      />
    </Container>
  );
};
