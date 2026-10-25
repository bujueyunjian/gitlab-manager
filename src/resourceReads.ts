import type { HookRow, Project, ProjectResources } from "./types";

/** A failed project or resource read retains its requested ID and safe error message. */
export interface ResourceFailure {
  projectId: number;
  stage: "项目" | "Webhook" | "成员";
  message: string;
}

/** Distinguish metadata failures from failures inside a successfully identified project. */
export function resourceFailures(
  resources: ProjectResources[],
  kind: "hooks" | "members",
): ResourceFailure[] {
  return resources.flatMap<ResourceFailure>((resource) => {
    if (resource.status === "error")
      return [{ projectId: resource.projectId, stage: "项目" as const, message: resource.message }];
    const result = resource[kind];
    return result.status === "error"
      ? [
          {
            projectId: resource.projectId,
            stage: kind === "hooks" ? ("Webhook" as const) : ("成员" as const),
            message: result.message,
          },
        ]
      : [];
  });
}

/** Only fully read Hook lists may supply visible configurations or repositories for batch settings. */
export function hookOverview(resources: ProjectResources[]): {
  projects: Project[];
  hooks: HookRow[];
} {
  const projects: Project[] = [];
  const hooks: HookRow[] = [];
  for (const resource of resources) {
    if (resource.status !== "ready" || resource.hooks.status !== "ready") continue;
    projects.push(resource.project);
    hooks.push(...resource.hooks.data.map((hook) => ({ project: resource.project, hook })));
  }
  return { projects, hooks };
}
