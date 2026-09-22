import { useEffect, useRef, useState } from 'react';
import { MemoryWorld, formatTime } from '../../prototype/world';
import {
  catalogue,
  continuePlayback,
  playSlot,
  replaceTimeline,
  restoreSlot,
  saveChunk,
  SaveHead,
  SaveSlot,
  SavePlayback,
} from '../lib/autosaves';

export type Restored = { world?: MemoryWorld; head: SaveHead };
export type PlayHandler = (
  playback: SavePlayback,
  live: Restored,
  playing?: boolean,
  speed?: number,
) => void;
export function useAutoSaves(
  world: MemoryWorld,
  enabled: boolean,
  initialHead: SaveHead,
  onRestore: (saved: Restored) => void,
  onPlay: PlayHandler,
  initialError = '',
  beforeSave = () => true,
) {
  const head = useRef(initialHead),
    selection = useRef(initialHead),
    pending = useRef<Promise<void>>(),
    active = useRef(true);
  const panel = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [selectedId, setSelectedId] = useState<number>();
  const failed = useRef(!!initialError),
    busy = useRef(false);
  const [error, setError] = useState(initialError),
    [status, setStatus] = useState(''),
    [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [slots, setSlots] = useState<SaveSlot[]>([]);
  const report = (e: unknown) => {
    failed.current = true;
    setError(`存档未完成：${(e as Error).message}`);
  };
  const flush = (manual = false) => {
    if (pending.current) return pending.current;
    if (!enabled || (busy.current && !manual)) return Promise.resolve();
    const stats = world.recordingStats(),
      count = stats.eventCount;
    if (!manual && count < 1000 && stats.elapsedMs < 60000 && !world.recordingCapacityReached())
      return Promise.resolve();
    if (!count && world.recordingCapacityReached()) {
      report(new Error('单个事件超过录制容量，无法自动存档。当前进度已保留。'));
      return Promise.resolve();
    }
    const operation = (async () => {
      try {
        const run = world.recording(
          count >= 1000 || world.recordingCapacityReached() ? Math.min(count, 1000) : undefined,
        );
        const next = await saveChunk(run, head.current);
        head.current = next;
        world.releaseRecording(next.sequence);
        failed.current = false;
        if (active.current) {
          setError('');
          setStatus(`已${manual ? '手动' : '自动'}保存 · ${new Date().toLocaleTimeString()}`);
        }
      } catch (e) {
        if (active.current) report(e);
      }
    })();
    pending.current = operation;
    void operation.finally(() => {
      pending.current = undefined;
    });
    return operation;
  };
  useEffect(() => {
    active.current = true;
    if (!enabled) return;
    void navigator.storage?.persist?.().catch(() => false);
    const timer = setInterval(() => {
      const stats = world.recordingStats();
      if (
        !failed.current &&
        !busy.current &&
        (stats.eventCount >= 1000 || stats.elapsedMs >= 60000 || world.recordingCapacityReached())
      )
        void flush();
    }, 1000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [world, enabled]);
  useEffect(() => {
    if (open) {
      if (!panel.current?.open) panel.current?.showModal();
    } else panel.current?.close();
  }, [open]);
  const showSlots = async () => {
    const menu = trigger.current?.closest('details');
    if (menu) menu.open = false;
    setOpen(true);
    setLoading(true);
    busy.current = true;
    try {
      await pending.current;
      const saved = await catalogue(true);
      selection.current = saved.head;
      setSlots(saved.slots);
      setSelectedId(saved.head.slot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const load = async (id: number) => {
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      await pending.current;
      if (id === 0) {
        const next = await replaceTimeline([], selection.current);
        onRestore({ head: next });
      } else onRestore(await restoreSlot(id, selection.current, setStatus));
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const play = async (id: number, expected = selection.current, playing = true, speed = 1) => {
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      await pending.current;
      onPlay(
        await playSlot(id, expected, setStatus),
        { world, head: head.current },
        playing,
        speed,
      );
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const resume = async (playback: SavePlayback) => {
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      onRestore(await continuePlayback(playback));
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const retry = async () => {
    setOpen(false);
    busy.current = false;
    if (!initialError) {
      try {
        const stats = world.recordingStats();
        if (stats.eventCount || stats.pendingMs) await flush();
        else {
          if ((await catalogue()).head.revision !== head.current.revision)
            throw new Error('存档已更新，请打开存档列表加载。');
          failed.current = false;
          setError('');
        }
      } catch (e) {
        report(e);
      }
      return;
    }
    setLoading(true);
    busy.current = true;
    try {
      const saved = await catalogue();
      onRestore(
        saved.head.slot
          ? await restoreSlot(saved.head.slot, saved.head, setStatus)
          : { world, head: saved.head },
      );
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const saveNow = async () => {
    if (!enabled || busy.current || initialError) return;
    busy.current = true;
    setLoading(true);
    try {
      await pending.current;
      if (world.recordingCapacityReached()) {
        await flush(true);
        if (failed.current) return;
      }
      if (!beforeSave()) throw new Error('无法结算当前进度，请先处理录制错误。');
      const stats = world.recordingStats();
      if (!stats.eventCount && !stats.pendingMs) {
        setStatus('没有新的进度需要保存');
        return;
      }
      // Drain bounded batches while gameplay is paused; never discard an unsaved suffix.
      while (world.recordingStats().eventCount || world.recordingStats().pendingMs) {
        await flush(true);
        if (failed.current) break;
      }
    } catch (e) {
      report(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const selected = slots.find((slot) => slot.id === selectedId);
  const later = selected ? slots.length - slots.indexOf(selected) - 1 : 0;
  const close = () => {
    if (!loading) {
      busy.current = false;
      setOpen(false);
    }
  };
  return {
    error,
    blocked: open || loading || !!error,
    play,
    resume,
    loading,
    menu: (
      <>
        <button
          disabled={!enabled || loading || open || !!initialError}
          className="px-3 py-2 text-left hover:bg-brown-800 focus-visible:outline"
          onClick={saveNow}
        >
          立即存档
        </button>
        <button
          ref={trigger}
          disabled={loading}
          className="px-3 py-2 text-left hover:bg-brown-800 focus-visible:outline"
          onClick={() => void showSlots()}
          aria-haspopup="dialog"
        >
          存档
        </button>
        {status && (
          <p role="status" className="px-3 py-1 text-xs break-words">
            {status}
          </p>
        )}
        {error && (
          <div role="alert" className="px-3 py-2 text-sm break-words">
            {error}
            <button className="block underline" disabled={loading} onClick={() => void retry()}>
              重试自动存档
            </button>
            <p>当前进度保留在内存中。可打开存档列表加载已有档案。</p>
          </div>
        )}
      </>
    ),
    window: (
      <dialog
        ref={panel}
        className="goods-panel"
        aria-labelledby="saves-title"
        onKeyDown={(event) => event.stopPropagation()}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          close();
          trigger.current?.closest('details')?.querySelector('summary')?.focus();
        }}
      >
        <header>
          <div>
            <p>余时遗物</p>
            <h2 id="saves-title">读取存档</h2>
          </div>
          <div className="goods-balance">{slots.length} 份存档</div>
          <button autoFocus aria-label="关闭存档窗口" disabled={loading} onClick={close}>
            ×
          </button>
        </header>
        <p className="my-4 text-sm">
          进度自动保存，也可在设置中选择“立即存档”。刷新后从最新存档继续。
        </p>
        <div className="goods-body">
          <section className="goods-list" aria-label="存档列表">
            {[...slots].reverse().map((slot) => (
              <button
                key={slot.id}
                aria-label={`选择存档 ${slot.id}`}
                aria-pressed={selectedId === slot.id}
                disabled={loading}
                onClick={() => setSelectedId(slot.id)}
              >
                <span>
                  <strong>
                    存档 {slot.id}
                    {slot.id === slots.at(-1)?.id ? ' · 最新' : ''}
                  </strong>
                  <small>{slot.scene}</small>
                  <small>{new Date(slot.savedAt).toLocaleString()}</small>
                  <small>进行中：{slot.tasks?.active.join('、') || '无'}</small>
                  <small>已完成：{slot.tasks?.completed.join('、') || '无'}</small>
                  <small>
                    文件大小：
                    {slot.bytes === undefined ? '未知' : `${(slot.bytes / 1048576).toFixed(2)} MiB`}
                  </small>
                </span>
              </button>
            ))}
            <button
              aria-label="选择存档 0"
              aria-pressed={selectedId === 0}
              disabled={loading}
              onClick={() => setSelectedId(0)}
            >
              <span>
                <strong>存档 0</strong>
                <small>开始新游戏</small>
              </span>
            </button>
          </section>
          <section className="goods-detail" aria-label="存档详情">
            {selectedId === 0 && (
              <>
                <h3>开始新游戏</h3>
                <p>从起点开始一段新游戏。</p>
                <div className="goods-order">
                  <button disabled={loading} onClick={() => void load(0)}>
                    开始新游戏
                  </button>
                  <small>将清除全部存档和当前进度。</small>
                </div>
              </>
            )}
            {selected && (
              <>
                <h3>{selected.scene}</h3>
                <p>保存于 {new Date(selected.savedAt).toLocaleString()}</p>
                <p>生命余额 {formatTime(selected.balance)}</p>
                <p>已游玩 {formatTime(Math.floor(selected.time / 1000))}</p>
                <p>记录进度：{selected.end} 个事件</p>
                <div className="goods-order">
                  <button disabled={loading} onClick={() => void play(selected.id)}>
                    播放存档 {selected.id}
                  </button>
                  <button disabled={loading} onClick={() => void load(selected.id)}>
                    加载存档 {selected.id}
                    {later ? `（清除后续${later}档）` : ''}
                  </button>
                  <small>
                    播放从本档开头开始。加载恢复本档末尾，并清除后续存档和当前未保存进度。
                  </small>
                </div>
              </>
            )}
            {loading && <p role="status">{status || '正在读取存档…'}</p>}
            {error && <p role="alert">{error}</p>}
            <p className="mt-4 text-xs">存档保存在此浏览器。清除网站数据会删除存档。</p>
          </section>
        </div>
      </dialog>
    ),
  };
}
