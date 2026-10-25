import { expect, it } from "vitest";
import { hookOverview, resourceFailures } from "./resourceReads";
import type { ProjectResources, Project } from "./types";

/** Fictional known projects label errors while only fresh successful reads supply operation targets. */
function project(id: number): Project {
  return {
    id,
    name: "Example " + id,
    path: "example-" + id,
    path_with_namespace: "demo/example-" + id,
    web_url: "https://gitlab.example.com/demo/example-" + id,
    archived: false,
    visibility: "private",
    description: null,
    permissions: null,
  };
}

/** Build an identified project outcome independently of the metadata-failure variant. */
function ready(projectId: number): Extract<ProjectResources, { status: "ready" }> {
  return {
    status: "ready",
    projectId,
    project: project(projectId),
    hooks: { status: "ready", data: [] },
    members: { status: "not_requested" },
  };
}

it("keeps metadata and Hook failures visible while excluding both from Hook mutation scopes", () => {
  const hook = {
    id: 7,
    name: "Example",
    url: "https://hooks.example.com/gitlab",
    push_events: true,
    merge_requests_events: false,
    pipeline_events: false,
    issues_events: false,
    tag_push_events: false,
    enable_ssl_verification: true,
    token_present: false,
    signing_token_present: false,
  };
  const resources: ProjectResources[] = [
    { status: "error", projectId: 2, message: "HTTP 403" },
    { ...ready(1), hooks: { status: "ready", data: [hook] } },
    { ...ready(3), hooks: { status: "error", message: "HTTP 404" } },
    ready(4),
  ];
  const overview = hookOverview(resources);
  expect(overview.projects.map((project) => project.id)).toEqual([1, 4]);
  expect(overview.hooks.map((row) => [row.project.id, row.hook.id])).toEqual([[1, 7]]);
  expect(resourceFailures(resources, "hooks")).toEqual([
    { projectId: 2, stage: "项目", message: "HTTP 403" },
    { projectId: 3, stage: "Webhook", message: "HTTP 404" },
  ]);
});

it("does not reuse a failed project's old selected Hook after refreshed metadata fails", () => {
  const refreshed: ProjectResources[] = [
    { status: "error", projectId: 1, message: "HTTP 403" },
    ready(2),
  ];
  const previousSelection = new Set(["1:7"]);
  expect(
    hookOverview(refreshed).hooks.filter((row) =>
      previousSelection.has(`${row.project.id}:${row.hook.id}`),
    ),
  ).toEqual([]);
  expect(hookOverview(refreshed).projects.map((project) => project.id)).toEqual([2]);
});

it("separates member failure from metadata failure and ignores resources the page did not request", () => {
  const resources: ProjectResources[] = [
    { status: "error", projectId: 3, message: "HTTP 403" },
    { ...ready(4), members: { status: "error", message: "HTTP 404" } },
    ready(5),
  ];
  expect(resourceFailures(resources, "members")).toEqual([
    { projectId: 3, stage: "项目", message: "HTTP 403" },
    { projectId: 4, stage: "成员", message: "HTTP 404" },
  ]);
});
