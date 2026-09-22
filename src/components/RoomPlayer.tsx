import { useEffect, useState } from 'react';
import { Sprite } from '@pixi/react';
import { BaseTexture, SCALE_MODES, Spritesheet } from 'pixi.js';
import player from '../../data/spritesheets/room-player.json';

const sheetData = {
  frames: Object.fromEntries(
    Object.entries(player.frames).map(([name, { x, y, w, h }]) => [
      name,
      { frame: { x, y, w, h } },
    ]),
  ),
  meta: { scale: '1' },
};

export default function RoomPlayer({
  orientation,
  moving,
  time,
  sprinting,
}: {
  orientation: number;
  moving: boolean;
  time: number;
  sprinting: boolean;
}) {
  const [sheet, setSheet] = useState<Spritesheet>();
  useEffect(() => {
    let cancelled = false;
    let parsed = false;
    const spritesheet = new Spritesheet(
      BaseTexture.from(`${import.meta.env.BASE_URL}assets/room-player/player.png`, {
        scaleMode: SCALE_MODES.NEAREST,
      }),
      sheetData,
    );
    void spritesheet.parse().then(() => {
      parsed = true;
      if (!cancelled) setSheet(spritesheet);
      else spritesheet.destroy();
    });
    return () => {
      cancelled = true;
      if (parsed) spritesheet.destroy();
    };
  }, []);

  const direction = (['e', 's', 'w', 'n'] as const)[Math.floor(orientation / 90)];
  const animation = player.animations[direction][moving ? 'walk' : 'idle'];
  const index =
    Math.floor((time * (sprinting ? 2 : 1)) / animation.duration) % animation.frames.length;
  const name = animation.frames[index] as keyof typeof player.frames;
  const frame = player.frames[name];
  if (!sheet) return null;
  return (
    <Sprite
      texture={sheet.textures[name]}
      anchor={{ x: frame.anchor[0] / frame.w, y: frame.anchor[1] / frame.h }}
      eventMode="none"
    />
  );
}
