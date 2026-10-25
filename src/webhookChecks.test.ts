import { describe, expect, it, vi } from "vitest";
import {
  filterWebhookProjects,
  inspectWebhookBatches,
  missingWebhookTargets,
  uniqueWebhookTargets,
} from "./webhookChecks";
import type { Hook, Project, ProjectWebhookCheck } from "./types";

/** Construct a fictional project for scope and selection checks. */
function project(id: number): Project {
  return {
    id,
    name: "Example",
    path: "example",
    path_with_namespace: "demo/example-" + id,
    web_url: "https://gitlab.example.com/demo/example-" + id,
    description: null,
    archived: false,
    visibility: "private",
    permissions: null,
  };
}

/** Fictional public webhook fields used to distinguish duplicates from unique matches. */
function hook(id: number): Hook {
  return {
    id,
    name: "Code Review",
    url: "https://hooks.example.com/gitlab",
    push_events: true,
    merge_requests_events: true,
    pipeline_events: false,
    issues_events: false,
    tag_push_events: false,
    enable_ssl_verification: true,
    token_present: null,
    signing_token_present: null,
  };
}

describe("webhook maintenance filters", () => {
  const projects = [1, 2, 3, 4].map(project);
  const checks = new Map<number, ProjectWebhookCheck>([
    [1, { projectId: 1, status: "present", count: 2, hooks: [hook(1), hook(2)] }],
    [2, { projectId: 2, status: "missing" }],
    [3, { projectId: 3, status: "error", message: "HTTP 403" }],
    [5, { projectId: 5, status: "missing" }],
  ]);
  it("keeps failures and unchecked projects distinct from missing URLs", () => {
    expect(filterWebhookProjects(projects, checks, "present").map((p) => p.id)).toEqual([1]);
    expect(filterWebhookProjects(projects, checks, "missing").map((p) => p.id)).toEqual([2]);
    expect(filterWebhookProjects(projects, checks, "error").map((p) => p.id)).toEqual([3]);
    expect(filterWebhookProjects(projects, checks, "unchecked").map((p) => p.id)).toEqual([4]);
    expect(filterWebhookProjects(projects, checks, "all")).toEqual(projects);
    expect(filterWebhookProjects(projects, new Map(), "missing")).toEqual([]);
  });
  it("never adds selected existing, failed, unchecked or out-of-scope projects to create targets", () => {
    const selected = new Map([1, 2, 3, 4, 5].map((id) => [id, project(id)]));
    expect(missingWebhookTargets(projects, checks, selected).map((p) => p.id)).toEqual([2]);
    expect(missingWebhookTargets(projects, checks, new Map())).toEqual([]);
  });
});

describe("bounded inspection dispatch", () => {
  it("deduplicates projects and reports completed batches of at most four", async () => {
    const read = vi.fn(async (ids: number[]): Promise<ProjectWebhookCheck[]> =>
      ids.map((projectId) => ({ projectId, status: "missing" })),
    );
    const completed: number[] = [];
    await inspectWebhookBatches(
      [1, 2, 3, 4, 5, 5, 6, 7, 8, 9],
      read,
      (rows) => completed.push(rows.length),
      () => false,
    );
    expect(read.mock.calls.map(([ids]) => ids)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    expect(completed).toEqual([4, 4, 1]);
  });
  it("stops dispatching after cancellation without losing earlier completed outcomes", async () => {
    let cancelled = false;
    const read = vi.fn(async (ids: number[]): Promise<ProjectWebhookCheck[]> =>
      ids.map((projectId) => ({ projectId, status: "missing" })),
    );
    const complete = vi.fn(() => {
      cancelled = true;
    });
    await inspectWebhookBatches([1, 2, 3, 4, 5], read, complete, () => cancelled);
    expect(read).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("discards a late response after the address or scope was invalidated", async () => {
    let finish!: (rows: ProjectWebhookCheck[]) => void;
    let cancelled = false;
    const read = vi.fn(
      () =>
        new Promise<ProjectWebhookCheck[]>((resolve) => {
          finish = resolve;
        }),
    );
    const complete = vi.fn();
    const pending = inspectWebhookBatches([1, 2, 3, 4, 5], read, complete, () => cancelled);
    cancelled = true;
    finish([{ projectId: 1, status: "missing" }]);
    await pending;
    expect(read).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
  it("propagates a batch failure without retrying or dispatching later projects", async () => {
    const failure = new Error("fixture failure");
    const read = vi
      .fn()
      .mockResolvedValueOnce([{ projectId: 1, status: "missing" }])
      .mockRejectedValueOnce(failure);
    const complete = vi.fn();
    await expect(
      inspectWebhookBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], read, complete, () => false),
    ).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

it("requires unique hook identity before batch editing and keeps duplicate matches selectable individually", () => {
  const projects = [project(1), project(2), project(3)];
  const results = new Map<number, ProjectWebhookCheck>([
    [1, { projectId: 1, status: "present", count: 2, hooks: [hook(1), hook(2)] }],
    [2, { projectId: 2, status: "present", count: 1, hooks: [hook(7)] }],
    [3, { projectId: 3, status: "error", message: "HTTP 403" }],
  ]);
  const selected = new Map(projects.map((p) => [p.id, p]));
  expect(filterWebhookProjects(projects, results, "duplicate").map((p) => p.id)).toEqual([1]);
  expect(
    uniqueWebhookTargets(projects, results, selected).map((row) => [row.project.id, row.hook.id]),
  ).toEqual([[2, 7]]);
  expect(uniqueWebhookTargets([project(1)], results, selected)).toEqual([]);
});
