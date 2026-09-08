// UX-8: wizards are argument collectors. A wizard's only side effect is
// calling the shared dispatch table entry — the same function a typed
// command hits — with the argv it assembled. Cancel executes nothing.

import type { InboxItem } from "@obligato/schemas";

export type CommandFn = (argv: string[]) => void | Promise<void>;
export type DispatchTable = Record<string, CommandFn>;

export interface WizardField {
  key: string;
  label: string;
  required: boolean;
  flag?: string; // rendered as --flag <value>; otherwise positional
}

export interface WizardSpec {
  command: string;
  subcommand?: string[];
  title: string;
  description: string;
  fields: WizardField[];
}

export const WIZARDS: WizardSpec[] = [
  {
    command: "init",
    title: "init",
    description: "install obligato into this repo (J0)",
    fields: [
      {
        key: "dir",
        label: "target dir (blank = cwd)",
        required: false,
        flag: "dir",
      },
    ],
  },
  {
    command: "eval",
    subcommand: ["ablate"],
    title: "eval ablate",
    description: "measure one pack's contribution",
    fields: [
      { key: "pack", label: "pack id", required: true },
      { key: "suite", label: "suite dir", required: true, flag: "suite" },
    ],
  },
  {
    command: "route",
    subcommand: ["explain"],
    title: "route explain",
    description: "show the routing decision for a task",
    fields: [
      {
        key: "step",
        label: "pipeline step (blank = build)",
        required: false,
        flag: "step",
      },
    ],
  },
  {
    command: "loop",
    subcommand: ["status"],
    title: "loop status",
    description: "list improvement proposals",
    fields: [],
  },
  {
    command: "loop",
    subcommand: ["review"],
    title: "loop review",
    description: "review one proposal with its evidence",
    fields: [{ key: "id", label: "proposal id", required: true }],
  },
  {
    command: "pack",
    subcommand: ["lint"],
    title: "pack lint",
    description: "check a pack's declared version bump",
    fields: [
      { key: "dir", label: "pack dir", required: true },
      {
        key: "prev",
        label: "previous version dir",
        required: true,
        flag: "prev",
      },
    ],
  },
  {
    command: "ui",
    title: "ui",
    description: "serve the local read-only web UI (§8)",
    fields: [
      {
        key: "port",
        label: "port (blank = default)",
        required: false,
        flag: "port",
      },
    ],
  },
];

export const buildArgv = (
  spec: WizardSpec,
  answers: Record<string, string>,
): string[] => {
  const argv = [...(spec.subcommand ?? [])];
  for (const f of spec.fields) {
    const v = answers[f.key]?.trim();
    if (!v) {
      if (f.required) throw new Error(`missing required field: ${f.key}`);
      continue;
    }
    if (f.flag) argv.push(`--${f.flag}`, v);
    else argv.push(v);
  }
  return argv;
};

// UX-43: an inbox verb becomes a wizard spec — one parser for the launcher
// home. Leading `obligato` dropped; the first word is the COMMANDS key; the
// rest ride as subcommand words in order, except a `<placeholder>` token,
// which becomes a required field (positional, or bound to the `--flag` word
// immediately before it, which is then consumed). A placeholder is the one
// case where the verb cannot be dispatched verbatim, so the field asks for it.
export const verbSpec = (item: InboxItem): WizardSpec => {
  const words = item.verb.trim().split(/\s+/);
  if (words[0] === "obligato") words.shift();
  const command = words.shift() ?? "";
  const subcommand: string[] = [];
  const fields: WizardField[] = [];
  for (const w of words) {
    const m = /^<(.+)>$/.exec(w);
    if (m === null) {
      subcommand.push(w);
      continue;
    }
    const prev = subcommand[subcommand.length - 1];
    const flag = prev?.startsWith("--") === true ? prev.slice(2) : undefined;
    if (flag !== undefined) subcommand.pop();
    fields.push({
      key: m[1] as string,
      label: m[1] as string,
      required: true,
      ...(flag !== undefined ? { flag } : {}),
    });
  }
  return {
    command,
    subcommand,
    title: item.verb,
    description: item.summary,
    fields,
  };
};

export type LauncherState = "home" | "menu" | "fields" | "done" | "cancelled";

export interface LauncherModel {
  state: LauncherState;
  spec: WizardSpec | null;
  fieldIndex: number;
  answers: Record<string, string>;
  // UX-43: the attention items the home screen lists (empty = no home).
  inbox: InboxItem[];
}

// UX-43: `inbox` is REQUIRED so every launcher entry states what it read —
// with zero items the model starts in the menu, byte-identical to before.
export const createModel = (inbox: InboxItem[]): LauncherModel => ({
  state: inbox.length > 0 ? "home" : "menu",
  spec: null,
  fieldIndex: 0,
  answers: {},
  inbox,
});

export const selectSpec = (
  m: LauncherModel,
  spec: WizardSpec,
): LauncherModel =>
  spec.fields.length === 0
    ? { ...m, spec, state: "done" }
    : { ...m, spec, state: "fields", fieldIndex: 0, answers: {} };

// UX-43: selecting a home row is selecting its verb's spec — same completion
// path as every wizard (UX-8).
export const selectItem = (m: LauncherModel, item: InboxItem): LauncherModel =>
  selectSpec(m, verbSpec(item));

export const openMenu = (m: LauncherModel): LauncherModel => ({
  ...m,
  state: "menu",
});

export const answerField = (m: LauncherModel, value: string): LauncherModel => {
  const spec = m.spec;
  if (!spec || m.state !== "fields") return m;
  const field = spec.fields[m.fieldIndex];
  if (!field) return m;
  if (field.required && value.trim() === "") return m; // stay on the field
  const answers = { ...m.answers, [field.key]: value };
  const next = m.fieldIndex + 1;
  return next >= spec.fields.length
    ? { ...m, answers, state: "done" }
    : { ...m, answers, fieldIndex: next };
};

export const cancel = (m: LauncherModel): LauncherModel => ({
  ...m,
  state: "cancelled",
});

// The single completion path: cancelled or incomplete models dispatch nothing.
export const complete = (
  m: LauncherModel,
  table: DispatchTable,
): void | Promise<void> => {
  if (m.state !== "done" || !m.spec) return;
  const entry = table[m.spec.command];
  if (!entry) throw new Error(`no dispatch entry for ${m.spec.command}`);
  return entry(buildArgv(m.spec, m.answers));
};
