import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, RefreshCw, ShieldCheck, Webhook } from "lucide-react";
import { api } from "./api";
import { Button } from "./ui";
import { useReadProgress } from "./useReadProgress";
import { resourceFailures } from "./resourceReads";
import type {
  Connection,
  HookRequest,
  HookRow,
  MemberRow,
  Page,
  PermissionRequest,
  Project,
  ProjectResources,
  User,
  WebhookQuery,
} from "./types";

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

export interface Workspace {
  connection: Connection;
  selected: Map<number, Project>;
  selectedProjects: Project[];
  selectedIds: number[];
  writable: boolean;
  setSelected: Dispatch<SetStateAction<Map<number, Project>>>;
  setModal: Dispatch<SetStateAction<Modal | null>>;
  changePage: (page: Page) => void;
  chooseProject: (project: Project, checked: boolean) => void;
}

// Only the selected connection and repository scope are shared across pages.
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Resource pages require an active workspace");
  return value;
}

/** Read only the current page's resource and isolate progress by connection, kind and selection. */
export function useResources(kind: "hooks" | "members") {
  const { connection, selectedIds } = useWorkspace();
  const progress = useReadProgress(
    JSON.stringify([connection.id, connection.revision, kind, selectedIds]),
  );
  const query = useQuery({
    queryKey: ["resources", connection.id, connection.revision, kind, selectedIds],
    queryFn: () =>
      progress.track(selectedIds.length, (report) =>
        api.resources(connection.id, selectedIds, kind, report),
      ),
    enabled: selectedIds.length > 0,
  });
  return { ...query, progress: progress.state };
}

/** Batch actions apply only to selected repositories in the current query, with explicit user or hook targets. */
export function SelectionBar({
  inspection,
  scope,
  user,
  role,
  permissionChecking = false,
}: {
  inspection?: { query: WebhookQuery; targets: Project[]; matches: HookRow[]; checking: boolean };
  scope?: Project[];
  user?: User | null;
  role?: number | null;
  permissionChecking?: boolean;
}) {
  const { setSelected, writable, setModal, selectedProjects } = useWorkspace();
  const targets = scope ?? selectedProjects;
  return (
    <div className="selection-bar">
      <span>
        {scope ? "当前筛选已选" : "已选择"} <strong>{targets.length}</strong> 个仓库
      </span>
      <button className="text-btn" onClick={() => setSelected(new Map())}>
        清空选择
      </button>
      <div className="button-group">
        <Button
          className="small"
          disabled={!targets.length || !writable || permissionChecking}
          onClick={() =>
            setModal({
              type: "permission",
              mode: "grant",
              projects: targets,
              initialUsers: user ? [user] : undefined,
              initialRole:
                role !== undefined && role !== null && [10, 20, 30, 40].includes(role)
                  ? role
                  : undefined,
            })
          }
        >
          <ShieldCheck size={15} />
          {user ? "设置所选用户授权" : "批量授权"} ({targets.length})
        </Button>
        {inspection && (
          <Button
            className="small"
            disabled={
              !writable || permissionChecking || inspection.checking || !inspection.matches.length
            }
            onClick={() =>
              setModal({
                type: "hook",
                mode: "update",
                rows: inspection.matches,
                projects: inspection.matches.map((row) => row.project),
              })
            }
          >
            修改已选匹配项 ({inspection.matches.length})
          </Button>
        )}
        <Button
          className="small"
          variant="primary"
          disabled={
            !writable ||
            permissionChecking ||
            (inspection ? inspection.checking || !inspection.targets.length : !targets.length)
          }
          onClick={() =>
            setModal({
              type: "hook",
              mode: inspection ? "create" : "ensure",
              projects: inspection ? inspection.targets : targets,
              initialUrl: inspection?.query.field === "url" ? inspection.query.value : undefined,
              initialName: inspection?.query.field === "name" ? inspection.query.value : undefined,
            })
          }
        >
          <Webhook size={15} />
          {inspection ? "为已选未维护新增 (" + inspection.targets.length + ")" : "批量设置 Webhook"}
        </Button>
      </div>
    </div>
  );
}

export function ResourceScope({ refresh, fetching }: { refresh: () => void; fetching: boolean }) {
  const { selected, writable, changePage, setModal } = useWorkspace();
  return (
    <>
      <div className="scope-bar">
        <span>范围：已选 {selected.size} 个仓库</span>
        <Button className="small" onClick={() => changePage("repos")}>
          调整仓库范围
        </Button>
        <Button className="small" onClick={() => setModal({ type: "resolve" })}>
          <Link2 size={14} />
          批量粘贴
        </Button>
        <Button className="small push-right" busy={fetching} onClick={refresh}>
          <RefreshCw size={14} />
          刷新
        </Button>
      </div>
      {!writable && (
        <div className="hint warning">当前令牌仅允许查看。批量修改需要 api 授权范围。</div>
      )}
    </>
  );
}

/** Show every failed requested ID using known selection labels, without inventing project metadata. */
export function ResourceErrors({
  resources,
  kind,
  projects,
}: {
  resources: ProjectResources[];
  kind: "hooks" | "members";
  projects: Project[];
}) {
  const failed = resourceFailures(resources, kind);
  const labels = new Map(projects.map((project) => [project.id, project.path_with_namespace]));
  return (
    failed.length > 0 && (
      <details className="read-errors">
        <summary>
          {failed.length} 个仓库读取失败，
          {kind === "members" ? "未据此判断缺少成员授权" : "未将它们视为没有配置"}
        </summary>
        {failed.map((resource) => {
          return (
            <p key={resource.projectId}>
              <strong>{labels.get(resource.projectId) ?? "项目 #" + resource.projectId}</strong>：
              {resource.stage}读取失败 · {resource.message}
            </p>
          );
        })}
      </details>
    )
  );
}
