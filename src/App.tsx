import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  Check,
  ChevronRight,
  ExternalLink,
  Home,
  History,
  GitBranch,
  Plus,
  Settings2,
  ShieldCheck,
  Webhook,
  X,
} from "lucide-react";
import { api, desktop, errorMessage } from "./api";
import { accessLevel, canAttemptWrite, roleName } from "./domain";
import type { Connection, OperationRunner, Page, Project, Task, TaskKind } from "./types";
import { Button, Dialog, ErrorBox, Loading } from "./ui";
import { ConnectionDialog, Connections } from "./Connections";
import { ResolveDialog } from "./ResolveDialog";
import { HookDialog, PermissionDialog } from "./BatchDialogs";
import { TaskDialog, Tasks } from "./Tasks";
import { refreshTasks } from "./taskQueries";
import { WorkspaceContext } from "./Workspace";
import type { Modal, Workspace } from "./Workspace";
import { HookDetails, HooksPage } from "./pages/Hooks";
import { PermissionsPage } from "./pages/Permissions";
import {
  cacheSavedConnection,
  createTaskOperation,
  initialTaskRoute,
  taskRoute,
} from "./taskRouting";

const navigation = [
  { id: "home", label: "首页", icon: Home },
  { id: "hooks", label: "Webhook 配置", icon: Webhook },
  { id: "permissions", label: "成员权限", icon: ShieldCheck },
  { id: "tasks", label: "任务记录", icon: History },
] as const;
/** Inline workflows are retained separately while users switch between tasks. */
type WorkflowModal = Extract<Modal, { type: "hook" | "permission" | "task" }>;
/** One task's live form or result remains mounted while another task is inspected. */
interface WorkflowScreen {
  id: string;
  session: string;
  modal: WorkflowModal;
}
/** Native details retain their owning task; connection continuations additionally carry an intent ID. */
interface NativeScreen {
  id: string;
  session: string;
  task: TaskKind;
  modal: Modal;
  intentId: number | null;
}

/** Own task routes, scoped selections and connection-bound operations; all remote work uses the existing API. */
export default function App() {
  const queryClient = useQueryClient();
  const [route, dispatch] = useReducer(taskRoute, undefined, initialTaskRoute);
  const [flows, setFlows] = useState<Record<TaskKind, WorkflowScreen | null>>({
    hooks: null,
    permissions: null,
  });
  const [native, setNative] = useState<NativeScreen | null>(null);
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const [busy, setBusy] = useState(false);
  const [scopeEpoch, setScopeEpoch] = useState(0);

  const [resourceRevision, setResourceRevision] = useState(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    enabled: desktop,
  });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: desktop });
  const connection = connections.data?.find((value) => value.id === route.connectionId) ?? null;
  const session = connection ? connection.id + ":" + connection.revision : "none";
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const operation = useRef<ReturnType<typeof createTaskOperation> | null>(null);
  if (operation.current === null)
    operation.current = createTaskOperation(() => sessionRef.current, setBusy);
  /** A stable operation entry is shared by all real scan and submit callers. */
  const runOperation: OperationRunner = useCallback((work) => operation.current!.run(work), []);
  /** Notices contain backend-safe errors, never simulated outcomes. */
  function notify(message: string, error = false) {
    setNotice({ message, error });
  }
  /** Drop connection-bound drafts and native details when identity changes. */
  function clearSession() {
    setScopeEpoch((value) => value + 1);
    setFlows({ hooks: null, permissions: null });
    setNative(null);
    nativeRef.current = null;
  }
  /** Only an explicit task request may continue through a new connection dialog. */
  function startTask(task: TaskKind) {
    if (operation.current!.busy) return;
    dispatch({ type: "task", task });
    if (!connection && desktop && !connections.isPending)
      openNative(task, { type: "connection" }, route.serial + 1);
  }
  /** Navigation preserves task drafts but cancels any unconsumed connection intent. */
  function navigate(page: Page) {
    if (operation.current!.busy) return;
    if (page === "hooks" || page === "permissions") {
      startTask(page);
      return;
    }
    dispatch({ type: "navigate", page });
    setNative(null);
    nativeRef.current = null;
  }
  /** Connection switches clear both task scopes, preventing ID reuse across instances. */
  function changeConnection(id: string) {
    if (operation.current!.busy) return;
    clearSession();
    dispatch({ type: "connection", id });
  }
  /** Capture the task/session now rather than resolving it from whichever page is visible later. */
  function openNative(task: TaskKind, modal: Modal, intentId: number | null = null) {
    const screen = { id: crypto.randomUUID(), session: sessionRef.current, task, modal, intentId };
    nativeRef.current = screen;
    setNative(screen);
  }
  /** Route mutation forms into task pages while keeping secondary inspections as native dialogs. */
  function openTaskModal(task: TaskKind, modal: Modal | null) {
    if (operation.current!.busy) return;
    if (!modal) {
      setNative(null);
      nativeRef.current = null;
      return;
    }
    if (modal.type === "hook" || modal.type === "permission" || modal.type === "task") {
      setNative(null);
      nativeRef.current = null;
      setFlows((previous) => ({
        ...previous,
        [task]: { id: crypto.randomUUID(), session: sessionRef.current, modal },
      }));
    } else openNative(task, modal);
  }
  /** Construct an isolated context for each still-mounted task pane. */
  function workspaceFor(task: TaskKind): Workspace {
    const selected = new Map(route.scopes[task].map((project) => [project.id, project]));
    return {
      connection: connection!,
      active: route.page === task && flows[task] === null,
      task,
      selected,
      selectedProjects: [...selected.values()],
      selectedIds: [...selected.keys()].sort((a, b) => a - b),
      writable: connection !== null && canAttemptWrite(connection.scopes),
      setSelected: (update) =>
        dispatch({
          type: "scope",
          task,
          update: (previous) => (typeof update === "function" ? update(previous) : update),
        }),
      setModal: (modal) => openTaskModal(task, modal),
      chooseProject: (project, checked) =>
        dispatch({
          type: "scope",
          task,
          update: (previous) => {
            const next = new Map(previous);
            checked ? next.set(project.id, project) : next.delete(project.id);
            return next;
          },
        }),
      runOperation,
    };
  }
  /** Results belong only to the flow and connection that launched the real backend task. */
  function started(task: TaskKind, origin: string, value: Task) {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    if (origin !== sessionRef.current) return;
    setFlows((previous) => ({
      ...previous,
      [task]: { id: crypto.randomUUID(), session: origin, modal: { type: "task", id: value.id } },
    }));
  }
  const openProject = useMutation({
    mutationFn: (project: Project) => api.openProject(connection!.id, project.id),
    onError: (error) => notify(errorMessage(error), true),
  });
  const openManual = useMutation({
    mutationFn: api.openManual,
    onError: (error) => notify(errorMessage(error), true),
  });

  useEffect(() => {
    if (!connections.data) return;
    if (route.connectionId === null && connections.data.length) {
      dispatch({ type: "connection", id: connections.data[0].id });
      return;
    }
    if (
      route.connectionId !== null &&
      !connections.data.some((value) => value.id === route.connectionId)
    ) {
      clearSession();
      dispatch({ type: "connection", id: connections.data[0]?.id ?? null });
    }
  }, [connections.data, route.connectionId]);
  useEffect(() => {
    if (desktop && !connections.isPending && !connection && route.intent && !native) {
      openNative(route.intent.task, { type: "connection" }, route.intent.id);
    }
  }, [connections.isPending, connection, route.intent, native]);
  useEffect(() => {
    clearSession();
    dispatch({ type: "connection", id: route.connectionId });
  }, [session]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    async function register() {
      const handlers: [string, (payload: unknown) => void][] = [
        [
          "tasks-updated",
          () => {
            void refreshTasks(queryClient).catch((error) => notify(errorMessage(error), true));
          },
        ],
        [
          "resources-updated",
          () => {
            setResourceRevision((value) => value + 1);
            void queryClient.invalidateQueries({ queryKey: ["resources"] });
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
          },
        ],
        [
          "operation-notice",
          (payload) => {
            if (typeof payload === "string") notify(payload, true);
          },
        ],
      ];
      for (const [name, handler] of handlers) {
        const stop = await listen(name, (event) => handler(event.payload));
        if (disposed) stop();
        else stops.push(stop);
      }
    }
    void register().catch((error) => notify(errorMessage(error), true));
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

  /** Publish the returned connection into the cache before selecting it; old list reads are cancelled. */
  function savedConnection(screen: NativeScreen, value: Connection) {
    if (nativeRef.current?.id !== screen.id) return;
    cacheSavedConnection(queryClient, value);
    clearSession();
    dispatch({ type: "saved", id: value.id, intentId: screen.intentId });
  }
  /** Closing or manually editing a connection cannot resurrect a previously selected task intent. */
  function closeNative() {
    if (operation.current!.busy) return;
    if (nativeRef.current?.modal.type === "connection") dispatch({ type: "cancel-connection" });
    setNative(null);
    nativeRef.current = null;
  }
  const activeTask: TaskKind = route.page === "permissions" ? "permissions" : "hooks";
  const nativeWorkspace = connection ? workspaceFor(native?.task ?? activeTask) : null;
  const nativeModal = native?.modal;
  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" disabled={busy} onClick={() => navigate("home")}>
          <GitBranch size={22} />
          <strong>GitLab 管理器</strong>
        </button>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={"nav-button " + (route.page === item.id ? "active" : "")}
              aria-label={item.label}
              aria-current={route.page === item.id ? "page" : undefined}
              disabled={busy}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={"nav-button " + (route.page === "connections" ? "active" : "")}
            disabled={busy}
            onClick={() => navigate("connections")}
          >
            <Settings2 size={18} />
            <span>连接</span>
          </button>
          <button
            className="nav-button"
            disabled={!desktop || openManual.isPending}
            onClick={() => openManual.mutate()}
          >
            <BookOpen size={18} />
            <span>使用手册</span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="text-btn" disabled={busy} onClick={() => navigate("home")}>
              首页
            </button>
            {route.page !== "home" && (
              <>
                <ChevronRight size={13} />
                <strong>
                  {navigation.find((item) => item.id === route.page)?.label ?? "连接"}
                </strong>
              </>
            )}
          </div>
          <div className="topbar-right">
            {connection ? (
              connections.data!.length > 1 ? (
                <select
                  className="instance-select"
                  aria-label="当前 GitLab 实例"
                  value={connection.id}
                  disabled={busy}
                  onChange={(event) => changeConnection(event.target.value)}
                >
                  {connections.data!.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span>{connection.name}</span>
              )
            ) : (
              <span className="subtle">尚未连接</span>
            )}
            {!desktop && <span className="prototype-label">网页界面预览</span>}
          </div>
        </header>
        <main className="content">
          {!desktop && (
            <p className="scope-caption">
              请在桌面应用中连接 GitLab。当前网页不会读取凭据或执行请求。
            </p>
          )}
          {connections.error && <ErrorBox message={errorMessage(connections.error)} />}
          {route.page === "home" && (
            <section className="task-home">
              <h1>开始一个任务</h1>
              <div className="task-entry-grid">
                <button className="task-entry" disabled={busy} onClick={() => startTask("hooks")}>
                  <Webhook size={22} />
                  <h2>配置 Webhook</h2>
                  <p>检查指定地址或名称，选择仓库后新增或更新配置。</p>
                  <span>选择仓库范围 →</span>
                </button>
                <button
                  className="task-entry"
                  disabled={busy}
                  onClick={() => startTask("permissions")}
                >
                  <ShieldCheck size={22} />
                  <h2>查询成员权限</h2>
                  <p>选择具体用户，查看角色与来源，设置直接权限。</p>
                  <span>选择仓库范围 →</span>
                </button>
              </div>
            </section>
          )}
          {(route.page === "hooks" || route.page === "permissions") && !connection && (
            <section className="connection-start">
              <h1>{route.page === "hooks" ? "配置 Webhook" : "查询成员权限"}</h1>
              <p>
                {connections.isPending && desktop
                  ? "正在读取本地连接…"
                  : "先连接 GitLab，连接后继续这项任务。"}
              </p>
              <Button
                variant="primary"
                disabled={!desktop || busy || connections.isPending}
                onClick={() => {
                  if (route.intent) openNative(activeTask, { type: "connection" }, route.intent.id);
                  else startTask(activeTask);
                }}
              >
                <Plus size={16} />
                添加连接
              </Button>
            </section>
          )}
          {connection &&
            (["hooks", "permissions"] as const).map((task) => {
              const context = workspaceFor(task),
                flow = flows[task],
                visible = route.page === task;
              return (
                <section
                  key={session + ":" + scopeEpoch + ":" + task}
                  hidden={!visible}
                  className="task-pane"
                >
                  <WorkspaceContext.Provider value={context}>
                    <div hidden={!!flow}>
                      {task === "hooks" ? (
                        <HooksPage resourceRevision={resourceRevision} />
                      ) : (
                        <PermissionsPage />
                      )}
                    </div>
                    {flow?.modal.type === "hook" && (
                      <HookDialog
                        key={flow.id}
                        {...flow.modal}
                        connection={connection}
                        initialMode={flow.modal.mode}
                        presentation="page"
                        active={visible}
                        runOperation={runOperation}
                        onClose={() => setFlows((previous) => ({ ...previous, [task]: null }))}
                        onStarted={(value) => started(task, flow.session, value)}
                        notify={notify}
                      />
                    )}
                    {flow?.modal.type === "permission" && (
                      <PermissionDialog
                        key={flow.id}
                        {...flow.modal}
                        connection={connection}
                        initialMode={flow.modal.mode}
                        presentation="page"
                        active={visible}
                        runOperation={runOperation}
                        onClose={() => setFlows((previous) => ({ ...previous, [task]: null }))}
                        onStarted={(value) => started(task, flow.session, value)}
                        notify={notify}
                      />
                    )}
                    {flow?.modal.type === "task" && (
                      <TaskDialog
                        key={flow.id}
                        taskId={flow.modal.id}
                        presentation="page"
                        runOperation={runOperation}
                        onClose={() => setFlows((previous) => ({ ...previous, [task]: null }))}
                        notify={notify}
                      />
                    )}
                  </WorkspaceContext.Provider>
                </section>
              );
            })}
          {route.page === "tasks" &&
            (tasks.isPending && desktop ? (
              <Loading />
            ) : tasks.error ? (
              <ErrorBox message={errorMessage(tasks.error)} />
            ) : (
              <Tasks
                tasks={tasks.data ?? []}
                onOpen={(id) => openNative(activeTask, { type: "task", id })}
              />
            ))}
          {route.page === "connections" && (
            <Connections
              connections={connections.data ?? []}
              currentId={route.connectionId}
              onAdd={() => {
                dispatch({ type: "navigate", page: "connections" });
                openNative(activeTask, { type: "connection" });
              }}
              onEdit={(value) => {
                dispatch({ type: "navigate", page: "connections" });
                openNative(activeTask, { type: "connection", connection: value });
              }}
              onSwitch={changeConnection}
              onChanged={() => {
                void queryClient.invalidateQueries({ queryKey: ["connections"] });
              }}
              notify={notify}
            />
          )}
        </main>
      </div>
      {nativeModal?.type === "connection" && native && (
        <ConnectionDialog
          key={native.id}
          connection={nativeModal.connection}
          runOperation={runOperation}
          onClose={closeNative}
          onSaved={(value) => savedConnection(native, value)}
        />
      )}
      <WorkspaceContext.Provider value={nativeWorkspace}>
        {nativeModal?.type === "resolve" && native && connection && (
          <ResolveDialog
            key={native.id}
            connectionId={connection.id}
            runOperation={runOperation}
            onClose={closeNative}
            onSelect={(matches) => {
              if (native.session !== sessionRef.current) return;
              dispatch({
                type: "scope",
                task: native.task,
                update: (previous) =>
                  new Map([
                    ...previous,
                    ...matches.map((project) => [project.id, project] as const),
                  ]),
              });
              closeNative();
            }}
          />
        )}
        {nativeModal?.type === "hookDetail" && connection && (
          <HookDetails row={nativeModal.row} onClose={closeNative} />
        )}
        {nativeModal?.type === "task" && (
          <TaskDialog
            taskId={nativeModal.id}
            runOperation={runOperation}
            onClose={closeNative}
            notify={notify}
          />
        )}
        {nativeModal?.type === "project" && connection && (
          <Dialog
            title={nativeModal.project.name}
            description={nativeModal.project.path_with_namespace}
            drawer
            onClose={closeNative}
          >
            <dl className="detail-grid">
              <div className="full">
                <dt>描述</dt>
                <dd>{nativeModal.project.description ?? "未填写描述"}</dd>
              </div>
              <div>
                <dt>我的角色</dt>
                <dd>{roleName(accessLevel(nativeModal.project))}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{nativeModal.project.archived ? "已归档" : "活跃"}</dd>
              </div>
              <div className="full">
                <dt>仓库地址</dt>
                <dd className="wrap-cell">{nativeModal.project.web_url}</dd>
              </div>
            </dl>
            <div className="button-group">
              <Button onClick={() => openProject.mutate(nativeModal.project)}>
                <ExternalLink size={15} />在 GitLab 查看
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  nativeWorkspace!.chooseProject(nativeModal.project, true);
                  closeNative();
                  notify("已加入本任务仓库范围");
                }}
              >
                <Check size={15} />
                选择此仓库
              </Button>
            </div>
          </Dialog>
        )}
      </WorkspaceContext.Provider>
      {notice && (
        <div
          className={"toast " + (notice.error ? "error" : "")}
          role={notice.error ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          <button className="icon-btn" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
