import LocalGame from './components/LocalGame';
import AgenticDemo from './components/AgenticDemo';
import { ToastContainer } from 'react-toastify';
import starImg from '../assets/star.svg';
import Button from './components/buttons/Button.tsx';

/**
 * The agentic flow check replaces the game rather than joining it.
 *
 * Set by `npm run play:demo` and nothing else: the flag lives in the committed `.env.demo`, which
 * only `vite --mode demo` loads. It is wiring, not a knob -- `npm run play:local` is the game.
 *
 * Separate from `VITE_AGENTIC`, which attaches an agentic world to a session somebody is playing,
 * where this runs agents on a `dev` room with nobody playing at all. They are different questions,
 * and turning on both at once would run two agentic worlds.
 */
const demoMode = !!(import.meta as any).env?.VITE_AGENTIC_DEMO;

export default function Home() {
  if (demoMode) {
    return (
      <main className="font-body">
        <AgenticDemo />
        <ToastContainer position="bottom-right" autoClose={2000} closeOnClick theme="dark" />
      </main>
    );
  }
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-between font-body game-background">
      <div className="w-full relative isolate overflow-hidden shadow-2xl flex flex-col justify-start h-[100dvh] min-h-0 p-2 sm:p-4">
        <LocalGame controlsBlocked={false} />
        <footer className="shrink-0 justify-end bottom-0 left-0 w-full flex items-center gap-3 flex-wrap pointer-events-none mt-2 p-2">
          <div className="flex gap-4 flex-grow pointer-events-none">
            <Button href="https://github.com/NevaMind-AI/remaining-time" imgUrl={starImg}>
              Repo
            </Button>
          </div>
        </footer>
        <ToastContainer position="bottom-right" autoClose={2000} closeOnClick theme="dark" />
      </div>
    </main>
  );
}
