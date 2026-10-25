import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReadProgress } from "./types";

/** Local display metadata accompanies backend counts and never enters task storage. */
export interface ReadProgressState extends ReadProgress {
  runId: string;
  startedAt: number;
  updatedAt: number;
}

/** Share in-flight progress across page remounts while isolating each connection and selection. */
export function useReadProgress(scope: string) {
  const client = useQueryClient();
  const key = ["read-progress", scope];
  const state = useQuery<ReadProgressState>({ queryKey: key, queryFn: skipToken });

  /** Keep the newest invocation for this scope; propagate errors and ignore events after completion. */
  async function track<T>(
    total: number,
    work: (report: (progress: ReadProgress) => void) => Promise<T>,
  ): Promise<T> {
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    let finished = false;
    client.setQueryData<ReadProgressState>(key, {
      runId,
      total,
      completed: 0,
      failed: 0,
      startedAt,
      updatedAt: startedAt,
    });
    try {
      return await work((progress) => {
        if (finished) return;
        client.setQueryData<ReadProgressState>(key, (previous) =>
          previous?.runId === runId
            ? { ...progress, runId, startedAt, updatedAt: Date.now() }
            : previous,
        );
      });
    } finally {
      finished = true;
    }
  }
  return { track, state: state.data ?? null };
}
