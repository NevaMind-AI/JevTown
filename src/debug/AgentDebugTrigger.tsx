import { useEffect } from 'react';

/**
 * How the agent debug panel opens: a button beside the settings gear, and `\` anywhere outside a
 * text field.
 *
 * Kept apart from the panel on purpose. The panel is inert without it, so a public build drops
 * this component (or turns `AGENT_DEBUG_TRIGGER` off in `AgentDebug.tsx`) and nothing else about
 * the game changes. `\` is bound nowhere else: movement is WASD and arrows, E interacts, R waits,
 * 1/2 open inventory, and backquote is the developer console.
 */
export default function AgentDebugTrigger({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      if (event.key !== '\\' && event.code !== 'Backslash') return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [onToggle]);

  return (
    <button
      aria-label="Agent 调试面板"
      aria-pressed={open}
      aria-keyshortcuts="\"
      title="Agent 调试面板 · \"
      className="pointer-events-auto absolute right-16 top-3 z-20 flex h-11 w-11 items-center justify-center border border-brown-500 bg-brown-900 text-lg focus-visible:outline focus-visible:outline-2"
      onClick={onToggle}
    >
      <span aria-hidden="true">🐞</span>
    </button>
  );
}
