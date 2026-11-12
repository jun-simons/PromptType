import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import english from '../src/data/words/english.json';
import { buildWordTest, COMBO_SHARE, focusGroups, MIN_GROUP, parseLetters, tierSize } from '../src/lib/words.ts';

const words = english.words;

/** deterministic rng for stable proportions */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('english word list', () => {
  test('is big, clean and frequency-ordered', () => {
    assert.ok(words.length >= 20000, `only ${words.length} words`);
    assert.equal(new Set(words).size, words.length, 'duplicates');
    for (const w of words) assert.match(w, /^[a-z]+$/);
    assert.deepEqual(words.slice(0, 3), ['the', 'to', 'and']);
    for (const w of ['people', 'because', 'world']) assert.ok(words.indexOf(w) < 200, `${w} should be top 200`);
  });

  test('tiers are prefixes of the list', () => {
    assert.equal(tierSize('200', words.length), 200);
    assert.equal(tierSize('1k', words.length), 1000);
    assert.equal(tierSize('all', words.length), words.length);
  });
});

describe('parseLetters', () => {
  test('keeps unique lowercase letters only', () => {
    assert.deepEqual(parseLetters('B, y b!'), ['b', 'y']);
    assert.deepEqual(parseLetters(' 12 '), []);
  });
});

describe('buildWordTest', () => {
  test('plain tests use only the top `depth` words, the requested count, no adjacent repeats', () => {
    const top = new Set(words.slice(0, 200));
    const t = buildWordTest(words, { count: 300, depth: 200 }).text.split(' ');
    assert.equal(t.length, 300);
    for (const w of t) assert.ok(top.has(w));
    for (let i = 1; i < t.length; i++) assert.notEqual(t[i], t[i - 1]);
  });

  test('no repeats within a test while the pool is big enough', () => {
    const t = buildWordTest(words, { count: 100, depth: 200 }).text.split(' ');
    assert.equal(new Set(t).size, 100);
  });

  test('tiny pools still fill the count without adjacent repeats', () => {
    const t = buildWordTest(['a', 'b'], { count: 40 }).text.split(' ');
    assert.equal(t.length, 40);
    for (let i = 1; i < t.length; i++) assert.notEqual(t[i], t[i - 1]);
  });

  test('a single focus letter: every word contains it', () => {
    const r = buildWordTest(words, { count: 100, depth: 200, letters: ['k'] });
    assert.deepEqual(r.letters, ['k']);
    for (const w of r.text.split(' ')) assert.ok(w.includes('k'), w);
  });

  test('rare letters search past the tier for the most common matches', () => {
    const g = focusGroups(words, 200, ['q']);
    assert.ok(g.byLetter[0].words.length >= MIN_GROUP);
    // the most common q-words come first, not obscure ones
    assert.ok(g.byLetter[0].words.slice(0, 5).includes('question'));
  });

  test('two letters: words with either, and words with both get a priority share', () => {
    const rng = mulberry32(7);
    const r = buildWordTest(words, { count: 2000, depth: 1000, letters: ['b', 'y'], rng });
    const t = r.text.split(' ');
    let both = 0;
    let b = 0;
    let y = 0;
    for (const w of t) {
      assert.ok(w.includes('b') || w.includes('y'), w);
      if (w.includes('b') && w.includes('y')) both++;
      else if (w.includes('b')) b++;
      else y++;
    }
    // combo draws alone are COMBO_SHARE; words with both are far rarer than that in plain text
    assert.ok(both / t.length >= COMBO_SHARE * 0.9, `both ${both}`);
    assert.ok(b > 200 && y > 200, `b ${b} y ${y}`);
  });

  test('letters absent from the list are dropped and reported via `letters`', () => {
    const r = buildWordTest(['cat', 'dog'], { count: 10, letters: ['c', 'z'] });
    assert.deepEqual(r.letters, ['c']);
    for (const w of r.text.split(' ')) assert.equal(w, 'cat');
  });
});
