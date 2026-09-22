import { ComponentProps, useEffect, useState } from 'react';
import { BaseTexture, SCALE_MODES, Spritesheet } from 'pixi.js';
import AssetSprite from './AssetSprite';
import { RoomNpcAsset, loadRoomNpcAsset, roomNpcFrame, roomNpcId } from '../lib/roomNpcAnimation';

export default function RoomNpc({
  time,
  ...props
}: ComponentProps<typeof AssetSprite> & { time: number }) {
  const image = props.visual.image;
  const [loaded, setLoaded] = useState<{
    image: string;
    asset: RoomNpcAsset;
    sheet: Spritesheet;
  }>();

  useEffect(() => {
    setLoaded(undefined);
    const controller = new AbortController();
    let sheet: Spritesheet | undefined;
    const load = async () => {
      const id = roomNpcId(image);
      if (!id) throw new Error(`Invalid NPC image: ${image}`);
      const asset = await loadRoomNpcAsset(id, import.meta.env.BASE_URL, controller.signal);
      const parsed = new Spritesheet(
        BaseTexture.from(`${import.meta.env.BASE_URL}assets/room-npcs/${id}.png`, {
          scaleMode: SCALE_MODES.NEAREST,
        }),
        {
          frames: Object.fromEntries(
            Object.entries(asset.frames).map(([name, frame]) => [
              name,
              { frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h } },
            ]),
          ),
          meta: { scale: '1' },
        },
      );
      try {
        await parsed.parse();
      } catch (error) {
        parsed.destroy();
        throw error;
      }
      if (controller.signal.aborted) parsed.destroy();
      else {
        sheet = parsed;
        setLoaded({ image, asset, sheet });
      }
    };
    void load().catch((error) => {
      if (!controller.signal.aborted) console.warn('NPC animation unavailable:', error);
    });
    return () => {
      controller.abort();
      sheet?.destroy();
    };
  }, [image]);

  if (!loaded || loaded.image !== image) return <AssetSprite {...props} />;
  const name = roomNpcFrame(loaded.asset, 'idle', time);
  const frame = loaded.asset.frames[name];
  return (
    <AssetSprite
      {...props}
      texture={loaded.sheet.textures[name]}
      visual={{
        ...props.visual,
        anchor: [frame.anchor[0] / frame.w, frame.anchor[1] / frame.h],
      }}
    />
  );
}
