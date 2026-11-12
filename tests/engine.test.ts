import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TypingEngine, type EngineOptions } from '../src/lib/engine.ts';
import { computeResult } from '../src/lib/stats.ts';

const TEXT: EngineOptions = { kind: 'text', mistakes: 'allow', autoIndent: false, indentUnit: 4 };
const CODE: EngineOptions = { kind: 'code', mistakes: 'allow', autoIndent: true, indentUnit: 4 };

/** Feed a string through the engine; '\n' goes through enter(). Returns the next timestamp. */
function feed(e: TypingEngine, s: string, t = 0, step = 100): number {
  for (const ch of s) {
    if (ch === '\n') e.enter(t);
    else e.type(ch, t);
    t += step;
  }
  return t;
}

const states = (e: TypingEngine, from = 0, to = e.length) => e.states.slice(from, to);

describe('text engine, allow mode', () => {
  test('correct keys advance and mark correct', () => {
    const e = new TypingEngine('cat dog', TEXT);
    feed(e, 'cat');
    assert.equal(e.pos, 3);
    assert.deepEqual(states(e, 0, 3), ['correct', 'correct', 'correct']);
    assert.equal(e.started, true);
    assert.equal(e.finished, false);
  });

  test('a wrong key marks incorrect and advances', () => {
    const e = new TypingEngine('cat', TEXT);
    e.type('x', 0);
    assert.equal(e.pos, 1);
    assert.equal(e.states[0], 'incorrect');
    assert.equal(e.errorPulse, 1);
    assert.equal(e.keystrokes[0].ok, false);
  });

  test('fixing a mistake with backspace yields "corrected"', () => {
    const e = new TypingEngine('cat', TEXT);
    e.type('x', 0);
    e.backspace();
    assert.equal(e.pos, 0);
    assert.equal(e.states[0], 'pending');
    e.type('c', 100);
    assert.equal(e.states[0], 'corrected');
    assert.equal(e.backspaces, 1);
  });

  test('ctrl+backspace deletes the current word, then the space and previous word', () => {
    const e = new TypingEngine('one two three', TEXT);
    feed(e, 'one tw');
    e.backspace(true);
    assert.equal(e.pos, 4);
    e.backspace(true);
    assert.equal(e.pos, 0);
    assert.ok(states(e).every((s) => s === 'pending'));
  });

  test('space mid-word skips to the next word and marks the rest missed', () => {
    const e = new TypingEngine('hello world', TEXT);
    feed(e, 'he ');
    assert.equal(e.pos, 6);
    assert.deepEqual(states(e, 0, 6), ['correct', 'correct', 'incorrect', 'incorrect', 'incorrect', 'correct']);
    // one keystroke for the space, and it counts as a miss
    assert.equal(e.keystrokes.length, 3);
    assert.equal(e.keystrokes[2].ok, false);
    feed(e, 'world', 1000);
    assert.equal(e.finished, true);
  });

  test('space mid-word in the last word finishes the test', () => {
    const e = new TypingEngine('hi there', TEXT);
    feed(e, 'hi th ');
    assert.equal(e.finished, true);
    assert.deepEqual(states(e, 5), ['incorrect', 'incorrect', 'incorrect']);
  });

  test('a space at the start of a word is ignored', () => {
    const e = new TypingEngine('ab cd', TEXT);
    e.type(' ', 0);
    assert.equal(e.pos, 0);
    assert.equal(e.started, false);
    assert.equal(e.keystrokes.length, 0);
    feed(e, 'ab ');
    e.type(' ', 500); // extra space after a word
    assert.equal(e.pos, 3);
    assert.equal(e.keystrokes.length, 3);
  });

  test('Enter and Tab do nothing in text', () => {
    const e = new TypingEngine('ab', TEXT);
    e.enter(0);
    e.tab(0);
    assert.equal(e.pos, 0);
    assert.equal(e.keystrokes.length, 0);
  });

  test('finishes on the last character and ignores further input', () => {
    const e = new TypingEngine('ab', TEXT);
    feed(e, 'ab', 0);
    assert.equal(e.finished, true);
    assert.equal(e.elapsed(), 100);
    e.type('x', 500);
    e.backspace();
    assert.equal(e.pos, 2);
    assert.equal(e.keystrokes.length, 2);
  });

  test('notifies subscribers and bumps only the touched segment version', () => {
    const e = new TypingEngine('ab cd', TEXT);
    let calls = 0;
    const unsub = e.subscribe(() => calls++);
    e.type('a', 0);
    assert.equal(calls, 1);
    assert.deepEqual(e.segVersion, [1, 0]);
    unsub();
    e.type('b', 100);
    assert.equal(calls, 1);
  });
});

describe('text engine, fix mode', () => {
  const FIX: EngineOptions = { ...TEXT, mistakes: 'fix' };

  test('a wrong key is logged but the caret does not move', () => {
    const e = new TypingEngine('cat', FIX);
    e.type('x', 0);
    assert.equal(e.pos, 0);
    assert.equal(e.states[0], 'pending');
    assert.equal(e.keystrokes.length, 1);
    assert.equal(e.errorPulse, 1);
    e.type('c', 100);
    assert.equal(e.pos, 1);
    assert.equal(e.states[0], 'corrected');
  });

  test('backspace is a no-op', () => {
    const e = new TypingEngine('cat', FIX);
    feed(e, 'ca');
    e.backspace();
    assert.equal(e.pos, 2);
    assert.equal(e.backspaces, 0);
  });

  test('space mid-word is just a wrong key (no skip)', () => {
    const e = new TypingEngine('hello world', FIX);
    feed(e, 'he ');
    assert.equal(e.pos, 2);
    assert.equal(e.keystrokes.length, 3);
    assert.equal(e.keystrokes[2].ok, false);
  });
});

describe('code engine', () => {
  test('space is always literal (no word skip)', () => {
    const e = new TypingEngine('x = 1', { ...CODE, autoIndent: false });
    feed(e, ' ');
    assert.equal(e.pos, 1);
    assert.equal(e.states[0], 'incorrect');
  });

  test('Enter is a real character', () => {
    const e = new TypingEngine('a\nb', { ...CODE, autoIndent: false });
    feed(e, 'a');
    e.type('b', 100); // wrong: expected newline
    assert.equal(e.states[1], 'incorrect');
    e.backspace();
    e.enter(200);
    assert.equal(e.states[1], 'corrected');
    feed(e, 'b', 300);
    assert.equal(e.finished, true);
  });

  describe('auto-indent on', () => {
    const SRC = 'if x:\n    y = 1\nz';

    test('fills the target indentation after Enter as auto', () => {
      const e = new TypingEngine(SRC, CODE);
      feed(e, 'if x:\n');
      assert.equal(e.pos, 10);
      assert.deepEqual(states(e, 6, 10), ['auto', 'auto', 'auto', 'auto']);
      // auto chars are not keystrokes
      assert.equal(e.keystrokes.length, 6);
    });

    test('dedents by copying the target (no indent after the block)', () => {
      const e = new TypingEngine(SRC, CODE);
      feed(e, 'if x:\ny = 1\n');
      assert.equal(e.pos, SRC.indexOf('z'));
      feed(e, 'z', 2000);
      assert.equal(e.finished, true);
    });

    test('nested dedent lands on the outer indent level', () => {
      const src = 'a:\n    b:\n        c\n    d';
      const e = new TypingEngine(src, CODE);
      feed(e, 'a:\nb:\nc\n');
      assert.equal(e.pos, src.lastIndexOf('d'));
      assert.deepEqual(states(e, src.lastIndexOf('\n') + 1, src.lastIndexOf('d')), ['auto', 'auto', 'auto', 'auto']);
    });

    test('a stray space right after the auto-fill is ignored', () => {
      const e = new TypingEngine(SRC, CODE);
      feed(e, 'if x:\n');
      feed(e, '    ', 1000);
      assert.equal(e.pos, 10);
      assert.equal(e.keystrokes.length, 6);
      // Tab is ignored there too
      e.tab(2000);
      assert.equal(e.pos, 10);
      assert.equal(e.keystrokes.length, 6);
    });

    test('backspace removes the whole indent and the newline in one step', () => {
      const e = new TypingEngine(SRC, CODE);
      feed(e, 'if x:\n');
      e.backspace();
      assert.equal(e.pos, 5);
      assert.ok(states(e, 5, 10).every((s) => s === 'pending'));
      assert.equal(e.backspaces, 1);
      e.enter(1000);
      assert.equal(e.pos, 10);
    });

    test('a passage that starts indented is pre-filled, and backspace cannot remove it', () => {
      const e = new TypingEngine('  x\ny', CODE);
      assert.equal(e.pos, 2);
      assert.deepEqual(states(e, 0, 2), ['auto', 'auto']);
      assert.equal(e.started, false);
      feed(e, 'x');
      e.backspace();
      e.backspace();
      assert.equal(e.pos, 2);
      assert.deepEqual(states(e, 0, 3), ['auto', 'auto', 'pending']);
    });

    test('auto chars are excluded from WPM and accuracy', () => {
      const e = new TypingEngine(SRC, CODE);
      feed(e, 'if x:\ny = 1\nz', 0, 100);
      assert.equal(e.finished, true);
      const r = computeResult(e, { passageId: 'p', title: 't', prompt: '', format: 'code', language: 'python', source: 'library' });
      assert.equal(r.chars.auto, 4);
      assert.equal(r.chars.correct, SRC.length - 4);
      assert.equal(r.keystrokes, SRC.length - 4);
      assert.equal(r.accuracy, 100);
    });
  });

  describe('auto-indent off', () => {
    const MANUAL: EngineOptions = { ...CODE, autoIndent: false };
    const SRC = 'def f():\n        return 1';

    test('Tab in leading whitespace jumps to the next indent stop', () => {
      const e = new TypingEngine(SRC, MANUAL);
      feed(e, 'def f():\n');
      assert.equal(e.pos, 9);
      e.tab(1000);
      assert.equal(e.pos, 13);
      e.tab(1100);
      assert.equal(e.pos, 17);
      assert.ok(states(e, 9, 17).every((s) => s === 'correct'));
    });

    test('one Tab press is one keystroke', () => {
      const e = new TypingEngine(SRC, MANUAL);
      feed(e, 'def f():\n');
      e.tab(1000);
      e.tab(1100);
      assert.equal(e.keystrokes.length, 11);
      assert.deepEqual(
        e.keystrokes.slice(-2).map((k) => [k.typed, k.ok, k.tab]),
        [
          ['\t', true, true],
          ['\t', true, true],
        ],
      );
      feed(e, 'return 1', 1200);
      const r = computeResult(e, { passageId: 'p', title: 't', prompt: '', format: 'code', language: 'python', source: 'library' });
      assert.equal(r.keystrokes, 19);
      assert.equal(r.chars.correct, SRC.length);
    });

    test('Tab stops at the end of the leading whitespace', () => {
      const e = new TypingEngine('a\n      b', { ...MANUAL, indentUnit: 4 });
      feed(e, 'a\n');
      e.tab(0);
      e.tab(100);
      assert.equal(e.pos, 8); // 4, then capped at 6 spaces
    });

    test('Tab aligns to the indent unit from a partial indent', () => {
      const e = new TypingEngine('a\n    b', { ...MANUAL, indentUnit: 2 });
      feed(e, 'a\n ');
      e.tab(0);
      assert.equal(e.pos, 4); // column 1 -> 2
    });

    test('Tab outside leading whitespace is a wrong key', () => {
      const e = new TypingEngine('a b', MANUAL);
      feed(e, 'a');
      e.tab(100);
      assert.equal(e.pos, 2);
      assert.equal(e.states[1], 'incorrect');
      assert.equal(e.keystrokes[1].typed, '\t');
    });

    test('indentation can be typed with spaces', () => {
      const e = new TypingEngine('a\n  b', MANUAL);
      feed(e, 'a\n  b');
      assert.equal(e.finished, true);
      assert.ok(states(e).every((s) => s === 'correct'));
    });
  });
});

describe('computeResult', () => {
  const meta = { passageId: 'p', title: 't', prompt: '', format: 'prose' as const, language: null, source: 'library' };

  test('WPM, raw WPM and accuracy', () => {
    // 10 chars, one mistake fixed with backspace, 12 s total
    const e = new TypingEngine('abcde fghi', TEXT);
    const t = feed(e, 'abcde fg', 0, 1000);
    e.type('x', t);
    e.backspace();
    feed(e, 'hi', 11000, 1000);
    const r = computeResult(e, meta);
    assert.equal(r.timeMs, 12000);
    assert.equal(r.chars.correct, 9);
    assert.equal(r.chars.corrected, 1);
    assert.equal(r.wpm, 10); // 10 chars / 5 / 0.2 min
    assert.equal(r.rawWpm, 11); // 11 keystrokes / 5 / 0.2 min
    assert.equal(r.accuracy, 90.9);
    assert.equal(r.backspaces, 1);
    assert.deepEqual(r.keys.h.slice(0, 2), [2, 1]);
    assert.equal(r.confusions['h→x'], 1);
    assert.equal(r.tokens.fghi, 1);
    assert.equal(r.timeline.wpm.length, 12);
  });

  test('in allow mode a wrong final character still ends the test', () => {
    const e = new TypingEngine('ab', TEXT);
    feed(e, 'ax');
    assert.equal(e.finished, true);
    assert.equal(e.states[1], 'incorrect');
  });

  test('a very short test is clamped to one second', () => {
    const e = new TypingEngine('ab', TEXT);
    feed(e, 'ab', 0, 10);
    const r = computeResult(e, meta);
    assert.equal(r.timeMs, 1000);
  });
});
