import { describe, expect, it } from "vitest";
import {
  canAttemptWrite,
  inputLines,
  resolvedSelection,
  supportsWebhookNames,
  taskCounts,
  tokenScopeLabel,
} from "./domain";
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

describe("token scope availability", () => {
  it("allows legacy requests while displaying their authorization as unknown", () => {
    expect(canAttemptWrite(null)).toBe(true);
    expect(tokenScopeLabel(null)).toBe("范围未知 · 由 GitLab 校验");
  });
  it("keeps verified read-only tokens from enabling write actions", () => {
    expect(canAttemptWrite(["read_api"])).toBe(false);
    expect(canAttemptWrite([])).toBe(false);
    expect(tokenScopeLabel(["read_api"])).toBe("只读 · read_api");
    expect(canAttemptWrite(["api"])).toBe(true);
    expect(tokenScopeLabel(["api"])).toBe("可读写 · api");
  });
});

it("offers webhook names only from GitLab 17.1, including edition suffixes", () => {
  expect(supportsWebhookNames("13.10.5")).toBe(false);
  expect(supportsWebhookNames("17.0.8-ee")).toBe(false);
  expect(supportsWebhookNames("17.1.0-ee")).toBe(true);
  expect(supportsWebhookNames("19.0.0")).toBe(true);
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
