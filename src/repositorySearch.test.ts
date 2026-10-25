import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { searchRepositories } from "./repositorySearch";
import { matchesMembershipRole } from "./permissionOverview";
import type { Project, ProjectFilter } from "./types";

vi.mock("./api", () => ({ api: { projects: vi.fn(), resolve: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const project: Project = {
  id: 1,
  name: "Demo",
  path: "service",
  path_with_namespace: "demo/service",
  web_url: "https://gitlab.example.com/demo/service",
  description: null,
  archived: false,
  visibility: "private",
  permissions: { project_access: { access_level: 40 }, group_access: null },
};
const filter: ProjectFilter = { search: "service", archived: false, accessLevel: null };

it("keeps partial repository name search on the projects API", async () => {
  vi.mocked(api.projects).mockResolvedValue([project]);
  expect(await searchRepositories("fixture", filter)).toEqual([project]);
  expect(api.projects).toHaveBeenCalledWith("fixture", filter);
  expect(api.resolve).not.toHaveBeenCalled();
});
it.each(["https://gitlab.example.com/demo/service.git", "demo/service"])(
  "resolves a full reference through the instance-validated backend: %s",
  async (search) => {
    vi.mocked(api.resolve).mockResolvedValue([
      { input: search, candidates: [project], error: null },
    ]);
    expect(await searchRepositories("fixture", { ...filter, search })).toEqual([project]);
    expect(api.resolve).toHaveBeenCalledWith("fixture", [search], expect.any(Function));
    expect(api.projects).not.toHaveBeenCalled();
  },
);
it("preserves archive and signed-in role filters for direct references", async () => {
  vi.mocked(api.resolve).mockResolvedValue([
    { input: "demo/service", candidates: [project], error: null },
  ]);
  expect(
    await searchRepositories("fixture", { ...filter, search: "demo/service", accessLevel: 30 }),
  ).toEqual([]);
  expect(
    await searchRepositories("fixture", { ...filter, search: "demo/service", archived: true }),
  ).toEqual([]);
});
it("never broadens a failed URL resolution into unrelated project search", async () => {
  vi.mocked(api.resolve).mockResolvedValue([
    { input: "demo/service", candidates: [], error: "HTTP 403" },
  ]);
  await expect(
    searchRepositories("fixture", { ...filter, search: "demo/service" }),
  ).rejects.toThrow("HTTP 403");
  expect(api.projects).not.toHaveBeenCalled();
});
it("matches the queried user's role exactly rather than the signed-in user's Maintainer role", () => {
  const coverage = {
    status: "granted" as const,
    member: { id: 2, name: "Demo", username: "demo-user", access_level: 30, expires_at: null },
    source: "含直接授权" as const,
  };
  expect(matchesMembershipRole(coverage, 30)).toBe(true);
  expect(matchesMembershipRole(coverage, 40)).toBe(false);
  expect(matchesMembershipRole({ status: "missing" }, 30)).toBe(false);
  expect(matchesMembershipRole({ status: "error", reason: "HTTP 403" }, 30)).toBe(false);
});
