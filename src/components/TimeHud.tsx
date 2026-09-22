import { formatTime } from '../../prototype/world';
import './TimeHud.css';

export default function TimeHud({
  balance,
  storyTime,
  quantumSeconds,
}: {
  balance: number;
  storyTime: number;
  quantumSeconds?: number;
}) {
  const story = formatTime(storyTime % 86400)
    .padStart(8, '0')
    .slice(0, -3);
  // Prototype calendar anchor; world content will supply the starting date later.
  const date = new Date(Date.UTC(2026, 5, 1 + Math.floor(storyTime / 86400)));
  const calendar = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 · 星期${'日一二三四五六'[date.getUTCDay()]}`;
  return (
    <section className="time-hud" aria-label="游戏时间与生命余额">
      <span className="time-hud__label">剧情时间</span>
      <output className="time-hud__clock" aria-label={`剧情时间 ${story}`}>
        {story}
      </output>
      <p className="time-hud__date">{calendar}</p>
      {quantumSeconds !== undefined && (
        <p className="time-hud__date">
          每{quantumSeconds % 60 === 0 ? `${quantumSeconds / 60}分钟` : `${quantumSeconds}秒`}
          统一结算
        </p>
      )}
      <div className="time-hud__balance" data-overdrawn={balance < 0}>
        <span>{balance < 0 ? '生命余额 · 透支' : '生命余额'}</span>
        <output aria-label={`生命余额 ${formatTime(balance)}`}>{formatTime(balance)}</output>
      </div>
    </section>
  );
}
