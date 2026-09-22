import { Sprite } from '@pixi/react';
import { Texture, SCALE_MODES } from 'pixi.js';
import { Visual, visualPlacement } from '../../prototype/assets';

import { interactionHighlight } from '../lib/interactionHighlight';

export default function AssetSprite({
  visual,
  position,
  depth,
  onClick,
  highlighted = false,
  texture,
}: {
  visual: Visual;
  position: number[];
  depth: number;
  onClick?: () => void;
  highlighted?: boolean;
  texture?: Texture;
}) {
  return (
    <Sprite
      texture={
        texture ??
        Texture.from(`${import.meta.env.BASE_URL}${visual.image}`, {
          scaleMode: SCALE_MODES.NEAREST,
        })
      }
      {...visualPlacement(visual, position, depth)}
      filters={highlighted ? interactionHighlight : null}
      cursor={highlighted && onClick ? 'pointer' : 'auto'}
      interactive={!!onClick}
      pointerdown={onClick}
    />
  );
}
