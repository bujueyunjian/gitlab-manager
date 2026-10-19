import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pause, Play, Search } from "lucide-react";
import { api, errorMessage } from "./api";
import { actionLabels, dateTime, statusLabels, taskCounts } from "./domain";
import type { ItemStatus, Task } from "./types";
import { Badge, Button, Dialog, Empty, ErrorBox, Loading } from "./ui";
import { refreshTasks } from "./taskQueries";

const taskLabels = {
  running: "执行中",
  paused: "已暂停",
  attention: "需要处理",
  completed: "已完成",
};
function color(status: ItemStatus): string {
  return status === "succeeded"
    ? "green"
    : status === "failed" || status === "blocked"
      ? "red"
      : status === "unknown"
        ? "amber"
        : status === "running"
          ? "accent"
          : "gray";
}

export function Tasks({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = tasks.filter(
    (task) =>
      (filter === "all" ||
        (filter === "completed" ? task.status === "completed" : task.status !== "completed")) &&
      [task.title, task.connectionName, ...task.items.map((item) => item.projectPath)]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>任务记录</h1>
          <p>查看每个仓库的处理结果，继续未完成的操作。</p>
        </div>
      </div>
      <section className="panel">
        <div className="tabs">
          {[
            ["all", "全部任务"],
            ["attention", "需要处理"],
            ["completed", "已完成"],
          ].map(([value, label]) => (
            <button
              className={`tab ${value === filter ? "active" : ""}`}
              key={value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索任务"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索操作名称、实例或仓库"
            />
          </div>
        </div>
        {filtered.length ? (
          filtered.map((task) => {
            const counts = taskCounts(task.items);
            return (
              <div className="task-list-item" key={task.id}>
                <div className="fill">
                  <button className="repo-name" onClick={() => onOpen(task.id)}>
                    {task.title}
                  </button>
                  <p>
                    {task.connectionName} · {dateTime(task.createdAt)} · {task.items.length} 项
                  </p>
                </div>
                <span className="subtle">
                  {counts.succeeded} 成功 · {counts.failed + counts.blocked} 失败 / 阻止 ·{" "}
                  {counts.unknown} 未知
                </span>
                <Badge
                  color={
                    task.status === "completed"
                      ? "green"
                      : task.status === "running"
                        ? "accent"
                        : "amber"
                  }
                >
                  {taskLabels[task.status]}
                </Badge>
                <Button className="small" onClick={() => onOpen(task.id)}>
                  查看结果
                </Button>
              </div>
            );
          })
        ) : (
          <Empty title="还没有匹配的任务">完成一次批量预览并执行后，逐项结果会保留在这里。</Empty>
        )}
      </section>
    </>
  );
}

export function TaskDialog({
  taskId,
  onClose,
  notify,
}: {
  taskId: string;
  onClose: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resume, setResume] = useState<{ ids: string[] | null; secretRequired: boolean } | null>(
    null,
  );
  const [secret, setSecret] = useState("");
  const [confirmItem, setConfirmItem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const run = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: async () => {
      await refreshTasks(queryClient);
      setSelected(new Set());
      setResume(null);
      setSecret("");
      setConfirmItem(null);
      setNote("");
    },
    onError: (error) => notify(errorMessage(error), true),
  });
  const task = query.data;
  const counts = task ? taskCounts(task.items) : null;
  const running = task?.status === "running";
  function prepareResume(ids: string[] | null) {
    if (!task) return;
    const targets = task.items.filter((item) =>
      ids ? ids.includes(item.id) : item.status === "pending",
    );
    if (targets.some((item) => item.secretRequired)) {
      setResume({ ids, secretRequired: true });
      return;
    }
    setResume({ ids, secretRequired: false });
  }
  return (
    <>
      <Dialog
        title={task?.title ?? "任务详情"}
        description={task ? `${task.connectionName} · ${dateTime(task.createdAt)}` : undefined}
        drawer
        onClose={onClose}
      >
        {query.isPending && <Loading />}
        {query.error && <ErrorBox message={errorMessage(query.error)} />}
        {task && counts && (
          <>
            <div className="button-group">
              <Badge color={running ? "accent" : task.status === "completed" ? "green" : "amber"}>
                {taskLabels[task.status]}
              </Badge>
              {running ? (
                <Button
                  className="small"
                  busy={run.isPending}
                  onClick={() =>
                    run.mutate(async () => {
                      await api.stopTask(task.id);
                      notify("已停止派发，正在等待当前请求完成");
                    })
                  }
                >
                  <Pause size={14} />
                  停止
                </Button>
              ) : (
                counts.pending > 0 && (
                  <Button className="small" variant="primary" onClick={() => prepareResume(null)}>
                    <Play size={14} />
                    继续未执行项
                  </Button>
                )
              )}
              <Button
                className="small"
                onClick={() =>
                  run.mutate(async () => {
                    if (await api.exportTask(task.id))
                      notify("结果已导出，请勿将运行数据加入源码仓库");
                  })
                }
              >
                <Download size={14} />
                导出结果
              </Button>
            </div>
            <div className="task-summary">
              <div>
                <span>成功</span>
                <b>{counts.succeeded}</b>
              </div>
              <div>
                <span>失败 / 无法执行</span>
                <b>{counts.failed + counts.blocked}</b>
              </div>
              <div>
                <span>结果未知</span>
                <b>{counts.unknown}</b>
              </div>
              <div>
                <span>待执行 / 跳过</span>
                <b>
                  {counts.pending} <small>/ {counts.skipped}</small>
                </b>
              </div>
            </div>
            {counts.unknown > 0 && (
              <div className="hint warning">未知结果可能已经写入。先查询核实，不能直接重发。</div>
            )}
            <div className="toolbar task-toolbar">
              <input
                aria-label="搜索任务条目"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索仓库、成员或错误原因"
              />
              <select
                aria-label="筛选执行结果"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部结果</option>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label} ({counts[value as ItemStatus]})
                  </option>
                ))}
              </select>
            </div>
            <div className="button-group mb">
              {counts.failed > 0 && (
                <Button
                  className="small"
                  disabled={running || !selected.size || run.isPending}
                  onClick={() => prepareResume([...selected])}
                >
                  重试所选失败项 ({selected.size})
                </Button>
              )}
              {counts.unknown > 0 && (
                <Button
                  className="small"
                  variant="soft"
                  busy={run.isPending}
                  disabled={running}
                  onClick={() => run.mutate(() => api.reconcile(task.id))}
                >
                  查询核实未知项
                </Button>
              )}
            </div>
            <div className="task-results">
              {task.items
                .filter(
                  (item) =>
                    (filter === "all" || item.status === filter) &&
                    [item.projectPath, item.subject, item.message]
                      .join(" ")
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                )
                .map((item) => (
                  <article className="task-result" key={item.id}>
                    <div className="task-result-head">
                      {item.status === "failed" && (
                        <input
                          type="checkbox"
                          aria-label={`重试 ${item.projectPath}`}
                          checked={selected.has(item.id)}
                          onChange={(e) =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              e.target.checked ? next.add(item.id) : next.delete(item.id);
                              return next;
                            })
                          }
                        />
                      )}
                      <strong>{item.projectPath}</strong>
                      <Badge color={color(item.status)}>{statusLabels[item.status]}</Badge>
                    </div>
                    {item.subject && <p className="subtle">{item.subject}</p>}
                    <p>
                      {actionLabels[item.action]} · {item.message}
                    </p>
                    <div className="changes">
                      {item.changes.map((change, index) => (
                        <div key={index}>
                          {change.field}：
                          {change.before !== null && (
                            <>
                              <del>{change.before}</del> →{" "}
                            </>
                          )}
                          <ins>{change.after ?? "移除"}</ins>
                        </div>
                      ))}
                    </div>
                    <div className="task-result-foot">
                      <span>尝试 {item.attempts} 次</span>
                      {item.status === "unknown" && !running && (
                        <button
                          className="text-btn"
                          onClick={() => {
                            setConfirmItem(item.id);
                            setNote("");
                          }}
                        >
                          填写人工核实结果
                        </button>
                      )}
                    </div>
                  </article>
                ))}
            </div>
          </>
        )}
      </Dialog>
      {resume && task && (
        <Dialog
          title={resume.ids ? "重试已选失败项" : "继续未执行项"}
          description="执行前会再次检查目标状态，已成功条目不会重复发送。"
          busy={run.isPending}
          onClose={() => {
            setResume(null);
            setSecret("");
          }}
          footer={
            <>
              <Button onClick={() => setResume(null)} disabled={run.isPending}>
                取消
              </Button>
              <Button
                variant="primary"
                busy={run.isPending}
                disabled={resume.secretRequired && !secret}
                onClick={() =>
                  run.mutate(() => api.resumeTask(task.id, resume.ids, secret || null))
                }
              >
                确认继续
              </Button>
            </>
          }
        >
          <p>
            本次处理 {resume.ids?.length ?? counts?.pending}{" "}
            条记录。失败或未知结果不会随“继续未执行项”一起重发。
          </p>
          {resume.secretRequired && (
            <label className="form-field space-top">
              <span>本次接收端密钥</span>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
              />
              <small>任务记录不保存密钥，需要重新提供。</small>
            </label>
          )}
        </Dialog>
      )}
      {confirmItem && task && (
        <Dialog
          title="记录人工核实结果"
          description="仅在你已确认 GitLab 或接收端变更生效后使用。"
          onClose={() => setConfirmItem(null)}
          busy={run.isPending}
          footer={
            <>
              <Button onClick={() => setConfirmItem(null)}>取消</Button>
              <Button
                variant="primary"
                disabled={!note.trim()}
                busy={run.isPending}
                onClick={() => run.mutate(() => api.confirmUnknown(task.id, confirmItem, note))}
              >
                确认已核实生效
              </Button>
            </>
          }
        >
          <label className="form-field">
            <span>核实说明</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="说明你在哪里核实，以及实际生效的结果"
            />
          </label>
        </Dialog>
      )}
    </>
  );
}
