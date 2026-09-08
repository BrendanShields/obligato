import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PermissionAction, PermissionRule } from "@obligato/schemas";
import { z } from "zod";

// PERM-1: read-only tools plus `todo` (amendment 2026-07-20 — mutates only
// the session's own advisory list, AGT-19; nothing external to guard).
const DEFAULT_ALLOW = new Set(["read", "grep", "find", "ls", "todo"]);

// ponytail: JSON, not YAML — no YAML dependency for a rules list.
export const loadRules = (repoRoot: string): PermissionRule[] => {
  const path = join(repoRoot, ".obligato", "permissions.json");
  if (!existsSync(path)) return [];
  return z.array(PermissionRule).parse(JSON.parse(readFileSync(path, "utf8")));
};

// PERM-1: flat globs — * crosses "/", ? is any single char.
const globToRegExp = (glob: string): RegExp => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`);
};

const matches = (glob: string, value: string): boolean =>
  globToRegExp(glob).test(value);

// AGT-20: hook matchers reuse the PERM-1 glob (F-085).
export const matchesGlob = matches;

// PERM-6: shipped guard layer — destructive bash shapes resolve `ask` when no
// operator rule matched. Globs over the bash primary argument (PERM-1 `*`
// crosses everything, so `rm -rf /*` covers every absolute recursive rm).
export const DEFAULT_GUARDS: PermissionRule[] = [
  "rm -rf /*",
  "rm -rf ~*",
  "git push*--force*",
  "git push* -f*",
  "git reset --hard*",
  "git clean*-f*",
  "sudo *",
  "curl*|*sh*",
  "wget*|*sh*",
  "chmod -R 777*",
  "mkfs*",
  "dd if=*",
  ":(){*",
].map((arg) => ({ tool: "bash", arg, action: "ask" as const }));

const literalChars = (glob: string | undefined): number =>
  glob === undefined ? 0 : glob.replace(/[*?]/g, "").length;

// PERM-4: the winning rule rides along as provenance; null means the PERM-1
// default decided.
export interface PermissionVerdict {
  action: PermissionAction;
  rule: PermissionRule | null;
}

// PERM-1 (divergence ruling 2026-07-03): deny trumps regardless of
// specificity; among the rest, lexicographic (literalChars(tool),
// literalChars(arg)) with tool dominant; exact ties resolve ask > allow;
// list order never decides between different actions.
export const evaluate = (
  rules: PermissionRule[],
  tool: string,
  arg: string,
): PermissionVerdict => {
  const matching = rules.filter(
    (r) =>
      matches(r.tool, tool) && (r.arg === undefined || matches(r.arg, arg)),
  );
  const deny = matching.find((r) => r.action === "deny");
  if (deny) return { action: "deny", rule: deny };

  let best: PermissionRule | undefined;
  for (const r of matching) {
    if (!best) {
      best = r;
      continue;
    }
    const cmp =
      literalChars(r.tool) - literalChars(best.tool) ||
      literalChars(r.arg) - literalChars(best.arg);
    if (cmp > 0 || (cmp === 0 && r.action === "ask" && best.action === "allow"))
      best = r;
  }
  if (best) return { action: best.action, rule: best };
  return { action: DEFAULT_ALLOW.has(tool) ? "allow" : "ask", rule: null };
};

// PERM-6: guards join the operator's rules under PERM-1's own ranking — a
// guard outranks a bare `bash` allow (arg specificity), a strictly more
// specific operator glob outranks the guard, a same-glob tie resolves ask,
// deny trumps. PERM-5's granular allow stays on plain `evaluate` (no guards).
export const evaluateGuarded = (
  rules: PermissionRule[],
  tool: string,
  arg: string,
): PermissionVerdict => evaluate([...rules, ...DEFAULT_GUARDS], tool, arg);

export const decide = (
  rules: PermissionRule[],
  tool: string,
  arg: string,
): PermissionAction => evaluate(rules, tool, arg).action;
