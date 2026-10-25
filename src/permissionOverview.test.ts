import { describe, expect, it } from "vitest";
import { assessMembership, inheritedMembers, repositoryPermissions } from "./permissionOverview";
import type { MemberCollection } from "./permissionOverview";
import type { Member, Project, ProjectResources, User } from "./types";

const user: User = { id: 7, name: "Demo", username: "demo-user", is_admin: null };
const project: Project = {
  id: 1,
  name: "Demo API",
  path: "demo-api",
  path_with_namespace: "demo/demo-api",
  web_url: "https://gitlab.example.com/demo/demo-api",
  archived: false,
  description: null,
  visibility: "private",
  permissions: null,
};
/** Fictional members preserve exact IDs independently of mutable names. */
function member(id: number, access_level = 30): Member {
  return { id, name: "Demo", username: "demo-user", access_level, expires_at: null };
}
/** Construct complete resource responses without credentials or private metadata. */
function resource(
  members: MemberCollection,
  projectId = 1,
): Extract<ProjectResources, { status: "ready" }> {
  return {
    status: "ready",
    projectId,
    project: { ...project, id: projectId },
    hooks: { status: "not_requested" },
    members: { status: "ready", data: members },
  };
}
const empty: MemberCollection = { direct: [], all: [], shares: [] };

describe("repository overview", () => {
  it("keeps one row for a repository with many members and retains empty repositories", () => {
    const members = Array.from({ length: 44 }, (_, i) => member(i + 1));
    const rows = repositoryPermissions(
      [project, { ...project, id: 2 }],
      [resource({ ...empty, direct: members, all: members }), resource(empty, 2)],
      null,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].members).toMatchObject({ status: "ready", data: { direct: members } });
    expect(rows[1].members).toMatchObject({ status: "ready", data: { direct: [] } });
  });
  it("does not include resources outside the selected repository scope", () => {
    const rows = repositoryPermissions([project], [resource(empty), resource(empty, 2)], null);
    expect(rows.map((row) => row.project.id)).toEqual([1]);
  });
  it("keeps failed or unread projects and never treats them as missing membership", () => {
    const rows = repositoryPermissions(
      [project, { ...project, id: 2 }],
      [{ ...resource(empty), members: { status: "error", message: "HTTP 403" } }],
      user,
    );
    expect(rows.map((row) => row.coverage?.status)).toEqual(["error", "unread"]);
  });
  it("invalidates cached grants when a refresh fails", () => {
    const rows = repositoryPermissions(
      [project],
      [resource({ ...empty, direct: [member(7)] })],
      user,
      "HTTP 403",
    );
    expect(rows[0].coverage?.status).toBe("error");
  });
  it("retains metadata failure rows by requested ID without losing other successes or inventing membership", () => {
    const rows = repositoryPermissions(
      [project, { ...project, id: 2 }, { ...project, id: 3 }],
      [
        resource(empty, 3),
        { status: "error", projectId: 1, message: "HTTP 403" },
        resource({ ...empty, direct: [member(7)] }, 2),
      ],
      user,
    );
    expect(rows.map((row) => row.project.id)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.coverage?.status)).toEqual(["error", "granted", "missing"]);
    expect(rows[0].project).toEqual(project);
    expect(rows[0].members).toEqual({ status: "error", message: "项目读取失败：HTTP 403" });
    expect(
      rows.filter((row) => row.coverage?.status === "missing").map((row) => row.project.id),
    ).toEqual([3]);
    expect(
      rows.filter((row) => row.members.status === "ready").map((row) => row.project.id),
    ).toEqual([2, 3]);
  });
});

describe("user membership coverage", () => {
  it("uses the highest visible role and preserves higher inherited authorization", () => {
    const data = { ...empty, direct: [member(7, 30)], all: [member(7, 40)] };
    expect(assessMembership(project, { status: "ready", data }, user)).toMatchObject({
      status: "granted",
      member: { access_level: 40 },
      source: "继承或共享",
    });
    expect(inheritedMembers(data)).toEqual([member(7, 40)]);
  });
  it("recognizes direct membership even when the aggregate response omits it", () => {
    expect(
      assessMembership(project, { status: "ready", data: { ...empty, direct: [member(7)] } }, user),
    ).toMatchObject({ status: "granted", source: "含直接授权" });
  });
  it("recognizes inherited-only members without enabling direct-member edits", () => {
    const data = { ...empty, all: [member(7)] };
    expect(assessMembership(project, { status: "ready", data }, user)).toMatchObject({
      status: "granted",
      source: "继承或共享",
    });
    expect(data.direct).toHaveLength(0);
  });
  it("matches identity by ID, not a shared or changed username", () => {
    expect(
      assessMembership(
        project,
        { status: "ready", data: { ...empty, direct: [member(8)], all: [member(8)] } },
        user,
      ).status,
    ).toBe("missing");
  });
  it("reports missing membership only after successful reads", () => {
    expect(assessMembership(project, { status: "ready", data: empty }, user).status).toBe(
      "missing",
    );
    expect(assessMembership(project, { status: "error", message: "HTTP 403" }, user).status).toBe(
      "error",
    );
    expect(assessMembership(project, { status: "not_requested" }, user).status).toBe("unread");
  });
  it.each(["public", "internal"])(
    "keeps %s repository access separate from membership absence",
    (visibility) => {
      expect(
        assessMembership({ ...project, visibility }, { status: "ready", data: empty }, user).status,
      ).toBe("unverified");
    },
  );
  it("does not infer lack of access for administrators or hidden shared-group members", () => {
    expect(
      assessMembership(project, { status: "ready", data: empty }, { ...user, is_admin: true })
        .status,
    ).toBe("unverified");
    const data = {
      ...empty,
      shares: [
        {
          group_id: 3,
          group_name: "Demo group",
          group_full_path: "demo/group",
          group_access_level: 30,
          expires_at: null,
        },
      ],
    };
    expect(assessMembership(project, { status: "ready", data }, user).status).toBe("unverified");
  });
  it("does not duplicate an equal direct role in the inherited view", () => {
    expect(
      inheritedMembers({ ...empty, direct: [member(7, 40)], all: [member(7, 40), member(8, 20)] }),
    ).toEqual([member(8, 20)]);
  });
});
