import type {
  Hook,
  HookRow,
  HookRequest,
  Project,
  ProjectWebhookCheck,
  WebhookQuery,
} from "./types";
import type { RepositoryPermission } from "./permissionOverview";

/** UI groups distinguish confirmed absence from unresolved or unread configurations. */
export type HookGroup = "missing" | "present" | "needs";
/** A repository check keeps its unresolved state separate from any explicitly identified Hook. */
export interface HookTaskRow {
  project: Project;
  result?: ProjectWebhookCheck;
  hook?: Hook;
  eligible: boolean;
}

/** Both user and secondary sharing actions select only the visible, successfully read repository rows. */
export function permissionTaskRows(
  rows: RepositoryPermission[],
  hasUser: boolean,
): RepositoryPermission[] {
  return rows.filter(
    (row) =>
      row.members.status === "ready" &&
      (!hasUser || ["granted", "missing"].includes(row.coverage?.status ?? "")),
  );
}

/** Every permission batch uses the same explicit checked subset of current visible readable rows. */
export function permissionBatchProjects(
  rows: RepositoryPermission[],
  selected: ReadonlySet<number>,
  hasUser: boolean,
): Project[] {
  return permissionTaskRows(rows, hasUser)
    .filter((row) => selected.has(row.project.id))
    .map((row) => row.project);
}

/** Keep explicit duplicate IDs and include existing configurations only when the user requests a mixed batch. */
export function webhookTaskRows(
  projects: Project[],
  checks: ReadonlyMap<number, ProjectWebhookCheck>,
  group: HookGroup,
  includeExisting: boolean,
  choices: ReadonlyMap<number, number>,
): HookTaskRow[] {
  return projects.flatMap((project) => {
    const result = checks.get(project.id);
    const missing = result?.status === "missing";
    const unique = result?.status === "present" && result.hooks.length === 1;
    const belongs =
      group === "missing"
        ? missing || (includeExisting && unique)
        : group === "present"
          ? unique
          : !missing && !unique;
    if (!belongs) return [];
    const hook =
      result?.status === "present"
        ? result.hooks.find(
            (item) => item.id === (unique ? result.hooks[0].id : choices.get(project.id)),
          )
        : undefined;
    return [{ project, result, hook, eligible: missing || !!hook }];
  });
}

/** Build the exact visible, resolvable mutation scope; invalid selections never become creates. */
export function webhookBatch(
  rows: HookTaskRow[],
  selected: ReadonlySet<number>,
  query: WebhookQuery,
): {
  projects: Project[];
  rows: HookRow[];
  mode: HookRequest["mode"];
  creationCount: number;
  initialUrl: string;
  initialName?: string;
} | null {
  const chosen = rows.filter((row) => row.eligible && selected.has(row.project.id));
  if (!chosen.length) return null;
  const existing = chosen.flatMap((row) =>
    row.hook ? [{ project: row.project, hook: row.hook }] : [],
  );
  const creationCount = chosen.length - existing.length;
  const initialUrl =
    query.field === "url" ? query.value : creationCount ? "" : existing[0].hook.url;
  return {
    projects: chosen.map((row) => row.project),
    rows: existing,
    mode: creationCount ? (existing.length ? "ensure" : "create") : "update",
    creationCount,
    initialUrl,
    initialName: query.field === "name" ? query.value : undefined,
  };
}
