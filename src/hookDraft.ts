import type { HookEvents, HookRequest, HookRow, Project } from "./types";

/** Existing values remain unchanged unless their corresponding fields were explicitly selected. */
export interface HookFields {
  name: boolean;
  url: boolean;
  events: boolean;
  ssl: boolean;
  secret: boolean;
}
/** Form inputs needed by the existing planner contract, including mixed explicit-ID targets. */
export interface HookDraft {
  connectionId: string;
  projects: Project[];
  rows: HookRow[];
  mode: HookRequest["mode"];
  matchUrl: string;
  name: string;
  url: string;
  events: HookEvents;
  ssl: boolean;
  secret: string;
  fields: HookFields;
  namesSupported: boolean;
  choices: Record<string, number>;
}
/** Guided flows own creation URLs; a named mixed batch must never borrow the first existing URL. */
export function initialHookMatchUrl(guided: boolean, initialUrl: string, rows: HookRow[]): string {
  return guided ? initialUrl : (rows[0]?.hook.url ?? initialUrl);
}
/** New configurations use established safe defaults independently of selected existing Hooks. */
export function initialHookSettings(
  rows: HookRow[],
  initialName: string,
  creating: boolean,
): { name: string; events: HookEvents; ssl: boolean } {
  const first = creating ? undefined : rows[0]?.hook;
  return {
    name: first?.name ?? initialName,
    events: {
      push_events: first?.push_events ?? true,
      merge_requests_events: first?.merge_requests_events ?? true,
      pipeline_events: first?.pipeline_events ?? false,
      issues_events: first?.issues_events ?? false,
      tag_push_events: first?.tag_push_events ?? false,
    },
    ssl: first?.enable_ssl_verification ?? true,
  };
}
/** Translate explicit fields without changing the five-event group or authentication boundary. */
export function buildHookRequest(draft: HookDraft): HookRequest {
  return {
    connectionId: draft.connectionId,
    projectIds: draft.projects.map((project) => project.id),
    targets: draft.rows.map((row) => ({ projectId: row.project.id, hookId: row.hook.id })),
    mode: draft.mode,
    matchUrl: draft.matchUrl,
    name: draft.namesSupported && draft.fields.name ? draft.name : null,
    url: draft.fields.url ? draft.url : null,
    events: draft.fields.events ? draft.events : null,
    ssl: draft.fields.ssl ? draft.ssl : null,
    secret: draft.fields.secret ? draft.secret : null,
    choices: draft.choices,
    creation:
      draft.mode === "ensure" || draft.mode === "create"
        ? { name: draft.namesSupported ? draft.name : null, events: draft.events, ssl: draft.ssl }
        : null,
  };
}
