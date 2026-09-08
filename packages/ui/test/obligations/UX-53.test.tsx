import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initialPoll, refreshState } from "../../src/api";
import { Pending, StaleBadge } from "../../src/components";

describe("UX-53: a failed refresh keeps the last good payload and shows a stale badge; loading is never null", () => {
  it("reducer: success → fresh; failure with data → kept + stale; failure without → nulls; success clears stale", () => {
    const start = initialPoll<{ n: number }>();
    const good = refreshState(start, {
      ok: true,
      data: { n: 1 },
      at: "2026-09-08T10:00:00.000Z",
    });
    expect(good).toEqual({
      data: { n: 1 },
      error: null,
      stale: false,
      updated_at: "2026-09-08T10:00:00.000Z",
    });
    const failed = refreshState(good, { ok: false, error: "503" });
    // revert-check: reset data on failure → these two reads come back null.
    expect(failed.data).toEqual({ n: 1 });
    expect(failed.updated_at).toBe("2026-09-08T10:00:00.000Z");
    expect(failed.stale).toBe(true);
    expect(failed.error).toBe("503");
    const failedFirst = refreshState(start, {
      ok: false,
      error: "ECONNREFUSED",
    });
    expect(failedFirst).toEqual({
      data: null,
      error: "ECONNREFUSED",
      stale: false,
      updated_at: null,
    });
    const recovered = refreshState(failed, {
      ok: true,
      data: { n: 2 },
      at: "2026-09-08T10:00:05.000Z",
    });
    expect(recovered.stale).toBe(false);
    expect(recovered.error).toBeNull();
    expect(recovered.data).toEqual({ n: 2 });
  });

  it("badge: stale renders the ~ symbol, timestamp and error; fresh renders nothing", () => {
    const html = renderToStaticMarkup(
      <StaleBadge
        poll={{
          stale: true,
          updated_at: "2026-09-08T10:00:00.000Z",
          error: "503",
        }}
      />,
    );
    expect(html).toContain("~ stale");
    expect(html).toContain("2026-09-08T10:00:00.000Z");
    expect(html).toContain("503");
    // revert-check: render the badge unconditionally → this is non-empty.
    expect(
      renderToStaticMarkup(
        <StaleBadge poll={{ stale: false, updated_at: null, error: null }} />,
      ),
    ).toBe("");
  });

  it("pending: names the polled route and the error when given one", () => {
    const html = renderToStaticMarkup(
      <Pending path="/api/telemetry" error={null} />,
    );
    expect(html).toContain("GET /api/telemetry");
    expect(html).toContain("loading");
    const failed = renderToStaticMarkup(
      <Pending path="/api/telemetry" error="ECONNREFUSED" />,
    );
    expect(failed).toContain("ECONNREFUSED");
  });
});
