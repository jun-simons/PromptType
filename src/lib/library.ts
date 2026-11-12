// Offline library of pre-generated exercises (src/data/library.json).
// Loaded lazily as its own chunk; also used as the fallback when AI is unavailable.

import { LENGTH_SPEC, type Format, type Length } from '../../shared/types.ts';
import { newId, type Passage } from './storage.ts';
import { buildWordTest, DEFAULT_WORD_OPTIONS, parseLetters, tierSize, type WordOptions, type WordTier } from './words.ts';

export interface Preset {
  id: string;
  label: string;
  prompt: string;
  format: Format;
  tags: string[];
  /** words presets: draw from the bundled frequency list instead of library entries */
  wordList?: boolean;
}

export interface LibraryEntry {
  id: string;
  preset: string;
  title: string;
  language?: string;
  /** prose/code: the passage. words: a pool of words sampled per test. */
  text: string;
}

export interface LibraryData {
  presets: Preset[];
  entries: LibraryEntry[];
  /** common English words, most frequent first (src/data/words/english.json) */
  words: string[];
}

let cache: Promise<LibraryData> | null = null;
export function loadLibrary(): Promise<LibraryData> {
  cache ??= Promise.all([import('../data/library.json'), import('../data/words/english.json')]).then(
    ([lib, words]) => ({ ...(lib.default as Omit<LibraryData, 'words'>), words: words.default.words }),
  );
  return cache;
}

export function lengthOf(format: Format, text: string): Length {
  if (format === 'code') {
    const lines = text.split('\n').length;
    return lines <= 11 ? 'short' : lines <= 22 ? 'medium' : 'long';
  }
  const words = text.split(/\s+/).length;
  return words <= 50 ? 'short' : words <= 105 ? 'medium' : 'long';
}

const STOP = new Set('the and for with that this from into like some about style writing code text using use make give type'.split(' '));
const tokenize = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/** Best-matching preset for a free-form prompt within a format (null if nothing matches). */
export function matchPreset(lib: LibraryData, prompt: string, format: Format): Preset | null {
  const words = new Set(tokenize(prompt));
  let best: Preset | null = null;
  let bestScore = 0;
  for (const p of lib.presets) {
    if (p.format !== format) continue;
    const vocab = new Set([...p.tags.map((t) => t.toLowerCase()), ...tokenize(p.prompt), ...tokenize(p.label)]);
    let score = 0;
    for (const w of words) if (vocab.has(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Shuffled sample of a word pool (kept for callers that don't need focus letters). */
export function sampleWords(pool: string[], count: number): string {
  return buildWordTest(pool, { count }).text;
}

const tierLabel = (tier: WordTier) => (tier === 'all' ? 'all words' : `top ${tier}`);

/** A words test from a preset: the frequency list (wordList presets) or the entry's pool. */
function wordsPassage(
  lib: LibraryData,
  preset: Preset,
  e: LibraryEntry | null,
  length: Length,
  opts: WordOptions,
): { passage: Passage; missingLetters: string[] } {
  const list = preset.wordList || !e ? lib.words : e.text.split(/\s+/);
  const depth = preset.wordList ? tierSize(opts.tier, list.length) : list.length;
  const letters = parseLetters(opts.letters);
  const test = buildWordTest(list, { count: LENGTH_SPEC.words[length].target, depth, letters });
  const base = preset.wordList ? `Common English \u00b7 ${tierLabel(opts.tier)}` : e!.title;
  return {
    passage: {
      id: newId('lib'),
      title: test.letters.length ? `${base} \u00b7 focus ${test.letters.join(' ')}` : base,
      prompt: preset.prompt,
      format: 'words',
      length,
      language: null,
      text: test.text,
      source: 'library',
      preset: preset.id,
    },
    missingLetters: letters.filter((l) => !test.letters.includes(l)),
  };
}

export function entryToPassage(lib: LibraryData, e: LibraryEntry, length: Length, words = DEFAULT_WORD_OPTIONS): Passage {
  const preset = lib.presets.find((p) => p.id === e.preset)!;
  if (preset.format === 'words') return wordsPassage(lib, preset, e, length, words).passage;
  return {
    id: e.id,
    title: e.title,
    prompt: preset.prompt,
    format: preset.format,
    length: lengthOf(preset.format, e.text),
    language: e.language ?? null,
    text: e.text,
    source: 'library',
    preset: preset.id,
  };
}

/**
 * Pick a cached exercise. Uses the preset if given, else the best match for
 * the prompt, else any preset of the format (for words: the common word list).
 * Prefers the requested length and avoids `excludeId` (the passage just typed).
 * Words tests are freshly shuffled every time, using `words` (tier + focus letters).
 */
export function pickFromLibrary(
  lib: LibraryData,
  opts: { format: Format; length: Length; prompt?: string; presetId?: string; excludeId?: string; words?: WordOptions },
): { passage: Passage; matched: boolean; missingLetters?: string[] } | null {
  let preset = opts.presetId ? lib.presets.find((p) => p.id === opts.presetId) ?? null : null;
  let matched = !!preset;
  if (!preset && opts.prompt) {
    preset = matchPreset(lib, opts.prompt, opts.format);
    matched = !!preset;
  }
  const format = preset?.format ?? opts.format;
  if (format === 'words') {
    preset ??= lib.presets.find((p) => p.format === 'words' && p.wordList) ?? null;
    if (preset) {
      const entries = lib.entries.filter((e) => e.preset === preset!.id);
      const e = entries.length ? entries[Math.floor(Math.random() * entries.length)] : null;
      if (preset.wordList || e) {
        const r = wordsPassage(lib, preset, e, opts.length, opts.words ?? DEFAULT_WORD_OPTIONS);
        return { passage: r.passage, matched, missingLetters: r.missingLetters };
      }
    }
  }
  const candidates = (preset ? [preset] : lib.presets.filter((p) => p.format === opts.format)).map((p) => p.id);
  const entries = lib.entries.filter((e) => candidates.includes(e.preset));
  if (!entries.length) return null;
  const fmt = lib.presets.find((p) => p.id === entries[0].preset)!.format;
  // preference: requested length and not just typed > any length and not just typed > a repeat
  const fresh = entries.filter((e) => e.id !== opts.excludeId);
  const sameLen = fresh.filter((e) => lengthOf(fmt, e.text) === opts.length);
  const pool = sameLen.length ? sameLen : fresh.length ? fresh : entries;
  const e = pool[Math.floor(Math.random() * pool.length)];
  return { passage: entryToPassage(lib, e, opts.length, opts.words), matched };
}
