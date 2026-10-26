import { expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  cacheSavedConnection,
  createTaskOperation,
  initialTaskRoute,
  taskRoute,
} from "./taskRouting";
import type { Connection, Project } from "./types";

const project: Project = {
  id: 1,
  name: "Example",
  path: "example",
  path_with_namespace: "demo/example",
  web_url: "https://gitlab.example.com/demo/example",
  description: null,
  visibility: "private",
  archived: false,
  permissions: null,
};
const connection: Connection = {
  id: "new-connection",
  name: "Example GitLab",
  baseUrl: "https://gitlab.example.com",
  revision: "identity-1",
  user: { id: 1, name: "Example", username: "example-user", is_admin: false },
  scopes: ["api"],
  expiresAt: null,
  version: "19.0.0",
  checkedAt: "2026-10-26T00:00:00Z",
};

it("starts at equal task choice and continues only the explicitly requested new-connection task", () => {
  let state = initialTaskRoute();
  expect(state.page).toBe("home");
  state = taskRoute(state, { type: "task", task: "permissions" });
  const intentId = state.intent!.id;
  state = taskRoute(state, { type: "saved", id: "example", intentId });
  expect(state.page).toBe("permissions");
  expect(state.connectionId).toBe("example");
  expect(state.intent).toBeNull();
});
it("cancellation and manual editing never resurrect old task intent or a late connection callback", () => {
  let state = taskRoute(initialTaskRoute(), { type: "task", task: "hooks" });
  const intentId = state.intent!.id;
  state = taskRoute(state, { type: "cancel-connection" });
  expect(state.page).toBe("home");
  expect(taskRoute(state, { type: "saved", id: "late", intentId })).toBe(state);
  state = taskRoute(state, { type: "navigate", page: "connections" });
  state = taskRoute(state, { type: "saved", id: "edited", intentId: null });
  expect(state.page).toBe("connections");
});
it("keeps task scopes across navigation and clears both scopes on connection changes", () => {
  let state = taskRoute(initialTaskRoute(), { type: "connection", id: "first" });
  state = taskRoute(state, { type: "scope", task: "hooks", update: () => new Map([[1, project]]) });
  state = taskRoute(state, { type: "task", task: "permissions" });
  expect(state.scopes.permissions).toEqual([]);
  expect(state.scopes.hooks).toEqual([project]);
  state = taskRoute(state, {
    type: "scope",
    task: "permissions",
    update: () => new Map([[2, { ...project, id: 2 }]]),
  });
  state = taskRoute(state, { type: "navigate", page: "home" });
  state = taskRoute(state, { type: "task", task: "hooks" });
  expect(state.scopes.hooks.map((item) => item.id)).toEqual([1]);
  state = taskRoute(state, { type: "connection", id: "second" });
  expect(state.scopes).toEqual({ hooks: [], permissions: [] });
});
it("publishes the save response before selection and cancels an older list that would remove it", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let resolve!: (value: Connection[]) => void;
  const old = client
    .fetchQuery({
      queryKey: ["connections"],
      queryFn: () =>
        new Promise<Connection[]>((done) => {
          resolve = done;
        }),
    })
    .catch(() => undefined);
  cacheSavedConnection(client, connection);
  expect(client.getQueryData(["connections"])).toEqual([connection]);
  resolve([]);
  await old;
  expect(client.getQueryData(["connections"])).toEqual([connection]);
  client.clear();
});
it("locks before starting work, rejects concurrent owners and rejects late responses from old sessions", async () => {
  let session = "first",
    resolve!: (value: string) => void;
  const pending: boolean[] = [];
  const operation = createTaskOperation(
    () => session,
    (value) => pending.push(value),
  );
  const first = operation.run(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  expect(operation.busy).toBe(true);
  await expect(operation.run(async () => "second")).rejects.toThrow("尚未完成");
  expect(operation.busy).toBe(true);
  expect(pending).toEqual([true]);
  session = "changed";
  resolve("late");
  await expect(first).rejects.toThrow("响应已失效");
  expect(operation.busy).toBe(false);
  expect(pending).toEqual([true, false]);
  await expect(operation.run(async () => "current")).resolves.toBe("current");
});
