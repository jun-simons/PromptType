// localStorage persistence: settings, results history, saved passages.

import type { Format, Length } from '../../shared/types.ts';
import type { MistakeMode } from './engine.ts';
import { DEFAULT_WORD_OPTIONS, type WordOptions } from './words.ts';
import type { TestResult } from './stats.ts';

export type PassageSource = 'library' | 'ai' | 'custom' | 'drill';

export interface Passage {
  id: string;
  title: string;
  prompt: string;
  format: Format;
  length: Length;
  language: string | null;
  text: string;
  source: PassageSource;
  createdAt?: number;
  preset?: string;
  /** starred passages are never evicted from local storage */
  starred?: boolean;
}

export type ThemeName = 'dusk' | 'gruvbox' | 'rose' | 'nord' | 'paper';
export type FontName = 'jetbrains' | 'plex' | 'fira';
export type CaretStyle = 'line' | 'block' | 'underline';

export interface Settings {
  theme: ThemeName;
  font: FontName;
  fontSize: number;
  caret: CaretStyle;
  smoothCaret: boolean;
  liveStats: boolean;
  useAI: boolean;
  text: { mistakes: MistakeMode };
  code: {
    mistakes: MistakeMode;
    autoIndent: boolean;
    syntax: boolean;
    lineNumbers: 'off' | 'absolute' | 'relative';
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dusk',
  font: 'jetbrains',
  fontSize: 24,
  caret: 'line',
  smoothCaret: true,
  liveStats: true,
  useAI: true,
  text: { mistakes: 'allow' },
  code: { mistakes: 'allow', autoIndent: true, syntax: true, lineNumbers: 'relative' },
};

const K = {
  settings: 'promptype.settings.v1',
  results: 'promptype.results.v1',
  passages: 'promptype.passages.v1',
  composer: 'promptype.composer.v1',
};

const MAX_RESULTS = 400;
const MAX_PASSAGES = 200;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>(K.settings, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    text: { ...DEFAULT_SETTINGS.text, ...s.text },
    code: { ...DEFAULT_SETTINGS.code, ...s.code },
  };
}
export const saveSettings = (s: Settings) => write(K.settings, s);

export const loadResults = () => read<TestResult[]>(K.results, []);
export function addResult(r: TestResult): TestResult[] {
  const all = [r, ...loadResults()].slice(0, MAX_RESULTS);
  write(K.results, all);
  return all;
}
export const clearResults = () => write(K.results, []);

export const loadPassages = () => read<Passage[]>(K.passages, []);

/** Save newest-first; beyond MAX_PASSAGES unstarred, the oldest unstarred ones are dropped. */
export function savePassage(p: Passage): Passage[] {
  let unstarred = 0;
  const all = [p, ...loadPassages().filter((x) => x.id !== p.id)].filter((x) => x.starred || ++unstarred <= MAX_PASSAGES);
  write(K.passages, all);
  return all;
}

const promptKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Saved passages generated for the same prompt, format and length (newest first). */
export function savedMatches(all: Passage[], c: { prompt: string; format: Format; length: Length }): Passage[] {
  const key = promptKey(c.prompt);
  if (!key) return [];
  return all.filter((p) => p.source === 'ai' && p.format === c.format && p.length === c.length && promptKey(p.prompt) === key);
}
export function deletePassage(id: string): Passage[] {
  const all = loadPassages().filter((x) => x.id !== id);
  write(K.passages, all);
  return all;
}

export interface ComposerState {
  prompt: string;
  format: Format;
  length: Length;
  source: 'ai' | 'library';
  /** library preset picked from the topic chips (cleared when the prompt is edited) */
  presetId?: string;
  /** words format: list depth and focus letters */
  words: WordOptions;
}
export function loadComposer(): ComposerState {
  const c = read<Partial<ComposerState>>(K.composer, {});
  return { prompt: '', format: 'prose', length: 'medium', source: 'ai', ...c, words: { ...DEFAULT_WORD_OPTIONS, ...c.words } };
}
export const saveComposer = (c: ComposerState) => write(K.composer, c);

export function exportAll(): string {
  return JSON.stringify({ results: loadResults(), passages: loadPassages(), settings: loadSettings() }, null, 2);
}

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
