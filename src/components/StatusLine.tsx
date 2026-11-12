import { useEffect, useReducer, useSyncExternalStore } from 'react';
import type { TypingEngine } from '../lib/engine.ts';
import type { AiState } from '../lib/api.ts';
import { liveStats, type TestResult } from '../lib/stats.ts';
import type { Passage, Settings } from '../lib/storage.ts';

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Editor-style status bar: mode, passage, progress and live numbers. */
export default function StatusLine({
  engine,
  passage,
  settings,
  result,
  ai,
}: {
  engine: TypingEngine;
  passage: Passage;
  settings: Settings;
  result: TestResult | null;
  ai: AiState;
}) {
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // keep the clock moving between keystrokes
  useEffect(() => {
    const id = window.setInterval(() => {
      if (engine.started && !engine.finished) tick();
    }, 250);
    return () => window.clearInterval(id);
  }, [engine]);

  const live = liveStats(engine);
  const wpm = result ? Math.round(result.wpm) : live.wpm;
  const acc = result ? Math.floor(result.accuracy) : live.accuracy;
  const ms = result ? result.timeMs : live.ms;
  const kind = passage.format === 'code' ? 'code' : 'text';
  const showLive = settings.liveStats || !!result;

  return (
    <div className="statusline">
      <span className="pill mode">{passage.format.toUpperCase()}</span>
      {passage.language && <span className="pill">{passage.language}</span>}
      <span className="pill">{passage.length}</span>
      <span className="pill title">{passage.title}</span>
      <span className="spacer" />
      <span className="pill">
        <span className="val">{Math.min(engine.pos, engine.length)}</span>/{engine.length}
      </span>
      {showLive && (
        <>
          <span className="pill">
            <span className="val">{wpm}</span> wpm
          </span>
          <span className="pill">
            <span className="val">{acc}</span>%
          </span>
          <span className="pill">
            <span className="val">{formatTime(ms)}</span>
          </span>
        </>
      )}
      <span className="pill">{settings[kind].mistakes === 'fix' ? 'fix' : 'allow'}</span>
      {ai !== 'checking' && (
        <span className={`pill ai ${ai}`} title={ai === 'quota' ? 'AI quota used up for now' : undefined}>
          {ai === 'quota' ? 'quota' : `ai ${ai}`}
        </span>
      )}
    </div>
  );
}
