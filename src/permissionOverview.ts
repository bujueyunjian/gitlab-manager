import type { Member, Project, ProjectResources, ReadResult, User } from "./types";

/** Member lists returned by the direct, aggregate and shared-group APIs for one repository. */
export type MemberCollection = Extract<
  Extract<ProjectResources, { status: "ready" }>["members"],
  { status: "ready" }
>["data"];

/** Absence from visible membership records is not proof that a user cannot access a repository. */
export type MembershipCoverage =
  | { status: "granted"; member: Member; source: "含直接授权" | "继承或共享" }
  | { status: "missing" }
  | { status: "unverified"; reason: string }
  | { status: "error" | "unread"; reason: string };

/** One row per selected repository; original selection metadata labels failures without implying a fresh read. */
export interface RepositoryPermission {
  project: Project;
  members: ReadResult<MemberCollection>;
  coverage: MembershipCoverage | null;
}

/** Match a queried user's visible effective role exactly, never the signed-in account's role. */
export function matchesMembershipRole(
  coverage: MembershipCoverage | null,
  role: number | null,
): boolean {
  return role === null || (coverage?.status === "granted" && coverage.member.access_level === role);
}

/** Return aggregate entries that add a member or a higher role beyond direct membership. */
export function inheritedMembers(members: MemberCollection): Member[] {
  const direct = new Map(members.direct.map((member) => [member.id, member.access_level]));
  return members.all.filter(
    (member) => !direct.has(member.id) || direct.get(member.id)! < member.access_level,
  );
}

/** Assess an exact user ID using the highest visible role, keeping uncertain access routes explicit. */
export function assessMembership(
  project: Project,
  members: ReadResult<MemberCollection>,
  user: User,
): MembershipCoverage {
  // 1. Failed or incomplete reads cannot establish missing membership.
  if (members.status === "error") return { status: "error", reason: members.message };
  if (members.status === "not_requested")
    return { status: "unread", reason: "尚未取得此仓库的成员数据" };

  // 2. Direct and aggregate membership can overlap; compare exact IDs and keep the higher role.
  const direct = members.data.direct.find((member) => member.id === user.id);
  const aggregate = members.data.all.find((member) => member.id === user.id);
  const effective = !direct
    ? aggregate
    : !aggregate || direct.access_level >= aggregate.access_level
      ? direct
      : aggregate;
  if (effective)
    return {
      status: "granted",
      member: effective,
      source: direct && direct.access_level >= effective.access_level ? "含直接授权" : "继承或共享",
    };

  // 3. Membership APIs do not prove absence of administrator, visibility or hidden shared-group access.
  if (user.is_admin === true)
    return { status: "unverified", reason: "该用户是实例管理员，成员列表不能证明其没有访问权限" };
  if (project.visibility !== "private")
    return { status: "unverified", reason: "仓库可见性可能允许非成员访问，请在 GitLab 核实" };
  if (members.data.shares.length)
    return { status: "unverified", reason: "存在群组共享，当前接口可能未返回全部共享成员" };
  return { status: "missing" };
}

/** Associate outcomes by requested ID and retain selection labels when project metadata cannot be read. */
export function repositoryPermissions(
  projects: Project[],
  resources: ProjectResources[],
  user: User | null,
  readError?: string,
): RepositoryPermission[] {
  const byId = new Map(resources.map((resource) => [resource.projectId, resource]));
  return projects.map((selected) => {
    const resource = byId.get(selected.id);
    const project = resource?.status === "ready" ? resource.project : selected;
    const members: ReadResult<MemberCollection> = readError
      ? { status: "error", message: readError }
      : resource?.status === "error"
        ? { status: "error", message: "项目读取失败：" + resource.message }
        : resource?.status === "ready"
          ? resource.members
          : { status: "not_requested" };
    return { project, members, coverage: user ? assessMembership(project, members, user) : null };
  });
}
