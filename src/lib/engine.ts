// Framework-free typing engine. Holds per-character state and the keystroke log.
// React subscribes through `subscribe`/`version` and only re-renders segments
// (words for text, lines for code) whose version changed.

export type CharState = 'pending' | 'correct' | 'incorrect' | 'corrected' | 'auto';
export type Kind = 'text' | 'code';
export type MistakeMode = 'allow' | 'fix';

export interface EngineOptions {
  kind: Kind;
  mistakes: MistakeMode;
  /** code only: indentation after Enter is filled automatically and excluded from stats */
  autoIndent: boolean;
  /** code only: spaces inserted per Tab press */
  indentUnit: number;
}

export interface Keystroke {
  /** ms since test start */
  t: number;
  i: number;
  expected: string;
  typed: string;
  ok: boolean;
  /** produced by a Tab press (excluded from latency stats) */
  tab?: boolean;
}

export interface Segment {
  start: number;
  end: number; // exclusive
}

export class TypingEngine {
  private static seq = 0;
  /** unique per engine instance (used as a React key) */
  readonly id = ++TypingEngine.seq;
  readonly target: string;
  readonly opts: EngineOptions;
  readonly states: CharState[];
  readonly everWrong: Uint8Array;
  readonly segments: Segment[];
  readonly segOf: Int32Array;
  readonly segVersion: number[];

  pos = 0;
  startedAt: number | null = null;
  finishedAt: number | null = null;
  keystrokes: Keystroke[] = [];
  backspaces = 0;
  /** increments on every wrong key (used to animate the caret) */
  errorPulse = 0;
  version = 0;

  private listeners = new Set<() => void>();
  private dirty = new Set<number>();

  constructor(target: string, opts: EngineOptions) {
    this.target = target;
    this.opts = opts;
    const n = target.length;
    this.states = new Array<CharState>(n).fill('pending');
    this.everWrong = new Uint8Array(n);
    this.segOf = new Int32Array(n);
    this.segments = [];

    // text: a segment is a word plus its trailing space; code: a line plus its '\n'
    const boundary = opts.kind === 'code' ? '\n' : ' ';
    let start = 0;
    for (let i = 0; i < n; i++) {
      this.segOf[i] = this.segments.length;
      if (target[i] === boundary || i === n - 1) {
        this.segments.push({ start, end: i + 1 });
        start = i + 1;
      }
    }
    if (n === 0) this.segments.push({ start: 0, end: 0 });
    this.segVersion = new Array(this.segments.length).fill(0);

    // a passage that starts indented: pre-fill when auto-indent is on
    if (opts.kind === 'code' && opts.autoIndent) this.fillIndent();
    this.flush();
  }

  get length() {
    return this.target.length;
  }
  get finished() {
    return this.finishedAt !== null;
  }
  get started() {
    return this.startedAt !== null;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;

  /** Time elapsed in ms (live while running). */
  elapsed(now = performance.now()): number {
    if (this.startedAt === null) return 0;
    return (this.finishedAt ?? now) - this.startedAt;
  }

  // ---- input -------------------------------------------------------------

  type(ch: string, now = performance.now()): void {
    if (this.finished || this.pos >= this.length) return;
    const i = this.pos;
    const expected = this.target[i];

    if (ch === ' ' && expected !== ' ') {
      if (this.opts.kind === 'text') {
        // A space at the start of a word is ignored. This also re-syncs after an
        // extra letter was typed where the space belonged.
        if (i === 0 || this.target[i - 1] === ' ') return;
        if (this.opts.mistakes === 'allow') return this.skipWord(now);
      } else if (this.opts.autoIndent && this.justIndented()) {
        // habit-typed indentation after auto-indent already filled it
        return;
      }
    }

    if (this.startedAt === null) this.startedAt = now;
    const ok = ch === expected;
    this.keystrokes.push({ t: now - this.startedAt, i, expected, typed: ch, ok });
    this.touch(i);

    if (ok) {
      this.states[i] = this.everWrong[i] ? 'corrected' : 'correct';
      this.pos++;
      if (ch === '\n' && this.opts.kind === 'code' && this.opts.autoIndent) this.fillIndent();
    } else {
      this.everWrong[i] = 1;
      this.errorPulse++;
      if (this.opts.mistakes === 'allow') {
        this.states[i] = 'incorrect';
        this.pos++;
      }
    }
    this.checkFinish(now);
    this.flush();
  }

  enter(now = performance.now()): void {
    if (this.opts.kind !== 'code') return;
    this.type('\n', now);
  }

  /** Tab: in leading whitespace, jump to the next indent stop; elsewhere it's a wrong key. */
  tab(now = performance.now()): void {
    if (this.opts.kind !== 'code' || this.finished) return;
    const i = this.pos;
    if (this.opts.autoIndent && this.target[i] !== ' ' && this.justIndented()) return;
    const lineStart = this.target.lastIndexOf('\n', i - 1) + 1;
    const inLeading = /^ *$/.test(this.target.slice(lineStart, i)) && this.target[i] === ' ';
    if (!inLeading) {
      this.type('\t', now);
      return;
    }
    let leadEnd = i;
    while (this.target[leadEnd] === ' ') leadEnd++;
    const col = i - lineStart;
    const unit = this.opts.indentUnit;
    const stop = Math.min(lineStart + (Math.floor(col / unit) + 1) * unit, leadEnd);

    // one Tab press = one keystroke, however many spaces it fills
    if (this.startedAt === null) this.startedAt = now;
    this.keystrokes.push({ t: now - this.startedAt, i, expected: ' ', typed: '\t', ok: true, tab: true });
    for (let k = i; k < stop; k++) {
      this.states[k] = this.everWrong[k] ? 'corrected' : 'correct';
      this.touch(k);
    }
    this.pos = stop;
    this.checkFinish(now);
    this.flush();
  }

  backspace(word = false): void {
    if (this.finished || this.opts.mistakes === 'fix' || this.pos === 0) return;
    this.backspaces++;
    const isSpace = (c: string) => c === ' ' || c === '\n';
    if (!word) {
      this.stepBack();
    } else {
      // delete trailing whitespace first, then the word before it
      while (this.pos > 0 && isSpace(this.target[this.pos - 1]) && this.stepBack());
      while (this.pos > 0 && !isSpace(this.target[this.pos - 1]) && this.stepBack());
    }
    this.flush();
  }

  // ---- internals ---------------------------------------------------------

  /** Text, allow mode: space mid-word jumps past the next space; skipped chars count as missed. */
  private skipWord(now: number) {
    if (this.startedAt === null) this.startedAt = now;
    const i = this.pos;
    this.keystrokes.push({ t: now - this.startedAt, i, expected: this.target[i], typed: ' ', ok: false });
    this.errorPulse++;
    const sp = this.target.indexOf(' ', i);
    const end = sp === -1 ? this.length : sp;
    for (let k = i; k < end; k++) {
      this.states[k] = 'incorrect';
      this.everWrong[k] = 1;
      this.touch(k);
    }
    this.pos = end;
    if (sp !== -1) {
      this.states[sp] = this.everWrong[sp] ? 'corrected' : 'correct';
      this.touch(sp);
      this.pos = sp + 1;
    }
    this.checkFinish(now);
    this.flush();
  }

  /** True when everything typed so far on the current line was auto-indent. */
  private justIndented(): boolean {
    const i = this.pos;
    const lineStart = this.target.lastIndexOf('\n', i - 1) + 1;
    if (i === lineStart) return false;
    for (let k = lineStart; k < i; k++) if (this.states[k] !== 'auto') return false;
    return true;
  }

  /** Move back one typed position (auto-indent + its newline count as one step). */
  private stepBack(): boolean {
    if (this.pos === 0) return false;
    this.pos--;
    if (this.states[this.pos] === 'auto') {
      while (this.pos > 0 && this.states[this.pos] === 'auto') {
        this.states[this.pos] = 'pending';
        this.touch(this.pos);
        this.pos--;
      }
      if (this.states[this.pos] === 'auto') {
        // passage itself starts indented; nothing typed before it
        this.states[this.pos] = 'pending';
        this.fillIndentFrom0();
        return false;
      }
    }
    this.states[this.pos] = 'pending';
    this.touch(this.pos);
    return true;
  }

  private fillIndentFrom0() {
    this.pos = 0;
    this.fillIndent();
  }

  private fillIndent() {
    while (this.pos < this.length && this.target[this.pos] === ' ') {
      this.states[this.pos] = 'auto';
      this.touch(this.pos);
      this.pos++;
    }
  }

  private checkFinish(now: number) {
    if (this.pos >= this.length && this.finishedAt === null) this.finishedAt = now;
  }

  private touch(i: number) {
    if (i >= 0 && i < this.length) this.dirty.add(this.segOf[i]);
  }

  private flush() {
    for (const s of this.dirty) this.segVersion[s]++;
    this.dirty.clear();
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
