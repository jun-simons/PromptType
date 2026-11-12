import { useEffect, useLayoutEffect, useReducer, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { TypingEngine } from '../lib/engine.ts';
import type { CaretStyle } from '../lib/storage.ts';

interface Props {
  engine: TypingEngine;
  /** positioned element that contains the [data-i] character spans */
  containerRef: RefObject<HTMLElement>;
  style: CaretStyle;
  smooth: boolean;
}

const BLINK_AFTER_MS = 550;

/**
 * A single absolutely positioned caret. It reads the position of the current
 * character span after every engine change and glides there with a CSS transform.
 */
export default function Caret({ engine, containerRef, style, smooth }: Props) {
  const version = useSyncExternalStore(engine.subscribe, engine.getVersion);
  const ref = useRef<HTMLDivElement>(null);
  const [measure, remeasure] = useReducer((n: number) => n + 1, 0);
  const placed = useRef(false);
  const lastPulse = useRef(engine.errorPulse);
  const blinkTimer = useRef<number>();

  // re-measure when layout can change: resize, font load
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(c);
    document.fonts?.ready.then(() => remeasure());
    return () => {
      ro.disconnect();
      window.clearTimeout(blinkTimer.current);
    };
  }, [containerRef]);

  useLayoutEffect(() => {
    const c = containerRef.current;
    const el = ref.current;
    const n = engine.length;
    if (!c || !el || !n) return;

    const atEnd = engine.pos >= n;
    const ch = c.querySelector<HTMLElement>(`[data-i="${atEnd ? n - 1 : engine.pos}"]`);
    if (!ch) return;

    const cw = ch.offsetWidth || 8;
    const chH = ch.offsetHeight;
    let x = ch.offsetLeft + (atEnd ? cw : 0);
    let y = ch.offsetTop;
    let w = 2;
    let h = chH * 0.86;
    if (style === 'block') {
      w = cw;
    } else if (style === 'underline') {
      w = cw;
      h = 2;
      y += chH - 2;
    } else {
      x -= 1;
    }
    if (style !== 'underline') y += (chH - h) / 2;

    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;

    // jump (no glide) on first placement so a new test doesn't animate in
    if (!placed.current) {
      placed.current = true;
      requestAnimationFrame(() => el.classList.toggle('smooth', smooth));
    } else {
      el.classList.toggle('smooth', smooth);
    }

    // solid while typing, blink when idle
    el.classList.remove('blink');
    window.clearTimeout(blinkTimer.current);
    if (!engine.finished) blinkTimer.current = window.setTimeout(() => el.classList.add('blink'), BLINK_AFTER_MS);

    if (engine.errorPulse !== lastPulse.current) {
      lastPulse.current = engine.errorPulse;
      el.classList.remove('err');
      void el.offsetWidth; // restart the animation
      el.classList.add('err');
    }
  }, [engine, containerRef, version, measure, style, smooth]);

  return <div ref={ref} className={`caret style-${style}`} aria-hidden />;
}
