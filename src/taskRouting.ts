import type { Page, Project, TaskKind } from "./types";
import type { Connection, OperationRunner } from "./types";
import type { QueryClient } from "@tanstack/react-query";

/** Connection intent is explicit and consumed only by the matching new-connection dialog. */
export interface TaskRoute {
  page: Page;
  connectionId: string | null;
  intent: { task: TaskKind; id: number } | null;
  serial: number;
  scopes: Record<TaskKind, Project[]>;
}

/** Route transitions preserve task-local scopes and reject cancelled connection continuations. */
export type TaskRouteAction =
  | { type: "task"; task: TaskKind }
  | { type: "navigate"; page: Page }
  | { type: "connection"; id: string | null }
  | { type: "saved"; id: string; intentId: number | null }
  | { type: "cancel-connection" }
  | {
      type: "scope";
      task: TaskKind;
      update: (previous: Map<number, Project>) => Map<number, Project>;
    };

/** Start with task selection, regardless of whether a saved connection exists. */
export function initialTaskRoute(): TaskRoute {
  return {
    page: "home",
    connectionId: null,
    intent: null,
    serial: 0,
    scopes: { hooks: [], permissions: [] },
  };
}

/** Resolve one user transition without implicitly carrying another task's selection or intent. */
export function taskRoute(state: TaskRoute, action: TaskRouteAction): TaskRoute {
  switch (action.type) {
    case "task":
      return {
        ...state,
        page: action.task,
        serial: state.serial + 1,
        intent: state.connectionId ? null : { task: action.task, id: state.serial + 1 },
      };
    case "navigate":
      return { ...state, page: action.page, intent: null };
    case "cancel-connection":
      return { ...state, page: state.intent ? "home" : state.page, intent: null };
    case "connection":
      return {
        ...state,
        connectionId: action.id,
        intent: null,
        scopes: { hooks: [], permissions: [] },
      };
    case "saved":
      if (action.intentId !== null && state.intent?.id !== action.intentId) return state;
      return {
        ...state,
        connectionId: action.id,
        page: action.intentId !== null && state.intent ? state.intent.task : "connections",
        intent: null,
        scopes: { hooks: [], permissions: [] },
      };
    case "scope":
      return {
        ...state,
        scopes: {
          ...state.scopes,
          [action.task]: [
            ...action
              .update(new Map(state.scopes[action.task].map((project) => [project.id, project])))
              .values(),
          ],
        },
      };
  }
}

/** A late scan cannot publish a plan or result into a different connection session. */
export async function inTaskSession<T>(
  session: string,
  current: () => string,
  work: () => Promise<T>,
): Promise<T> {
  const value = await work();
  if (session !== current()) throw new Error("连接已变化，本次响应已失效，请在当前任务中重新检查");
  return value;
}

/** Insert the actual save response before selection; cancelled older list reads cannot remove it. */
export function cacheSavedConnection(client: QueryClient, connection: Connection): void {
  void client.cancelQueries({ queryKey: ["connections"] });
  client.setQueryData<Connection[]>(["connections"], (previous) => [
    ...(previous ?? []).filter((value) => value.id !== connection.id),
    connection,
  ]);
}

/** One synchronous owner guards navigation across real scans and submissions. */
export function createTaskOperation(
  current: () => string,
  pending: (busy: boolean) => void,
): { readonly busy: boolean; run: OperationRunner } {
  let owner: number | null = null;
  let serial = 0;
  return {
    get busy() {
      return owner !== null;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (owner !== null) throw new Error("当前扫描或提交尚未完成，请稍候");
      const token = ++serial;
      owner = token;
      pending(true);
      try {
        return await inTaskSession(current(), current, work);
      } finally {
        if (owner === token) {
          owner = null;
          pending(false);
        }
      }
    },
  };
}
