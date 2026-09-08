// SEC-8: credential patterns redacted from every tool output before it is
// recorded or observed. Order matters where patterns overlap: the specific
// anthropic prefix precedes the generic sk- key; bearer runs after the
// token kinds so a `Bearer ghp_…` reads as a github token, not a bearer.
const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  { kind: "generic_sk_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "bearer_token", re: /\bBearer [A-Za-z0-9._~+/=-]{20,}/g },
];

export interface Redaction {
  kind: string;
  count: number;
}

export const redactSecrets = (
  text: string,
): { text: string; hits: Redaction[] } => {
  const counts = new Map<string, number>();
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return `[REDACTED:${kind}]`;
    });
  }
  return {
    text: out,
    hits: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
};
