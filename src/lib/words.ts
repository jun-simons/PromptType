// Word-mode test builder: shuffled samples from a frequency-ordered word list,
// optionally focused on letters you want to practise.

/** How deep into the frequency list plain word tests draw from. */
export type WordTier = '200' | '1k' | '5k' | '10k' | 'all';
export const WORD_TIERS: WordTier[] = ['200', '1k', '5k', '10k', 'all'];
const TIER_SIZE: Record<WordTier, number> = { '200': 200, '1k': 1000, '5k': 5000, '10k': 10000, all: Infinity };

/** Word-mode options from the composer. */
export interface WordOptions {
  tier: WordTier;
  /** free-form focus letters, e.g. "by" */
  letters: string;
}
export const DEFAULT_WORD_OPTIONS: WordOptions = { tier: '200', letters: '' };

export const tierSize = (tier: WordTier, listLength: number) => Math.min(TIER_SIZE[tier], listLength);

/** Unique lowercase letters from free-form input ("B, y" → ["b", "y"]). */
export function parseLetters(input: string): string[] {
  return [...new Set(input.toLowerCase().replace(/[^a-z]/g, ''))];
}

/**
 * Smallest group a focus letter (or letter combination) should have. When the tier
 * holds fewer matching words, the search continues down the frequency list, so
 * rare letters pull in the most common words that contain them, not obscure ones.
 */
export const MIN_GROUP = 40;
/** Share of focus-letter draws that go to words containing two or more of the letters. */
export const COMBO_SHARE = 0.4;

type Rng = () => number;

function shuffleInPlace<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Endless draws from a word group: shuffled, reshuffled once used up. */
class Bag {
  private queue: string[] = [];
  constructor(
    readonly words: string[],
    private rng: Rng,
  ) {}
  draw(): string {
    if (!this.queue.length) this.queue = shuffleInPlace([...this.words], this.rng);
    return this.queue.pop()!;
  }
}

/** Words containing `test`: everything within `depth`, extended down the list until `min` are found. */
function group(list: string[], depth: number, min: number, test: (w: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i >= depth && out.length >= min) break;
    if (test(list[i])) out.push(list[i]);
  }
  return out;
}

export interface WordGroups {
  /** words with two or more of the focus letters (empty for a single letter) */
  combo: string[];
  /** per focus letter, words containing it */
  byLetter: { letter: string; words: string[] }[];
}

export function focusGroups(list: string[], depth: number, letters: string[]): WordGroups {
  const byLetter = letters.map((letter) => ({ letter, words: group(list, depth, MIN_GROUP, (w) => w.includes(letter)) }));
  const combo =
    letters.length > 1
      ? group(list, depth, MIN_GROUP, (w) => {
          let n = 0;
          for (const l of letters) if (w.includes(l) && ++n >= 2) return true;
          return false;
        })
      : [];
  return { combo, byLetter: byLetter.filter((g) => g.words.length) };
}

export interface WordTestOptions {
  count: number;
  /** how many of the most frequent words plain draws use (and focus draws search first) */
  depth?: number;
  /** focus letters; empty = plain shuffle of the top `depth` words */
  letters?: string[];
  rng?: Rng;
}

export interface WordTest {
  text: string;
  /** focus letters that actually matched something in the list */
  letters: string[];
}

/**
 * Build a word test. Without letters it's a shuffle of the top `depth` words.
 * With letters, draws are split between "has two or more of the letters"
 * (COMBO_SHARE, when such words exist) and an equal share per letter, so a
 * weak pair like b + y gets words with b, words with y and words with both.
 * No word repeats back to back, and repeats within a test are avoided while
 * the groups are big enough.
 */
export function buildWordTest(list: string[], opts: WordTestOptions): WordTest {
  const rng = opts.rng ?? Math.random;
  const depth = Math.max(1, Math.min(opts.depth ?? list.length, list.length));
  const letters = opts.letters ?? [];

  let pick: () => string;
  let matched: string[] = [];
  const groups = letters.length ? focusGroups(list, depth, letters) : null;

  if (groups && groups.byLetter.length) {
    matched = groups.byLetter.map((g) => g.letter);
    const letterBags = groups.byLetter.map((g) => new Bag(g.words, rng));
    const comboBag = groups.combo.length ? new Bag(groups.combo, rng) : null;
    const comboShare = comboBag ? COMBO_SHARE : 0;
    pick = () => {
      if (comboBag && rng() < comboShare) return comboBag.draw();
      return letterBags[Math.floor(rng() * letterBags.length)].draw();
    };
  } else {
    const bag = new Bag(list.slice(0, depth), rng);
    pick = () => bag.draw();
  }

  const out: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < opts.count; i++) {
    const prev = out[out.length - 1];
    let w = pick();
    // a few retries to dodge repeats within the test, more to dodge back-to-back ones
    for (let tries = 0; tries < 8 && (used.has(w) || w === prev); tries++) w = pick();
    for (let tries = 0; tries < 24 && w === prev; tries++) w = pick();
    out.push(w);
    used.add(w);
  }
  return { text: out.join(' '), letters: matched };
}
