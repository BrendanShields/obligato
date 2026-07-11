import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadRegistry } from "@obligato/kernel";
import { AgentRegistryEntry, AgentsListResult } from "@obligato/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { table } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

export const repoRegistryDir = (root: string): string =>
  join(root, ".obligato", "routing", "agents");

// UX-24: repo-registered agents union with the resolved registry, repo
// entries winning by id — shared by `agents list` and `route explain`.
export const unionRegistries = (
  base: AgentRegistryEntry[],
  overlay: AgentRegistryEntry[],
): AgentRegistryEntry[] => {
  const byId = new Map(base.map((e) => [e.id, e]));
  for (const entry of overlay) byId.set(entry.id, entry);
  return [...byId.values()];
};

export const loadRepoRegistry = (root: string): AgentRegistryEntry[] => {
  const dir = repoRegistryDir(root);
  return existsSync(dir) ? loadRegistry(dir) : [];
};

export const agentsCommand = (argv: string[]): void => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  const root = typeof named.dir === "string" ? named.dir : process.cwd();

  if (sub === "register") {
    const manifestPath =
      positional[0] ?? fail("usage: obligato agents register <manifest.yaml>");
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (e) {
      return fail(`cannot read ${manifestPath}: ${(e as Error).message}`);
    }
    // UX-24: validate before any write — an invalid manifest changes nothing.
    const parsed = AgentRegistryEntry.safeParse(Bun.YAML.parse(raw));
    if (!parsed.success)
      return fail(
        `invalid agent manifest ${manifestPath}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    const dir = repoRegistryDir(root);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${parsed.data.id}.yaml`);
    writeFileSync(dest, raw);
    write(
      `registered ${parsed.data.id} (${basename(manifestPath)} -> ${dest})`,
    );
    write("verify as a candidate: obligato route explain --step build");
    return;
  }

  if (sub === "list") {
    const repoDir = repoRegistryDir(root);
    const defaultDir =
      typeof named.registry === "string"
        ? named.registry
        : join(root, "packs/routing-default/agents");
    const base = existsSync(defaultDir) ? loadRegistry(defaultDir) : [];
    const agents = unionRegistries(base, loadRepoRegistry(root));
    const result = AgentsListResult.parse({
      registry_dir: existsSync(repoDir) ? repoDir : defaultDir,
      agents,
      schema_version: 1,
    });
    if (named.json === true) {
      emitJson(result);
      return;
    }
    if (agents.length === 0) {
      write(
        "no agents registered — add one: obligato agents register <manifest.yaml>",
      );
      return;
    }
    write(
      table(
        [
          { header: "id" },
          { header: "kind" },
          { header: "endpoint" },
          { header: "cost", align: "right" },
          { header: "capabilities" },
        ],
        agents.map((a) => [
          a.id,
          a.kind,
          a.endpoint.ref,
          String(a.cost_class),
          a.capabilities
            .map((c) =>
              [c.step, c.task_type, c.lang, c.domain].filter(Boolean).join("/"),
            )
            .join(", ") || "(any)",
        ]),
      ),
    );
    return;
  }

  fail(`unknown agents subcommand: ${sub ?? "(none)"} (have: register, list)`);
};
