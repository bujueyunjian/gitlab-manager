import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FolderGit2, Link2, RefreshCw, Search } from "lucide-react";
import { api, errorMessage } from "../api";
import { accessLevel, roleName, tokenScopeLabel } from "../domain";
import type { ProjectFilter } from "../types";
import { Badge, Button, Empty, ErrorBox, Loading, OrbitDecoration } from "../ui";
import { SelectionBar, useWorkspace } from "../Workspace";

/** Repository selection persists across pages; search and paging are local view state. */
export function RepositoriesPage() {
  const { connection, selected, setSelected, setModal, chooseProject } = useWorkspace();
  const [filter, setFilter] = useState<ProjectFilter>({
    search: "",
    archived: false,
    minAccessLevel: null,
  });
  const [searchInput, setSearchInput] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const projects = useQuery({
    queryKey: ["projects", connection.id, filter],
    queryFn: () => api.projects(connection.id, filter),
  });

  const all = projects.data ?? [];
  const pageSize = 15,
    pages = Math.max(1, Math.ceil(all.length / pageSize)),
    currentPage = Math.min(pageIndex, pages);
  const visible = all.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  return (
    <>
      <div className="page-heading">
        <OrbitDecoration />
        <div>
          <h1>仓库</h1>
          <p>选择要处理的仓库，批量管理成员权限和 Webhook。</p>
        </div>
        <div className="heading-actions">
          <Button onClick={() => setModal({ type: "resolve" })}>
            <Link2 size={16} />
            批量粘贴地址 / 应用名
          </Button>
          <Button busy={projects.isFetching} onClick={() => void projects.refetch()}>
            <RefreshCw size={15} />
            刷新
          </Button>
        </div>
      </div>
      <div className="context-bar">
        <span>{connection?.name}</span>
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
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ ...filter, search: searchInput.trim() });
            setPageIndex(1);
          }}
        >
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索仓库"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索仓库名称或项目路径"
            />
          </div>
          <Button type="submit">搜索</Button>
          <select
            aria-label="仓库归档状态"
            value={filter.archived === null ? "all" : filter.archived ? "archived" : "active"}
            onChange={(e) => {
              setFilter({
                ...filter,
                archived: e.target.value === "all" ? null : e.target.value === "archived",
              });
              setPageIndex(1);
            }}
          >
            <option value="active">活跃仓库</option>
            <option value="archived">已归档</option>
            <option value="all">全部状态</option>
          </select>
          <select
            aria-label="仓库管理权限筛选"
            value={filter.minAccessLevel ?? "all"}
            onChange={(e) => {
              setFilter({
                ...filter,
                minAccessLevel: e.target.value === "all" ? null : Number(e.target.value),
              });
              setPageIndex(1);
            }}
          >
            <option value="all">全部角色</option>
            <option value="40">可管理仓库</option>
            <option value="30">Developer 及以上</option>
          </select>
        </form>
        {selected.size > 0 && <SelectionBar />}
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
                    <th>可见性</th>
                    <th>状态</th>
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
            <Empty title="没有匹配到可访问的仓库">
              调整搜索条件，或粘贴完整仓库地址来定位项目。
            </Empty>
          )
        )}
      </section>
      <div className="page-foot">
        列表显示已加入的仓库，也可粘贴完整地址定位其他仓库。筛选不会清除已选范围。
      </div>
    </>
  );
}
