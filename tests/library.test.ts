import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_CODE_LINE } from '../shared/types.ts';
import { normalizeFor } from '../shared/normalize.ts';
import data from '../src/data/library.json';
import english from '../src/data/words/english.json';
import { matchPreset, pickFromLibrary, sampleWords, type LibraryData } from '../src/lib/library.ts';

const lib = { ...data, words: english.words } as LibraryData;

describe('seed library data', () => {
  test('every preset has entries and every entry has a preset', () => {
    const ids = new Set(lib.presets.map((p) => p.id));
    assert.equal(ids.size, lib.presets.length, 'duplicate preset ids');
    for (const p of lib.presets)
      if (!p.wordList) assert.ok(lib.entries.some((e) => e.preset === p.id), `no entries for ${p.id}`);
    for (const p of lib.presets) if (p.wordList) assert.equal(p.format, 'words', `${p.id}: wordList needs format words`);
    for (const e of lib.entries) assert.ok(ids.has(e.preset), `unknown preset ${e.preset}`);
    assert.equal(new Set(lib.entries.map((e) => e.id)).size, lib.entries.length, 'duplicate entry ids');
  });

  test('entries are already normalized and typeable', () => {
    for (const e of lib.entries) {
      const p = lib.presets.find((x) => x.id === e.preset)!;
      assert.equal(e.text, normalizeFor(p.format, e.text), `${e.id} is not normalized`);
      assert.ok(!/[^\x20-\x7E\n]/.test(e.text), `${e.id} has untypeable characters`);
      if (p.format === 'code') {
        assert.ok(e.language, `${e.id} needs a language`);
        for (const line of e.text.split('\n')) assert.ok(line.length <= MAX_CODE_LINE, `${e.id}: long line`);
      } else {
        assert.ok(!e.text.includes('\n'), `${e.id} has newlines`);
      }
    }
  });
});

describe('library selection', () => {
  test('matches free-form prompts to presets within a format', () => {
    assert.equal(matchPreset(lib, 'Python with list comprehensions', 'code')?.id, 'python-comprehensions');
    assert.equal(matchPreset(lib, 'latex integrals and sums', 'code')?.id, 'latex-math');
    assert.equal(matchPreset(lib, 'an academic astronomy paper', 'prose')?.id, 'astro-academic');
    assert.equal(matchPreset(lib, 'zzz qqq', 'prose'), null);
  });

  test('every format and length yields a passage', () => {
    for (const format of ['prose', 'words', 'code'] as const)
      for (const length of ['short', 'medium', 'long'] as const) {
        const r = pickFromLibrary(lib, { format, length });
        assert.ok(r, `${format}/${length}`);
        assert.equal(r.passage.format, format);
        assert.equal(r.matched, false);
      }
  });

  test('prefers the requested length and avoids the excluded passage', () => {
    for (let i = 0; i < 20; i++) {
      const r = pickFromLibrary(lib, { format: 'code', length: 'short', presetId: 'sql-queries', excludeId: 'nope' })!;
      assert.equal(r.passage.preset, 'sql-queries');
      assert.equal(r.passage.length, 'short');
    }
    // only one short entry in the preset: "next" moves to another length rather than repeating
    const first = pickFromLibrary(lib, { format: 'code', length: 'short', presetId: 'python-comprehensions' })!;
    const again = pickFromLibrary(lib, {
      format: 'code',
      length: 'short',
      presetId: 'python-comprehensions',
      excludeId: first.passage.id,
    })!;
    assert.notEqual(again.passage.id, first.passage.id);
  });

  test('word presets are sampled to the requested length without adjacent repeats', () => {
    const r = pickFromLibrary(lib, { format: 'words', length: 'medium', presetId: 'common-english' })!;
    assert.equal(r.passage.text.split(' ').length, 50);
    const pool = pickFromLibrary(lib, { format: 'words', length: 'short', presetId: 'programming-terms' })!;
    assert.equal(pool.passage.text.split(' ').length, 25);
    assert.equal(pool.passage.preset, 'programming-terms');
    const s = sampleWords(['a', 'b'], 40).split(' ');
    assert.equal(s.length, 40);
    for (let i = 1; i < s.length; i++) assert.notEqual(s[i], s[i - 1]);
  });
});

describe('words from the common list', () => {
  test('words format defaults to the common list, drawn from the chosen tier', () => {
    const top200 = new Set(lib.words.slice(0, 200));
    for (let i = 0; i < 5; i++) {
      const r = pickFromLibrary(lib, { format: 'words', length: 'long', words: { tier: '200', letters: '' } })!;
      assert.equal(r.passage.preset, 'common-english');
      assert.equal(r.matched, false);
      for (const w of r.passage.text.split(' ')) assert.ok(top200.has(w), `${w} not in top 200`);
    }
    // an unmatched prompt also falls back to the common list
    const r = pickFromLibrary(lib, { format: 'words', length: 'short', prompt: 'zzz qqq' })!;
    assert.equal(r.passage.preset, 'common-english');
  });

  test('every test is a fresh shuffle', () => {
    const a = pickFromLibrary(lib, { format: 'words', length: 'long', words: { tier: '1k', letters: '' } })!;
    const b = pickFromLibrary(lib, { format: 'words', length: 'long', words: { tier: '1k', letters: '' } })!;
    assert.notEqual(a.passage.text, b.passage.text);
    assert.notEqual(a.passage.id, b.passage.id);
  });

  test('focus letters filter words and are named in the title', () => {
    const r = pickFromLibrary(lib, { format: 'words', length: 'long', words: { tier: '1k', letters: 'by' } })!;
    for (const w of r.passage.text.split(' ')) assert.ok(/[by]/.test(w), `${w} has neither b nor y`);
    assert.match(r.passage.title, /focus b y/);
    assert.deepEqual(r.missingLetters, []);
  });

  test('pool presets honour focus letters too', () => {
    const r = pickFromLibrary(lib, { format: 'words', length: 'short', presetId: 'programming-terms', words: { tier: '200', letters: 'q' } })!;
    for (const w of r.passage.text.split(' ')) assert.ok(w.includes('q'), `${w} has no q`);
  });
});
