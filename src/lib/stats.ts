// Turn an engine's keystroke log into a compact, storable result.

import type { Format } from '../../shared/types.ts';
import type { Kind, MistakeMode, TypingEngine } from './engine.ts';

export type Category = 'lower' | 'upper' | 'digit' | 'space' | 'bracket' | 'quote' | 'operator' | 'punct';
export const CATEGORY_LABEL: Record<Category, string> = {
  lower: 'lowercase',
  upper: 'capitals',
  digit: 'digits',
  space: 'space / enter',
  bracket: 'brackets',
  quote: 'quotes',
  operator: 'operators',
  punct: 'punctuation',
};

export function categoryOf(ch: string): Category {
  if (/[a-z]/.test(ch)) return 'lower';
  if (/[A-Z]/.test(ch)) return 'upper';
  if (/[0-9]/.test(ch)) return 'digit';
  if (ch === ' ' || ch === '\n') return 'space';
  if ('()[]{}'.includes(ch)) return 'bracket';
  if ('\'"`'.includes(ch)) return 'quote';
  if ('+-*/=<>!&|^%~?'.includes(ch)) return 'operator';
  return 'punct';
}

/** Display name for a key. */
export function keyLabel(ch: string): string {
  if (ch === ' ') return 'space';
  if (ch === '\n') return 'enter';
  if (ch === '\t') return 'tab';
  return ch;
}

export interface TestResult {
  id: string;
  at: number;
  kind: Kind;
  format: Format;
  passageId: string;
  title: string;
  prompt: string;
  language: string | null;
  source: string;
  mistakes: MistakeMode;
  autoIndent: boolean;

  wpm: number;
  rawWpm: number;
  accuracy: number; // 0..100
  timeMs: number;
  chars: { correct: number; incorrect: number; corrected: number; auto: number; total: number };
  keystrokes: number;
  backspaces: number;

  /** per second: cumulative wpm, instantaneous raw wpm, errors in that second */
  timeline: { wpm: number[]; raw: number[]; err: number[] };
  /** key -> [attempts, misses, latencySumMs, latencyCount] */
  keys: Record<string, [number, number, number, number]>;
  /** "expected→typed" -> count */
  confusions: Record<string, number>;
  /** missed bigrams (previous char + missed char) -> count */
  bigrams: Record<string, number>;
  /** words (text) or tokens (code) that contained a miss -> count */
  tokens: Record<string, number>;
  /** category -> [attempts, misses] */
  cats: Partial<Record<Category, [number, number]>>;
}

export interface ResultMeta {
  passageId: string;
  title: string;
  prompt: string;
  format: Format;
  language: string | null;
  source: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Word (text) or token (code) around index i, with its start index. */
function tokenAt(target: string, i: number, kind: Kind): [string, number] {
  if (kind === 'text') {
    let s = i, e = i;
    if (target[i] === ' ') s = e = i - 1 >= 0 ? i - 1 : i; // a missed space belongs to the word before it
    while (s > 0 && target[s - 1] !== ' ') s--;
    while (e < target.length && target[e] !== ' ') e++;
    const w = target.slice(s, e);
    return [w.replace(/^[^\w']+|[^\w']+$/g, '') || w, s];
  }
  const isWord = (c: string) => /\w/.test(c);
  const isSym = (c: string) => !!c && !/[\w\s]/.test(c);
  const ch = target[i];
  if (ch === ' ' || ch === '\n') return ['', i];
  const test = isWord(ch) ? isWord : isSym;
  let s = i, e = i;
  while (s > 0 && test(target[s - 1])) s--;
  while (e < target.length && test(target[e])) e++;
  return [target.slice(s, e), s];
}

export function computeResult(engine: TypingEngine, meta: ResultMeta): TestResult {
  const { target, states, keystrokes } = engine;
  const kind = engine.opts.kind;
  const timeMs = Math.max(engine.elapsed(), 1000);
  const minutes = timeMs / 60000;

  const chars = { correct: 0, incorrect: 0, corrected: 0, auto: 0, total: target.length };
  for (const s of states) {
    if (s === 'correct') chars.correct++;
    else if (s === 'incorrect') chars.incorrect++;
    else if (s === 'corrected') chars.corrected++;
    else if (s === 'auto') chars.auto++;
  }

  const okCount = keystrokes.filter((k) => k.ok).length;
  const wpm = (chars.correct + chars.corrected) / 5 / minutes;
  const rawWpm = keystrokes.length / 5 / minutes;
  const accuracy = keystrokes.length ? (okCount / keystrokes.length) * 100 : 100;

  // timeline
  const secs = Math.max(1, Math.ceil(timeMs / 1000));
  const okPer = new Array(secs).fill(0);
  const allPer = new Array(secs).fill(0);
  const errPer = new Array(secs).fill(0);
  for (const k of keystrokes) {
    const s = Math.min(secs - 1, Math.floor(k.t / 1000));
    allPer[s]++;
    if (k.ok) okPer[s]++;
    else errPer[s]++;
  }
  let cum = 0;
  const wpmLine = okPer.map((n, s) => {
    cum += n;
    const dur = s === secs - 1 ? timeMs / 1000 : s + 1;
    return round1(cum / 5 / (dur / 60));
  });
  const raw = allPer.map((_, s) => {
    const win = allPer.slice(Math.max(0, s - 1), s + 2);
    return round1(((win.reduce((a, b) => a + b, 0) / win.length) * 60) / 5);
  });

  // per-key, confusions, bigrams, tokens, categories
  const keys: TestResult['keys'] = {};
  const confusions: Record<string, number> = {};
  const bigrams: Record<string, number> = {};
  const tokens: Record<string, number> = {};
  const cats: TestResult['cats'] = {};
  const seenTokenStarts = new Set<number>();
  let prev: (typeof keystrokes)[number] | null = null;

  for (const k of keystrokes) {
    const e = k.expected;
    const entry = (keys[e] ??= [0, 0, 0, 0]);
    entry[0]++;
    const cat = categoryOf(e);
    const ce = (cats[cat] ??= [0, 0]);
    ce[0]++;
    if (!k.ok) {
      entry[1]++;
      ce[1]++;
      const ck = `${e}→${k.typed}`;
      confusions[ck] = (confusions[ck] ?? 0) + 1;
      const p = target[k.i - 1];
      if (k.i > 0 && p !== ' ' && p !== '\n' && e !== ' ' && e !== '\n') {
        const bg = p + e;
        bigrams[bg] = (bigrams[bg] ?? 0) + 1;
      }
      const [tok, start] = tokenAt(target, k.i, kind);
      // count each occurrence of a token once, however many misses it had
      if (tok.length > 1 && !seenTokenStarts.has(start)) {
        seenTokenStarts.add(start);
        tokens[tok] = (tokens[tok] ?? 0) + 1;
      }
    } else if (prev && prev.ok && !k.tab) {
      const dt = k.t - prev.t;
      if (dt > 0 && dt < 2000) {
        entry[2] += dt;
        entry[3]++;
      }
    }
    prev = k;
  }

  // keep token map small
  const topTokens = Object.fromEntries(
    Object.entries(tokens)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25),
  );

  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    kind,
    format: meta.format,
    passageId: meta.passageId,
    title: meta.title,
    prompt: meta.prompt,
    language: meta.language,
    source: meta.source,
    mistakes: engine.opts.mistakes,
    autoIndent: engine.opts.autoIndent,
    wpm: round1(wpm),
    rawWpm: round1(rawWpm),
    // floor so a run with any miss never displays as 100%
    accuracy: Math.floor(accuracy * 10) / 10,
    timeMs: Math.round(timeMs),
    chars,
    keystrokes: keystrokes.length,
    backspaces: engine.backspaces,
    timeline: { wpm: wpmLine, raw, err: errPer },
    keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [v[0], v[1], Math.round(v[2]), v[3]]])),
    confusions,
    bigrams,
    tokens: topTokens,
    cats,
  };
}

/** Live numbers while typing. */
export function liveStats(engine: TypingEngine, now = performance.now()) {
  const ms = engine.elapsed(now);
  if (ms < 500) return { wpm: 0, accuracy: 100, ms };
  let good = 0;
  for (let i = 0; i < engine.pos; i++) {
    const s = engine.states[i];
    if (s === 'correct' || s === 'corrected') good++;
  }
  const ok = engine.keystrokes.filter((k) => k.ok).length;
  return {
    wpm: Math.round(good / 5 / (ms / 60000)),
    accuracy: engine.keystrokes.length ? Math.floor((ok / engine.keystrokes.length) * 100) : 100,
    ms,
  };
}
