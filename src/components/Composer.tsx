import { useEffect, useState } from 'react';
import { FORMATS, LENGTHS, MAX_PROMPT_CHARS } from '../../shared/types.ts';
import type { AiState } from '../lib/api.ts';
import type { LibraryData } from '../lib/library.ts';
import type { ComposerState, Settings } from '../lib/storage.ts';
import { parseLetters, WORD_TIERS } from '../lib/words.ts';

const EXAMPLES = [
  'astronomy paper written in an advanced academic style',
  'Python code with list comprehensions',
  'LaTeX with integrals, sums, products and special characters',
  'sci-fi prose with simple words',
  'inspirational quotes',
];

/** What a composer change should load: nothing, a library passage, or whatever the source says. */
export type RunMode = 'none' | 'library' | 'source';

interface Props {
  composer: ComposerState;
  lib: LibraryData | null;
  settings: Settings;
  ai: AiState;
  generating: boolean;
  /** saved AI passages for the current prompt/format/length */
  savedCount: number;
  onChange: (c: ComposerState, run: RunMode) => void;
  onReplay: () => void;
  onSettings: (fn: (s: Settings) => Settings) => void;
}

const AI_OFF_REASON = 'AI is off: the server has no GEMINI_API_KEY (or is unreachable). The library still works.';

function Seg<T extends string>({ value, options, onPick }: { value: T; options: readonly T[]; onPick: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o} className={o === value ? 'on' : ''} onClick={() => onPick(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function Opt<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly T[]; onPick: (v: T) => void }) {
  return (
    <span className="opt">
      <span className="label">{label}</span>
      {options.map((o) => (
        <button key={o} className={o === value ? 'on' : ''} onClick={() => onPick(o)}>
          {o}
        </button>
      ))}
    </span>
  );
}

export default function Composer({ composer, lib, settings, ai, generating, savedCount, onChange, onReplay, onSettings }: Props) {
  const [example, setExample] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setExample((n) => (n + 1) % EXAMPLES.length), 4000);
    return () => window.clearInterval(id);
  }, []);

  const kind = composer.format === 'code' ? 'code' : 'text';
  const presets = lib?.presets.filter((p) => p.format === composer.format) ?? [];
  const set = (patch: Partial<ComposerState>, run: RunMode) => onChange({ ...composer, ...patch }, run);
  const useAi = composer.source === 'ai' && ai !== 'off';
  // format/length changes never spend quota: with an AI prompt they wait for Enter
  const reshape: RunMode = useAi && composer.prompt.trim() ? 'none' : 'library';

  return (
    <div className="composer">
      <label className="prompt">
        <span className="glyph">✦</span>
        <input
          value={composer.prompt}
          maxLength={MAX_PROMPT_CHARS}
          placeholder={`describe what to type, e.g. “${EXAMPLES[example]}”`}
          onChange={(e) => set({ prompt: e.target.value, presetId: undefined }, 'none')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              if (generating) return;
              e.currentTarget.blur();
              set({}, 'source');
            }
          }}
        />
        {useAi && savedCount > 0 && !generating && (
          <button className="replay" title="Type a passage you already generated for this prompt (no quota used)" onClick={onReplay}>
            replay saved ({savedCount})
          </button>
        )}
        <span className="hint" aria-live="polite">
          {generating ? (
            <>
              <span className="spinner" aria-hidden />
              generating…
            </>
          ) : (
            <>
              {useAi && composer.prompt.trim() ? 'generate' : 'library'} <kbd>enter</kbd>
            </>
          )}
        </span>
      </label>

      <div className="controls">
        <div className="seg" role="group" aria-label="source">
          <button
            className={useAi ? 'on' : ''}
            disabled={ai === 'off'}
            title={ai === 'off' ? AI_OFF_REASON : ai === 'quota' ? 'The AI quota is used up for now; generation may fail and fall back to the library.' : 'Generate passages from your prompt'}
            onClick={() => set({ source: 'ai' }, 'none')}
          >
            {ai === 'off' ? 'ai off' : ai === 'checking' ? 'ai…' : 'ai'}
          </button>
          <button className={useAi ? '' : 'on'} onClick={() => set({ source: 'library' }, 'none')}>
            library
          </button>
        </div>
        <Seg value={composer.format} options={FORMATS} onPick={(format) => set({ format, presetId: undefined }, reshape)} />
        <Seg value={composer.length} options={LENGTHS} onPick={(length) => set({ length }, reshape)} />
        <div className="chips">
          {presets.map((p) => (
            <button
              key={p.id}
              className={`chip${composer.presetId === p.id ? ' on' : ''}`}
              title="Load a library passage (no quota used)"
              onClick={() => set({ presetId: p.id, prompt: p.prompt }, 'library')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="options">
        {composer.format === 'words' && (
          <>
            <Opt
              label="common"
              value={composer.words.tier}
              options={WORD_TIERS}
              onPick={(tier) => set({ words: { ...composer.words, tier } }, reshape)}
            />
            <label className="opt" title="Practise specific letters: words containing them, with words that have several of them prioritised">
              <span className="label">letters</span>
              <input
                className="letters"
                value={composer.words.letters}
                placeholder="any"
                maxLength={12}
                spellCheck={false}
                onChange={(e) => {
                  const letters = parseLetters(e.target.value).join('');
                  if (letters !== composer.words.letters) set({ words: { ...composer.words, letters } }, reshape);
                }}
              />
              {composer.words.letters && (
                <button aria-label="clear letters" onClick={() => set({ words: { ...composer.words, letters: '' } }, reshape)}>
                  ×
                </button>
              )}
            </label>
          </>
        )}
        <Opt
          label="mistakes"
          value={settings[kind].mistakes}
          options={['allow', 'fix'] as const}
          onPick={(mistakes) => onSettings((s) => ({ ...s, [kind]: { ...s[kind], mistakes } }))}
        />
        {kind === 'code' && (
          <>
            <Opt
              label="auto-indent"
              value={settings.code.autoIndent ? 'on' : 'off'}
              options={['on', 'off'] as const}
              onPick={(v) => onSettings((s) => ({ ...s, code: { ...s.code, autoIndent: v === 'on' } }))}
            />
            <Opt
              label="line numbers"
              value={settings.code.lineNumbers}
              options={['relative', 'absolute', 'off'] as const}
              onPick={(lineNumbers) => onSettings((s) => ({ ...s, code: { ...s.code, lineNumbers } }))}
            />
          </>
        )}
        <Opt label="caret" value={settings.caret} options={['line', 'block', 'underline'] as const} onPick={(caret) => onSettings((s) => ({ ...s, caret }))} />
        <Opt
          label="smooth"
          value={settings.smoothCaret ? 'on' : 'off'}
          options={['on', 'off'] as const}
          onPick={(v) => onSettings((s) => ({ ...s, smoothCaret: v === 'on' }))}
        />
        <Opt label="font" value={settings.font} options={['jetbrains', 'plex', 'fira'] as const} onPick={(font) => onSettings((s) => ({ ...s, font }))} />
      </div>
    </div>
  );
}
