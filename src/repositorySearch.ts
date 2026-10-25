import { api } from "./api";
import { accessLevel } from "./domain";
import type { Project, ProjectFilter } from "./types";

/** Names use GitLab search; URLs and namespace paths use the backend's instance-validated resolver. */
export async function searchRepositories(
  connectionId: string,
  filter: ProjectFilter,
): Promise<Project[]> {
  if (!filter.search.includes("/")) return api.projects(connectionId, filter);
  const resolutions = await api.resolve(connectionId, [filter.search], () => {});
  const resolution = resolutions[0];
  if (!resolution) throw new Error("未收到仓库定位结果");
  if (resolution.error) throw new Error(resolution.error);
  return resolution.candidates.filter(
    (project) =>
      (filter.archived === null || project.archived === filter.archived) &&
      (filter.accessLevel === null || accessLevel(project) === filter.accessLevel),
  );
}
