import { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { TypingEngine } from '../lib/engine.ts';
import type { Passage, Settings } from '../lib/storage.ts';
import Caret from './Caret.tsx';

const EXT: Record<string, string> = {
  python: 'py', javascript: 'js', typescript: 'ts', rust: 'rs', go: 'go', java: 'java', c: 'c',
  cpp: 'cpp', csharp: 'cs', sql: 'sql', bash: 'sh', latex: 'tex', ruby: 'rb', haskell: 'hs', kotlin: 'kt',
};

function fileName(p: Passage): string {
  const base =
    p.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 32) || 'snippet';
  return `${base}.${EXT[p.language ?? ''] ?? 'txt'}`;
}

type LineNumbers = Settings['code']['lineNumbers'];

/** Code: one row per line with a gutter, cursorline and scrolloff-style scrolling. */
export default function CodeView({ engine, passage, settings }: { engine: TypingEngine; passage: Passage; settings: Settings }) {
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  const viewRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const cur = engine.length ? engine.segOf[Math.min(engine.pos, engine.length - 1)] : 0;
  const total = engine.segments.length;
  const mode = settings.code.lineNumbers;

  // keep the current line about a third of the way down
  useLayoutEffect(() => {
    const view = viewRef.current;
    const inner = innerRef.current;
    const lineEl = inner?.children[cur] as HTMLElement | undefined;
    if (!view || !inner || !lineEl) return;
    const lh = lineEl.offsetHeight || 1;
    const visible = Math.max(1, Math.floor((view.clientHeight - 24) / lh));
    const top = Math.min(Math.max(0, cur - Math.floor(visible / 3)), Math.max(0, total - visible));
    inner.style.transform = `translateY(${-top * lh}px)`;
  });

  const { autoIndent, mistakes } = engine.opts;

  return (
    <div className="code-panel">
      <div className="code-tabbar">
        <span className="code-tab">
          <span className="dot" />
          {fileName(passage)}
        </span>
        <span>
          {passage.language ?? 'plain'} · {autoIndent ? 'auto-indent' : 'manual indent'} · {mistakes === 'fix' ? 'fix mistakes' : 'allow mistakes'}
        </span>
      </div>
      <div ref={viewRef} className="code-view">
        <div ref={innerRef} className="code-inner">
          {engine.segments.map((_, k) => (
            <Line key={k} engine={engine} index={k} v={engine.segVersion[k]} num={lineNumber(mode, k, cur)} current={k === cur} />
          ))}
          <Caret engine={engine} containerRef={innerRef} style={settings.caret} smooth={settings.smoothCaret} />
        </div>
      </div>
    </div>
  );
}

function lineNumber(mode: LineNumbers, k: number, cur: number): string | null {
  if (mode === 'off') return null;
  if (mode === 'absolute' || k === cur) return String(k + 1);
  return String(Math.abs(k - cur));
}

const Line = memo(function Line({
  engine,
  index,
  num,
  current,
}: {
  engine: TypingEngine;
  index: number;
  v: number;
  num: string | null;
  current: boolean;
}) {
  const { start, end } = engine.segments[index];
  const chars = [];
  for (let i = start; i < end; i++) {
    const ch = engine.target[i];
    const st = engine.states[i];
    if (ch === '\n') {
      chars.push(
        <span key={i} data-i={i} className={`ch nl ws ${st}`}>
          ↵
        </span>,
      );
    } else {
      chars.push(
        <span key={i} data-i={i} className={`ch ${st}${ch === ' ' ? ' ws' : ''}`}>
          {ch}
        </span>,
      );
    }
  }
  return (
    <div className={`line${current ? ' cur' : ''}`}>
      <span className={`gutter${num === null ? ' off' : ''}`}>{num}</span>
      <span className="code">{chars}</span>
    </div>
  );
});
