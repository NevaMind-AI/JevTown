import { useLayoutEffect, useState } from 'react';

export function observeElementSize(
  element: HTMLElement,
  update: (size: { width: number; height: number }) => void,
) {
  const measure = () => update({ width: element.clientWidth, height: element.clientHeight });
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  measure();
  return () => observer.disconnect();
}

export function useElementSize() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    return observeElementSize(element, (next) => {
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    });
  }, [element]);
  return [setElement, size] as const;
}
