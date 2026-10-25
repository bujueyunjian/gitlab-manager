import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { api, errorMessage } from "./api";
import type { User } from "./types";
import { Button, ErrorBox } from "./ui";

/** Resolve a typed name to an explicit user ID; stale search results never select an identity. */
export function UserLookup({
  connectionId,
  value,
  onChange,
  compact = false,
}: {
  connectionId: string;
  value: User | null;
  onChange: (user: User | null) => void;
  compact?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const lookup = useMutation({
    mutationFn: async (query: string) => ({ query, users: await api.users(connectionId, query) }),
  });
  return (
    <div className={"permission-lookup" + (compact ? " compact" : "")}>
      {(!compact || !value) && (
        <form
          className="permission-user-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (search.trim() && !lookup.isPending) {
              onChange(null);
              lookup.mutate(search.trim());
            }
          }}
        >
          <label htmlFor={id} className={compact ? "visually-hidden" : undefined}>
            查询用户的仓库授权
          </label>
          <div className="button-group">
            <input
              id={id}
              placeholder="搜索用户名或姓名，再选择具体用户"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                onChange(null);
                lookup.reset();
              }}
            />
            <Button busy={lookup.isPending} disabled={!search.trim()} type="submit">
              <Search size={15} />
              查找用户
            </Button>
          </div>
        </form>
      )}
      {lookup.error && lookup.variables === search.trim() && (
        <ErrorBox message={errorMessage(lookup.error)} />
      )}
      {!lookup.isPending && !value && lookup.data?.query === search.trim() && (
        <div className="permission-user-results">
          {lookup.data.users.length ? (
            lookup.data.users.map((candidate) => (
              <button key={candidate.id} onClick={() => onChange(candidate)}>
                <strong>{candidate.name}</strong>
                <span>@{candidate.username}</span>
              </button>
            ))
          ) : (
            <p className="scope-caption">没有匹配的用户，请尝试完整用户名。</p>
          )}
        </div>
      )}
      {value && (
        <div className="permission-current-user">
          <strong title={value.name + " (@" + value.username + ")"}>
            {compact ? "@" + value.username : value.name}
          </strong>
          {!compact && <span>@{value.username}</span>}
          <button
            className={compact ? "btn small" : "icon-btn"}
            aria-label={compact ? "更换查询用户" : "清除查询用户"}
            onClick={() => {
              onChange(null);
              lookup.reset();
            }}
          >
            {compact ? "更换用户" : <X size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}
