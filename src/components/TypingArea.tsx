import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { TypingEngine } from '../lib/engine.ts';
import type { Passage, Settings } from '../lib/storage.ts';
import CodeView from './CodeView.tsx';
import TextView from './TextView.tsx';

/** True when the user is typing in some other text field (the prompt box, etc.). */
function otherFieldFocused(sink: HTMLElement | null): boolean {
  const a = document.activeElement;
  if (!a || a === sink || a === document.body) return false;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement || (a as HTMLElement).isContentEditable;
}

/**
 * Captures keystrokes in a hidden textarea and feeds them to the engine.
 * keydown handles editing keys; the input event handles characters, so dead
 * keys, compose sequences and IMEs produce the final character.
 */
export default function TypingArea({ engine, passage, settings }: { engine: TypingEngine; passage: Passage; settings: Settings }) {
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [focused, setFocused] = useState(true);

  const focus = () => sinkRef.current?.focus({ preventScroll: true });

  useEffect(() => {
    if (!otherFieldFocused(sinkRef.current)) focus();
  }, [engine]);

  // any typing key while nothing else has focus jumps back into the test
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || otherFieldFocused(sinkRef.current)) return;
      if (document.activeElement === sinkRef.current) return;
      if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Tab') e.preventDefault();
        focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return; // app shortcuts
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'Backspace':
        e.preventDefault();
        engine.backspace(e.ctrlKey || e.altKey || e.metaKey);
        return;
      case 'Enter':
        e.preventDefault();
        engine.enter();
        return;
      case 'Tab':
        e.preventDefault();
        engine.tab();
        return;
    }
  };

  const flush = (ta: HTMLTextAreaElement) => {
    const v = ta.value;
    ta.value = '';
    for (const ch of v) {
      if (ch === '\n' || ch === '\r') continue; // Enter is handled on keydown
      engine.type(ch === ' ' ? ' ' : ch);
    }
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    if (!composing.current) flush(e.currentTarget);
  };

  return (
    <div
      className={`typing${focused ? '' : ' blurred'}`}
      onMouseDown={(e) => {
        e.preventDefault();
        focus();
      }}
    >
      <textarea
        ref={sinkRef}
        className="sink"
        aria-label="Typing input"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onInput={onInput}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(e) => {
          composing.current = false;
          flush(e.currentTarget);
        }}
        onPaste={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />

      {passage.format === 'code' ? (
        <CodeView engine={engine} passage={passage} settings={settings} />
      ) : (
        <>
          <div className="passage-meta fade">
            <span className="title">{passage.title}</span>
            <span>{passage.source}</span>
          </div>
          <TextView engine={engine} settings={settings} />
        </>
      )}

      {!focused && <div className="focus-overlay">click or press any key to focus</div>}
    </div>
  );
}
