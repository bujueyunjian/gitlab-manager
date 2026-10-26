import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useReadProgress } from "./useReadProgress";
import { resourceFailures } from "./resourceReads";
import type {
  Connection,
  HookRequest,
  HookRow,
  MemberRow,
  OperationRunner,
  PermissionRequest,
  Project,
  ProjectResources,
  TaskKind,
  User,
} from "./types";

/** Secondary details and existing mutation forms retain their explicit targets. */
export type Modal =
  | { type: "connection"; connection?: Connection }
  | { type: "resolve" }
  | { type: "hookDetail"; row: HookRow }
  | {
      type: "hook";
      mode: HookRequest["mode"];
      rows?: HookRow[];
      projects: Project[];
      initialUrl?: string;
      initialName?: string;
      guided?: boolean;
      creationCount?: number;
    }
  | {
      type: "permission";
      mode: PermissionRequest["mode"];
      rows?: MemberRow[];
      projects: Project[];
      initialUsers?: User[];
      initialRole?: number;
    }
  | { type: "task"; id: string }
  | { type: "project"; project: Project };

/** Bind repository selection and operations to one task and connection identity. */
export interface Workspace {
  connection: Connection;
  active: boolean;
  task: TaskKind;
  selected: Map<number, Project>;
  selectedProjects: Project[];
  selectedIds: number[];
  writable: boolean;
  setSelected: Dispatch<SetStateAction<Map<number, Project>>>;
  setModal: (modal: Modal | null) => void;
  chooseProject: (project: Project, checked: boolean) => void;
  runOperation: OperationRunner;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
/** Details and task pages require their owning task scope. */
export function useWorkspace(): Workspace {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Task pages require an active workspace");
  return context;
}

/** Read only after scope selection, with identity, task and progress isolated together. */
export function useResources(kind: "hooks" | "members", enabled = true) {
  const { connection, selectedIds, task, active } = useWorkspace();
  const scope = JSON.stringify([connection.id, connection.revision, task, kind, selectedIds]);
  const progress = useReadProgress(scope);
  const query = useQuery({
    queryKey: ["resources", scope],
    queryFn: () =>
      progress.track(selectedIds.length, (report) =>
        api.resources(connection.id, selectedIds, kind, report),
      ),
    enabled: active && enabled && selectedIds.length > 0,
  });
  return { ...query, progress: progress.state };
}

/** Keep per-project failures visible independently of object and role filters. */
export function ResourceErrors({
  resources,
  kind,
  projects,
}: {
  resources: ProjectResources[];
  kind: "hooks" | "members";
  projects: Project[];
}) {
  const failures = resourceFailures(resources, kind);
  const labels = new Map(projects.map((project) => [project.id, project.path_with_namespace]));
  return (
    failures.length > 0 && (
      <details className="read-errors">
        <summary>
          {failures.length} 个仓库读取失败，
          {kind === "members" ? "未据此判断缺少成员授权" : "未将它们视为没有配置"}
        </summary>
        {failures.map((failure) => (
          <p key={failure.projectId}>
            <strong>{labels.get(failure.projectId) ?? "项目 #" + failure.projectId}</strong>：
            {failure.stage}读取失败 · {failure.message}
          </p>
        ))}
      </details>
    )
  );
}
