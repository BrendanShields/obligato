import { useEffect, useState } from "react";

export interface Poll<T> {
  data: T | null;
  error: string | null;
  // UX-53: a failed refresh keeps the last good payload and flags it.
  stale: boolean;
  updated_at: string | null;
}

export type FetchResult<T> =
  | { ok: true; data: T; at: string }
  | { ok: false; error: string };

export function initialPoll<T>(): Poll<T> {
  return { data: null, error: null, stale: false, updated_at: null };
}

// UX-53: the one pure transition — a failure never resets data to null.
export function refreshState<T>(
  prev: Poll<T>,
  result: FetchResult<T>,
): Poll<T> {
  if (result.ok)
    return {
      data: result.data,
      error: null,
      stale: false,
      updated_at: result.at,
    };
  if (prev.data === null)
    return { data: null, error: result.error, stale: false, updated_at: null };
  return { ...prev, error: result.error, stale: true };
}

const POLL_MS = 5000;

export function usePoll<T>(path: string): Poll<T> {
  const [state, setState] = useState<Poll<T>>(initialPoll<T>());
  useEffect(() => {
    let live = true;
    const tick = async () => {
      let result: FetchResult<T>;
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`${res.status}`);
        result = {
          ok: true,
          data: (await res.json()) as T,
          at: new Date().toISOString(),
        };
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }
      if (live) setState((s) => refreshState(s, result));
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [path]);
  return state;
}

export const fmtMicroUsd = (v: number): string => `$${(v / 1e6).toFixed(2)}`;
export const fmtTokens = (v: number): string =>
  v >= 1000 ? `${(v / 1000).toFixed(1)}k tok` : `${v} tok`;
