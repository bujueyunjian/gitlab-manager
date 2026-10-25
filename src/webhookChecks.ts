import type { HookRow, Project, ProjectWebhookCheck, WebhookPresenceFilter } from "./types";

/** Read small batches so stopping prevents further requests and late results can be discarded. */
export async function inspectWebhookBatches(
  projectIds: number[],
  read: (ids: number[]) => Promise<ProjectWebhookCheck[]>,
  onBatch: (rows: ProjectWebhookCheck[]) => void,
  cancelled: () => boolean,
): Promise<void> {
  const uniqueIds = [...new Set(projectIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += 4) {
    if (cancelled()) return;
    const rows = await read(uniqueIds.slice(offset, offset + 4));
    if (cancelled()) return;
    onBatch(rows);
  }
}

/** Filter explicit inspection outcomes; absent results remain unchecked. */
export function filterWebhookProjects(
  projects: Project[],
  checks: ReadonlyMap<number, ProjectWebhookCheck>,
  status: WebhookPresenceFilter,
): Project[] {
  return status === "all"
    ? projects
    : projects.filter((project) => {
        const result = checks.get(project.id);
        return status === "duplicate"
          ? result?.status === "present" && result.count > 1
          : (result?.status ?? "unchecked") === status;
      });
}

/** Batch edits require exactly one matched Hook per selected repository; duplicates need an explicit choice. */
export function uniqueWebhookTargets(
  projects: Project[],
  checks: ReadonlyMap<number, ProjectWebhookCheck>,
  selected: ReadonlyMap<number, Project>,
): HookRow[] {
  return projects.flatMap((project) => {
    const result = checks.get(project.id);
    return selected.has(project.id) && result?.status === "present" && result.hooks.length === 1
      ? [{ project, hook: result.hooks[0] }]
      : [];
  });
}

/** Only selected, visible projects with successful missing results may enter the create-only flow. */
export function missingWebhookTargets(
  projects: Project[],
  checks: ReadonlyMap<number, ProjectWebhookCheck>,
  selected: ReadonlyMap<number, Project>,
): Project[] {
  return projects.filter(
    (project) => selected.has(project.id) && checks.get(project.id)?.status === "missing",
  );
}
