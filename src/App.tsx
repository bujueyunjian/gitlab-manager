import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  History,
  Orbit,
  Plus,
  Settings2,
  ShieldCheck,
  Webhook,
  X,
} from "lucide-react";
import { api, desktop, errorMessage } from "./api";
import { accessLevel, roleName } from "./domain";
import type { Page, Project, Task } from "./types";
import { Button, Dialog, ErrorBox, Loading } from "./ui";
import { ConnectionDialog, Connections } from "./Connections";
import { ResolveDialog } from "./ResolveDialog";
import { HookDialog, PermissionDialog } from "./BatchDialogs";
import { TaskDialog, Tasks } from "./Tasks";
import { refreshTasks } from "./taskQueries";
import { WorkspaceContext } from "./Workspace";
import type { Modal } from "./Workspace";
import { RepositoriesPage } from "./pages/Repositories";
import { HookDetails, HooksPage } from "./pages/Hooks";
import { PermissionsPage } from "./pages/Permissions";

const navigation = [
  { id: "repos", label: "仓库", icon: FolderGit2 },
  { id: "permissions", label: "授权管理", icon: ShieldCheck },
  { id: "hooks", label: "Webhook", icon: Webhook },
  { id: "tasks", label: "任务记录", icon: History },
] as const;

/** Application shell owns only connection, selection, dialogs and backend notifications. */
export default function App() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>("repos");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<number, Project>>(new Map());
  const [modal, setModal] = useState<Modal | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    enabled: desktop,
  });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: desktop });
  const connection = connections.data?.find((c) => c.id === connectionId) ?? null;
  const writable = connection?.scopes.includes("api") ?? false;
  const selectedProjects = useMemo(() => [...selected.values()], [selected]);
  const selectedIds = useMemo(() => [...selected.keys()].sort((a, b) => a - b), [selected]);
  function notify(message: string, error = false) {
    setNotice({ message, error });
  }
  function changeConnection(id: string) {
    setConnectionId(id);
    setSelected(new Map());
    setModal(null);
  }
  function changePage(value: Page) {
    setPage(value);
  }
  function changedConnections() {
    void queryClient.invalidateQueries({ queryKey: ["connections"] });
  }
  function started(task: Task) {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    setModal({ type: "task", id: task.id });
  }
  function chooseProject(project: Project, checked: boolean) {
    setSelected((previous) => {
      const next = new Map(previous);
      checked ? next.set(project.id, project) : next.delete(project.id);
      return next;
    });
  }
  const openProject = useMutation({
    mutationFn: (project: Project) => api.openProject(connectionId!, project.id),
    onError: (e) => notify(errorMessage(e), true),
  });
  const workspace = connection
    ? {
        connection,
        selected,
        selectedProjects,
        selectedIds,
        writable,
        setSelected,
        setModal,
        changePage,
        chooseProject,
      }
    : null;
  useEffect(() => {
    if (!connections.data) return;
    if (!connections.data.some((c) => c.id === connectionId)) {
      setConnectionId(connections.data[0]?.id ?? null);
      setSelected(new Map());
    }
  }, [connections.data, connectionId]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    async function register() {
      const handlers: [string, (payload: unknown) => void][] = [
        [
          "tasks-updated",
          () => {
            void refreshTasks(queryClient).catch((e) =>
              setNotice({ message: errorMessage(e), error: true }),
            );
          },
        ],
        [
          "resources-updated",
          () => {
            void queryClient.invalidateQueries({ queryKey: ["resources"] });
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
          },
        ],
        [
          "operation-notice",
          (payload) => {
            if (typeof payload === "string") setNotice({ message: payload, error: true });
          },
        ],
      ];
      for (const [name, handler] of handlers) {
        const stop = await listen(name, (event) => handler(event.payload));
        if (disposed) stop();
        else stops.push(stop);
      }
    }
    void register().catch((e) => setNotice({ message: errorMessage(e), error: true }));
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [queryClient]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <Orbit size={24} />
            </span>
            <div>
              <strong>GitLab 管理台</strong>
              <small>RESOURCE WORKSPACE</small>
            </div>
          </div>
          <div>
            <div className="nav-label">工作空间</div>
            <nav>
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={`nav-button ${page === item.id ? "active" : ""}`}
                  onClick={() => changePage(item.id)}
                  aria-label={item.label}
                  title={item.label}
                  disabled={!connection && item.id !== "tasks"}
                >
                  <item.icon size={19} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
          <div>
            <div className="nav-label">管理</div>
            <button
              className={`nav-button ${page === "connections" ? "active" : ""}`}
              aria-label="连接配置"
              onClick={() => changePage("connections")}
            >
              <Settings2 size={19} />
              <span>连接配置</span>
            </button>
          </div>
          <div className="sidebar-bottom">
            <div className="sidebar-help">
              <strong>让重复操作，一次完成。</strong>连接 GitLab，选择仓库，
              <br />
              预览后批量执行。
            </div>
            <div className="profile">
              <span className="avatar">{connection ? connection.user.name.slice(0, 1) : "G"}</span>
              <div>
                <strong>{connection?.user.name ?? "尚未连接"}</strong>
                <small>{connection?.name ?? "添加你的 GitLab 实例"}</small>
              </div>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              工作空间
              <ChevronRight size={13} />
              <strong>
                {page === "connections"
                  ? "连接配置"
                  : navigation.find((item) => item.id === page)?.label}
              </strong>
            </div>
            <div className="topbar-right">
              {connection && (
                <select
                  className="instance-select"
                  aria-label="当前 GitLab 实例"
                  value={connection.id}
                  onChange={(e) => changeConnection(e.target.value)}
                >
                  {connections.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              {!desktop && <span className="prototype-label">网页界面预览</span>}
            </div>
          </header>
          <main className="content">
            {!desktop && (
              <div className="hint">
                此页面只用于查看界面。请启动桌面应用以安全连接 GitLab，网页不会读取令牌或访问仓库。
              </div>
            )}
            {connections.error && <ErrorBox message={errorMessage(connections.error)} />}
            {desktop && connections.isPending ? (
              <Loading>正在读取本地连接…</Loading>
            ) : page === "tasks" ? (
              tasks.isPending && desktop ? (
                <Loading />
              ) : tasks.error ? (
                <ErrorBox message={errorMessage(tasks.error)} />
              ) : (
                <Tasks tasks={tasks.data ?? []} onOpen={(id) => setModal({ type: "task", id })} />
              )
            ) : !connection ? (
              <div className="onboarding">
                <div className="onboarding-symbol">
                  <Orbit size={42} />
                </div>
                <span className="eyebrow">GitLab 资源管理</span>
                <h1>多个仓库，一次管理。</h1>
                <p>批量设置成员权限与 Webhook。先预览变更，再查看每个仓库的执行结果。</p>
                <div className="onboarding-steps">
                  <span>
                    <b>01</b>连接 GitLab
                  </span>
                  <ChevronRight size={15} />
                  <span>
                    <b>02</b>搜索或粘贴仓库
                  </span>
                  <ChevronRight size={15} />
                  <span>
                    <b>03</b>预览并批量执行
                  </span>
                </div>
                <Button
                  variant="primary"
                  disabled={!desktop}
                  onClick={() => setModal({ type: "connection" })}
                >
                  <Plus size={17} />
                  添加 GitLab 连接
                  <ArrowRight size={16} />
                </Button>
                <small>令牌由系统安全存储管理，不采集遥测数据。</small>
              </div>
            ) : page === "repos" ? (
              <RepositoriesPage key={connection.id} />
            ) : page === "hooks" ? (
              <HooksPage key={connection.id} />
            ) : page === "permissions" ? (
              <PermissionsPage key={connection.id} />
            ) : (
              <Connections
                connections={connections.data ?? []}
                currentId={connectionId}
                onAdd={() => setModal({ type: "connection" })}
                onEdit={(c) => setModal({ type: "connection", connection: c })}
                onSwitch={changeConnection}
                onChanged={changedConnections}
                notify={notify}
              />
            )}
          </main>
        </div>
        {modal?.type === "connection" && (
          <ConnectionDialog
            connection={modal.connection}
            onClose={() => setModal(null)}
            onSaved={(value) => {
              changedConnections();
              changeConnection(value.id);
              setPage("repos");
              notify("连接成功，现在可以搜索或批量粘贴仓库");
            }}
          />
        )}
        {modal?.type === "resolve" && connection && (
          <ResolveDialog
            connectionId={connection.id}
            onClose={() => setModal(null)}
            onSelect={(matches) => {
              setSelected(
                (previous) =>
                  new Map([
                    ...previous,
                    ...matches.map((project) => [project.id, project] as const),
                  ]),
              );
              setModal(null);
              notify(`已加入 ${matches.length} 个唯一仓库，可直接批量操作`);
            }}
          />
        )}
        {modal?.type === "hook" && connection && (
          <HookDialog
            connection={connection}
            projects={modal.projects}
            rows={modal.rows}
            initialMode={modal.mode}
            onClose={() => setModal(null)}
            onStarted={started}
            notify={notify}
          />
        )}
        {modal?.type === "hookDetail" && connection && (
          <HookDetails row={modal.row} onClose={() => setModal(null)} />
        )}
        {modal?.type === "permission" && connection && (
          <PermissionDialog
            connection={connection}
            projects={modal.projects}
            rows={modal.rows}
            initialMode={modal.mode}
            onClose={() => setModal(null)}
            onStarted={started}
            notify={notify}
          />
        )}
        {modal?.type === "task" && (
          <TaskDialog taskId={modal.id} onClose={() => setModal(null)} notify={notify} />
        )}
        {modal?.type === "project" && connection && (
          <Dialog
            title={modal.project.name}
            description={modal.project.path_with_namespace}
            drawer
            onClose={() => setModal(null)}
          >
            <dl className="detail-grid">
              <div className="full">
                <dt>描述</dt>
                <dd>{modal.project.description ?? "未填写描述"}</dd>
              </div>
              <div>
                <dt>我的角色</dt>
                <dd>{roleName(accessLevel(modal.project))}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{modal.project.archived ? "已归档" : "活跃"}</dd>
              </div>
              <div className="full">
                <dt>仓库地址</dt>
                <dd className="wrap-cell">{modal.project.web_url}</dd>
              </div>
            </dl>
            <div className="button-group">
              <Button onClick={() => openProject.mutate(modal.project)}>
                <ExternalLink size={15} />在 GitLab 查看
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  chooseProject(modal.project, true);
                  setModal(null);
                  notify("已加入所选仓库");
                }}
              >
                <Check size={15} />
                选择此仓库
              </Button>
            </div>
          </Dialog>
        )}
        {notice && (
          <div
            className={`toast ${notice.error ? "error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            <span>{notice.message}</span>
            <button className="icon-btn" aria-label="关闭提示" onClick={() => setNotice(null)}>
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
