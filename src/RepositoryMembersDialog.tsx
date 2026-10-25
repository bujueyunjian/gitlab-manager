import { useState } from "react";
import { Search } from "lucide-react";
import { roleName, roles } from "./domain";
import { inheritedMembers } from "./permissionOverview";
import type { MemberCollection } from "./permissionOverview";
import type { MemberRow, Project } from "./types";
import { Badge, Button, Dialog, Empty } from "./ui";

/** Inspect one repository; only selected direct memberships can enter the existing edit workflow. */
export function RepositoryMembersDialog({
  project,
  members,
  writable,
  onClose,
  onEdit,
  onGrant,
}: {
  project: Project;
  members: MemberCollection;
  writable: boolean;
  onClose: () => void;
  onEdit: (rows: MemberRow[], mode: "update" | "revoke") => void;
  onGrant: () => void;
}) {
  const [tab, setTab] = useState<"direct" | "inherited" | "shared">("direct");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(1);
  const query = search.trim().toLowerCase();
  const source = tab === "direct" ? members.direct : inheritedMembers(members);
  const filtered = source.filter(
    (member) =>
      [member.name, member.username].join(" ").toLowerCase().includes(query) &&
      (role === "all" || member.access_level === Number(role)),
  );
  const shares = members.shares.filter(
    (share) =>
      [share.group_name, share.group_full_path].join(" ").toLowerCase().includes(query) &&
      (role === "all" || share.group_access_level === Number(role)),
  );
  const count = tab === "shared" ? shares.length : filtered.length;
  const pages = Math.max(1, Math.ceil(count / 20));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * 20;
  const visible = filtered.slice(offset, offset + 20);
  const chosen =
    tab === "direct"
      ? filtered
          .filter((member) => selected.has(member.id))
          .map((member) => ({ project, member, inherited: false }))
      : [];
  /** A different search or source must not retain hidden mutation targets. */
  function resetSelection() {
    setSelected(new Set());
    setPage(1);
  }
  return (
    <Dialog
      title={project.name + " · 成员权限"}
      description={project.path_with_namespace}
      drawer
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" disabled={!writable} onClick={onGrant}>
            为此仓库授权
          </Button>
        </>
      }
    >
      <div className="tabs">
        {(
          [
            ["direct", "直接成员", members.direct.length],
            ["inherited", "继承或共享成员", inheritedMembers(members).length],
            ["shared", "共享群组", members.shares.length],
          ] as const
        ).map(([value, label, total]) => (
          <button
            key={value}
            className={"tab " + (tab === value ? "active" : "")}
            onClick={() => {
              setTab(value);
              resetSelection();
            }}
          >
            {label} ({total})
          </button>
        ))}
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索当前仓库成员或群组"
            placeholder="搜索姓名、用户名或群组"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetSelection();
            }}
          />
        </div>
        <select
          aria-label="筛选当前仓库成员角色"
          value={role}
          onChange={(event) => {
            setRole(event.target.value);
            resetSelection();
          }}
        >
          <option value="all">全部角色</option>
          {Object.entries(roles).map(([level, label]) => (
            <option key={level} value={level}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {chosen.length > 0 && (
        <div className="selection-bar">
          已选 {chosen.length} 条直接授权
          <div className="button-group">
            <Button className="small" disabled={!writable} onClick={() => onEdit(chosen, "update")}>
              修改授权
            </Button>
            <Button className="small" disabled={!writable} onClick={() => onEdit(chosen, "revoke")}>
              撤销授权
            </Button>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {tab === "direct" && (
                <th className="check-col">
                  <input
                    type="checkbox"
                    aria-label="选择本页直接成员"
                    checked={
                      visible.length > 0 && visible.every((member) => selected.has(member.id))
                    }
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        visible.forEach((member) =>
                          event.target.checked ? next.add(member.id) : next.delete(member.id),
                        );
                        return next;
                      })
                    }
                  />
                </th>
              )}
              <th>{tab === "shared" ? "共享群组" : "成员"}</th>
              <th>角色</th>
              <th>到期时间</th>
            </tr>
          </thead>
          <tbody>
            {tab === "shared"
              ? shares.slice(offset, offset + 20).map((share) => (
                  <tr key={share.group_id}>
                    <td>
                      {share.group_name}
                      <small className="cell-note">{share.group_full_path}</small>
                    </td>
                    <td>
                      <Badge>{roleName(share.group_access_level)}</Badge>
                    </td>
                    <td>{share.expires_at ?? "长期有效"}</td>
                  </tr>
                ))
              : visible.map((member) => (
                  <tr key={member.id}>
                    {tab === "direct" && (
                      <td className="check-col">
                        <input
                          type="checkbox"
                          aria-label={"选择直接成员 " + member.username}
                          checked={selected.has(member.id)}
                          onChange={(event) =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              event.target.checked ? next.add(member.id) : next.delete(member.id);
                              return next;
                            })
                          }
                        />
                      </td>
                    )}
                    <td>
                      {member.name}
                      <small className="cell-note">@{member.username}</small>
                    </td>
                    <td>
                      <Badge>{roleName(member.access_level)}</Badge>
                    </td>
                    <td>{member.expires_at ?? "长期有效"}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!count && (
        <Empty title="没有匹配的记录">当前仓库在此来源和筛选条件下没有返回成员或群组。</Empty>
      )}
      <div className="pagination">
        <span>{count} 条记录</span>
        <span>
          {currentPage} / {pages} 页
        </span>
        <div className="pages">
          <Button
            className="small"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </Button>
          <Button
            className="small"
            disabled={currentPage === pages}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
      {tab !== "direct" && (
        <p className="scope-caption">
          继承或共享权限由来源群组控制。删除直接成员不会撤销其他来源的权限；完整来源需在 GitLab
          核实。
        </p>
      )}
    </Dialog>
  );
}
