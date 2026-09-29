import { useCallback, useState } from 'react';
import { AgenticRuntime } from '../sim/agenticRuntime';
import AgentDebugPanel from './AgentDebugPanel';
import AgentDebugTrigger from './AgentDebugTrigger';

/**
 * On in `vite` dev, off in a build unless `VITE_AGENT_DEBUG=1`. Read at module load, so a
 * production bundle without the flag tree-shakes the whole folder away.
 */
export const AGENT_DEBUG_ENABLED = import.meta.env.DEV || import.meta.env.VITE_AGENT_DEBUG === '1';

/**
 * Whether the button and hotkey are mounted. Separate from the panel, so a public build can keep
 * the panel code and drop the only way to open it — or delete `AgentDebugTrigger.tsx` outright.
 */
const AGENT_DEBUG_TRIGGER = true;

/** The agent debug panel and its trigger. The only thing `LocalGame` mounts from this folder. */
export default function AgentDebug({ runtime }: { runtime: AgenticRuntime | undefined }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  return (
    <>
      {AGENT_DEBUG_TRIGGER && <AgentDebugTrigger open={open} onToggle={toggle} />}
      <AgentDebugPanel runtime={runtime} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
