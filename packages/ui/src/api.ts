import { useEffect, useState } from "react";

export interface Poll<T> {
  data: T | null;
  error: string | null;
}

const POLL_MS = 5000;

export function usePoll<T>(path: string): Poll<T> {
  const [state, setState] = useState<Poll<T>>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as T;
        if (live) setState({ data, error: null });
      } catch (e) {
        if (live) setState((s) => ({ ...s, error: (e as Error).message }));
      }
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
