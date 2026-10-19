import { describe, expect, it } from "vitest";
import { inputLines, resolvedSelection, taskCounts } from "./domain";
import type { PlanItem, Project } from "./types";

const project = (id: number): Project => ({
  id,
  name: "app",
  path: "app",
  path_with_namespace: `team-${id}/app`,
  description: null,
  web_url: `https://gitlab.example.com/team-${id}/app`,
  archived: false,
  visibility: "private",
  permissions: null,
});

describe("batch repository selection", () => {
  it("retains one input per line without splitting application names on spaces", () => {
    expect(inputLines("  Example App\r\nteam/app\nExample App\n\n")).toEqual([
      "Example App",
      "team/app",
    ]);
  });
  it("requires an explicit choice for identical names and deduplicates aliases", () => {
    const rows = [
      { input: "app", candidates: [project(1), project(2)], error: null },
      { input: "team-1/app", candidates: [project(1)], error: null },
    ];
    expect(resolvedSelection(rows, {}).map((p) => p.id)).toEqual([1]);
    expect(resolvedSelection(rows, { 0: 2 }).map((p) => p.id)).toEqual([2, 1]);
    expect(resolvedSelection(rows, { 0: 1 }).map((p) => p.id)).toEqual([1]);
  });
  it("does not turn a failed lookup into a selected target", () => {
    expect(resolvedSelection([{ input: "private-app", candidates: [], error: "403" }], {})).toEqual(
      [],
    );
  });
});

it("keeps unknown writes separate from successful writes", () => {
  const items = [
    { status: "unknown" },
    { status: "succeeded" },
    { status: "pending" },
  ] as PlanItem[];
  expect(taskCounts(items)).toMatchObject({ unknown: 1, succeeded: 1, pending: 1 });
});
