import { ReactNode, RefObject, useEffect, useRef, useState } from 'react';
import { useElementSize } from '../hooks/useElementSize';
import { Stage } from '@pixi/react';
export default function GameFrame({
  scene,
  sceneOverlay,
  details,
  hud,
  overlay,
  menuItems,
  playback,
  notifications,
  shortcuts,
  scrollViewRef,
  hudHidden = false,
  backgroundColor = 0x7ab5ff,
}: {
  sceneOverlay?: (width: number, height: number) => ReactNode;
  shortcuts?: ReactNode;
  notifications?: ReactNode;
  hudHidden?: boolean;
  backgroundColor?: number;
  scene: (width: number, height: number) => ReactNode;
  details: ReactNode;
  menuItems?: ReactNode;
  playback?: ReactNode;
  hud?: ReactNode;
  overlay?: ReactNode;
  scrollViewRef?: RefObject<HTMLDivElement>;
}) {
  const [gameWrapperRef, { width, height }] = useElementSize();
  const frame = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const menuButton = useRef<HTMLElement>(null);
  const closeMenu = () => {
    if (menu.current) menu.current.open = false;
    menuButton.current?.focus();
  };
  const [panelOpen, setPanelOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === frame.current);
    const outside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu();
      }
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, []);
  const toggleFullscreen = async () => {
    setError('');
    try {
      if (document.fullscreenElement === frame.current) await document.exitFullscreen();
      else await frame.current?.requestFullscreen();
      closeMenu();
    } catch {
      setError('无法进入全屏，请检查浏览器权限。');
    }
  };
  return (
    <div
      ref={frame}
      className={
        fullscreen
          ? 'relative flex h-screen w-screen overflow-hidden bg-brown-900 text-brown-100'
          : `relative mx-auto w-full min-h-0 flex-1 grid game-frame text-brown-100 ${panelOpen ? 'grid-rows-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_auto]' : 'grid-rows-[minmax(0,1fr)]'}`
      }
    >
      {overlay}
      {hud && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[calc(100%-5rem)]">
          {hud}
        </div>
      )}
      <details
        ref={menu}
        className="absolute right-3 top-3 z-20"
        onToggle={() => {
          if (menu.current?.open) setError('');
        }}
      >
        <summary
          ref={menuButton}
          aria-label="游戏设置"
          title="游戏设置"
          className="ml-auto flex h-11 w-11 cursor-pointer list-none items-center justify-center border border-brown-500 bg-brown-900 text-xl focus-visible:outline focus-visible:outline-2 [&::-webkit-details-marker]:hidden"
        >
          <span aria-hidden="true">⚙</span>
        </summary>
        <div className="mt-2 flex w-52 max-w-[calc(100vw-3rem)] flex-col gap-1 border border-brown-500 bg-brown-900 p-2 shadow-lg">
          <button
            className="px-3 py-2 text-left hover:bg-brown-800 focus-visible:outline"
            aria-expanded={panelOpen}
            aria-controls="game-details"
            onClick={() => {
              setPanelOpen(!panelOpen);
              closeMenu();
            }}
          >
            {panelOpen ? '收起信息面板' : '展开信息面板'}
          </button>
          {document.fullscreenEnabled && (
            <button
              className="px-3 py-2 text-left hover:bg-brown-800 focus-visible:outline"
              aria-pressed={fullscreen}
              onClick={toggleFullscreen}
            >
              {fullscreen ? '退出全屏' : '进入全屏'}
            </button>
          )}
          {menuItems}
          {error && (
            <p role="alert" className="p-2 text-sm">
              {error}
            </p>
          )}
        </div>
      </details>
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-brown-900"
        ref={gameWrapperRef}
      >
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-10 flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 flex-1 [&_.gain-notifications]:max-w-full">{notifications}</div>
            {!hudHidden && shortcuts}
          </div>
          {!hudHidden && playback && (
            <div className="pointer-events-auto border border-brown-500 bg-brown-900 p-3">
              {playback}
            </div>
          )}
        </div>
        <div className="absolute inset-0">
          {width > 0 && height > 0 && (
            <Stage width={width} height={height} options={{ backgroundColor }}>
              {scene(width, height)}
            </Stage>
          )}
        </div>
        {width > 0 && height > 0 && sceneOverlay?.(width, height)}
      </div>
      <aside
        id="game-details"
        hidden={!panelOpen}
        ref={scrollViewRef}
        className={
          fullscreen
            ? 'absolute right-0 top-16 bottom-0 z-10 w-80 max-w-[85vw] overflow-y-auto border-l-4 border-brown-900 bg-brown-800 px-4 py-6 lg:static lg:w-96 lg:shrink-0'
            : 'min-h-0 overflow-y-auto shrink-0 px-4 py-6 sm:px-6 lg:w-96 xl:pr-6 border-t-8 sm:border-t-0 sm:border-l-8 border-brown-900 bg-brown-800 text-brown-100'
        }
      >
        {details}
      </aside>
    </div>
  );
}
