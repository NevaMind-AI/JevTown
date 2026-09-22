import { ReactNode, useEffect, useRef } from 'react';
import { useApp } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import PixiViewport from './PixiViewport';
<<<<<<< HEAD
import { PixiStaticMap } from './PixiStaticMap';
import type { TileMap } from '../../prototype/mapData';
=======
import { PixiStaticMap, RenderableMap } from './PixiStaticMap';
>>>>>>> 2937c94 (🔀 merge: bring feat/agentic onto dev (phase 1))

export default function TownViewport({
  map,
  width,
  height,
  children,
  focus,
  viewportRef: externalRef,
  onPointerDown,
  onPointerUp,
  background,
}: {
<<<<<<< HEAD
  map: TileMap;
=======
  map: RenderableMap;
>>>>>>> 2937c94 (🔀 merge: bring feat/agentic onto dev (phase 1))
  width: number;
  height: number;
  children: ReactNode;
  focus?: { x: number; y: number };
  viewportRef?: React.MutableRefObject<Viewport | undefined>;
  background?: ReactNode;
  onPointerDown?: (event: any) => void;
  onPointerUp?: (event: any) => void;
}) {
  const app = useApp();
  const ownRef = useRef<Viewport>();
  const viewportRef = externalRef ?? ownRef;
  useEffect(() => {
    if (focus) viewportRef.current?.moveCenter(focus.x * map.tileDim, focus.y * map.tileDim);
  }, [focus?.x, focus?.y, width, height]);
  return (
    <PixiViewport
      app={app}
      screenWidth={width}
      screenHeight={height}
      worldWidth={map.width * map.tileDim}
      worldHeight={map.height * map.tileDim}
      viewportRef={viewportRef}
    >
      {background ?? (
        <PixiStaticMap map={map} onpointerdown={onPointerDown} onpointerup={onPointerUp} />
      )}
      {children}
    </PixiViewport>
  );
}
