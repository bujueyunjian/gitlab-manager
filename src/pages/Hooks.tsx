import { useState } from "react";
import { ArrowRight, Plus, Search, Trash2 } from "lucide-react";
import { errorMessage } from "../api";
import { eventLabels, uniqueProjects } from "../domain";
import type { HookRow } from "../types";
import { Badge, Button, Dialog, Empty, ErrorBox } from "../ui";
import { ResourceScope, ResourceErrors, useResources, useWorkspace } from "../Workspace";
import { ReadProgressView } from "../ReadProgress";
import { hookOverview } from "../resourceReads";

/** Manage only successfully read, currently visible Hook targets; refreshes block cached write scopes. */
export function HooksPage() {
  const { selected, selectedProjects, writable, setModal, changePage } = useWorkspace();
  const resources = useResources("hooks");
  const [resourceSearch, setResourceSearch] = useState("");
  const [hookEventsFilter, setHookEventsFilter] = useState("all");
  const [hookSelected, setHookSelected] = useState<Set<string>>(new Set());
  const hookKey = (row: HookRow) => `${row.project.id}:${row.hook.id}`;
  const { projects: readableProjects, hooks: hookRows } = hookOverview(
    resources.error ? [] : (resources.data ?? []),
  );
  const shownHooks = hookRows.filter(
    (row) =>
      [row.hook.name, row.hook.url, row.project.path_with_namespace]
        .join(" ")
        .toLowerCase()
        .includes(resourceSearch.toLowerCase()) &&
      (hookEventsFilter === "all" || row.hook[hookEventsFilter as keyof typeof eventLabels]),
  );

  const chosen = shownHooks.filter((row) => hookSelected.has(hookKey(row)));
  const busyOrFailed = resources.isFetching || !!resources.error;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Webhook</h1>
          <p>查看所选仓库的配置，统一补齐、修改或删除。</p>
        </div>
        <Button
          variant="primary"
          disabled={!readableProjects.length || !writable || busyOrFailed}
          onClick={() => setModal({ type: "hook", mode: "ensure", projects: readableProjects })}
        >
          <Plus size={16} />
          批量设置 ({readableProjects.length})
        </Button>
      </div>
      {<ResourceScope refresh={() => void resources.refetch()} fetching={resources.isFetching} />}
      {!selected.size ? (
        <Empty
          title="先选择要查看的仓库"
          action={
            <Button variant="primary" onClick={() => changePage("repos")}>
              选择仓库
              <ArrowRight size={15} />
            </Button>
          }
        >
          也可以粘贴多个仓库地址或应用名，一次定位。
        </Empty>
      ) : (
        <section className="panel">
          <div className="toolbar">
            <div className="search-box">
              <Search size={16} />
              <input
                aria-label="搜索 Webhook"
                value={resourceSearch}
                onChange={(e) => setResourceSearch(e.target.value)}
                placeholder="搜索名称、地址或仓库"
              />
            </div>
            <select
              aria-label="筛选触发事件"
              value={hookEventsFilter}
              onChange={(e) => setHookEventsFilter(e.target.value)}
            >
              <option value="all">全部触发事件</option>
              {Object.entries(eventLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {chosen.length > 0 && (
            <div className="selection-bar">
              已选 {chosen.length} 条配置
              <div className="button-group">
                <Button
                  className="small"
                  disabled={!writable || busyOrFailed}
                  onClick={() =>
                    setModal({
                      type: "hook",
                      mode: "update",
                      rows: chosen,
                      projects: uniqueProjects(chosen),
                    })
                  }
                >
                  批量修改
                </Button>
                <Button
                  className="small"
                  disabled={!writable || busyOrFailed}
                  onClick={() =>
                    setModal({
                      type: "hook",
                      mode: "delete",
                      rows: chosen,
                      projects: uniqueProjects(chosen),
                    })
                  }
                >
                  <Trash2 size={14} />
                  批量删除
                </Button>
              </div>
            </div>
          )}
          {resources.isFetching && (
            <ReadProgressView title="正在读取 Webhook" progress={resources.progress} />
          )}
          {resources.isPending ? null : resources.error ? (
            <ErrorBox message={errorMessage(resources.error)} />
          ) : (
            <>
              {
                <ResourceErrors
                  resources={resources.data ?? []}
                  kind="hooks"
                  projects={selectedProjects}
                />
              }
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="check-col">
                        <input
                          type="checkbox"
                          aria-label="选择筛选后的 Webhook"
                          disabled={busyOrFailed}
                          checked={
                            shownHooks.length > 0 &&
                            shownHooks.every((row) => hookSelected.has(hookKey(row)))
                          }
                          onChange={(e) =>
                            setHookSelected((previous) => {
                              const next = new Set(previous);
                              shownHooks.forEach((row) =>
                                e.target.checked
                                  ? next.add(hookKey(row))
                                  : next.delete(hookKey(row)),
                              );
                              return next;
                            })
                          }
                        />
                      </th>
                      <th>Webhook / 目标地址</th>
                      <th>仓库</th>
                      <th>触发事件</th>
                      <th>TLS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownHooks.map((row) => (
                      <tr key={hookKey(row)}>
                        <td className="check-col">
                          <input
                            type="checkbox"
                            aria-label={`选择 Hook ${row.hook.id} · ${row.project.path_with_namespace}`}
                            disabled={busyOrFailed}
                            checked={hookSelected.has(hookKey(row))}
                            onChange={(e) =>
                              setHookSelected((previous) => {
                                const next = new Set(previous);
                                e.target.checked
                                  ? next.add(hookKey(row))
                                  : next.delete(hookKey(row));
                                return next;
                              })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="repo-name"
                            disabled={busyOrFailed}
                            onClick={() =>
                              setModal({
                                type: "hookDetail",
                                row,
                              })
                            }
                          >
                            {row.hook.name ?? "未命名 Webhook"}
                          </button>
                          <p className="url-text" title={row.hook.url}>
                            {row.hook.url}
                          </p>
                        </td>
                        <td>
                          <span>{row.project.path_with_namespace}</span>
                          <small className="cell-note">Hook #{row.hook.id}</small>
                        </td>
                        <td>
                          <div className="event-tags">
                            {Object.entries(eventLabels)
                              .filter(([key]) => row.hook[key as keyof typeof eventLabels])
                              .map(([key, label]) => (
                                <span className="event-tag" key={key}>
                                  {label}
                                </span>
                              ))}
                          </div>
                        </td>
                        <td>
                          <Badge color={row.hook.enable_ssl_verification ? "green" : "amber"}>
                            {row.hook.enable_ssl_verification ? "已开启" : "未开启"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!shownHooks.length && (
                <Empty
                  title={
                    readableProjects.length
                      ? "成功读取的仓库中没有匹配的 Webhook"
                      : "没有成功读取的仓库"
                  }
                >
                  {readableProjects.length
                    ? "调整筛选，或在成功读取的仓库范围使用“批量设置”；失败项见上方说明。"
                    : "检查上方读取错误后刷新，再进行配置。"}
                </Empty>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}

export function HookDetails({ row, onClose }: { row: HookRow; onClose: () => void }) {
  const { writable, setModal } = useWorkspace();
  const { hook, project } = row;
  const events = Object.entries(eventLabels)
    .filter(([key]) => hook[key as keyof typeof eventLabels])
    .map(([, label]) => label);
  const authentication =
    hook.signing_token_present === true
      ? "签名令牌"
      : hook.token_present === true
        ? "接收端密钥"
        : hook.token_present === false && hook.signing_token_present === false
          ? "未设置"
          : "当前 GitLab 版本未提供认证状态";
  return (
    <Dialog
      title={hook.name ?? "未命名 Webhook"}
      description={project.path_with_namespace}
      drawer
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            disabled={!writable}
            onClick={() =>
              setModal({ type: "hook", mode: "update", rows: [row], projects: [project] })
            }
          >
            修改配置
          </Button>
        </>
      }
    >
      <dl className="detail-grid">
        <div className="full">
          <dt>目标地址</dt>
          <dd className="wrap-cell">{hook.url}</dd>
        </div>
        <div className="full">
          <dt>触发事件</dt>
          <dd>{events.length ? events.join("、") : "未启用事件"}</dd>
        </div>
        <div>
          <dt>TLS 证书校验</dt>
          <dd>{hook.enable_ssl_verification ? "已开启" : "未开启"}</dd>
        </div>
        <div>
          <dt>配置 ID</dt>
          <dd>{hook.id}</dd>
        </div>
        <div className="full">
          <dt>认证</dt>
          <dd>{authentication}</dd>
        </div>
      </dl>
    </Dialog>
  );
}
