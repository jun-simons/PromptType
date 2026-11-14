// Types and limits shared by the frontend and the generation backend.

export type Format = 'prose' | 'words' | 'code';
export type Length = 'short' | 'medium' | 'long';

export const FORMATS: Format[] = ['prose', 'words', 'code'];
export const LENGTHS: Length[] = ['short', 'medium', 'long'];

/** Max characters accepted for the user's topic prompt. */
export const MAX_PROMPT_CHARS = 240;

/**
 * Target sizes per format/length. Prose and words are measured in words,
 * code in lines. `maxChars` is a hard cap applied after generation, and
 * `maxTokens` caps the model's output so a single call stays cheap.
 */
export const LENGTH_SPEC: Record<Format, Record<Length, { target: number; maxChars: number; maxTokens: number }>> = {
  prose: {
    short: { target: 35, maxChars: 320, maxTokens: 300 },
    medium: { target: 70, maxChars: 620, maxTokens: 500 },
    long: { target: 140, maxChars: 1200, maxTokens: 900 },
  },
  words: {
    short: { target: 25, maxChars: 260, maxTokens: 300 },
    medium: { target: 50, maxChars: 520, maxTokens: 500 },
    long: { target: 100, maxChars: 1000, maxTokens: 800 },
  },
  code: {
    short: { target: 8, maxChars: 480, maxTokens: 400 },
    medium: { target: 16, maxChars: 900, maxTokens: 700 },
    long: { target: 30, maxChars: 1600, maxTokens: 1100 },
  },
};

export const MAX_CODE_LINE = 80;

export interface GenerateRequest {
  prompt: string;
  format: Format;
  length: Length;
}

/** Structured content returned by POST /api/generate. */
export interface GeneratedContent {
  title: string;
  format: Format;
  length: Length;
  /** highlight.js language id for code, otherwise null */
  language: string | null;
  /** normalized, ready-to-type text (code keeps newlines + indentation) */
  text: string;
}

export interface GenerateError {
  error: 'bad_request' | 'quota' | 'disabled' | 'upstream' | 'limit';
  message: string;
}
