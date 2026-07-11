// UX-8: wizards are argument collectors. A wizard's only side effect is
// calling the shared dispatch table entry — the same function a typed
// command hits — with the argv it assembled. Cancel executes nothing.

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

export type LauncherState = "menu" | "fields" | "done" | "cancelled";

export interface LauncherModel {
  state: LauncherState;
  spec: WizardSpec | null;
  fieldIndex: number;
  answers: Record<string, string>;
}

export const createModel = (): LauncherModel => ({
  state: "menu",
  spec: null,
  fieldIndex: 0,
  answers: {},
});

export const selectSpec = (
  m: LauncherModel,
  spec: WizardSpec,
): LauncherModel =>
  spec.fields.length === 0
    ? { ...m, spec, state: "done" }
    : { ...m, spec, state: "fields", fieldIndex: 0, answers: {} };

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
