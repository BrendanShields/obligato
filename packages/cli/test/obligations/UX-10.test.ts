import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PATHS, createUiServer } from "../../src/ui/server.ts";

const dir = mkdtempSync(join(tmpdir(), "obligato-ux10-"));
const server = createUiServer({ dbPath: join(dir, "k.db"), port: 0 });
afterAll(() => server.stop(true));

describe("UX-10: the obligato ui server binds loopback only and responds 405 to every non-GET", () => {
  it("reports a loopback bind address", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  it("POST/PUT/PATCH/DELETE return 405 on every registered route", async () => {
    for (const path of API_PATHS) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
        });
        expect(`${path} ${method} ${res.status}`).toBe(`${path} ${method} 405`);
      }
    }
  });

  it("non-GET is refused on non-API paths too — the server is read-only structurally", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });
});
