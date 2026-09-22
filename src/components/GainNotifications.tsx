import { useCallback, useEffect, useRef, useState } from 'react';
import './GainNotifications.css';

export type Gain = {
  name: string;
  amount?: string;
  image?: string;
  kind?: 'task' | 'task-progress' | 'task-complete';
};
const taskLabels = { task: '新任务', 'task-progress': '任务更新', 'task-complete': '任务完成' };
type Notice = Gain & { id: number; createdAt: number };

function GainRow({ notice }: { notice: Notice }) {
  const [age] = useState(() => Math.max(0, performance.now() - notice.createdAt));
  return (
    <div className="gain-row" style={{ animationDelay: `-${age}ms` }}>
      {notice.image ? (
        <img src={import.meta.env.BASE_URL + notice.image} alt="" />
      ) : (
        <span className="gain-clock" aria-hidden="true">
          {notice.kind ? (notice.kind === 'task-complete' ? '✓' : '!') : '◷'}
        </span>
      )}
      <span>
        {notice.kind && <strong>{taskLabels[notice.kind]} · </strong>}
        {notice.name}
        {notice.amount !== undefined && (
          <>
            {' '}
            <strong>+ {notice.amount}</strong>
          </>
        )}
      </span>
    </div>
  );
}

export function useGainNotifications() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0),
    timers = useRef(new Set<number>());
  const audio = useRef<AudioContext>();
  useEffect(() => {
    const unlock = () => {
      try {
        if (!window.AudioContext) return;
        audio.current ??= new AudioContext();
        if (audio.current.state === 'suspended') void audio.current.resume().catch(() => {});
      } catch {
        /* Audio availability does not affect rewards. */
      }
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
      void audio.current?.close().catch(() => {});
      audio.current = undefined;
    };
  }, []);
  const clear = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    setNotices([]);
  }, []);
  const add = useCallback((gains: Gain[]) => {
    if (!gains.length) return;
    const added = gains.map((gain) => ({
      ...gain,
      id: ++nextId.current,
      createdAt: performance.now(),
    }));
    setNotices((previous) => [...added.reverse(), ...previous]);
    for (const notice of added) {
      const timer = window.setTimeout(() => {
        timers.current.delete(timer);
        setNotices((previous) => previous.filter((n) => n.id !== notice.id));
      }, 3350);
      timers.current.add(timer);
    }
    const context = audio.current;
    if (context?.state === 'running') {
      try {
        // Simultaneous receipts share one short chime; rows remain separate for every recorded gain.
        const tone = context.createOscillator(),
          volume = context.createGain(),
          now = context.currentTime;
        tone.type = 'sine';
        tone.frequency.setValueAtTime(880, now);
        tone.frequency.exponentialRampToValueAtTime(1320, now + 0.1);
        volume.gain.setValueAtTime(0.0001, now);
        volume.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
        volume.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        tone.connect(volume);
        volume.connect(context.destination);
        tone.onended = () => {
          tone.disconnect();
          volume.disconnect();
        };
        tone.start(now);
        tone.stop(now + 0.21);
      } catch {
        /* Keep the visual receipt if sound is unavailable. */
      }
    }
  }, []);
  const view = (
    <section
      className="gain-notifications"
      aria-label="动态提示"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-atomic="false"
    >
      {notices.length > 0 && (
        <>
          <p className="gain-title">{notices.some((n) => n.kind) ? '提示' : '获得'}</p>
          <div className="gain-list">
            {notices.map((notice) => (
              <GainRow key={notice.id} notice={notice} />
            ))}
          </div>
        </>
      )}
    </section>
  );
  return { add, clear, view };
}
