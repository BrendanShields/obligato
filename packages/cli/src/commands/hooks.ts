import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOKS_FILE, loadHooks } from "@obligato/agent";
import { type HookDefinition, HooksListResult } from "@obligato/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { table } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

// UX-40: the runtime's own loader (F-085) — the command and the loop read
// the same definitions; a missing file is one line, an invalid one fails.
const listCommand = (argv: string[]): void => {
  const { named } = parseArgs(argv);
  const root = process.cwd();
  const path = join(root, HOOKS_FILE);
  let hooks: HookDefinition[];
  try {
    hooks = loadHooks(root);
  } catch (e) {
    return fail(`invalid hooks file ${path}: ${(e as Error).message}`);
  }
  if (named.json === true) {
    emitJson(HooksListResult.parse({ path, hooks, schema_version: 1 }));
    return;
  }
  if (!existsSync(path)) {
    write("no hooks configured (.obligato/hooks.json)");
    return;
  }
  write(
    table(
      [
        { header: "event" },
        { header: "matcher" },
        { header: "command" },
        { header: "timeout", align: "right" },
      ],
      hooks.map((h) => [
        h.event,
        h.matcher ?? "*",
        h.command,
        `${h.timeout_ms ?? 10_000} ms`,
      ]),
    ),
  );
};

export const hooksCommand = (argv: string[]): void => {
  const sub = argv[0];
  if (sub === "list") return listCommand(argv.slice(1));
  fail(`unknown hooks subcommand: ${sub ?? "(none)"} (have: list)`);
};
