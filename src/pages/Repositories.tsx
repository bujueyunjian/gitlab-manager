import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderGit2, Link2, RefreshCw, Search } from "lucide-react";
import { api, errorMessage } from "../api";
import { accessLevel, roleName, roles, supportsWebhookNames, tokenScopeLabel } from "../domain";
import type {
  Project,
  ProjectFilter,
  ProjectWebhookCheck,
  User,
  WebhookPresenceFilter,
  WebhookQuery,
} from "../types";
import { useWebhookChecks } from "../useWebhookChecks";
import {
  filterWebhookProjects,
  missingWebhookTargets,
  uniqueWebhookTargets,
} from "../webhookChecks";
import { repositoryPermissions, matchesMembershipRole } from "../permissionOverview";
import type { MembershipCoverage } from "../permissionOverview";
import { searchRepositories } from "../repositorySearch";
import { UserLookup } from "../UserLookup";
import { useReadProgress } from "../useReadProgress";
import { ReadProgressView } from "../ReadProgress";
import { Badge, Button, Empty, ErrorBox, Loading } from "../ui";
import { SelectionBar, useWorkspace } from "../Workspace";

const membershipLabels = {
  granted: "有成员授权",
  missing: "未查到成员授权",
  unverified: "访问途径待核实",
  error: "读取失败",
  unread: "未取得结果",
};

/** Show the queried user's role independently of the signed-in account's permissions. */
function UserRoleBadge({ coverage }: { coverage: MembershipCoverage | null | undefined }) {
  if (!coverage) return <Badge>待查询</Badge>;
  if (coverage.status === "granted")
    return (
      <>
        <Badge color="accent">{roleName(coverage.member.access_level)}</Badge>
        <small className="cell-note">{coverage.source}</small>
      </>
    );
  return (
    <span title={"reason" in coverage ? coverage.reason : undefined}>
      <Badge color={coverage.status === "error" ? "red" : "amber"}>
        {membershipLabels[coverage.status]}
      </Badge>
      {coverage.status === "error" && (
        <small className="cell-note permission-coverage-note">{coverage.reason}</small>
      )}
    </span>
  );
}

/** Expose each matching hook's ID and address so duplicate names cannot authorize an implicit overwrite. */
function WebhookStatusBadge({
  result,
  project,
  query,
}: {
  result: ProjectWebhookCheck | undefined;
  project: Project;
  query: WebhookQuery;
}) {
  const { setModal } = useWorkspace();
  if (!result) return <Badge>未检查</Badge>;
  if (result.status === "missing") return <Badge color="amber">未维护</Badge>;
  if (result.status === "error")
    return (
      <span className="webhook-inspection-error">
        <Badge color="red">检查失败</Badge>
        <small>{result.message}</small>
      </span>
    );
  return (
    <details className="hook-matches">
      <summary>
        <Badge color={result.count > 1 ? "amber" : "green"}>
          {result.count > 1 ? "多条匹配" : query.field === "name" ? "已匹配" : "已维护"} ·{" "}
          {result.count} 条
        </Badge>
      </summary>
      <ul>
        {result.hooks.map((hook) => (
          <li key={hook.id}>
            <button
              className="text-btn"
              aria-label={"查看 Hook " + hook.id + " · " + project.path_with_namespace}
              onClick={() => setModal({ type: "hookDetail", row: { project, hook } })}
            >
              #{hook.id} · {hook.name ?? "Webhook"}
            </button>
            <small>{hook.url}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Query repositories first, then filter by an explicit user's role or exact webhook identity. */
export function RepositoriesPage({ resourceRevision }: { resourceRevision: number }) {
  const { connection, selected, setSelected, setModal, chooseProject } = useWorkspace();
  const [mode, setMode] = useState<"repositories" | "members" | "hooks">("repositories");
  const [filter, setFilter] = useState<ProjectFilter>({
    search: "",
    archived: false,
    accessLevel: null,
  });
  const [searchInput, setSearchInput] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [inspectionRevision, setInspectionRevision] = useState(0);
  const listingFilter = mode === "members" ? { ...filter, accessLevel: null } : filter;
  const projects = useQuery({
    queryKey: ["projects", connection.id, listingFilter],
    queryFn: () => searchRepositories(connection.id, listingFilter),
  });
  const matchedProjects = projects.data ?? [];
  const inspectionScope = JSON.stringify([
    connection.revision,
    listingFilter,
    resourceRevision,
    inspectionRevision,
    matchedProjects.map((project) => project.id),
  ]);
  const [user, setUser] = useState<User | null>(null);
  const [userRole, setUserRole] = useState<number | null>(null);
  const [memberStatus, setMemberStatus] = useState<"all" | MembershipCoverage["status"]>("all");
  const progress = useReadProgress("home-members:" + inspectionScope);
  const members = useQuery({
    queryKey: ["resources", "home-members", connection.id, inspectionScope],
    queryFn: () =>
      progress.track(matchedProjects.length, (report) =>
        api.resources(
          connection.id,
          matchedProjects.map((project) => project.id),
          "members",
          report,
        ),
      ),
    enabled: false,
  });
  useEffect(() => {
    if (members.error) setUserRole(null);
  }, [members.error]);
  const memberRows = repositoryPermissions(
    matchedProjects,
    members.data ?? [],
    user,
    members.error ? errorMessage(members.error) : undefined,
  );
  const memberById = new Map(memberRows.map((row) => [row.project.id, row]));
  const failedMemberCount = memberRows.filter((row) => row.members.status === "error").length;
  const [webhookQuery, setWebhookQuery] = useState<WebhookQuery>({ field: "url", value: "" });
  const [presence, setPresence] = useState<WebhookPresenceFilter>("all");
  const checks = useWebhookChecks(connection.id, inspectionScope);
  const namesSupported = supportsWebhookNames(connection.version);
  useEffect(() => {
    setPresence("all");
    setUserRole(null);
    setMemberStatus("all");
    setPageIndex(1);
  }, [inspectionScope]);

  const all =
    mode === "members"
      ? memberRows
          .filter(
            (row) =>
              matchesMembershipRole(row.coverage, userRole) &&
              (memberStatus === "all" || row.coverage?.status === memberStatus),
          )
          .map((row) => row.project)
      : mode === "hooks"
        ? filterWebhookProjects(matchedProjects, checks.results, presence)
        : matchedProjects;
  const missing = filterWebhookProjects(matchedProjects, checks.results, "missing");
  const selectedMissing = missingWebhookTargets(all, checks.results, selected);
  const selectedMatches = uniqueWebhookTargets(all, checks.results, selected);
  const operationScope = all.filter(
    (project) =>
      selected.has(project.id) &&
      (mode !== "members" ||
        ["granted", "missing"].includes(memberById.get(project.id)?.coverage?.status ?? "")),
  );
  const pageSize = 15,
    pages = Math.max(1, Math.ceil(all.length / pageSize)),
    currentPage = Math.min(pageIndex, pages);
  const visible = all.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  /** Identity changes reset role filters, while the same complete member snapshot can serve another user. */
  function chooseUser(value: User | null) {
    setUser(value);
    setUserRole(null);
    setMemberStatus("all");
    setPageIndex(1);
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>仓库</h1>
          <p>先按用户角色或 Webhook 查找仓库，再对筛选结果执行批量操作。</p>
        </div>
        <div className="heading-actions">
          <Button onClick={() => setModal({ type: "resolve" })}>
            <Link2 size={16} />
            批量粘贴地址 / 应用名
          </Button>
          <Button
            busy={projects.isFetching}
            onClick={() => {
              checks.reset();
              setInspectionRevision((revision) => revision + 1);
              setPresence("all");
              void projects.refetch();
            }}
          >
            <RefreshCw size={15} />
            刷新
          </Button>
        </div>
      </div>
      <div className="context-bar">
        <span>{connection.name}</span>
        <span className="separator" />
        <span>
          <b>{projects.data ? all.length : "—"}</b> 个匹配仓库
        </span>
        <span className="separator" />
        <span>
          <b>{selected.size}</b> 个已选
        </span>
        <span className="context-end">{tokenScopeLabel(connection.scopes)}</span>
      </div>
      <section className="panel">
        <div className="tabs" role="tablist" aria-label="仓库查询方式">
          {(
            [
              ["repositories", "仓库列表"],
              ["members", "用户权限"],
              ["hooks", "Webhook"],
            ] as const
          ).map(([value, label]) => (
            <button
              role="tab"
              aria-selected={mode === value}
              className={"tab " + (mode === value ? "active" : "")}
              key={value}
              onClick={() => {
                if (mode === "hooks") checks.stop();
                setMode(value);
                setPageIndex(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setFilter({ ...filter, search: searchInput.trim() });
            setPageIndex(1);
          }}
        >
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索仓库"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="仓库名称、完整路径或 Git 仓库地址"
            />
          </div>
          <Button type="submit">搜索</Button>
          <select
            aria-label="仓库归档状态"
            value={filter.archived === null ? "all" : filter.archived ? "archived" : "active"}
            onChange={(event) => {
              setFilter({
                ...filter,
                archived: event.target.value === "all" ? null : event.target.value === "archived",
              });
              setPageIndex(1);
            }}
          >
            <option value="active">活跃仓库</option>
            <option value="archived">已归档</option>
            <option value="all">全部状态</option>
          </select>
          {mode !== "members" && (
            <select
              aria-label="仓库角色筛选（精确匹配）"
              value={filter.accessLevel ?? "all"}
              onChange={(event) => {
                setFilter({
                  ...filter,
                  accessLevel: event.target.value === "all" ? null : Number(event.target.value),
                });
                setPageIndex(1);
              }}
            >
              <option value="all">我的全部角色</option>
              {[10, 20, 30, 40, 50].map((level) => (
                <option value={level} key={level}>
                  我的角色：{roleName(level)}
                </option>
              ))}
            </select>
          )}
        </form>
        {mode === "members" && (
          <>
            <div className="toolbar home-members-toolbar">
              <UserLookup connectionId={connection.id} value={user} onChange={chooseUser} compact />
              <Button
                variant="primary"
                disabled={!user || !matchedProjects.length || projects.isFetching}
                busy={members.isFetching}
                onClick={() => void members.refetch()}
              >
                检查用户角色 ({matchedProjects.length})
              </Button>
              <select
                aria-label="用户角色筛选（精确匹配）"
                disabled={!user || !members.data || !!members.error}
                value={userRole ?? "all"}
                onChange={(event) => {
                  setUserRole(event.target.value === "all" ? null : Number(event.target.value));
                  if (event.target.value !== "all") setMemberStatus("all");
                  setPageIndex(1);
                }}
              >
                <option value="all">用户全部角色</option>
                {Object.entries(roles).map(([level, label]) => (
                  <option key={level} value={level}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="用户授权状态筛选"
                disabled={!user || (!members.data && !members.error)}
                value={memberStatus}
                onChange={(event) => {
                  setMemberStatus(event.target.value as typeof memberStatus);
                  if (!["all", "granted"].includes(event.target.value)) setUserRole(null);
                  setPageIndex(1);
                }}
              >
                <option value="all">全部授权状态</option>
                {Object.entries(membershipLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label} ({memberRows.filter((row) => row.coverage?.status === value).length})
                  </option>
                ))}
              </select>
              {user && members.data && !members.error && failedMemberCount > 0 && (
                <button
                  className="text-btn"
                  onClick={() => {
                    setUserRole(null);
                    setMemberStatus("error");
                    setPageIndex(1);
                  }}
                >
                  读取失败 ({failedMemberCount})
                </button>
              )}
            </div>
            {members.isFetching && (
              <ReadProgressView title="正在检查用户角色" progress={progress.state} />
            )}
            {members.error && <ErrorBox message={errorMessage(members.error)} />}
            <p className="permission-scope-note home-members-note">
              所查用户按可见最高角色精确筛选；仅设置项目直接授权，继承权限由群组管理；失败或待核实项不进入批量授权。
            </p>
          </>
        )}
        {mode === "hooks" && (
          <form
            className="webhook-inspection"
            onSubmit={(event) => {
              event.preventDefault();
              setPageIndex(1);
              void checks.start(
                matchedProjects.map((project) => project.id),
                webhookQuery,
              );
            }}
          >
            <div className="webhook-inspection-heading">
              <strong>查找已维护的 Webhook</strong>
              <span>
                {namesSupported
                  ? "按完整地址或名称精确匹配；展开结果核对具体配置。"
                  : "当前版本不提供 Webhook 名称，请按完整地址查询。"}
              </span>
            </div>
            <div className="webhook-inspection-controls">
              <select
                aria-label="Webhook 查询字段"
                value={webhookQuery.field}
                onChange={(event) => {
                  setWebhookQuery({
                    field: event.target.value as WebhookQuery["field"],
                    value: "",
                  });
                  checks.reset();
                  setPresence("all");
                  setPageIndex(1);
                }}
              >
                <option value="url">完整地址</option>
                <option value="name" disabled={!namesSupported}>
                  名称（GitLab 17.1+）
                </option>
              </select>
              <input
                type={webhookQuery.field === "url" ? "url" : "text"}
                aria-label={webhookQuery.field === "url" ? "Webhook 检查地址" : "Webhook 检查名称"}
                placeholder={
                  webhookQuery.field === "url"
                    ? "https://hooks.example.com/gitlab"
                    : "例如：Code Review"
                }
                value={webhookQuery.value}
                onChange={(event) => {
                  setWebhookQuery({ ...webhookQuery, value: event.target.value });
                  checks.reset();
                  setPresence("all");
                  setPageIndex(1);
                }}
                spellCheck={false}
              />
              <Button
                type="submit"
                busy={checks.checking}
                disabled={
                  !matchedProjects.length ||
                  projects.isFetching ||
                  !webhookQuery.value.trim() ||
                  (webhookQuery.field === "name" && !namesSupported)
                }
              >
                检查项目范围 ({matchedProjects.length})
              </Button>
              {checks.checking && (
                <Button type="button" disabled={checks.cancelled} onClick={checks.stop}>
                  {checks.cancelled ? "正在停止…" : "停止检查"}
                </Button>
              )}
            </div>
            {checks.target && (
              <div className="webhook-inspection-progress" aria-live="polite">
                <progress
                  aria-label="Webhook 检查进度"
                  value={checks.completed}
                  max={checks.total}
                />
                <span>
                  已检查 {checks.completed} / {checks.total}
                  {checks.cancelled ? " · 已停止后续检查" : checks.checking ? " · 检查中" : ""}
                </span>
              </div>
            )}
            {checks.error && <ErrorBox message={checks.error} />}
            {checks.target && (
              <div className="webhook-inspection-results">
                <select
                  aria-label="Webhook 维护状态筛选"
                  value={presence}
                  onChange={(event) => {
                    setPresence(event.target.value as WebhookPresenceFilter);
                    setPageIndex(1);
                  }}
                >
                  {(
                    [
                      ["all", "全部维护状态"],
                      ["present", "已匹配"],
                      ["duplicate", "多条匹配"],
                      ["missing", "未维护"],
                      ["error", "检查失败"],
                      ["unchecked", "未检查"],
                    ] as const
                  ).map(([status, label]) => (
                    <option key={status} value={status}>
                      {label} (
                      {filterWebhookProjects(matchedProjects, checks.results, status).length})
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  disabled={checks.checking || !missing.length}
                  onClick={() => {
                    setSelected(new Map(missing.map((project) => [project.id, project])));
                    setPresence("missing");
                    setPageIndex(1);
                  }}
                >
                  仅选择未维护 ({missing.length})
                </Button>
                <small>
                  名称不代表唯一配置。多条匹配需展开选择；批量修改只处理唯一匹配，新增前会重查同名或同址配置。
                </small>
              </div>
            )}
          </form>
        )}
        {selected.size > 0 && (
          <SelectionBar
            scope={operationScope}
            user={mode === "members" ? user : undefined}
            role={mode === "members" ? userRole : undefined}
            permissionChecking={
              mode === "members" &&
              (!user || members.isFetching || !members.data || !!members.error)
            }
            inspection={
              mode === "hooks" && checks.target
                ? {
                    query: checks.target,
                    targets: selectedMissing,
                    matches: selectedMatches,
                    checking: checks.checking,
                  }
                : undefined
            }
          />
        )}
        {projects.error && <ErrorBox message={errorMessage(projects.error)} />}
        {projects.isPending ? (
          <Loading>正在读取仓库…</Loading>
        ) : all.length > 0 ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="check-col">
                      <input
                        type="checkbox"
                        aria-label="选择当前页仓库"
                        checked={
                          visible.length > 0 && visible.every((project) => selected.has(project.id))
                        }
                        onChange={(e) =>
                          setSelected((previous) => {
                            const next = new Map(previous);
                            for (const project of visible)
                              e.target.checked
                                ? next.set(project.id, project)
                                : next.delete(project.id);
                            return next;
                          })
                        }
                      />
                    </th>
                    <th>仓库</th>
                    <th>我的角色</th>
                    {mode === "members" && user && <th>所查用户角色</th>}
                    <th>可见性</th>
                    <th>状态</th>
                    {mode === "hooks" && checks.target && <th>Webhook 维护状态</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((project) => (
                    <tr className={selected.has(project.id) ? "selected-row" : ""} key={project.id}>
                      <td className="check-col">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${project.path_with_namespace}`}
                          checked={selected.has(project.id)}
                          onChange={(e) => chooseProject(project, e.target.checked)}
                        />
                      </td>
                      <td>
                        <div className="repo-cell">
                          <span className="repo-icon">
                            <FolderGit2 size={19} />
                          </span>
                          <div>
                            <button
                              className="repo-name"
                              onClick={() => setModal({ type: "project", project })}
                            >
                              {project.name}
                            </button>
                            <div className="repo-path">{project.path_with_namespace}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Badge color={(accessLevel(project) ?? 0) >= 40 ? "accent" : "gray"}>
                          {roleName(accessLevel(project))}
                        </Badge>
                      </td>
                      {mode === "members" && user && (
                        <td>
                          <UserRoleBadge coverage={memberById.get(project.id)?.coverage} />
                        </td>
                      )}
                      <td>
                        <span className="subtle">
                          {project.visibility === "private"
                            ? "私有"
                            : project.visibility === "public"
                              ? "公开"
                              : "内部"}
                        </span>
                      </td>
                      <td>
                        <Badge color={project.archived ? "gray" : "green"}>
                          {project.archived ? "已归档" : "活跃"}
                        </Badge>
                      </td>
                      {mode === "hooks" && checks.target && (
                        <td>
                          <WebhookStatusBadge
                            result={checks.results.get(project.id)}
                            project={project}
                            query={checks.target!}
                          />
                        </td>
                      )}
                      <td>
                        <button
                          className="icon-btn"
                          aria-label={`查看 ${project.path_with_namespace}`}
                          onClick={() => setModal({ type: "project", project })}
                        >
                          <ChevronRight size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <button
                className="text-btn"
                onClick={() =>
                  setSelected(
                    (previous) =>
                      new Map([
                        ...previous,
                        ...all.map((project) => [project.id, project] as const),
                      ]),
                  )
                }
              >
                选择全部 {all.length} 个筛选结果
              </button>
              <span>
                {currentPage} / {pages} 页
              </span>
              <div className="pages">
                <Button
                  className="small"
                  disabled={currentPage === 1}
                  onClick={() => setPageIndex(currentPage - 1)}
                >
                  上一页
                </Button>
                <Button
                  className="small"
                  disabled={currentPage === pages}
                  onClick={() => setPageIndex(currentPage + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        ) : (
          !projects.error && (
            <Empty
              title={matchedProjects.length ? "当前筛选没有匹配的仓库" : "没有匹配到可访问的仓库"}
            >
              {matchedProjects.length
                ? mode === "members"
                  ? "可调整用户角色或授权状态；未取得结果和读取失败的项目不会被判定为缺少授权。"
                  : "可切换维护状态查看其他结果；未检查或读取失败的项目不会被判定为未维护。"
                : "调整搜索条件，或粘贴完整仓库地址来定位项目。"}
            </Empty>
          )
        )}
      </section>
      <div className="page-foot">
        默认显示已加入的仓库；搜索完整地址可定位其他有权访问的仓库。批量操作使用当前筛选中的已选仓库。
      </div>
    </>
  );
}
