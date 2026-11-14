// Turns arbitrary text (LLM output, pasted custom text) into something that can
// be typed on a standard US keyboard, while preserving structure for code.

import type { Format } from './types.ts';

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[–—―−]/g, '-'],
  [/…/g, '...'],
  [/[     ]/g, ' '],
  [/[​‌‍﻿]/g, ''],
  [/×/g, 'x'],
  [/•/g, '-'],
  [/\r\n?/g, '\n'],
];

/** Map typographic characters to ASCII and drop anything untypeable. */
export function toTypeable(input: string): string {
  let s = input;
  for (const [re, rep] of REPLACEMENTS) s = s.replace(re, rep);
  // strip accents: é -> e
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // keep printable ASCII, newlines and tabs only
  return s.replace(/[^\x20-\x7E\n\t]/g, '');
}

function stripFences(s: string): string {
  const m = s.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : s;
}

export function normalizeProse(input: string): string {
  return toTypeable(input).replace(/\s+/g, ' ').trim();
}

export function normalizeWords(words: string[] | string): string {
  const list = Array.isArray(words) ? words : words.split(/\s+/);
  return list
    .map((w) => toTypeable(w).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

export function normalizeCode(input: string, tabSize = 4): string {
  let s = toTypeable(stripFences(input.replace(/\r\n?/g, '\n')));
  s = s.replace(/\t/g, ' '.repeat(tabSize));
  let lines = s.split('\n').map((l) => l.replace(/\s+$/, ''));
  // trim leading/trailing blank lines
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // collapse runs of blank lines to a single blank line
  lines = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));
  // dedent common indentation
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  if (common) lines = lines.map((l) => l.slice(common));
  return lines.join('\n');
}

export function normalizeFor(format: Format, text: string): string {
  if (format === 'code') return normalizeCode(text);
  if (format === 'words') return normalizeWords(text);
  return normalizeProse(text);
}

/** Cut text down to maxChars on a sensible boundary (sentence/word/line). */
export function clampLength(format: Format, text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (format === 'code') {
    const lines = text.split('\n');
    const out: string[] = [];
    let n = 0;
    for (const l of lines) {
      if (n + l.length + 1 > maxChars) break;
      out.push(l);
      n += l.length + 1;
    }
    return normalizeCode(out.join('\n'));
  }
  const cut = text.slice(0, maxChars);
  if (format === 'prose') {
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (end > maxChars * 0.6) return cut.slice(0, end + 1);
  }
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).trim();
}

/** Guess an indentation unit (2 or 4) from leading whitespace. */
export function detectIndentUnit(code: string): number {
  const indents = code
    .split('\n')
    .map((l) => l.match(/^ */)![0].length)
    .filter((n) => n > 0);
  if (!indents.length) return 4;
  return indents.every((n) => n % 4 === 0) ? 4 : 2;
}
