import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DB_PATH, openDb } from "@obligato/kernel";
import {
  type DoctorComponent,
  DoctorReport,
  Lockfile,
} from "@obligato/schemas";
import { parseArgs } from "../args.js";
import { kvGrid, panel } from "../components/render.js";
import { write } from "../components/sink.js";
import { SYM } from "../components/theme.js";
import { emitJson } from "../output/json.js";

// UX-19: probe each component; every failure names its fix (UX-P5). The
// probes never render credential contents — provider names and expiry only.
export const doctorCommand = async (argv: string[]): Promise<void> => {
  const { named } = parseArgs(argv);
  const root = typeof named.dir === "string" ? named.dir : process.cwd();
  const dbPath = typeof named.db === "string" ? named.db : DEFAULT_DB_PATH;
  const lockfilePath =
    typeof named.lockfile === "string"
      ? named.lockfile
      : join(root, "obligato.lock");
  const components: DoctorComponent[] = [];

  // A diagnostic must not mutate (UX-19 audit pin): a missing store fails
  // without being created; openDb runs only against an existing file.
  if (!existsSync(dbPath)) {
    components.push({
      name: "store",
      status: "fail",
      detail: `${dbPath} does not exist`,
      fix: "obligato init",
    });
  } else {
    try {
      openDb(dbPath).close();
      components.push({
        name: "store",
        status: "pass",
        detail: `${dbPath} opens; migrations current`,
        fix: null,
      });
    } catch (e) {
      components.push({
        name: "store",
        status: "fail",
        detail: `${dbPath}: ${(e as Error).message}`,
        fix: "obligato init",
      });
    }
  }

  if (!existsSync(lockfilePath)) {
    components.push({
      name: "lockfile",
      status: "fail",
      detail: `${lockfilePath} does not exist`,
      fix: "obligato init",
    });
  } else {
    try {
      Lockfile.parse(JSON.parse(readFileSync(lockfilePath, "utf8")));
      components.push({
        name: "lockfile",
        status: "pass",
        detail: `${lockfilePath} parses`,
        fix: null,
      });
    } catch (e) {
      components.push({
        name: "lockfile",
        status: "fail",
        detail: `${lockfilePath}: ${(e as Error).message}`,
        fix: "obligato init",
      });
    }
  }

  try {
    const { defaultAuthPath, loadAuth } = await import("@obligato/agent");
    const auth = loadAuth(defaultAuthPath());
    const providers = Object.keys(auth);
    if (providers.length === 0) {
      components.push({
        name: "auth",
        status: "fail",
        detail: "no credential configured for any provider",
        fix: "obligato auth login <provider>",
      });
    } else {
      const now = new Date().toISOString();
      const expired = providers.filter((p) => {
        const c = auth[p];
        return c?.type === "oauth" && c.expires < now;
      });
      if (expired.length > 0)
        components.push({
          name: "auth",
          status: "fail",
          detail: `oauth credential expired: ${expired.join(", ")}`,
          fix: `obligato auth login ${expired[0]}`,
        });
      else
        components.push({
          name: "auth",
          status: "pass",
          detail: `configured: ${providers.join(", ")}`,
          fix: null,
        });
    }
  } catch (e) {
    components.push({
      name: "auth",
      status: "fail",
      detail: `auth file unreadable: ${(e as Error).message}`,
      fix: "obligato auth login <provider>",
    });
  }

  const telemetryDir = join(root, ".obligato", "telemetry");
  if (!existsSync(telemetryDir)) {
    components.push({
      name: "telemetry",
      status: "fail",
      detail: `${telemetryDir} does not exist`,
      fix: "obligato init",
    });
  } else {
    try {
      accessSync(telemetryDir, constants.W_OK);
      components.push({
        name: "telemetry",
        status: "pass",
        detail: `${telemetryDir} writable`,
        fix: null,
      });
    } catch {
      components.push({
        name: "telemetry",
        status: "fail",
        detail: `${telemetryDir} is not writable`,
        fix: `chmod u+w ${telemetryDir}`,
      });
    }
  }

  const report = DoctorReport.parse({
    ok: components.every((c) => c.status !== "fail"),
    components,
    schema_version: 1,
  });
  if (named.json === true) emitJson(report);
  else
    write(
      panel(
        "obligato doctor",
        kvGrid(
          report.components.map((c) => [
            `${c.status === "pass" ? SYM.pass : c.status === "warn" ? SYM.warn : SYM.fail} ${c.name}`,
            c.fix === null ? c.detail : `${c.detail} — fix: ${c.fix}`,
          ]),
        ),
      ),
    );
  if (!report.ok) process.exit(1);
};
