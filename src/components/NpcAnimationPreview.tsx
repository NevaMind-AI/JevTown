import { useEffect, useId, useRef, useState } from 'react';
import { RoomNpcAsset, loadRoomNpcAsset, roomNpcFrame } from '../lib/roomNpcAnimation';

export default function NpcAnimationPreview({
  characterId,
  name,
  onClose,
}: {
  characterId: string;
  name: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const elapsed = useRef(0);
  const titleId = useId();
  const [loaded, setLoaded] = useState<{ asset: RoomNpcAsset; image: HTMLImageElement }>();
  const [error, setError] = useState('');
  const [group, setGroup] = useState('idle');
  const [playing, setPlaying] = useState(true);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = panel.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(undefined);
    setError('');
    setGroup('idle');
    elapsed.current = 0;
    void (async () => {
      const asset = await loadRoomNpcAsset(
        characterId,
        import.meta.env.BASE_URL,
        controller.signal,
      );
      const image = new Image();
      image.src = `${import.meta.env.BASE_URL}assets/room-npcs/${characterId}.png`;
      await image.decode();
      for (const frame of Object.values(asset.frames)) {
        if (frame.x + frame.w > image.width || frame.y + frame.h > image.height)
          throw new Error('动画帧超出图集边界');
      }
      if (!controller.signal.aborted) setLoaded({ asset, image });
    })().catch((reason) => {
      if (!controller.signal.aborted) setError(`动画素材加载失败：${reason.message}`);
    });
    return () => controller.abort();
  }, [characterId]);

  useEffect(() => {
    if (!loaded) return;
    const target = canvas.current!;
    const context = target.getContext('2d')!;
    let request: number;
    let previous = performance.now();
    const draw = (now: number) => {
      if (playing && !document.hidden && document.hasFocus())
        elapsed.current += Math.min(now - previous, 100);
      previous = now;
      const frame = loaded.asset.frames[roomNpcFrame(loaded.asset, group, elapsed.current)];
      const scale = Math.max(
        1,
        Math.floor(Math.min(target.width / (frame.w + 16), target.height / (frame.h + 16))),
      );
      context.clearRect(0, 0, target.width, target.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(
        loaded.image,
        frame.x,
        frame.y,
        frame.w,
        frame.h,
        Math.round(target.width / 2 - frame.anchor[0] * scale),
        Math.round(target.height - 24 - frame.anchor[1] * scale),
        frame.w * scale,
        frame.h * scale,
      );
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, [loaded, group, playing]);

  return (
    <dialog
      ref={panel}
      className="goods-panel"
      style={{ width: 'min(520px,calc(100vw - 28px))' }}
      aria-labelledby={titleId}
      onKeyDown={(event) => event.stopPropagation()}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{name} · 动画素材预览</h2>
        <button onClick={() => panel.current?.close()} aria-label="关闭动画预览">
          ×
        </button>
      </header>
      <canvas
        ref={canvas}
        width={320}
        height={320}
        aria-label={`${name}的${loaded?.asset.animations[group].label ?? group}动画`}
        style={{
          display: 'block',
          margin: '16px auto',
          maxWidth: '100%',
          background: dark ? '#20242b' : '#e2e5e9',
          imageRendering: 'pixelated',
        }}
      />
      {!loaded && <p role="status">{error || '正在加载动画素材…'}</p>}
      {loaded && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="选择动作">
            {Object.entries(loaded.asset.animations).map(([id, animation]) => (
              <button
                key={id}
                aria-pressed={id === group}
                onClick={() => {
                  elapsed.current = 0;
                  setGroup(id);
                }}
              >
                {animation.label ?? id}
              </button>
            ))}
          </div>
          <p className="my-3 text-sm">
            {loaded.asset.animations[group].frames.length} 帧 · 每帧{' '}
            {loaded.asset.animations[group].duration} 毫秒
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setPlaying((value) => !value)}>
              {playing ? '暂停' : '播放'}
            </button>
            <button onClick={() => setDark((value) => !value)}>
              {dark ? '切换浅色背景' : '切换深色背景'}
            </button>
            <button onClick={() => panel.current?.close()}>返回交谈</button>
          </div>
        </>
      )}
    </dialog>
  );
}
