import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { errorMessage } from "../api";
import { roleName, roles } from "../domain";
import {
  inheritedMembers,
  matchesMembershipRole,
  repositoryPermissions,
} from "../permissionOverview";
import type { MembershipCoverage } from "../permissionOverview";
import type { MemberRow, Project, User } from "../types";
import { Badge, Button, Empty, ErrorBox, TaskSteps } from "../ui";
import { ResourceErrors, useResources, useWorkspace } from "../Workspace";
import { ReadProgressView } from "../ReadProgress";
import { UserLookup } from "../UserLookup";
import { RepositoryMembersDialog } from "../RepositoryMembersDialog";
import { ProjectScope } from "./Repositories";
import { permissionBatchProjects, permissionTaskRows } from "../taskTargets";

const coverageLabels = {
  granted: "有成员授权",
  missing: "未查到成员授权",
  unverified: "访问途径待核实",
  error: "读取失败",
  unread: "未取得结果",
};

/** Query a concrete user within this task's scope, retaining secondary member and sharing operations. */
export function PermissionsPage() {
  const { selectedProjects, selectedIds, writable, setModal, connection } = useWorkspace();
  const [stage, setStage] = useState<"scope" | "objects">("scope");
  const resources = useResources("members", stage === "objects");
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<"all" | MembershipCoverage["status"]>("all");
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [detailId, setDetailId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const scope = JSON.stringify([connection.id, connection.revision, selectedIds]);
  useEffect(() => {
    setChosen(new Set());
    setDetailId(null);
    setRole(null);
    setCoverage("all");
    setPage(1);
  }, [scope]);
  useEffect(() => {
    if (resources.error) {
      setRole(null);
      setChosen(new Set());
    }
  }, [resources.error]);
  const rows = repositoryPermissions(
    selectedProjects,
    resources.data ?? [],
    user,
    resources.error ? errorMessage(resources.error) : undefined,
  );
  const query = search.trim().toLowerCase();
  const searched = rows.filter((row) =>
    [row.project.name, row.project.path_with_namespace].join(" ").toLowerCase().includes(query),
  );
  const filtered = searched.filter(
    (row) =>
      matchesMembershipRole(row.coverage, role) &&
      (coverage === "all" || row.coverage?.status === coverage),
  );
  const blocked = resources.isFetching || !!resources.error;
  const eligible = permissionTaskRows(filtered, !!user);
  const targets = blocked ? [] : permissionBatchProjects(filtered, chosen, !!user);
  const pages = Math.max(1, Math.ceil(filtered.length / 15)),
    current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * 15, current * 15);
  const detail = rows.find((row) => row.project.id === detailId);

  /** Changing a concrete identity clears the role, status and mutation selection together. */
  function chooseUser(value: User | null) {
    setUser(value);
    setRole(null);
    setCoverage("all");
    setChosen(new Set());
    setPage(1);
  }
  /** Preserve exact user IDs and visible selected repositories for the existing real permission planner. */
  function grant(projects: Project[], prefill = true) {
    setDetailId(null);
    setModal({
      type: "permission",
      mode: "grant",
      projects,
      initialUsers: prefill && user ? [user] : undefined,
      initialRole: role !== null && [10, 20, 30, 40].includes(role) ? role : undefined,
    });
  }
  /** Direct edits and revocations keep the existing explicit member targets and inherited safeguards. */
  function edit(memberRows: MemberRow[], mode: "update" | "revoke") {
    setDetailId(null);
    setModal({ type: "permission", mode, rows: memberRows, projects: [memberRows[0].project] });
  }

  if (stage === "scope")
    return (
      <>
        <TaskSteps step={0} />
        <ProjectScope onContinue={() => setStage("objects")} />
      </>
    );
  return (
    <>
      <TaskSteps step={1} />
      <div className="workflow-heading">
        <div>
          <h1>成员权限</h1>
          <p>检查范围 {selectedIds.length} 个仓库。选择具体用户后，按可见最高角色精确筛选。</p>
        </div>
        <Button disabled={resources.isFetching} onClick={() => setStage("scope")}>
          调整仓库范围
        </Button>
      </div>
      <section className="panel">
        <div className="member-query">
          <UserLookup connectionId={connection.id} value={user} onChange={chooseUser} compact />
          <Button
            busy={resources.isFetching}
            onClick={() => {
              setChosen(new Set());
              void resources.refetch();
            }}
          >
            <RefreshCw size={15} />
            刷新权限
          </Button>
        </div>
        <div className="toolbar">
          <input
            className="fill"
            aria-label="搜索授权范围内的仓库"
            placeholder="搜索仓库名称或完整路径"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setChosen(new Set());
              setPage(1);
            }}
          />
          <select
            aria-label="筛选所查用户角色（精确匹配）"
            disabled={!user}
            value={role ?? "all"}
            onChange={(event) => {
              setRole(event.target.value === "all" ? null : Number(event.target.value));
              setCoverage("all");
              setChosen(new Set());
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
            value={coverage}
            onChange={(event) => {
              setCoverage(event.target.value as typeof coverage);
              if (!["all", "granted"].includes(event.target.value)) setRole(null);
              setChosen(new Set());
              setPage(1);
            }}
          >
            <option value="all">全部授权状态</option>
            {Object.entries(coverageLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({searched.filter((row) => row.coverage?.status === value).length})
              </option>
            ))}
          </select>
        </div>
        {resources.isFetching && (
          <ReadProgressView title="正在读取成员权限" progress={resources.progress} />
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
                <th className="check-col">
                  <input
                    type="checkbox"
                    aria-label="选择本组可处理仓库"
                    disabled={blocked || !eligible.length}
                    checked={
                      eligible.length > 0 && eligible.every((row) => chosen.has(row.project.id))
                    }
                    onChange={(event) =>
                      setChosen(
                        new Set(event.target.checked ? eligible.map((row) => row.project.id) : []),
                      )
                    }
                  />
                </th>
                <th>仓库</th>
                <th>{user ? "所查用户角色 / 来源" : "成员概览"}</th>
                <th>读取 / 授权状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.project.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={"选择 " + row.project.path_with_namespace}
                      checked={chosen.has(row.project.id) && eligible.includes(row)}
                      disabled={blocked || !eligible.includes(row)}
                      onChange={(event) =>
                        setChosen((previous) => {
                          const next = new Set(previous);
                          event.target.checked
                            ? next.add(row.project.id)
                            : next.delete(row.project.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="repo-name"
                      disabled={row.members.status !== "ready" || blocked}
                      onClick={() => setDetailId(row.project.id)}
                    >
                      {row.project.name}
                    </button>
                    <small className="cell-note">{row.project.path_with_namespace}</small>
                  </td>
                  <td>
                    {user ? (
                      row.coverage?.status === "granted" ? (
                        <>
                          <Badge>{roleName(row.coverage.member.access_level)}</Badge>
                          <small className="cell-note">{row.coverage.source}</small>
                        </>
                      ) : (
                        "—"
                      )
                    ) : row.members.status === "ready" ? (
                      <>
                        {row.members.data.direct.length} 直接成员
                        <small className="cell-note">
                          {inheritedMembers(row.members.data).length} 继承或共享 ·{" "}
                          {row.members.data.shares.length} 共享群组
                        </small>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {user && row.coverage ? (
                      <>
                        <Badge
                          color={
                            row.coverage.status === "error"
                              ? "red"
                              : row.coverage.status === "granted"
                                ? "green"
                                : "gray"
                          }
                        >
                          {coverageLabels[row.coverage.status]}
                        </Badge>
                        {"reason" in row.coverage && (
                          <small className="cell-note permission-coverage-note">
                            {row.coverage.reason}
                          </small>
                        )}
                      </>
                    ) : row.members.status === "ready" ? (
                      <Badge color="green">读取完成</Badge>
                    ) : row.members.status === "error" ? (
                      <>
                        <Badge color="red">读取失败</Badge>
                        <small className="cell-note">{row.members.message}</small>
                      </>
                    ) : (
                      <Badge>未取得结果</Badge>
                    )}
                  </td>
                  <td>
                    <Button
                      className="small"
                      disabled={row.members.status !== "ready" || blocked}
                      onClick={() => setDetailId(row.project.id)}
                    >
                      查看成员
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty title="没有匹配的仓库">调整用户角色、授权状态或仓库筛选。</Empty>
        )}
        <div className="pagination">
          <span>{filtered.length} 个筛选结果</span>
          <span>
            {current} / {pages} 页
          </span>
          <div className="button-group">
            <Button className="small" disabled={current === 1} onClick={() => setPage(current - 1)}>
              上一页
            </Button>
            <Button
              className="small"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </section>
      <p className="scope-caption">
        只设置项目直接授权；继承或共享由来源群组管理。未查到成员记录不等于绝对无法访问。
      </p>
      <footer className="workflow-footer">
        <span>
          本次选中 <strong>{targets.length}</strong> 个仓库
        </span>
        {!writable && <span className="scope-caption">当前令牌只读，修改需要 api 范围。</span>}
        <div className="button-group">
          <Button disabled={!writable || !targets.length} onClick={() => grant(targets, false)}>
            其他授权 / 群组共享 ({targets.length})
          </Button>
          <Button
            variant="primary"
            disabled={!user || !writable || !targets.length}
            onClick={() => grant(targets)}
          >
            设置所选用户的直接权限
          </Button>
        </div>
      </footer>
      {detail?.members.status === "ready" && (
        <RepositoryMembersDialog
          key={detail.project.id}
          project={detail.project}
          members={detail.members.data}
          writable={writable && !blocked}
          onClose={() => setDetailId(null)}
          onEdit={edit}
          onGrant={() => grant([detail.project], false)}
        />
      )}
    </>
  );
}
