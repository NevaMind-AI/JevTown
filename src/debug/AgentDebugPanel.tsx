import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { decider } from '../../agent/config';
import { StoredMessage, TranscriptRow } from '../../agent/ports';
import { InputArgs } from '../../engine/aiTown/inputs';
import { AgenticRuntime } from '../sim/agenticRuntime';

/**
 * A floating debug panel over the agentic world: what the agents decided and said, and what the
 * god judged. Two tabs, never one feed — the god reads what several exchanges left behind, so
 * interleaving it with the lines it is judging would put it next to the wrong evidence.
 *
 * Read-only, and it owns no trigger: whoever mounts it decides how it opens (`AgentDebug.tsx`).
 * It stays mounted while closed so the decision log keeps accumulating — `pruneEvents` drops what
 * a sync flush has taken, and a panel that only read the log on open would miss it.
 */

const POLL_MS = 500;

type Tab = 'agents' | 'god';

export default function AgentDebugPanel({
  runtime,
  open,
  onClose,
}: {
  runtime: AgenticRuntime | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('agents');
  const agents = useAgentFeed(runtime);
  const god = useGodTranscript(runtime);
  const [showDecisions, setShowDecisions] = useState(true);
  const [showConversations, setShowConversations] = useState(true);
  const scroll = useStickToBottom(
    `${tab}:${agents.decisions.length}:${agents.messageCount}:${god.length}:${open}`,
  );

  if (!open) return null;
  return (
    <section
      aria-label="Agent 调试面板"
      className="pointer-events-auto absolute bottom-3 right-3 top-16 z-[15] flex w-96 max-w-[calc(100%-1.5rem)] flex-col border border-brown-500 bg-brown-900/95 font-sans text-brown-100 shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-brown-500 px-2 pt-2">
        <div role="tablist" className="flex flex-1 gap-1">
          {(
            [
              ['agents', `${decider()} 决策 · 对话`],
              ['god', 'God 记录'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`px-3 py-1 text-sm ${tab === id ? 'bg-brown-700' : 'opacity-60 hover:opacity-100'}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          aria-label="关闭调试面板"
          className="px-2 py-1 opacity-70 hover:opacity-100"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      {tab === 'agents' && runtime && (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-brown-700 px-3 py-2 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showDecisions}
              onChange={(e) => setShowDecisions(e.target.checked)}
            />
            决策 {agents.decisions.length}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showConversations}
              onChange={(e) => setShowConversations(e.target.checked)}
            />
            对话 {agents.messageCount}
          </label>
        </div>
      )}
      <div
        key={tab}
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-sm"
      >
        {!runtime ? (
          <Empty>
            没有运行中的 agentic 世界：当前内容包没有 world 文件，或它启动失败（见控制台）。
          </Empty>
        ) : tab === 'agents' ? (
          <AgentFeed
            runtime={runtime}
            feed={agents}
            showDecisions={showDecisions}
            showConversations={showConversations}
          />
        ) : (
          <GodFeed runtime={runtime} rows={god.rows} />
        )}
      </div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs opacity-60">{children}</p>;
}

/** Keep a growing list pinned to its end, unless the reader has scrolled up to read. */
function useStickToBottom(change: string) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [change]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return { ref, onScroll };
}

// ---------------------------------------------------------------- agents

interface DecisionEntry {
  idx: number;
  gameTime: number;
  agentId: string;
  args: InputArgs<'agentDecideAction'>;
}

/**
 * Decisions off the input log, conversations out of the store.
 *
 * Every decision already re-enters the world as an `agentDecideAction` input (docs/09 §5), so
 * nothing extra is recorded to show it. Messages are read per conversation, keyed on
 * `lastMessage.timestamp` so each is fetched once per line — plus once more after it leaves the
 * world, since a last line and the end of the conversation can land between two polls.
 */
function useAgentFeed(runtime: AgenticRuntime | undefined) {
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [conversations, setConversations] = useState<Record<string, StoredMessage[]>>({});
  const seenIdx = useRef(-1);
  const stamps = useRef<Record<string, number>>({});
  const live = useRef(new Set<string>());

  useEffect(() => {
    if (!runtime) return;
    const fetch = (id: string) =>
      void runtime.store.listMessages(id as never).then((list) => {
        if (list.length) setConversations((previous) => ({ ...previous, [id]: list }));
      });
    const poll = () => {
      const fresh: DecisionEntry[] = [];
      for (const event of runtime.eventsSince(seenIdx.current)) {
        seenIdx.current = event.idx;
        if (event.name !== 'agentDecideAction') continue;
        const args = event.args as InputArgs<'agentDecideAction'>;
        fresh.push({ idx: event.idx, gameTime: event.gameTime, agentId: args.agentId, args });
      }
      if (fresh.length) setDecisions((previous) => [...previous, ...fresh]);

      const now = new Set<string>();
      for (const conversation of runtime.game.world.conversations.values()) {
        now.add(conversation.id);
        const stamp = conversation.lastMessage?.timestamp ?? 0;
        if (!stamp || stamps.current[conversation.id] === stamp) continue;
        stamps.current[conversation.id] = stamp;
        fetch(conversation.id);
      }
      for (const id of live.current) if (!now.has(id)) fetch(id);
      live.current = now;
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(timer);
  }, [runtime]);

  const messageCount = Object.values(conversations).reduce((sum, list) => sum + list.length, 0);
  return { decisions, conversations, messageCount };
}

function AgentFeed({
  runtime,
  feed,
  showDecisions,
  showConversations,
}: {
  runtime: AgenticRuntime;
  feed: ReturnType<typeof useAgentFeed>;
  showDecisions: boolean;
  showConversations: boolean;
}) {
  const live = new Set<string>(runtime.game.world.conversations.keys());
  // A conversation is one block, sorted by its first line, so the decisions taken while it ran
  // fall in after it rather than shredding it (the solarium panel's arrangement).
  const entries = [
    ...(showConversations
      ? Object.entries(feed.conversations).map(([id, list]) => ({
          kind: 'conversation' as const,
          key: `c-${id}`,
          at: list[0]?.createdAt ?? 0,
          id,
          list,
        }))
      : []),
    ...(showDecisions
      ? feed.decisions.map((d) => ({
          kind: 'decision' as const,
          key: `d-${d.idx}`,
          at: d.gameTime,
          decision: d,
        }))
      : []),
  ].sort((a, b) => a.at - b.at);

  if (!entries.length) {
    return (
      <Empty>
        {showDecisions || showConversations
          ? '还没有决策或对话。第一次决策要等一次模型调用；长时间没动静就看控制台。'
          : '两个开关都关了。'}
      </Empty>
    );
  }
  return (
    <>
      {entries.map((entry) =>
        entry.kind === 'conversation' ? (
          <section key={entry.key} className="border border-brown-500 p-2">
            <h3 className="mb-1 text-xs uppercase tracking-wide opacity-60">
              {clock(entry.at)} · {live.has(entry.id) ? 'talking' : 'ended'}
            </h3>
            <ol className="flex flex-col gap-1">
              {entry.list.map((message) => (
                <li key={message.messageUuid}>
                  <span className="opacity-60">{nameOf(runtime, message.author)}: </span>
                  {message.text}
                </li>
              ))}
            </ol>
          </section>
        ) : (
          <div key={entry.key} className="border-l-2 border-brown-500 pl-2">
            <p>
              <span className="opacity-60">
                {clock(entry.at)} · {agentName(runtime, entry.decision.agentId)} ·{' '}
              </span>
              {describeAction(runtime, entry.decision.args)}
            </p>
            {/* Verbatim: under Jev this is the distribution the choice came from (docs/12 §3). */}
            <p className="break-words text-xs opacity-60">{entry.decision.args.reason}</p>
            {entry.decision.args.problems?.map((problem, i) => (
              <p key={i} className="text-xs text-amber-300">
                {problem}
              </p>
            ))}
          </div>
        ),
      )}
    </>
  );
}

function describeAction(runtime: AgenticRuntime, args: InputArgs<'agentDecideAction'>): string {
  switch (args.action) {
    case 'approach':
      return `approach ${nameOf(runtime, args.target)}${args.intent ? ` — ${args.intent}` : ''}`;
    case 'wander':
      return `wander to the ${(args.anchor ?? '?').replace(/_/g, ' ')}`;
    default:
      return `${args.emoji ? `${args.emoji} ` : ''}${args.description ?? 'idle'}`;
  }
}

function agentName(runtime: AgenticRuntime, agentId: string): string {
  const agent = runtime.game.world.agents.get(agentId as never);
  return agent ? nameOf(runtime, agent.playerId) : agentId;
}

/** A player or an entity; the id stands in for anything without a name. */
function nameOf(runtime: AgenticRuntime, id: string | undefined): string {
  if (!id) return '?';
  return (
    runtime.game.playerDescriptions.get(id as never)?.name ??
    runtime.game.entityDescriptions.get(id as never)?.name ??
    id
  );
}

/** Game time, which both messages and decisions are stamped in (docs/13 §3.1). */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h ? `${h}:${pad(m)}` : m}:${pad(total % 60)}`;
}

// ---------------------------------------------------------------- god

/** The whole transcript, refetched only when its newest row changes. */
function useGodTranscript(runtime: AgenticRuntime | undefined) {
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!runtime) return;
    const poll = () =>
      void runtime.store.godTranscript(Number.MAX_SAFE_INTEGER).then((newestFirst) => {
        const seq = newestFirst[0]?.seq ?? 0;
        if (seq === lastSeq.current) return;
        lastSeq.current = seq;
        setRows([...newestFirst].reverse());
      });
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(timer);
  }, [runtime]);
  return { rows, length: rows.length };
}

/**
 * One block per batch: the evidence the god was shown, then what it concluded.
 *
 * The evidence is folded away because it is every state document in the batch, verbatim; the
 * verdict is the line worth scanning.
 */
function GodFeed({ runtime, rows }: { runtime: AgenticRuntime; rows: TranscriptRow[] }) {
  if (!runtime.context.world.worldDescription().godPersona) {
    return <Empty>这个世界的 world 文件没有 god persona，god 不会运行。</Empty>;
  }
  if (!rows.length) {
    return (
      <Empty>God 还没有记录。它每 30 秒游戏时间看一次，且只在有新的状态写入时才形成批次。</Empty>
    );
  }
  // Keyed rather than run-length: a god step whose model call outlasts the 30s interval overlaps
  // the next one, and their rows interleave.
  const byBatch = new Map<string, TranscriptRow[]>();
  for (const row of rows) {
    const key = row.batchId ?? `seq-${row.seq}`;
    byBatch.set(key, [...(byBatch.get(key) ?? []), row]);
  }
  const batches = [...byBatch].map(([key, rows]) => ({ key, rows }));
  return (
    <>
      {batches.map((batch) => {
        const evidence = batch.rows.filter((row) => row.role === 'event');
        const verdicts = batch.rows.filter((row) => row.role === 'verdict');
        const through = batch.rows.find((row) => row.throughInputNumber !== undefined);
        return (
          <section key={batch.key} className="border border-brown-500 p-2">
            <h3 className="mb-1 text-xs uppercase tracking-wide opacity-60">
              #{batch.rows[0].seq}
              {through ? ` · through input ${through.throughInputNumber}` : ''}
              {batch.key.startsWith('seq-') ? '' : ` · ${batch.key.slice(0, 8)}`}
            </h3>
            {verdicts.length ? (
              verdicts.map((row) => (
                <p
                  key={row.seq}
                  className={
                    row.content.startsWith('No intervention') ? 'opacity-70' : 'text-amber-200'
                  }
                >
                  {row.content}
                </p>
              ))
            ) : (
              <p className="opacity-60">judging…</p>
            )}
            {evidence.map((row) => (
              <details key={row.seq} className="mt-1">
                <summary className="cursor-pointer text-xs opacity-60">
                  batch evidence · {row.content.length} chars
                </summary>
                <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-black/40 p-2 text-xs">
                  {row.content}
                </pre>
              </details>
            ))}
          </section>
        );
      })}
    </>
  );
}
