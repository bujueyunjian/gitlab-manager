import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Plus, Server, ShieldCheck, Trash2 } from "lucide-react";
import { api, desktop, errorMessage } from "./api";
import type { Connection } from "./types";
import { Badge, Button, Dialog, ErrorBox } from "./ui";
import { dateTime } from "./domain";

export function ConnectionDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection?: Connection;
  onClose: () => void;
  onSaved: (connection: Connection) => void;
}) {
  const [name, setName] = useState(connection?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () => api.saveConnection({ id: connection?.id ?? null, name, baseUrl, token }),
    onSuccess: (value) => {
      setToken("");
      onSaved(value);
    },
  });
  return (
    <Dialog
      title={connection ? "编辑 GitLab 连接" : "连接 GitLab"}
      description="连接后即可搜索仓库，批量管理权限与 Webhook。"
      onClose={onClose}
      busy={save.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            取消
          </Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!desktop || !name.trim() || !baseUrl.trim() || !token.trim()}
            onClick={() => save.mutate()}
          >
            验证并保存连接
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-field full">
          <span>连接名称</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：研发 GitLab"
            maxLength={80}
          />
        </label>
        <label className="form-field full">
          <span>GitLab 实例地址</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://gitlab.example.com"
            autoCapitalize="none"
            spellCheck={false}
          />
          <small>填写网页首页地址，不包含 /api/v4；自建实例的路径前缀会被保留。</small>
        </label>
        <label className="form-field full">
          <span>个人访问令牌</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              connection ? "重新输入令牌以验证连接" : "输入 GitLab Personal Access Token"
            }
            autoComplete="off"
          />
          <small>批量修改需要 api 范围；仅查看可以使用 read_api。令牌不会回显。</small>
        </label>
      </div>
      <details className="help-details">
        <summary>在哪里创建令牌？</summary>
        <p>
          在 GitLab 的个人设置中打开“访问令牌”，设置到期时间并选择 api
          范围，再复制令牌到这里。此工具仅拥有该令牌及账号本来具备的权限。
        </p>
      </details>
      <div className="hint">
        <ShieldCheck size={18} />
        <span>令牌保存在系统凭据存储中，不写入项目文件、任务记录或导出结果。</span>
      </div>
      {save.error && <ErrorBox message={errorMessage(save.error)} />}
    </Dialog>
  );
}

export function Connections({
  connections,
  currentId,
  onAdd,
  onEdit,
  onSwitch,
  onChanged,
  notify,
}: {
  connections: Connection[];
  currentId: string | null;
  onAdd: () => void;
  onEdit: (connection: Connection) => void;
  onSwitch: (id: string) => void;
  onChanged: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const check = useMutation({
    mutationFn: api.checkConnection,
    onSuccess: () => {
      onChanged();
      notify("连接验证通过");
    },
    onError: (e) => notify(errorMessage(e), true),
  });
  const remove = useMutation({
    mutationFn: api.deleteConnection,
    onSuccess: () => {
      setDeleting(null);
      onChanged();
      notify("本地连接已移除，GitLab 资源未受影响");
    },
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>连接配置</h1>
          <p>管理 GitLab 实例和访问身份。</p>
        </div>
        <Button variant="primary" onClick={onAdd}>
          <Plus size={16} />
          添加连接
        </Button>
      </div>
      <div className="connection-grid">
        {connections.map((connection) => (
          <article
            className={`connection-card ${currentId === connection.id ? "current" : ""}`}
            key={connection.id}
          >
            <div className="connection-top">
              <span className="repo-icon">
                <Server size={20} />
              </span>
              <div className="fill">
                <h3>{connection.name}</h3>
                <p className="url-text">{connection.baseUrl}</p>
              </div>
              {currentId === connection.id && <Badge color="accent">当前实例</Badge>}
            </div>
            <dl className="detail-grid">
              <div>
                <dt>访问身份</dt>
                <dd>
                  {connection.user.name} <small>@{connection.user.username}</small>
                </dd>
              </div>
              <div>
                <dt>GitLab 版本</dt>
                <dd>{connection.version}</dd>
              </div>
              <div>
                <dt>授权范围</dt>
                <dd>{connection.scopes.includes("api") ? "可读写 · api" : "只读 · read_api"}</dd>
              </div>
              <div>
                <dt>令牌到期时间</dt>
                <dd>{connection.expiresAt ?? "GitLab 未提供"}</dd>
              </div>
              <div className="full">
                <dt>最近验证</dt>
                <dd>{dateTime(connection.checkedAt)}</dd>
              </div>
            </dl>
            <div className="button-group">
              <Button
                className="small"
                busy={check.isPending && check.variables === connection.id}
                onClick={() => check.mutate(connection.id)}
              >
                检查连接
              </Button>
              <Button className="small" onClick={() => onEdit(connection)}>
                <KeyRound size={14} />
                编辑
              </Button>
              {currentId !== connection.id && (
                <Button className="small" onClick={() => onSwitch(connection.id)}>
                  切换
                </Button>
              )}
              <button
                className="icon-btn push-right"
                aria-label={`移除连接 ${connection.name}`}
                onClick={() => setDeleting(connection)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {deleting && (
        <Dialog
          title="移除本地连接"
          description={deleting.name}
          onClose={() => setDeleting(null)}
          busy={remove.isPending}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>取消</Button>
              <Button
                variant="danger"
                busy={remove.isPending}
                onClick={() => remove.mutate(deleting.id)}
              >
                移除连接
              </Button>
            </>
          }
        >
          <p>移除此连接及系统中保存的令牌。历史任务保留，GitLab 仓库和权限不会被删除。</p>
          {remove.error && <ErrorBox message={errorMessage(remove.error)} />}
        </Dialog>
      )}
    </>
  );
}
