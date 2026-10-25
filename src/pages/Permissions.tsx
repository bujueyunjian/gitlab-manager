import { useEffect, useState } from "react";
import { ArrowRight, Plus, Search } from "lucide-react";
import { errorMessage } from "../api";
import { roleName, roles } from "../domain";
import {
  inheritedMembers,
  repositoryPermissions,
  matchesMembershipRole,
} from "../permissionOverview";
import type { MembershipCoverage } from "../permissionOverview";
import type { MemberRow, Project, User } from "../types";
import { Badge, Button, Empty, ErrorBox } from "../ui";
import { ResourceErrors, ResourceScope, useResources, useWorkspace } from "../Workspace";
import { ReadProgressView } from "../ReadProgress";
import { UserLookup } from "../UserLookup";
import { RepositoryMembersDialog } from "../RepositoryMembersDialog";

const coverageLabels = {
  granted: "有成员授权",
  missing: "未查到成员授权",
  unverified: "访问途径待核实",
  error: "读取失败",
  unread: "未取得结果",
};

/** Repository-first overview with explicit user identity and conservative membership coverage. */
export function PermissionsPage() {
  const { selected, selectedProjects, writable, setModal, changePage, connection } = useWorkspace();
  const resources = useResources("members");
  const [projectSearch, setProjectSearch] = useState("");
  const [userRole, setUserRole] = useState<number | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [coverage, setCoverage] = useState<"all" | MembershipCoverage["status"]>("all");
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<number | null>(null);
  useEffect(() => {
    if (resources.error) setUserRole(null);
  }, [resources.error]);
  const rows = repositoryPermissions(
    selectedProjects,
    resources.data ?? [],
    user,
    resources.error ? errorMessage(resources.error) : undefined,
  );
  const query = projectSearch.trim().toLowerCase();
  const searched = rows.filter((row) =>
    [row.project.name, row.project.path_with_namespace].join(" ").toLowerCase().includes(query),
  );
  const filtered = searched.filter(
    (row) =>
      (!user || coverage === "all" || row.coverage?.status === coverage) &&
      matchesMembershipRole(row.coverage, userRole),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 15));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 15, currentPage * 15);
  const grantProjects = filtered
    .filter(
      (row) =>
        row.members.status === "ready" &&
        (!user || row.coverage?.status === (userRole === null ? "missing" : "granted")),
    )
    .map((row) => row.project);
  const detail = rows.find((row) => row.project.id === detailId);

  /** Prefill the checked user and bind the write preview to the explicitly displayed repository scope. */
  function grant(projects: Project[]) {
    setDetailId(null);
    setModal({
      type: "permission",
      mode: "grant",
      projects,
      initialUsers: user ? [user] : undefined,
      initialRole: userRole !== null && [10, 20, 30, 40].includes(userRole) ? userRole : undefined,
    });
  }

  /** Open the existing preview flow for direct memberships in the inspected repository. */
  function edit(rows: MemberRow[], mode: "update" | "revoke") {
    setDetailId(null);
    setModal({ type: "permission", mode, rows, projects: [rows[0].project] });
  }

  /** A typed name never selects a person implicitly; identity changes reset the coverage filter. */
  function chooseUser(value: User | null) {
    setUser(value);
    setCoverage("all");
    setUserRole(null);
    setPage(1);
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>授权管理</h1>
          <p>按仓库查看成员权限，或选择用户检查授权覆盖情况。</p>
        </div>
        <Button
          variant="primary"
          disabled={!writable || !grantProjects.length || resources.isFetching || !!resources.error}
          onClick={() => grant(grantProjects)}
        >
          <Plus size={16} />
          {user
            ? userRole === null
              ? "为未查到授权的仓库授权"
              : "设置筛选用户授权"
            : "为筛选仓库授权"}{" "}
          ({grantProjects.length})
        </Button>
      </div>
      <ResourceScope refresh={() => void resources.refetch()} fetching={resources.isFetching} />
      {!selected.size ? (
        <Empty
          title="先选择要管理的仓库"
          action={
            <Button variant="primary" onClick={() => changePage("repos")}>
              选择仓库
              <ArrowRight size={15} />
            </Button>
          }
        >
          在仓库页选择范围，再查看每个仓库的成员与授权。
        </Empty>
      ) : (
        <section className="panel">
          <UserLookup connectionId={connection.id} value={user} onChange={chooseUser} />
          <div className="toolbar">
            <div className="search-box">
              <Search size={16} />
              <input
                aria-label="搜索授权范围内的仓库"
                placeholder="搜索仓库名称或完整路径"
                value={projectSearch}
                onChange={(event) => {
                  setProjectSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <select
              aria-label="筛选所查用户角色（精确匹配）"
              disabled={!user}
              value={userRole ?? "all"}
              onChange={(event) => {
                setUserRole(event.target.value === "all" ? null : Number(event.target.value));
                if (event.target.value !== "all") setCoverage("all");
                setPage(1);
              }}
            >
              <option value="all">用户全部角色</option>
              {Object.entries(roles).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选用户授权状态"
              disabled={!user}
              title={user ? "按所选用户的成员授权筛选" : "先查找并选择具体用户"}
              value={coverage}
              onChange={(event) => {
                setCoverage(event.target.value as typeof coverage);
                if (!["all", "granted"].includes(event.target.value)) setUserRole(null);
                setPage(1);
              }}
            >
              <option value="all">全部授权状态</option>
              {Object.entries(coverageLabels).map(([status, label]) => (
                <option key={status} value={status}>
                  {label} ({searched.filter((row) => row.coverage?.status === status).length})
                </option>
              ))}
            </select>
          </div>
          {resources.isFetching && (
            <ReadProgressView title="正在读取授权" progress={resources.progress} />
          )}
          {resources.error && <ErrorBox message={errorMessage(resources.error)} />}
          <ResourceErrors
            resources={resources.data ?? []}
            kind="members"
            projects={selectedProjects}
          />
          <div className="table-scroll">
            <table className="permission-projects">
              <thead>
                <tr>
                  <th>仓库</th>
                  {user && (
                    <>
                      <th>所选用户授权</th>
                      <th>角色 / 来源</th>
                    </>
                  )}
                  <th>直接成员</th>
                  <th>继承 / 共享成员</th>
                  <th>共享群组</th>
                  {!user && <th>读取状态</th>}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.project.id}>
                    <td>
                      <button
                        className="repo-name"
                        onClick={() => setDetailId(row.project.id)}
                        disabled={
                          row.members.status !== "ready" ||
                          resources.isFetching ||
                          !!resources.error
                        }
                      >
                        {row.project.name}
                      </button>
                      <small className="cell-note permission-project-path">
                        {row.project.path_with_namespace}
                      </small>
                    </td>
                    {user && (
                      <>
                        <td>
                          <Badge
                            color={
                              row.coverage?.status === "granted"
                                ? "green"
                                : row.coverage?.status === "error"
                                  ? "red"
                                  : "amber"
                            }
                          >
                            {row.coverage && coverageLabels[row.coverage.status]}
                          </Badge>
                          {row.coverage && "reason" in row.coverage && (
                            <small className="cell-note permission-coverage-note">
                              {row.coverage.reason}
                            </small>
                          )}
                        </td>
                        <td>
                          {row.coverage?.status === "granted" ? (
                            <>
                              {roleName(row.coverage.member.access_level)}
                              <small className="cell-note">{row.coverage.source}</small>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </>
                    )}
                    <td>{row.members.status === "ready" ? row.members.data.direct.length : "—"}</td>
                    <td>
                      {row.members.status === "ready"
                        ? inheritedMembers(row.members.data).length
                        : "—"}
                    </td>
                    <td>{row.members.status === "ready" ? row.members.data.shares.length : "—"}</td>
                    {!user && (
                      <td>
                        <Badge
                          color={
                            row.members.status === "ready"
                              ? "green"
                              : row.members.status === "error"
                                ? "red"
                                : "gray"
                          }
                        >
                          {row.members.status === "ready"
                            ? "读取完成"
                            : row.members.status === "error"
                              ? "读取失败"
                              : "未取得结果"}
                        </Badge>
                        {row.members.status === "error" && (
                          <small className="cell-note permission-coverage-note">
                            {row.members.message}
                          </small>
                        )}
                      </td>
                    )}
                    <td>
                      <div className="button-group">
                        <Button
                          className="small"
                          disabled={
                            row.members.status !== "ready" ||
                            resources.isFetching ||
                            !!resources.error
                          }
                          onClick={() => setDetailId(row.project.id)}
                        >
                          查看成员
                        </Button>
                        <Button
                          className="small"
                          disabled={
                            !writable ||
                            resources.isFetching ||
                            !!resources.error ||
                            row.members.status !== "ready" ||
                            (!!user && !["granted", "missing"].includes(row.coverage?.status ?? ""))
                          }
                          onClick={() => grant([row.project])}
                        >
                          授权
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length && (
            <Empty title="没有匹配的仓库">调整仓库搜索或用户授权状态筛选。</Empty>
          )}
          <div className="pagination">
            <span>
              {filtered.length} 个筛选结果 / {selected.size} 个范围仓库
            </span>
            <span>
              {currentPage} / {pages} 页
            </span>
            <div className="pages">
              <Button
                className="small"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </Button>
              <Button
                className="small"
                disabled={currentPage === pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
          {user && (
            <p className="permission-scope-note">
              “未查到成员授权”不等于绝对无法访问。管理员、公开或内部可见性、共享群组及当前账号不可见的授权，需要在
              GitLab 核实。
            </p>
          )}
        </section>
      )}
      {detail?.members.status === "ready" && (
        <RepositoryMembersDialog
          key={detail.project.id}
          project={detail.project}
          members={detail.members.data}
          writable={writable && !resources.isFetching && !resources.error}
          onClose={() => setDetailId(null)}
          onEdit={edit}
          onGrant={() => grant([detail.project])}
        />
      )}
    </>
  );
}
