import LocalGame from './components/LocalGame';
import { ToastContainer } from 'react-toastify';
import starImg from '../assets/star.svg';
import Button from './components/buttons/Button.tsx';

export default function Home() {
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
