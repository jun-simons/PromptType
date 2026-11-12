// Thin client for the generation backend. Never retries: every call may spend free quota.

import type { GenerateError, GenerateRequest, GeneratedContent } from '../../shared/types.ts';

export type AiState = 'checking' | 'on' | 'off' | 'quota';

export type GenerateOutcome =
  | { ok: true; content: GeneratedContent }
  | { ok: false; error: GenerateError['error'] | 'network'; message: string };

const TIMEOUT_MS = 25_000;

/** True when the server has an API key configured. Any failure counts as "off". */
export async function fetchHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ai?: unknown };
    return body.ai === true;
  } catch {
    return false;
  }
}

export async function generatePassage(req: GenerateRequest): Promise<GenerateOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as Partial<GeneratedContent & GenerateError> | null;
    if (res.ok && body && typeof body.text === 'string' && body.text.length > 0) {
      return { ok: true, content: body as GeneratedContent };
    }
    if (body && typeof body.error === 'string') {
      return { ok: false, error: body.error, message: body.message ?? 'Generation failed.' };
    }
    return { ok: false, error: 'upstream', message: `The server answered ${res.status}.` };
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === 'AbortError';
    return {
      ok: false,
      error: 'network',
      message: timedOut ? 'Generation took too long.' : 'Could not reach the server.',
    };
  } finally {
    clearTimeout(timer);
  }
}
