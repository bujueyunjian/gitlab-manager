import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { errorMessage } from "../api";
import { eventLabels, supportsWebhookNames, uniqueProjects } from "../domain";
import type { HookRow, WebhookQuery } from "../types";
import { Button, Dialog, Empty, ErrorBox, TaskSteps } from "../ui";
import { ResourceErrors, useResources, useWorkspace } from "../Workspace";
import { ReadProgressView } from "../ReadProgress";
import { hookOverview } from "../resourceReads";
import { useWebhookChecks } from "../useWebhookChecks";
import { webhookBatch, webhookTaskRows } from "../taskTargets";
import type { HookGroup } from "../taskTargets";
import { ProjectScope } from "./Repositories";

/** Inspect a task-local range, then configure only the explicitly selected readable objects. */
export function HooksPage({ resourceRevision }: { resourceRevision: number }) {
  const { connection, selectedProjects, selectedIds, writable, setModal, runOperation } =
    useWorkspace();
  const [stage, setStage] = useState<"scope" | "objects">("scope");
  const [query, setQuery] = useState<WebhookQuery>({ field: "url", value: "" });
  const [group, setGroup] = useState<HookGroup>("missing");
  const [includeExisting, setIncludeExisting] = useState(false);
  const [selected, setChosen] = useState<Set<number>>(new Set());
  const [choices, setChoices] = useState<Map<number, number>>(new Map());
  const [inventory, setInventory] = useState(false);
  const [search, setSearch] = useState("");
  const [inventorySelected, setInventorySelected] = useState<Set<string>>(new Set());
  const [inspection, setInspection] = useState(0);
  const [operationError, setOperationError] = useState<string | null>(null);
  const scope = JSON.stringify([
    connection.id,
    connection.revision,
    selectedIds,
    resourceRevision,
    inspection,
  ]);
  const checks = useWebhookChecks(connection.id, scope);
  const resources = useResources("hooks", stage === "objects" && inventory);
  const namesSupported = supportsWebhookNames(connection.version);
  useEffect(() => {
    if (!namesSupported && query.field === "name") {
      setQuery({ field: "url", value: "" });
      checks.reset();
      setChosen(new Set());
    }
  }, [namesSupported, query.field]);
  const rows = webhookTaskRows(selectedProjects, checks.results, group, includeExisting, choices);
  const batch = checks.target ? webhookBatch(rows, selected, checks.target) : null;
  const counts = { missing: 0, present: 0, needs: 0 };
  for (const project of selectedProjects) {
    const result = checks.results.get(project.id);
    counts[
      result?.status === "missing"
        ? "missing"
        : result?.status === "present" && result.hooks.length === 1
          ? "present"
          : "needs"
    ]++;
  }
  useEffect(() => {
    setChosen(new Set());
    setChoices(new Map());
    setInventorySelected(new Set());
    setIncludeExisting(false);
  }, [scope]);
  /** An explicit group change clears hidden targets instead of silently retaining them. */
  function chooseGroup(value: HookGroup) {
    setGroup(value);
    setChosen(new Set());
    setIncludeExisting(false);
  }
  /** Preserve the checked mixed scope, including each existing Hook ID, in the real planner request. */
  function configure() {
    if (!batch || checks.checking) return;
    setModal({ type: "hook", ...batch, guided: true });
  }
  /** Start one real inspection under the application navigation lock. */
  async function inspect() {
    setChosen(new Set());
    setChoices(new Map());
    setOperationError(null);
    setGroup("missing");
    try {
      await runOperation(() => checks.start(selectedIds, query));
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  }
  const overview = hookOverview(resources.error ? [] : (resources.data ?? []));
  const visibleHooks = overview.hooks.filter((row) =>
    [row.project.path_with_namespace, row.hook.name, row.hook.url]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const hookKey = (row: HookRow) => row.project.id + ":" + row.hook.id;
  const chosenHooks = visibleHooks.filter((row) => inventorySelected.has(hookKey(row)));
  const inventoryBusy = resources.isFetching || !!resources.error;
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
          <h1>配置 Webhook</h1>
          <p>检查范围 {selectedIds.length} 个仓库。先检查，再选择本次要新增或更新的配置。</p>
        </div>
        <Button
          disabled={checks.checking}
          onClick={() => {
            checks.stop();
            setStage("scope");
          }}
        >
          调整仓库范围
        </Button>
      </div>
      {inventory ? (
        <>
          <div className="task-toolbar">
            <Button
              onClick={() => {
                setInventory(false);
                setInventorySelected(new Set());
              }}
            >
              返回地址 / 名称检查
            </Button>
            <Button busy={resources.isFetching} onClick={() => void resources.refetch()}>
              <RefreshCw size={15} />
              刷新现有配置
            </Button>
          </div>
          <section className="panel">
            <div className="toolbar">
              <input
                aria-label="搜索 Webhook"
                placeholder="搜索名称、地址或仓库"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setInventorySelected(new Set());
                }}
              />
            </div>
            {resources.isFetching && (
              <ReadProgressView title="正在读取 Webhook" progress={resources.progress} />
            )}
            {resources.error ? (
              <ErrorBox message={errorMessage(resources.error)} />
            ) : (
              <ResourceErrors
                resources={resources.data ?? []}
                kind="hooks"
                projects={selectedProjects}
              />
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="选择筛选后的 Webhook"
                        disabled={inventoryBusy}
                        checked={
                          visibleHooks.length > 0 &&
                          visibleHooks.every((row) => inventorySelected.has(hookKey(row)))
                        }
                        onChange={(event) =>
                          setInventorySelected(
                            new Set(event.target.checked ? visibleHooks.map(hookKey) : []),
                          )
                        }
                      />
                    </th>
                    <th>Webhook / 地址</th>
                    <th>仓库 / Hook ID</th>
                    <th>事件</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHooks.map((row) => (
                    <tr key={hookKey(row)}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={
                            "选择 Hook " + row.hook.id + " · " + row.project.path_with_namespace
                          }
                          checked={inventorySelected.has(hookKey(row))}
                          disabled={inventoryBusy}
                          onChange={(event) =>
                            setInventorySelected((previous) => {
                              const next = new Set(previous);
                              event.target.checked
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
                          disabled={inventoryBusy}
                          onClick={() => setModal({ type: "hookDetail", row })}
                        >
                          {row.hook.name ?? "未命名 Webhook"}
                        </button>
                        <small className="cell-note url-text">{row.hook.url}</small>
                      </td>
                      <td>
                        {row.project.path_with_namespace}
                        <small className="cell-note">#{row.hook.id}</small>
                      </td>
                      <td>
                        {Object.entries(eventLabels)
                          .filter(([key]) => row.hook[key as keyof typeof eventLabels])
                          .map(([, label]) => label)
                          .join("、") || "未开启"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visibleHooks.length && !resources.isFetching && (
              <Empty
                title={
                  overview.projects.length ? "成功读取的仓库中没有匹配配置" : "没有成功读取的配置"
                }
              >
                读取失败项不能用于判断缺失，请检查后刷新。
              </Empty>
            )}
          </section>
          <footer className="workflow-footer">
            <span>
              本次选中 <strong>{chosenHooks.length}</strong> 条配置 ·{" "}
              {uniqueProjects(chosenHooks).length} 个仓库
            </span>
            <div className="button-group">
              <Button
                disabled={!writable || inventoryBusy || !chosenHooks.length}
                onClick={() =>
                  setModal({
                    type: "hook",
                    mode: "delete",
                    projects: uniqueProjects(chosenHooks),
                    rows: chosenHooks,
                    guided: true,
                  })
                }
              >
                删除所选配置
              </Button>
              <Button
                variant="primary"
                disabled={!writable || inventoryBusy || !chosenHooks.length}
                onClick={() =>
                  setModal({
                    type: "hook",
                    mode: "update",
                    projects: uniqueProjects(chosenHooks),
                    rows: chosenHooks,
                    guided: true,
                    initialUrl: chosenHooks[0].hook.url,
                  })
                }
              >
                修改所选配置
              </Button>
            </div>
          </footer>
        </>
      ) : (
        <>
          <section className="panel">
            <form
              className="toolbar"
              onSubmit={(event) => {
                event.preventDefault();
                void inspect();
              }}
            >
              <select
                aria-label="Webhook 查询字段"
                disabled={checks.checking}
                value={query.field}
                onChange={(event) => {
                  setQuery({ field: event.target.value as WebhookQuery["field"], value: "" });
                  checks.reset();
                  setChosen(new Set());
                }}
              >
                <option value="url">完整地址</option>
                <option value="name" disabled={!namesSupported}>
                  名称（GitLab 17.1+）
                </option>
              </select>
              <input
                className="fill"
                aria-label={query.field === "url" ? "Webhook 检查地址" : "Webhook 检查名称"}
                type={query.field === "url" ? "url" : "text"}
                disabled={checks.checking}
                value={query.value}
                onChange={(event) => {
                  setQuery({ ...query, value: event.target.value });
                  checks.reset();
                  setChosen(new Set());
                }}
                placeholder={
                  query.field === "url"
                    ? "https://hooks.example.com/gitlab"
                    : "输入完整 Webhook 名称"
                }
              />
              <Button
                variant={checks.target ? "" : "primary"}
                type="submit"
                busy={checks.checking}
                disabled={
                  !query.value.trim() ||
                  !selectedIds.length ||
                  (query.field === "name" && !namesSupported)
                }
              >
                检查范围
              </Button>
              {checks.checking && (
                <Button type="button" onClick={checks.stop} disabled={checks.cancelled}>
                  停止检查
                </Button>
              )}
            </form>
            {!namesSupported && (
              <p className="permission-scope-note">
                当前 GitLab {connection.version} 不支持名称，按地址管理。
              </p>
            )}
            {checks.target && (
              <div className="inspection-progress" role="status">
                <progress
                  aria-label="Webhook 检查进度"
                  value={checks.completed}
                  max={checks.total}
                />
                <span>
                  已检查 {checks.completed} / {checks.total}
                  {checks.cancelled ? " · 已停止" : ""}
                </span>
              </div>
            )}
            {(checks.error || operationError) && (
              <ErrorBox message={checks.error ?? operationError!} />
            )}
          </section>
          <div className="task-toolbar">
            <Button
              disabled={checks.checking}
              onClick={() => {
                setInventory(true);
                setInventorySelected(new Set());
              }}
            >
              查看范围内全部现有配置
            </Button>
            {checks.target && (
              <Button
                disabled={checks.checking}
                onClick={() => {
                  checks.reset();
                  setInspection((value) => value + 1);
                  setChosen(new Set());
                }}
              >
                清除检查结果
              </Button>
            )}
          </div>
          {checks.target ? (
            <>
              <div className="object-groups" aria-label="Webhook 检查结果分组">
                {(
                  [
                    ["missing", "未配置"],
                    ["present", "已有配置"],
                    ["needs", "需处理"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={group === value}
                    disabled={checks.checking}
                    onClick={() => chooseGroup(value)}
                  >
                    {label} <span>{counts[value]}</span>
                  </button>
                ))}
              </div>
              {group === "missing" && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    disabled={checks.checking}
                    checked={includeExisting}
                    onChange={(event) => {
                      setIncludeExisting(event.target.checked);
                      setChosen(new Set());
                    }}
                  />
                  同时更新已有配置（{counts.present}）
                </label>
              )}
              <section className="panel">
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="check-col">
                          <input
                            type="checkbox"
                            aria-label="选择本组可处理仓库"
                            disabled={checks.checking || !rows.some((row) => row.eligible)}
                            checked={
                              rows.some((row) => row.eligible) &&
                              rows
                                .filter((row) => row.eligible)
                                .every((row) => selected.has(row.project.id))
                            }
                            onChange={(event) =>
                              setChosen(
                                new Set(
                                  event.target.checked
                                    ? rows
                                        .filter((row) => row.eligible)
                                        .map((row) => row.project.id)
                                    : [],
                                ),
                              )
                            }
                          />
                        </th>
                        <th>仓库</th>
                        <th>本次操作</th>
                        <th>检查结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.project.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={"选择 " + row.project.path_with_namespace}
                              checked={selected.has(row.project.id) && row.eligible}
                              disabled={checks.checking || !row.eligible}
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
                              onClick={() => setModal({ type: "project", project: row.project })}
                            >
                              {row.project.name}
                            </button>
                            <small className="cell-note">{row.project.path_with_namespace}</small>
                          </td>
                          <td>
                            {row.eligible
                              ? row.result?.status === "missing"
                                ? "新增"
                                : "更新"
                              : "不可执行"}
                          </td>
                          <td>
                            {!row.result ? (
                              "未取得结果"
                            ) : row.result.status === "missing" ? (
                              "未配置"
                            ) : row.result.status === "error" ? (
                              <span className="error-text">{row.result.message}</span>
                            ) : row.result.hooks.length > 1 ? (
                              <label className="form-field">
                                <span>多条匹配，请明确选择 Hook ID</span>
                                <select
                                  aria-label={
                                    "选择 " + row.project.path_with_namespace + " 的具体 Hook"
                                  }
                                  value={choices.get(row.project.id) ?? ""}
                                  disabled={checks.checking}
                                  onChange={(event) => {
                                    setChoices((previous) => {
                                      const next = new Map(previous);
                                      event.target.value
                                        ? next.set(row.project.id, Number(event.target.value))
                                        : next.delete(row.project.id);
                                      return next;
                                    });
                                    setChosen((previous) => {
                                      const next = new Set(previous);
                                      next.delete(row.project.id);
                                      return next;
                                    });
                                  }}
                                >
                                  <option value="">请选择具体配置</option>
                                  {row.result.hooks.map((hook) => (
                                    <option value={hook.id} key={hook.id}>
                                      #{hook.id} · {hook.name ?? hook.url}
                                    </option>
                                  ))}
                                </select>
                                {row.result.hooks.map((hook) => (
                                  <button
                                    className="text-btn"
                                    key={hook.id}
                                    onClick={() =>
                                      setModal({
                                        type: "hookDetail",
                                        row: { project: row.project, hook },
                                      })
                                    }
                                  >
                                    查看 #{hook.id} · {hook.url}
                                  </button>
                                ))}
                              </label>
                            ) : (
                              <button
                                className="text-btn"
                                onClick={() =>
                                  setModal({
                                    type: "hookDetail",
                                    row: { project: row.project, hook: row.hook! },
                                  })
                                }
                              >
                                已配置 · #{row.hook!.id}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!rows.length && <Empty title="这一组没有仓库">可切换其他结果分组。</Empty>}
              </section>
            </>
          ) : (
            <Empty title="先检查本次范围">输入完整地址或名称，读取各仓库的实际配置。</Empty>
          )}
          <footer className="workflow-footer">
            <span>
              本次选中 <strong>{batch?.projects.length ?? 0}</strong> 个仓库
            </span>
            <Button
              variant="primary"
              disabled={!writable || checks.checking || !batch}
              onClick={configure}
            >
              下一步：配置 Webhook
            </Button>
          </footer>
        </>
      )}
    </>
  );
}

/** Inspect an explicitly identified Hook; changes re-enter the existing real preview workflow. */
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
          {!writable && <span className="scope-caption">当前令牌只读，修改需要 api 范围。</span>}
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
