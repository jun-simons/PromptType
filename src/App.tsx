import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { detectIndentUnit } from '../shared/normalize.ts';
import Composer, { type RunMode } from './components/Composer.tsx';
import Results from './components/Results.tsx';
import StatusLine from './components/StatusLine.tsx';
import TypingArea from './components/TypingArea.tsx';
import { fetchHealth, generatePassage, type AiState } from './lib/api.ts';
import { TypingEngine } from './lib/engine.ts';
import { loadLibrary, pickFromLibrary, type LibraryData } from './lib/library.ts';
import { computeResult, type TestResult } from './lib/stats.ts';
import {
  addResult,
  loadComposer,
  loadPassages,
  loadSettings,
  newId,
  saveComposer,
  savedMatches,
  savePassage,
  saveSettings,
  type ComposerState,
  type FontName,
  type Passage,
  type Settings,
  type ThemeName,
} from './lib/storage.ts';

const FONT_STACK: Record<FontName, string> = {
  jetbrains: "'JetBrains Mono'",
  plex: "'IBM Plex Mono'",
  fira: "'Fira Code'",
};

const THEMES: { id: ThemeName; bg: string; fg: string }[] = [
  { id: 'dusk', bg: '#1a1b26', fg: '#7aa2f7' },
  { id: 'gruvbox', bg: '#282828', fg: '#fabd2f' },
  { id: 'rose', bg: '#191724', fg: '#ebbcba' },
  { id: 'nord', bg: '#2e3440', fg: '#88c0d0' },
  { id: 'paper', bg: '#f4f1ea', fg: '#a8561a' },
];

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [composer, setComposer] = useState<ComposerState>(loadComposer);
  const [lib, setLib] = useState<LibraryData | null>(null);
  const [passage, setPassage] = useState<Passage | null>(null);
  const [runId, setRunId] = useState(0);
  const [result, setResult] = useState<TestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ai, setAi] = useState<AiState>('checking');
  const [generating, setGenerating] = useState(false);
  /** request shown in the stage while generating; cleared if another passage is shown meanwhile */
  const [pendingGen, setPendingGen] = useState<ComposerState | null>(null);
  const [saved, setSaved] = useState<Passage[]>(loadPassages);

  const passageRef = useRef(passage);
  passageRef.current = passage;
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const aiRef = useRef(ai);
  aiRef.current = ai;
  /** bumps whenever a passage is shown, so a slow generation can tell it was superseded */
  const loadSeq = useRef(0);
  const inFlight = useRef(false);

  // ---- settings → document ------------------------------------------------
  useEffect(() => {
    saveSettings(settings);
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty('--font-mono', `${FONT_STACK[settings.font]}, ui-monospace, SFMono-Regular, Menlo, monospace`);
    root.style.setProperty('--type-size', `${settings.fontSize}px`);
  }, [settings]);

  useEffect(() => saveComposer(composer), [composer]);

  // ---- passages -------------------------------------------------------------
  useEffect(() => {
    loadLibrary()
      .then(setLib)
      .catch(() => setNotice('Could not load the exercise library.'));
    const ctrl = new AbortController();
    fetchHealth(ctrl.signal).then((on) => {
      if (!ctrl.signal.aborted) setAi(on ? 'on' : 'off');
    });
    return () => ctrl.abort();
  }, []);

  const show = useCallback((p: Passage, msg: string | null) => {
    loadSeq.current++;
    setPendingGen(null);
    setNotice(msg);
    setPassage(p);
    setResult(null);
    setRunId((r) => r + 1);
  }, []);

  /** Library passage for the composer state; `why` prefixes the notice (used for AI fallbacks). */
  const fromLibrary = useCallback(
    (c: ComposerState, why?: string) => {
      if (!lib) return;
      const prompt = c.prompt.trim();
      const picked = pickFromLibrary(lib, {
        format: c.format,
        length: c.length,
        prompt: prompt || undefined,
        presetId: c.presetId,
        excludeId: passageRef.current?.id,
        words: c.words,
      });
      if (!picked) {
        setNotice(`${why ? `${why} ` : ''}There are no ${c.format} passages in the library yet.`);
        return;
      }
      let msg: string | null = null;
      if (why) msg = `${why} Showing a library passage ${picked.matched ? 'on a similar topic' : `(random ${c.format})`} instead.`;
      else if (prompt && !picked.matched)
        msg = `Nothing in the library matched “${prompt}”, so here's a random ${c.format} passage.${
          aiRef.current !== 'off' ? ' Switch the source to ai to generate one.' : ''
        }`;
      if (picked.missingLetters?.length) {
        const missing = picked.missingLetters.join(', ');
        msg = `${msg ? `${msg} ` : ''}No words in this list contain ${missing}, so ${picked.missingLetters.length > 1 ? 'they were' : 'it was'} skipped.`;
      }
      show(picked.passage, msg);
    },
    [lib, show],
  );

  const generate = useCallback(
    async (c: ComposerState) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const prompt = c.prompt.trim();
      setGenerating(true);
      setPendingGen({ ...c, prompt });
      setNotice(null);
      const seq = loadSeq.current;
      const res = await generatePassage({ prompt, format: c.format, length: c.length });
      inFlight.current = false;
      setGenerating(false);
      setPendingGen(null);
      // the user moved on (picked a preset, replayed, …) while we waited: keep the result, don't switch
      const superseded = loadSeq.current !== seq;

      if (res.ok) {
        const { content } = res;
        const p: Passage = {
          id: newId('ai'),
          title: content.title,
          prompt,
          format: content.format,
          length: content.length,
          language: content.language,
          text: content.text,
          source: 'ai',
          createdAt: Date.now(),
        };
        setSaved(savePassage(p));
        if (aiRef.current === 'quota') setAi('on');
        if (!superseded) show(p, null);
        return;
      }
      if (res.error === 'quota') setAi('quota');
      if (res.error === 'disabled') setAi('off');
      if (superseded) return;
      // server messages end in "Please try again." / "The library still works."; the notice says what happens instead
      const reason = res.message.replace(/\s*(Please try again|The (cached )?library still works)\.?$/i, '').trim();
      const why = res.error === 'quota' ? 'AI quota reached.' : res.error === 'network' ? `AI unavailable: ${reason}` : reason;
      fromLibrary(c, why);
    },
    [fromLibrary, show],
  );

  const next = useCallback(
    (c: ComposerState, mode: RunMode = 'source') => {
      if (mode === 'none') return;
      const useAi = mode === 'source' && c.source === 'ai' && aiRef.current !== 'off' && !!c.prompt.trim();
      if (useAi) void generate(c);
      else fromLibrary(c);
    },
    [fromLibrary, generate],
  );

  const matches = useMemo(() => savedMatches(saved, composer), [saved, composer]);

  const replay = useCallback(() => {
    const pool = matches.filter((p) => p.id !== passageRef.current?.id);
    const pick = (pool.length ? pool : matches)[Math.floor(Math.random() * (pool.length || matches.length))];
    if (pick) show(pick, null);
  }, [matches, show]);

  useEffect(() => {
    // first passage comes from the library: never spend quota just because the page loaded
    if (lib && !passageRef.current) next(composerRef.current, 'library');
  }, [lib, next]);

  const restart = useCallback(() => {
    setResult(null);
    setRunId((r) => r + 1);
  }, []);

  // ---- engine ---------------------------------------------------------------
  const kind = passage?.format === 'code' ? 'code' : 'text';
  const mistakes = settings[kind].mistakes;
  const autoIndent = kind === 'code' && settings.code.autoIndent;

  const engine = useMemo(
    () =>
      passage
        ? new TypingEngine(passage.text, { kind, mistakes, autoIndent, indentUnit: detectIndentUnit(passage.text) })
        : null,
    // runId: a restart builds a fresh engine for the same passage
    [passage, runId, kind, mistakes, autoIndent],
  );

  // finished → compute and store the result
  useEffect(() => {
    if (!engine || !passage) return;
    let done = false;
    const check = () => {
      if (done || !engine.finished) return;
      done = true;
      const r = computeResult(engine, {
        passageId: passage.id,
        title: passage.title,
        prompt: passage.prompt,
        format: passage.format,
        language: passage.language,
        source: passage.source,
      });
      addResult(r);
      setResult(r);
    };
    return engine.subscribe(check);
  }, [engine, passage]);

  // focus mode: hide chrome while a test is running, bring it back on mouse move
  useEffect(() => {
    if (!engine) return;
    const update = () => document.body.classList.toggle('typing', engine.started && !engine.finished);
    const unsub = engine.subscribe(update);
    const reveal = () => document.body.classList.remove('typing');
    window.addEventListener('mousemove', reveal);
    update();
    return () => {
      unsub();
      window.removeEventListener('mousemove', reveal);
      document.body.classList.remove('typing');
    };
  }, [engine]);

  // ---- global shortcuts and focus ---------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        restart();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        next(composerRef.current);
      }
    };
    // buttons never take focus away from the typing input
    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('button')) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [next, restart]);

  const onComposer = (c: ComposerState, run: RunMode) => {
    setComposer(c);
    next(c, run);
  };

  return (
    <div className="app">
      <header className="topbar fade">
        <div className="wordmark" aria-label="promptype">
          prompt<span className="accent">type</span>
          <span className="cursor" />
        </div>
        <div className="themes">
          {THEMES.map((t) => (
            <button
              key={t.id}
              title={t.id}
              aria-label={`${t.id} theme`}
              className={`swatch${settings.theme === t.id ? ' on' : ''}`}
              style={{ '--sw-bg': t.bg, '--sw-fg': t.fg } as CSSProperties}
              onClick={() => setSettings((s) => ({ ...s, theme: t.id }))}
            />
          ))}
        </div>
      </header>

      <section className="fade">
        <Composer
          composer={composer}
          lib={lib}
          settings={settings}
          ai={ai}
          generating={generating}
          savedCount={matches.length}
          onChange={onComposer}
          onReplay={replay}
          onSettings={setSettings}
        />
      </section>

      <main className="stage">
        {notice && <div className="notice fade">{notice}</div>}
        {pendingGen ? (
          <div className="generating" role="status">
            <span className="spinner" aria-hidden />
            <span>
              writing a {pendingGen.length}{' '}
              {pendingGen.format === 'words' ? 'word list' : pendingGen.format === 'code' ? 'code snippet' : 'passage'} for “
              {pendingGen.prompt}”…
            </span>
          </div>
        ) : result ? (
          <Results result={result} onNext={() => next(composerRef.current)} onRetry={restart} />
        ) : engine && passage ? (
          <TypingArea key={engine.id} engine={engine} passage={passage} settings={settings} />
        ) : (
          <div className="loading">loading library…</div>
        )}
      </main>

      <footer>
        {engine && passage && <StatusLine engine={engine} passage={passage} settings={settings} result={result} ai={ai} />}
        <div className="hints fade">
          <span>
            <kbd>esc</kbd> restart
          </span>
          <span>
            <kbd>ctrl</kbd>/<kbd>⌘</kbd> + <kbd>enter</kbd> next
          </span>
        </div>
      </footer>
    </div>
  );
}
