import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2, Link2, Search } from "lucide-react";
import { errorMessage } from "../api";
import { accessLevel, roleName, roles } from "../domain";
import { searchRepositories } from "../repositorySearch";
import type { ProjectFilter } from "../types";
import { Badge, Button, Empty, ErrorBox, Loading } from "../ui";
import { useWorkspace } from "../Workspace";

/** Choose this task's repository scope without carrying another task's selection. */
export function ProjectScope({ onContinue }: { onContinue: () => void }) {
  const { connection, selected, selectedProjects, setSelected, setModal, chooseProject, active } =
    useWorkspace();
  const [filter, setFilter] = useState<ProjectFilter>({
    search: "",
    archived: false,
    accessLevel: null,
  });
  const [input, setInput] = useState("");
  const [page, setPage] = useState(1);
  const projects = useQuery({
    queryKey: ["projects", connection.id, connection.revision, filter],
    queryFn: () => searchRepositories(connection.id, filter),
    enabled: active,
  });
  const rows = projects.data ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / 15));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * 15, current * 15);
  return (
    <>
      <div className="workflow-heading">
        <div>
          <h1>选择仓库范围</h1>
          <p>搜索仓库，或粘贴已有清单。</p>
        </div>
        <Button onClick={() => setModal({ type: "resolve" })}>
          <Link2 size={16} />
          批量粘贴
        </Button>
      </div>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setFilter({ ...filter, search: input.trim() });
            setPage(1);
          }}
        >
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索仓库"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="名称、完整路径或 Git 仓库地址"
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
              setPage(1);
            }}
          >
            <option value="active">活跃仓库</option>
            <option value="archived">已归档</option>
            <option value="all">全部状态</option>
          </select>
          <select
            aria-label="我的角色筛选（精确匹配）"
            value={filter.accessLevel ?? "all"}
            onChange={(event) => {
              setFilter({
                ...filter,
                accessLevel: event.target.value === "all" ? null : Number(event.target.value),
              });
              setPage(1);
            }}
          >
            <option value="all">我的全部角色</option>
            {Object.entries(roles).map(([level, label]) => (
              <option key={level} value={level}>
                {label}
              </option>
            ))}
          </select>
        </form>
        {projects.error && <ErrorBox message={errorMessage(projects.error)} />}
        {projects.isPending ? (
          <Loading>正在读取仓库…</Loading>
        ) : (
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
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = new Map(previous);
                            for (const project of visible)
                              event.target.checked
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
                    <tr key={project.id} className={selected.has(project.id) ? "selected-row" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={"选择 " + project.path_with_namespace}
                          checked={selected.has(project.id)}
                          onChange={(event) => chooseProject(project, event.target.checked)}
                        />
                      </td>
                      <td>
                        <div className="repo-cell">
                          <FolderGit2 size={18} />
                          <div>
                            <button
                              className="repo-name"
                              onClick={() => setModal({ type: "project", project })}
                            >
                              {project.name}
                            </button>
                            <small className="cell-note">{project.path_with_namespace}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Badge>{roleName(accessLevel(project))}</Badge>
                      </td>
                      <td>
                        {project.visibility === "private"
                          ? "私有"
                          : project.visibility === "public"
                            ? "公开"
                            : "内部"}
                      </td>
                      <td>{project.archived ? "已归档" : "活跃"}</td>
                      <td>
                        <Button
                          className="small"
                          onClick={() => setModal({ type: "project", project })}
                        >
                          详情
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && !projects.error && (
              <Empty title="没有匹配的仓库">调整条件，或粘贴完整仓库地址定位。</Empty>
            )}
            <div className="pagination">
              <button
                className="text-btn"
                onClick={() =>
                  setSelected(
                    (previous) =>
                      new Map([
                        ...previous,
                        ...rows.map((project) => [project.id, project] as const),
                      ]),
                  )
                }
              >
                选择全部 {rows.length} 个筛选结果
              </button>
              <span>
                {current} / {pages} 页
              </span>
              <div className="button-group">
                <Button
                  className="small"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                >
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
          </>
        )}
      </section>
      <details className="selected-scope">
        <summary>本次范围 {selected.size} 个仓库</summary>
        {selectedProjects.map((project) => (
          <div className="scope-item" key={project.id}>
            <span>{project.path_with_namespace}</span>
            <button className="text-btn" onClick={() => chooseProject(project, false)}>
              移除
            </button>
          </div>
        ))}
      </details>
      <p className="scope-caption">
        默认列出当前账号已加入的仓库；完整地址可补查其他有权访问项目。
      </p>
      <footer className="workflow-footer">
        <span>
          本次范围 <strong>{selected.size}</strong> 个仓库
        </span>
        <Button
          variant="primary"
          disabled={!selected.size || projects.isFetching}
          onClick={onContinue}
        >
          下一步：检查范围
        </Button>
      </footer>
    </>
  );
}
