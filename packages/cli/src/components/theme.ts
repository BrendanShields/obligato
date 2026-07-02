// UX §7 color semantics — fixed. Color is never the only signal; every
// colored state pairs with a symbol at the call site.
const codes = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
} as const;

export type Tone = Exclude<keyof typeof codes, "reset">;

export const colorEnabled = (): boolean =>
  process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

export const paint = (tone: Tone, text: string): string =>
  colorEnabled() ? `${codes[tone]}${text}${codes.reset}` : text;

export const SYM = {
  pass: "✓",
  fail: "✗",
  warn: "~",
  unknown: "?",
} as const;
