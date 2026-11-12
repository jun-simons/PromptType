import { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { TypingEngine } from '../lib/engine.ts';
import type { Settings } from '../lib/storage.ts';
import Caret from './Caret.tsx';

/** Prose and word lists: wrapped words, a three-line window that scrolls line by line. */
export default function TextView({ engine, settings }: { engine: TypingEngine; settings: Settings }) {
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  const innerRef = useRef<HTMLDivElement>(null);

  // keep the caret on the first or second visible line
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || !engine.length) return;
    const i = Math.min(engine.pos, engine.length - 1);
    const word = inner.querySelector<HTMLElement>(`[data-i="${i}"]`)?.parentElement;
    if (!word) return;
    const lh = word.offsetHeight || 1;
    const line = Math.round(word.offsetTop / lh);
    inner.style.transform = `translateY(${-Math.max(0, line - 1) * lh}px)`;
  });

  return (
    <div className="text-view">
      <div ref={innerRef} className="text-inner">
        {engine.segments.map((_, k) => (
          <Word key={k} engine={engine} index={k} v={engine.segVersion[k]} />
        ))}
        <Caret engine={engine} containerRef={innerRef} style={settings.caret} smooth={settings.smoothCaret} />
      </div>
    </div>
  );
}

// `v` is the segment version: memo re-renders a word only when its characters changed
const Word = memo(function Word({ engine, index }: { engine: TypingEngine; index: number; v: number }) {
  const { start, end } = engine.segments[index];
  const chars = [];
  for (let i = start; i < end; i++) {
    const ch = engine.target[i];
    chars.push(
      <span key={i} data-i={i} className={`ch ${engine.states[i]}${ch === ' ' ? ' ws' : ''}`}>
        {ch}
      </span>,
    );
  }
  return <span className="word">{chars}</span>;
});
