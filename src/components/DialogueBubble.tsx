import { ReactNode, MutableRefObject, useEffect, useId, useRef, useState } from 'react';
import type { Viewport } from 'pixi-viewport';
import { useElementSize } from '../hooks/useElementSize';
import './DialogueBubble.css';
export default function DialogueBubble({
  viewportRef,
  position,
  width,
  height,
  name,
  text,
  topic,
  disabled,
  feedback,
  children,
}: {
  viewportRef: MutableRefObject<Viewport | undefined>;
  position: number[];
  width: number;
  height: number;
  name: string;
  text: string;
  topic?: string;
  disabled: boolean;
  feedback?: string;
  children: ReactNode;
}) {
  const [point, setPoint] = useState<{ x: number; y: number; bottom: number }>();
  const [bubbleRef, bubbleSize] = useElementSize();
  const dialogueRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const nameId = useId();
  const compact = width < 720 || height < 420;
  const bubbleWidth = Math.min(420, width * 0.48);
  const optionsWidth = Math.min(360, width * 0.43);
  useEffect(() => {
    let frame: number;
    const follow = () => {
      const viewport = viewportRef.current;
      if (viewport && !viewport.destroyed) {
        const screen = viewport.toScreen(position[0] * 32 + 16, position[1] * 32 - 48);
        const next = {
          x: Math.round(screen.x),
          y: Math.round(screen.y),
          bottom: Math.round(viewport.toScreen(position[0] * 32 + 16, position[1] * 32 + 32).y),
        };
        setPoint((previous) =>
          previous?.x === next.x && previous.y === next.y && previous.bottom === next.bottom
            ? previous
            : next,
        );
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [viewportRef, position[0], position[1]]);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    const options = dialogueRef.current?.querySelector('.dialogue-options-scroll');
    if (options) options.scrollTop = 0;
    if (!disabled)
      (
        dialogueRef.current?.querySelector<HTMLButtonElement>('fieldset button:not(:disabled)') ??
        dialogueRef.current
      )?.focus({ preventScroll: true });
  }, [name, topic, text, !!point, disabled]);
  if (!point) return null;
  // Give the speech and choices separate columns, with the speech nearest its speaker.
  const choicesOnRight = point.x < width / 2;
  const minLeft = choicesOnRight ? 16 : optionsWidth + 32;
  const maxLeft = choicesOnRight
    ? width - optionsWidth - bubbleWidth - 32
    : width - bubbleWidth - 16;
  const left = Math.max(minLeft, Math.min(maxLeft, point.x - bubbleWidth / 2));
  const aboveSpace = point.y - 82,
    belowSpace = height - point.bottom - 36;
  const above = aboveSpace >= belowSpace;
  const maxHeight = Math.max(
    80,
    Math.min(height * 0.55, Math.max(aboveSpace, belowSpace), height - 104),
  );
  const top = Math.max(
    64,
    Math.min(
      height - bubbleSize.height - 28,
      above ? point.y - bubbleSize.height - 18 : point.bottom + 18,
    ),
  );
  const optionsTop = Math.max(64, Math.min(height * 0.42, top + bubbleSize.height + 28));
  return (
    <section
      ref={dialogueRef}
      role="dialog"
      aria-label="当前交互"
      aria-labelledby={nameId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (!['w', 's', 'arrowup', 'arrowdown', 'e'].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (disabled || event.repeat) return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('fieldset button:not(:disabled)'),
        );
        if (!buttons.length) return;
        const index = buttons.findIndex((button) => button === document.activeElement);
        if (key === 'e') {
          if (index >= 0) {
            event.currentTarget.focus({ preventScroll: true });
            buttons[index].click();
          }
        } else {
          const step = key === 'w' || key === 'arrowup' ? -1 : 1;
          const next =
            buttons[
              index < 0
                ? step > 0
                  ? 0
                  : buttons.length - 1
                : (index + step + buttons.length) % buttons.length
            ];
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }}
      className={`dialogue-overlay${compact ? ' dialogue-overlay--compact' : ''}`}
    >
      <div
        ref={bubbleRef}
        className="dialogue-bubble"
        style={compact ? undefined : { left, top, width: bubbleWidth, maxHeight }}
      >
        <h2 id={nameId} className="dialogue-name">
          {name}
        </h2>
        <p ref={bodyRef} className="dialogue-text" tabIndex={0}>
          {text}
        </p>
        {!compact && (
          <span
            aria-hidden="true"
            className={`dialogue-tail${above ? '' : ' dialogue-tail--top'}`}
            style={{ left: Math.max(24, Math.min(bubbleWidth - 36, point.x - left - 10)) }}
          />
        )}
      </div>
      <div
        className="dialogue-options"
        style={
          compact
            ? undefined
            : {
                [choicesOnRight ? 'right' : 'left']: 16,
                top: optionsTop,
                width: optionsWidth,
                height: height - optionsTop - 20,
              }
        }
      >
        <h3>选择</h3>
        <p className="dialogue-keyboard-hint">W / S ↑↓ 选择 · E 确认 · Esc 离开</p>
        <div className="dialogue-options-scroll">
          <fieldset disabled={disabled} aria-label="对话选项">
            {children}
          </fieldset>
        </div>
        {feedback && (
          <p className="dialogue-feedback" role="status">
            {feedback}
          </p>
        )}
      </div>
    </section>
  );
}
