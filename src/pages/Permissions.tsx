import { useState } from "react";
import { ArrowRight, Plus, Search } from "lucide-react";
import { errorMessage } from "../api";
import { roleName, uniqueProjects } from "../domain";
import type { MemberRow } from "../types";
import { Badge, Button, Empty, ErrorBox, Loading } from "../ui";
import { ResourceScope, ResourceErrors, useResources, useWorkspace } from "../Workspace";

export function PermissionsPage() {
  const { selected, selectedProjects, writable, setModal, changePage } = useWorkspace();
  const resources = useResources();
  const [resourceSearch, setResourceSearch] = useState("");
  const [memberTab, setMemberTab] = useState<"direct" | "inherited" | "shared">("direct");
  const [memberRoleFilter, setMemberRoleFilter] = useState("all");
  const [memberSelected, setMemberSelected] = useState<Set<string>>(new Set());
  const memberKey = (row: MemberRow) => `${row.project.id}:${row.member.id}`;
  const memberRows: MemberRow[] = (resources.data ?? []).flatMap<MemberRow>((resource) => {
    if (resource.members.status === "error") return [];
    const data = resource.members.data;
    if (memberTab === "shared") return [];
    if (memberTab === "direct")
      return data.direct.map((member) => ({ project: resource.project, member, inherited: false }));
    // The aggregate member API does not expose a full provenance chain. Do not invent one.
    return data.all
      .filter(
        (member) =>
          !data.direct.some(
            (direct) => direct.id === member.id && direct.access_level >= member.access_level,
          ),
      )
      .map((member) => ({ project: resource.project, member, inherited: true }));
  });
  const shownMembers = memberRows.filter(
    (row) =>
      [row.member.name, row.member.username, row.project.path_with_namespace]
        .join(" ")
        .toLowerCase()
        .includes(resourceSearch.toLowerCase()) &&
      (memberRoleFilter === "all" || row.member.access_level === Number(memberRoleFilter)),
  );

  const chosen = memberRows.filter((row) => memberSelected.has(memberKey(row)));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>授权管理</h1>
          <p>查看谁能访问仓库，批量设置角色与有效期限。</p>
        </div>
        <Button
          variant="primary"
          disabled={!selected.size || !writable}
          onClick={() =>
            setModal({ type: "permission", mode: "grant", projects: selectedProjects })
          }
        >
          <Plus size={16} />
          批量授权
        </Button>
      </div>
      {<ResourceScope refresh={() => void resources.refetch()} fetching={resources.isFetching} />}
      {!selected.size ? (
        <Empty
          title="先选择要管理的仓库"
          action={
            <Button variant="primary" onClick={() => changePage("repos")}>
              选择仓库
              <ArrowRight size={15} />
            </Button>
          }
        >
          在仓库页多选，或粘贴仓库地址和应用名。
        </Empty>
      ) : (
        <section className="panel">
          <div className="tabs">
            {[
              ["direct", "直接成员"],
              ["inherited", "继承或共享成员"],
              ["shared", "共享群组"],
            ].map(([value, label]) => (
              <button
                className={`tab ${memberTab === value ? "active" : ""}`}
                key={value}
                onClick={() => {
                  setMemberTab(value as typeof memberTab);
                  setMemberSelected(new Set());
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <div className="search-box">
              <Search size={16} />
              <input
                aria-label="搜索成员或授权"
                value={resourceSearch}
                onChange={(e) => setResourceSearch(e.target.value)}
                placeholder="搜索成员、用户名或仓库"
              />
            </div>
            <select
              aria-label="筛选成员角色"
              value={memberRoleFilter}
              onChange={(e) => setMemberRoleFilter(e.target.value)}
            >
              <option value="all">全部角色</option>
              {[10, 20, 30, 40, 50].map((level) => (
                <option value={level} key={level}>
                  {roleName(level)}
                </option>
              ))}
            </select>
          </div>
          {chosen.length > 0 && memberTab === "direct" && (
            <div className="selection-bar">
              已选 {chosen.length} 条直接授权
              <div className="button-group">
                <Button
                  className="small"
                  disabled={!writable}
                  onClick={() =>
                    setModal({
                      type: "permission",
                      mode: "update",
                      rows: chosen,
                      projects: uniqueProjects(chosen),
                    })
                  }
                >
                  修改授权
                </Button>
                <Button
                  className="small"
                  disabled={!writable}
                  onClick={() =>
                    setModal({
                      type: "permission",
                      mode: "revoke",
                      rows: chosen,
                      projects: uniqueProjects(chosen),
                    })
                  }
                >
                  撤销授权
                </Button>
              </div>
            </div>
          )}
          {resources.isPending ? (
            <Loading />
          ) : resources.error ? (
            <ErrorBox message={errorMessage(resources.error)} />
          ) : (
            <>
              {<ResourceErrors resources={resources.data ?? []} kind="members" />}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="check-col">
                        {memberTab === "direct" && (
                          <input
                            type="checkbox"
                            aria-label="选择筛选后的直接成员"
                            checked={
                              shownMembers.length > 0 &&
                              shownMembers.every((row) => memberSelected.has(memberKey(row)))
                            }
                            onChange={(e) =>
                              setMemberSelected((previous) => {
                                const next = new Set(previous);
                                shownMembers.forEach((row) =>
                                  e.target.checked
                                    ? next.add(memberKey(row))
                                    : next.delete(memberKey(row)),
                                );
                                return next;
                              })
                            }
                          />
                        )}
                      </th>
                      <th>{memberTab === "shared" ? "共享群组" : "成员"}</th>
                      <th>仓库</th>
                      <th>角色</th>
                      <th>到期时间</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberTab === "shared"
                      ? (resources.data ?? []).flatMap((resource) =>
                          resource.members.status === "ready"
                            ? resource.members.data.shares
                                .filter(
                                  (share) =>
                                    [
                                      share.group_name,
                                      share.group_full_path,
                                      resource.project.path_with_namespace,
                                    ]
                                      .join(" ")
                                      .toLowerCase()
                                      .includes(resourceSearch.toLowerCase()) &&
                                    (memberRoleFilter === "all" ||
                                      share.group_access_level === Number(memberRoleFilter)),
                                )
                                .map((share) => (
                                  <tr key={`${resource.project.id}:${share.group_id}`}>
                                    <td />
                                    <td>
                                      {share.group_name}
                                      <small className="cell-note">{share.group_full_path}</small>
                                    </td>
                                    <td>{resource.project.path_with_namespace}</td>
                                    <td>
                                      <Badge>{roleName(share.group_access_level)}</Badge>
                                    </td>
                                    <td>{share.expires_at ?? "长期有效"}</td>
                                    <td>
                                      <Badge color="accent">群组共享</Badge>
                                    </td>
                                  </tr>
                                ))
                            : [],
                        )
                      : shownMembers.map((row) => (
                          <tr key={memberKey(row)}>
                            <td className="check-col">
                              {!row.inherited && (
                                <input
                                  type="checkbox"
                                  aria-label={`选择 ${row.member.username} · ${row.project.path_with_namespace}`}
                                  checked={memberSelected.has(memberKey(row))}
                                  onChange={(e) =>
                                    setMemberSelected((previous) => {
                                      const next = new Set(previous);
                                      e.target.checked
                                        ? next.add(memberKey(row))
                                        : next.delete(memberKey(row));
                                      return next;
                                    })
                                  }
                                />
                              )}
                            </td>
                            <td>
                              {row.member.name}
                              <small className="cell-note">@{row.member.username}</small>
                            </td>
                            <td>{row.project.path_with_namespace}</td>
                            <td>
                              <Badge color={row.member.access_level >= 40 ? "accent" : "gray"}>
                                {roleName(row.member.access_level)}
                              </Badge>
                            </td>
                            <td>{row.member.expires_at ?? "长期有效"}</td>
                            <td>
                              <Badge>{row.inherited ? "继承或共享" : "直接授权"}</Badge>
                            </td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
      {memberTab !== "direct" && (
        <div className="hint">
          继承或共享权限由来源群组控制，不能通过删除仓库的直接成员来撤销。完整来源请在 GitLab
          的仓库成员页面查看。
        </div>
      )}
    </>
  );
}
