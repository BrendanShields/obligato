import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as schemas from "../src/index.ts";

const out = join(import.meta.dir, "..", "json-schema");
mkdirSync(out, { recursive: true });

const exported: string[] = [];
for (const [name, value] of Object.entries(schemas)) {
  if (!(value instanceof z.ZodType)) continue;
  const js = z.toJSONSchema(value, { io: "output" });
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(js, null, 2)}\n`);
  exported.push(name);
}
console.log(`exported ${exported.length} JSON Schemas: ${exported.join(", ")}`);
