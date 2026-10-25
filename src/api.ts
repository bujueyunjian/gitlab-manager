import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Connection,
  Group,
  HookRequest,
  PermissionRequest,
  Plan,
  Project,
  ProjectFilter,
  ProjectResources,
  ProjectWebhookCheck,
  Resolution,
  ReadProgress,
  WebhookQuery,
  Task,
  User,
} from "./types";

export const desktop = isTauri();

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "操作失败，未收到有效的错误说明";
}

/** No browser-side GitLab requests: credentials and instance validation stay in Rust. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) throw new Error("请在桌面应用中操作；网页只用于查看界面。");
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
}

export const api = {
  /** Open the bundled offline manual in the system browser. */
  openManual: () => call<void>("open_user_manual"),
  connections: () => call<Connection[]>("list_connections"),
  saveConnection: (input: { id: string | null; name: string; baseUrl: string; token: string }) =>
    call<Connection>("save_connection", { input }),
  checkConnection: (connectionId: string) => call<Connection>("check_connection", { connectionId }),
  deleteConnection: (connectionId: string) => call<void>("delete_connection", { connectionId }),
  projects: (connectionId: string, filter: ProjectFilter) =>
    call<Project[]>("list_projects", { connectionId, filter }),
  resolve: (connectionId: string, inputs: string[], onProgress: (progress: ReadProgress) => void) =>
    call<Resolution[]>("resolve_projects", {
      connectionId,
      inputs,
      onProgress: new Channel(onProgress),
    }),
  resources: (
    connectionId: string,
    projectIds: number[],
    kind: "hooks" | "members",
    onProgress: (progress: ReadProgress) => void,
  ) =>
    call<ProjectResources[]>("read_resources", {
      connectionId,
      projectIds,
      kind,
      onProgress: new Channel(onProgress),
    }),
  checkWebhooks: (connectionId: string, projectIds: number[], query: WebhookQuery) =>
    call<ProjectWebhookCheck[]>("check_webhooks", { connectionId, projectIds, query }),
  users: (connectionId: string, search: string) =>
    call<User[]>("search_users", { connectionId, search }),
  groups: (connectionId: string, search: string) =>
    call<Group[]>("search_groups", { connectionId, search }),
  previewHooks: (request: HookRequest) => call<Plan>("preview_hooks", { request }),
  previewPermissions: (request: PermissionRequest) =>
    call<Plan>("preview_permissions", { request }),
  discardPlan: (planId: string) => call<void>("discard_plan", { planId }),
  startPlan: (planId: string) => call<Task>("start_plan", { planId }),
  tasks: () => call<Task[]>("list_tasks"),
  task: (taskId: string) => call<Task>("read_task", { taskId }),
  stopTask: (taskId: string) => call<void>("stop_task", { taskId }),
  resumeTask: (taskId: string, itemIds: string[] | null, secret: string | null) =>
    call<Task>("resume_task", { taskId, itemIds, secret }),
  reconcile: (taskId: string) => call<Task>("reconcile_task", { taskId }),
  confirmUnknown: (taskId: string, itemId: string, note: string) =>
    call<Task>("confirm_unknown", { taskId, itemId, note }),
  exportTask: (taskId: string) => call<boolean>("export_task", { taskId }),
  openProject: (connectionId: string, projectId: number) =>
    call<void>("open_project", { connectionId, projectId }),
};
