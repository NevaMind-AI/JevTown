import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../prototype/world';
const clockLabel = (seconds: number) =>
  `第 ${Math.floor(seconds / 86400) + 1} 天 ${formatTime(Math.floor(seconds) % 86400)
    .padStart(8, '0')
    .slice(0, 5)}`;
export default function WaitPanel({
  open,
  time,
  earliestTime = time,
  sleeping = false,
  fixedTime,
  balance,
  feedback,
  onClose,
  onWait,
}: {
  open: boolean;
  time: number;
  earliestTime?: number;
  sleeping?: boolean;
  fixedTime?: number;
  balance: number;
  feedback: string;
  onClose: () => void;
  onWait: (time: number, hours: number) => boolean;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [hours, setHours] = useState(1);
  const until = fixedTime ?? Math.ceil(earliestTime) + hours * 3600,
    seconds = until - time;
  const valid =
    Number.isSafeInteger(until) &&
    Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    until > earliestTime &&
    seconds <= balance;
  useEffect(() => {
    if (open) {
      setHours(sleeping ? 8 : 1);
      panel.current?.showModal();
    } else panel.current?.close();
  }, [open]);
  return (
    <dialog
      ref={panel}
      className="goods-panel"
      style={{ width: 'min(520px,calc(100vw - 28px))' }}
      aria-labelledby="wait-title"
      onClose={onClose}
    >
      <header>
        <h2 id="wait-title">{sleeping ? '睡眠' : '等待'}</h2>
        <button onClick={() => panel.current?.close()} aria-label="关闭休息窗口">
          ×
        </button>
      </header>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && onWait(until, hours)) panel.current?.close();
        }}
      >
        <p className="text-center">现在 · {clockLabel(earliestTime)}</p>
        {fixedTime === undefined ? (
          <label className="block py-3 text-center">
            <span className="block text-sm">{sleeping ? '睡多久' : '等待多久'}</span>
            <output className="my-4 block text-4xl font-semibold text-amber-200" aria-live="polite">
              {hours} <span className="text-lg">小时</span>
            </output>
            <input
              autoFocus
              className="block w-full accent-amber-300"
              type="range"
              min="1"
              max="24"
              step="1"
              value={hours}
              aria-label={sleeping ? '睡眠时长' : '等待时长'}
              aria-valuetext={`${hours} 小时`}
              onChange={(event) => setHours(Number(event.target.value))}
            />
            <span className="mt-2 flex justify-between text-sm" aria-hidden="true">
              <span>1 小时</span>
              <span>24 小时</span>
            </span>
          </label>
        ) : (
          <p className="text-center">本次睡眠时长 · {formatTime(seconds)}</p>
        )}
        <p className="text-center">
          {sleeping ? '醒来' : '结束'} · {clockLabel(until)}
        </p>
        <p aria-live="polite">
          消耗余时 {formatTime(seconds)} ·{' '}
          {valid ? `剩余 ${formatTime(balance - seconds)}` : '余时不足，无法确认。'}
        </p>
        <p className="text-sm">
          消耗包含当前已积累、尚未结算的时间。期间世界继续运转，人物按各自作息活动。
          {sleeping ? '这间临时客房免收房费。' : ''}
        </p>
        {feedback && <p role="status">{feedback}</p>}
        <button type="submit" disabled={!valid}>
          {sleeping ? '确认入睡' : '确认等待'}
        </button>
      </form>
    </dialog>
  );
}
