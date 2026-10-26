/** IPC models mirror the Rust boundary; GitLab response fields retain their API spelling. */
export interface User {
  id: number;
  username: string;
  name: string;
  is_admin: boolean | null;
}
/** Saved identity and token metadata; legacy GitLab cannot report token scopes. */
export interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  revision: string;
  user: User;
  scopes: string[] | null;
  expiresAt: string | null;
  version: string;
  checkedAt: string;
}
export interface Project {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  description: string | null;
  web_url: string;
  archived: boolean;
  visibility: string;
  permissions: {
    project_access: { access_level: number } | null;
    group_access: { access_level: number } | null;
  } | null;
}
export interface HookEvents {
  push_events: boolean;
  merge_requests_events: boolean;
  pipeline_events: boolean;
  issues_events: boolean;
  tag_push_events: boolean;
}
export interface Hook extends HookEvents {
  id: number;
  name: string | null;
  url: string;
  enable_ssl_verification: boolean;
  token_present: boolean | null;
  signing_token_present: boolean | null;
}
export interface Member {
  id: number;
  name: string;
  username: string;
  access_level: number;
  expires_at: string | null;
}
export interface Group {
  id: number;
  name: string;
  full_path: string;
}
export interface Share {
  group_id: number;
  group_name: string;
  group_full_path: string;
  group_access_level: number;
  expires_at: string | null;
}
export type ReadResult<T> =
  { status: "not_requested" } | { status: "ready"; data: T } | { status: "error"; message: string };
/** Progress counts only completed inputs or projects, including failed reads. */
export interface ReadProgress {
  total: number;
  completed: number;
  failed: number;
}
/** Exact webhook query; name matching is offered only by supported GitLab versions. */
export interface WebhookQuery {
  field: "url" | "name";
  value: string;
}
/** Complete inspection with safe hook metadata; an unavailable read is never a missing webhook. */
export type ProjectWebhookCheck = { projectId: number } & (
  | { status: "present"; count: number; hooks: Hook[] }
  | { status: "missing" }
  | { status: "error"; message: string }
);
export type WebhookPresenceFilter =
  "all" | "present" | "duplicate" | "missing" | "error" | "unchecked";
/** Each requested ID survives independently; only successful metadata reads include a Project. */
export type ProjectResources = { projectId: number } & (
  | {
      status: "ready";
      project: Project;
      hooks: ReadResult<Hook[]>;
      members: ReadResult<{ direct: Member[]; all: Member[]; shares: Share[] }>;
    }
  | { status: "error"; message: string }
);
/** Repository filters match the current user's effective role exactly; null includes all roles. */
export interface ProjectFilter {
  search: string;
  archived: boolean | null;
  accessLevel: number | null;
}
export interface Resolution {
  input: string;
  candidates: Project[];
  error: string | null;
}
export type Resource = "hook" | "member" | "share";
export type Action = "create" | "update" | "delete" | "skip" | "conflict" | "blocked";
export type ItemStatus =
  "pending" | "running" | "succeeded" | "failed" | "unknown" | "skipped" | "blocked";
export interface PlanItem {
  id: string;
  projectId: number;
  projectPath: string;
  resource: Resource;
  targetId: number | null;
  subject: string | null;
  action: Action;
  status: ItemStatus;
  message: string;
  before: Record<string, unknown> | null;
  body: Record<string, unknown>;
  changes: { field: string; before: string | null; after: string | null }[];
  candidates: { id: number; name: string | null }[];
  secretRequired: boolean;
  attempts: number;
}
export interface Plan {
  id: string;
  connectionId: string;
  connectionRevision: string;
  title: string;
  items: PlanItem[];
  createdAt: string;
}
export interface Task extends Omit<Plan, "connectionRevision"> {
  connectionRevision: string;
  connectionName: string;
  status: "running" | "paused" | "attention" | "completed";
  updatedAt: string;
}
export interface HookTarget {
  projectId: number;
  hookId: number;
}
export interface HookRow {
  project: Project;
  hook: Hook;
}
export interface MemberTarget {
  projectId: number;
  userId: number;
}
export interface MemberRow {
  project: Project;
  member: Member;
  inherited: boolean;
}
/** Webhook edits omit fields unavailable on the connected GitLab version. */
export interface HookRequest {
  connectionId: string;
  projectIds: number[];
  targets: HookTarget[];
  mode: "ensure" | "create" | "update" | "delete";
  matchUrl: string;
  name: string | null;
  url: string | null;
  events: HookEvents | null;
  ssl: boolean | null;
  secret: string | null;
  choices: Record<string, number>;
  creation: { name: string | null; events: HookEvents; ssl: boolean } | null;
}
export interface PermissionRequest {
  connectionId: string;
  projectIds: number[];
  subjectIds: number[];
  targets: MemberTarget[];
  subjectType: "user" | "group";
  mode: "grant" | "update" | "revoke";
  accessLevel: number | null;
  updateExpiry: boolean;
  expiresAt: string | null;
}
/** Primary tasks keep independent repository scopes and drafts. */
export type TaskKind = "hooks" | "permissions";
export type Page = "home" | TaskKind | "tasks" | "connections";
/** Scans and submissions hold navigation until their connection-bound response settles. */
export type OperationRunner = <T>(work: () => Promise<T>) => Promise<T>;
