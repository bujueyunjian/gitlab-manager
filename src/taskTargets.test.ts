import { expect, it } from "vitest";
import { permissionBatchProjects, webhookBatch, webhookTaskRows } from "./taskTargets";
import { repositoryPermissions } from "./permissionOverview";
import type { Hook, Project, ProjectWebhookCheck } from "./types";
/** Fictional scope supplies IDs only; ambiguous and failed reads are independent outcomes. */
function project(id: number): Project {
  return {
    id,
    name: "Example " + id,
    path: "example-" + id,
    path_with_namespace: "demo/example-" + id,
    web_url: "https://gitlab.example.com/demo/example-" + id,
    description: null,
    visibility: "private",
    archived: false,
    permissions: null,
  };
}
/** Safe Hook metadata includes every existing five-event field. */
function hook(id: number, url = "https://hooks.example.com/gitlab"): Hook {
  return {
    id,
    name: "Example",
    url,
    push_events: true,
    merge_requests_events: false,
    pipeline_events: false,
    issues_events: false,
    tag_push_events: false,
    enable_ssl_verification: true,
    token_present: false,
    signing_token_present: false,
  };
}
const projects = [1, 2, 3, 4].map(project);
const checks = new Map<number, ProjectWebhookCheck>([
  [1, { projectId: 1, status: "missing" }],
  [2, { projectId: 2, status: "present", count: 1, hooks: [hook(201)] }],
  [3, { projectId: 3, status: "present", count: 2, hooks: [hook(301), hook(302)] }],
  [4, { projectId: 4, status: "error", message: "HTTP 403" }],
]);
it("combines confirmed missing and unique existing targets without including hidden or failed choices", () => {
  const rows = webhookTaskRows(projects, checks, "missing", true, new Map());
  const batch = webhookBatch(rows, new Set([1, 2, 3, 4]), {
    field: "url",
    value: "https://hooks.example.com/gitlab",
  })!;
  expect(batch.projects.map((item) => item.id)).toEqual([1, 2]);
  expect(batch.rows.map((row) => row.hook.id)).toEqual([201]);
  expect(batch.mode).toBe("ensure");
  expect(batch.creationCount).toBe(1);
  expect(
    webhookBatch(webhookTaskRows(projects, checks, "present", false, new Map()), new Set([1, 2]), {
      field: "url",
      value: "https://hooks.example.com/gitlab",
    })?.projects.map((item) => item.id),
  ).toEqual([2]);
});
it("requires an explicit matched duplicate ID and never treats failed/unchecked projects as missing", () => {
  let rows = webhookTaskRows([...projects, project(5)], checks, "needs", false, new Map());
  expect(
    webhookBatch(rows, new Set([3, 4, 5]), {
      field: "url",
      value: "https://hooks.example.com/gitlab",
    }),
  ).toBeNull();
  rows = webhookTaskRows(projects, checks, "needs", false, new Map([[3, 302]]));
  expect(
    webhookBatch(rows, new Set([3, 4]), { field: "name", value: "Example" })?.rows[0].hook.id,
  ).toBe(302);
  rows = webhookTaskRows(projects, checks, "needs", false, new Map([[3, 999]]));
  expect(webhookBatch(rows, new Set([3]), { field: "name", value: "Example" })).toBeNull();
});
it("name-query mixed creates require an explicit new URL while URL queries can reuse their exact address", () => {
  const rows = webhookTaskRows(projects, checks, "missing", true, new Map());
  const named = webhookBatch(rows, new Set([1, 2]), { field: "name", value: "Example" })!;
  expect(named.initialUrl).toBe("");
  expect(named.initialName).toBe("Example");
  expect(
    webhookBatch(rows, new Set([1, 2]), { field: "url", value: "https://hooks.example.com/gitlab" })
      ?.initialUrl,
  ).toBe("https://hooks.example.com/gitlab");
});

it("secondary permission projectIds use only filtered checked readable repositories even before choosing a user", () => {
  const scope = [project(1), project(2), project(3)];
  const rows = repositoryPermissions(
    scope,
    [
      {
        status: "ready",
        projectId: 1,
        project: scope[0],
        hooks: { status: "not_requested" },
        members: { status: "ready", data: { direct: [], all: [], shares: [] } },
      },
      {
        status: "ready",
        projectId: 2,
        project: scope[1],
        hooks: { status: "not_requested" },
        members: { status: "ready", data: { direct: [], all: [], shares: [] } },
      },
      { status: "error", projectId: 3, message: "HTTP 403" },
    ],
    null,
  );
  const filtered = rows.filter((row) => row.project.id === 1);
  expect(
    permissionBatchProjects(filtered, new Set([1, 2, 3]), false).map((item) => item.id),
  ).toEqual([1]);
  expect(permissionBatchProjects(rows, new Set([1]), false).map((item) => item.id)).toEqual([1]);
  expect(permissionBatchProjects(rows, new Set(), false)).toEqual([]);
  expect(permissionBatchProjects(rows, new Set([3]), false)).toEqual([]);
});
