import { useEffect, useRef, useState } from 'react';
import type { ChatView, HumanPlayer } from '../sim/humanPlayer';

/** How often the panel reads the conversation. A reply arrives whenever the model answers. */
const POLL_MS = 200;

const STATUS: Record<ChatView['status'], string> = {
  connecting: '正在搭话…',
  open: '',
  ended: '对话已结束。',
  failed: '对方现在无法和你交谈。',
};

/**
 * The player's side of a conversation with an agent (docs/13 §2): what was said, and a box to
 * say more.
 *
 * Not a modal: the world keeps running while it is open, because an agent only answers on a tick.
 * The host stops the player walking while it is open, and Esc or the close button leaves.
 */
export default function AgentChat({ human, onClose }: { human: HumanPlayer; onClose: () => void }) {
  const [view, setView] = useState<ChatView>();
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      void human.view().then((next) => {
        if (live) setView(next);
      });
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [human]);

  const lineCount = view?.lines.length ?? 0;
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lineCount, view?.partnerTyping]);

  useEffect(() => {
    if (view?.status === 'open') input.current?.focus();
  }, [view?.status]);

  const open = view?.status === 'open';
  const canSend = open && !view.partnerTyping && draft.trim().length > 0;

  return (
    <section
      aria-label={view ? `与${view.partnerName}的对话` : '对话'}
      className="absolute bottom-4 left-1/2 z-40 flex max-h-[45%] w-[min(560px,calc(100%-32px))] -translate-x-1/2 flex-col gap-2 rounded-lg border border-brown-500 bg-brown-900 p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex items-center justify-between">
        <h2 className="font-semibold">{view?.partnerName ?? '…'}</h2>
        <button onClick={onClose} aria-label="结束对话">
          ×
        </button>
      </header>
      <ol ref={log} className="flex min-h-12 flex-col gap-1 overflow-y-auto" aria-live="polite">
        {view?.lines.map((line) => (
          <li key={line.id} className={line.mine ? 'self-end text-right' : 'self-start'}>
            <span className="mr-1 text-xs opacity-70">{line.name}</span>
            <span className={line.mine ? 'text-amber-200' : ''}>{line.text}</span>
          </li>
        ))}
        {view?.partnerTyping && <li className="self-start text-sm opacity-70">对方正在说话…</li>}
        {view && STATUS[view.status] && (
          <li role="status" className="self-center text-sm opacity-70">
            {STATUS[view.status]}
          </li>
        )}
      </ol>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSend) return;
          const text = draft;
          void human.say(text).then((sent) => {
            if (sent) setDraft((current) => (current === text ? '' : current));
          });
        }}
      >
        <input
          ref={input}
          className="min-w-0 flex-1 rounded border border-brown-500 bg-brown-800 px-2 py-1"
          value={draft}
          maxLength={500}
          disabled={!open}
          placeholder={open ? '说点什么… (Enter 发送，Esc 离开)' : ''}
          aria-label="你要说的话"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!canSend}>
          发送
        </button>
      </form>
    </section>
  );
}
