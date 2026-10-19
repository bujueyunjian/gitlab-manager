import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, RefreshCw, ShieldCheck, Webhook } from "lucide-react";
import { api } from "./api";
import { Button } from "./ui";
import type {
  Connection,
  HookRequest,
  HookRow,
  MemberRow,
  Page,
  PermissionRequest,
  Project,
  ProjectResources,
} from "./types";

export type Modal =
  | { type: "connection"; connection?: Connection }
  | { type: "resolve" }
  | { type: "hookDetail"; row: HookRow }
  | { type: "hook"; mode: HookRequest["mode"]; rows?: HookRow[]; projects: Project[] }
  | { type: "permission"; mode: PermissionRequest["mode"]; rows?: MemberRow[]; projects: Project[] }
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

export function useResources() {
  const { connection, selectedIds } = useWorkspace();
  return useQuery({
    queryKey: ["resources", connection.id, selectedIds],
    queryFn: () => api.resources(connection.id, selectedIds),
    enabled: selectedIds.length > 0,
  });
}

export function SelectionBar() {
  const { selected, setSelected, writable, setModal, selectedProjects } = useWorkspace();
  return (
    <div className="selection-bar">
      <span>
        已选择 <strong>{selected.size}</strong> 个仓库
      </span>
      <button className="text-btn" onClick={() => setSelected(new Map())}>
        清空选择
      </button>
      <div className="button-group">
        <Button
          className="small"
          disabled={!selected.size || !writable}
          onClick={() =>
            setModal({ type: "permission", mode: "grant", projects: selectedProjects })
          }
        >
          <ShieldCheck size={15} />
          批量授权
        </Button>
        <Button
          className="small"
          variant="primary"
          disabled={!selected.size || !writable}
          onClick={() => setModal({ type: "hook", mode: "ensure", projects: selectedProjects })}
        >
          <Webhook size={15} />
          批量设置 Webhook
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

export function ResourceErrors({
  resources,
  kind,
}: {
  resources: ProjectResources[];
  kind: "hooks" | "members";
}) {
  const failed = resources.filter((resource) => resource[kind].status === "error");
  return (
    failed.length > 0 && (
      <details className="read-errors">
        <summary>{failed.length} 个仓库读取失败，未将它们视为没有配置</summary>
        {failed.map((resource) => {
          const result = resource[kind];
          return (
            <p key={resource.project.id}>
              <strong>{resource.project.path_with_namespace}</strong>：
              {result.status === "error" ? result.message : ""}
            </p>
          );
        })}
      </details>
    )
  );
}
