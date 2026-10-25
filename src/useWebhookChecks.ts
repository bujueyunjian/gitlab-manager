import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { inspectWebhookBatches } from "./webhookChecks";
import type { ProjectWebhookCheck, WebhookQuery } from "./types";

/** Keep inspections scoped to the current query and discard late or cancelled responses. */
export function useWebhookChecks(connectionId: string, scopeKey: string) {
  const active = useRef<{ cancelled: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [target, setTarget] = useState<WebhookQuery | null>(null);
  const [resultScope, setResultScope] = useState<string | null>(null);
  const [results, setResults] = useState<Map<number, ProjectWebhookCheck>>(new Map());
  const [error, setError] = useState<string | null>(null);

  /** Invalidate results immediately while at most the current batch completes its reads. */
  const reset = useCallback(() => {
    if (active.current) active.current.cancelled = true;
    setCancelled(active.current !== null);
    setCompleted(0);
    setTotal(0);
    setTarget(null);
    setResultScope(null);
    setResults(new Map());
    setError(null);
  }, []);

  useEffect(() => reset(), [scopeKey, reset]);
  useEffect(
    () => () => {
      if (active.current) active.current.cancelled = true;
      active.current = null;
    },
    [],
  );

  /** Stop dispatching new batches; completed outcomes remain valid within the same scope. */
  function stop() {
    if (!active.current) return;
    active.current.cancelled = true;
    setCancelled(true);
  }

  /** Inspect the applied scope with progress and no automatic retries or remote changes. */
  async function start(projectIds: number[], input: WebhookQuery) {
    if (active.current) return;
    // 1. Bind this run to the current address and project scope.
    const run = { cancelled: false };
    active.current = run;
    const ids = [...new Set(projectIds)];
    const query = { ...input, value: input.value.trim() };
    setChecking(true);
    setCancelled(false);
    setCompleted(0);
    setTotal(ids.length);
    setTarget(query);
    setResultScope(scopeKey);
    setResults(new Map());
    setError(null);
    try {
      // 2. Publish only completed batches while this run remains active.
      await inspectWebhookBatches(
        ids,
        (batch) => api.checkWebhooks(connectionId, batch, query),
        (rows) => {
          setResults((previous) => {
            const next = new Map(previous);
            rows.forEach((row) => next.set(row.projectId, row));
            return next;
          });
          setCompleted((count) => count + rows.length);
        },
        () => run.cancelled,
      );
    } catch (failure) {
      if (!run.cancelled) setError(errorMessage(failure));
    } finally {
      // 3. Release the active run without updating an unmounted page.
      if (active.current === run) {
        active.current = null;
        setChecking(false);
      }
    }
  }

  return {
    checking,
    cancelled,
    completed,
    total,
    error,
    start,
    stop,
    reset,
    target: resultScope === scopeKey ? target : null,
    results: resultScope === scopeKey ? results : new Map<number, ProjectWebhookCheck>(),
  };
}
