import { useMemo, type ReactNode } from 'react';
import { keyLabel, type TestResult } from '../lib/stats.ts';
import { loadResults } from '../lib/storage.ts';
import WpmChart from './charts/WpmChart.tsx';

interface Props {
  result: TestResult;
  onNext: () => void;
  onRetry: () => void;
}

function topConfusion(result: TestResult, key: string): string | null {
  let best: [string, number] | null = null;
  for (const [pair, n] of Object.entries(result.confusions)) {
    const [exp, typed] = pair.split('→');
    if (exp === key && typed !== undefined && (!best || n > best[1])) best = [typed, n];
  }
  return best ? keyLabel(best[0]) : null;
}

export default function Results({ result, onNext, onRetry }: Props) {
  const missed = useMemo(
    () =>
      Object.entries(result.keys)
        .filter(([, v]) => v[1] > 0)
        .sort((a, b) => b[1][1] - a[1][1] || b[1][1] / b[1][0] - a[1][1] / a[1][0])
        .slice(0, 8),
    [result],
  );
  const slow = useMemo(
    () =>
      Object.entries(result.keys)
        .filter(([, v]) => v[3] >= 3)
        .map(([k, v]) => [k, v[2] / v[3]] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    [result],
  );
  const tokens = useMemo(
    () =>
      Object.entries(result.tokens)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    [result],
  );
  const avg = useMemo(() => {
    const prev = loadResults()
      .filter((r) => r.id !== result.id && r.format === result.format)
      .slice(0, 20);
    return prev.length >= 3 ? prev.reduce((s, r) => s + r.wpm, 0) / prev.length : null;
  }, [result]);

  const delta = avg === null ? null : result.wpm - avg;
  const { chars } = result;

  return (
    <div className="results">
      <div className="big">
        <div>
          <div className="label">wpm</div>
          <div className="num">{Math.round(result.wpm)}</div>
          {delta !== null && (
            <div className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
              {delta >= 0 ? '+' : ''}
              {delta.toFixed(1)} vs your {result.format} average
            </div>
          )}
        </div>
        <div>
          <div className="label">accuracy</div>
          <div className="num">{Math.floor(result.accuracy)}%</div>
        </div>
      </div>

      <WpmChart wpm={result.timeline.wpm} raw={result.timeline.raw} err={result.timeline.err} />

      <div className="sub">
        <Stat label="raw" value={Math.round(result.rawWpm)} />
        <Stat label="time" value={`${(result.timeMs / 1000).toFixed(1)}s`} />
        <Stat
          label="chars"
          value={
            <>
              {chars.correct + chars.corrected}
              <small> / {chars.incorrect} / {chars.corrected}</small>
            </>
          }
          title="typed correctly / left wrong / fixed after a mistake"
        />
        {chars.auto > 0 && <Stat label="auto-indented" value={chars.auto} title="filled by auto-indent, not counted" />}
        <Stat label="keystrokes" value={result.keystrokes} />
        <Stat label="backspaces" value={result.backspaces} />
      </div>

      <div className="lists">
        <div className="list">
          <h4>missed keys</h4>
          {missed.length ? (
            <ul>
              {missed.map(([k, v]) => {
                const conf = topConfusion(result, k);
                return (
                  <li key={k}>
                    <span className="key">{keyLabel(k)}</span>
                    <span className="meta">
                      {v[1]}/{v[0]}
                      {conf ? ` · typed ${conf}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="none">no misses, clean run</div>
          )}
        </div>
        <div className="list">
          <h4>slowest keys</h4>
          {slow.length ? (
            <ul>
              {slow.map(([k, ms]) => (
                <li key={k}>
                  <span className="key">{keyLabel(k)}</span>
                  <span className="meta">{Math.round(ms)} ms</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="none">not enough data</div>
          )}
        </div>
        <div className="list">
          <h4>{result.kind === 'code' ? 'missed tokens' : 'missed words'}</h4>
          {tokens.length ? (
            <ul>
              {tokens.map(([t, n]) => (
                <li key={t}>
                  <span>{t}</span>
                  <span className="meta">×{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="none">none</div>
          )}
        </div>
      </div>

      <div className="actions">
        <button className="btn" onClick={onNext}>
          next passage <kbd>ctrl</kbd>
          <kbd>enter</kbd>
        </button>
        <button className="btn" onClick={onRetry}>
          retry <kbd>esc</kbd>
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
