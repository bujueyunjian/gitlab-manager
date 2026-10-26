import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Search } from "lucide-react";
import { api, errorMessage } from "./api";
import { buildHookRequest, initialHookMatchUrl, initialHookSettings } from "./hookDraft";
import { actionLabels, eventLabels, roles, supportsWebhookNames } from "./domain";
import type {
  Connection,
  Group,
  HookEvents,
  HookRequest,
  HookRow,
  MemberRow,
  OperationRunner,
  PermissionRequest,
  Plan,
  Project,
  Task,
  User,
} from "./types";
import { Badge, Button, Dialog, ErrorBox, TaskSteps } from "./ui";

function Preview({
  plan,
  onChoose,
}: {
  plan: Plan;
  onChoose?: (projectId: number, hookId: number) => void;
}) {
  const counts = Object.fromEntries(
    Object.keys(actionLabels).map((action) => [
      action,
      plan.items.filter((item) => item.action === action).length,
    ]),
  );
  return (
    <>
      <div className="preview-counts">
        {Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([action, count]) => (
            <span className="preview-count" key={action}>
              <b>{count}</b>
              {actionLabels[action as keyof typeof actionLabels]}
            </span>
          ))}
      </div>
      <div className="preview-table">
        <table>
          <thead>
            <tr>
              <th>仓库 / 对象</th>
              <th>操作</th>
              <th>具体变更</th>
            </tr>
          </thead>
          <tbody>
            {plan.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.projectPath}</strong>
                  {item.subject && <small className="cell-note">{item.subject}</small>}
                </td>
                <td>
                  <Badge
                    color={
                      item.action === "blocked" || item.action === "delete"
                        ? "red"
                        : item.action === "conflict"
                          ? "amber"
                          : item.action === "create"
                            ? "green"
                            : "accent"
                    }
                  >
                    {actionLabels[item.action]}
                  </Badge>
                </td>
                <td>
                  <div className="changes">
                    {item.changes.map((change, index) => (
                      <div key={index}>
                        <span>{change.field}：</span>
                        {change.before !== null && (
                          <>
                            <del>{change.before}</del> →{" "}
                          </>
                        )}
                        <ins>{change.after ?? "移除"}</ins>
                      </div>
                    ))}
                  </div>
                  <small className="cell-note">{item.message}</small>
                  {item.action === "conflict" && onChoose && (
                    <select
                      aria-label={`选择 ${item.projectPath} 的 Webhook`}
                      value=""
                      onChange={(e) => onChoose(item.projectId, Number(e.target.value))}
                    >
                      <option value="">请选择具体 Webhook</option>
                      {item.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          #{candidate.id} · {candidate.name ?? "未命名"}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Steps({ preview }: { preview: boolean }) {
  return (
    <div className="steps">
      <span className={`step ${preview ? "done" : "current"}`}>
        <b>{preview ? "✓" : "1"}</b>设置操作
      </span>
      <span className={`step ${preview ? "current" : ""}`}>
        <b>2</b>预览变更
      </span>
      <span className="step">
        <b>3</b>逐项结果
      </span>
    </div>
  );
}
function Targets({ projects }: { projects: Project[] }) {
  return (
    <div className="target-summary">
      <span>本次操作 {projects.length} 个仓库</span>
      <div className="target-chips">
        {projects.map((project) => (
          <span className="target-chip" key={project.id}>
            {project.path_with_namespace}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Preview supported webhook fields before explicitly executing a batch change. */
export function HookDialog({
  connection,
  projects,
  rows = [],
  initialMode = "ensure",
  initialUrl = "",
  initialName = "",
  onClose,
  onStarted,
  notify,
  presentation = "dialog",
  active = true,
  guided = false,
  creationCount = 0,
  runOperation,
}: {
  connection: Connection;
  projects: Project[];
  rows?: HookRow[];
  initialMode?: HookRequest["mode"];
  initialUrl?: string;
  initialName?: string;
  onClose: () => void;
  onStarted: (task: Task) => void;
  notify: (message: string, error?: boolean) => void;
  presentation?: "dialog" | "page";
  active?: boolean;
  guided?: boolean;
  creationCount?: number;
  runOperation: OperationRunner;
}) {
  const first = rows[0]?.hook;
  const namesSupported = supportsWebhookNames(connection.version);
  const mode = initialMode;
  const creating = mode === "create" || creationCount > 0;
  const mixed = creating && rows.length > 0;
  const initial = initialHookSettings(rows, initialName, creating);
  const [matchUrl, setMatchUrl] = useState(initialHookMatchUrl(guided, initialUrl, rows));
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(first?.url ?? "");
  const [events, setEvents] = useState<HookEvents>(initial.events);
  const [ssl, setSsl] = useState(initial.ssl);
  const [fields, setFields] = useState({
    name: namesSupported && initialMode === "create",
    url: false,
    events: initialMode === "create",
    ssl: initialMode === "create",
    secret: false,
  });
  const [secret, setSecret] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const preparedId = useRef<string | null>(null);
  useEffect(
    () => () => {
      const id = preparedId.current;
      preparedId.current = null;
      if (id) void api.discardPlan(id).catch((error) => notify(errorMessage(error), true));
    },
    [],
  );
  const [choices, setChoices] = useState<Record<string, number>>({});
  const request = (overrides = choices): HookRequest =>
    buildHookRequest({
      connectionId: connection.id,
      projects,
      rows,
      mode,
      matchUrl,
      name,
      url,
      events,
      ssl,
      secret,
      fields,
      namesSupported,
      choices: overrides,
    });
  const scan = useMutation({
    mutationFn: (override: Record<string, number>) =>
      runOperation(() => api.previewHooks(request(override))),
    onSuccess: (value) => {
      preparedId.current = value.id;
      setPlan(value);
    },
  });
  const execute = useMutation({
    mutationFn: () => runOperation(() => api.startPlan(plan!.id)),
    onSuccess: (task) => {
      preparedId.current = null;
      setSecret("");
      onStarted(task);
    },
  });
  const busy = scan.isPending || execute.isPending;
  useEffect(() => {
    if (active) return;
    clearPlan();
    setSecret("");
  }, [active]);
  const needsConfirmation = mode === "delete";
  const executable =
    plan?.items.some((item) => item.status === "pending") &&
    !plan.items.some((item) => item.action === "conflict") &&
    (!needsConfirmation || confirmed);
  /** Discard the exact prepared plan while retaining editable settings. */
  function clearPlan() {
    const id = preparedId.current;
    preparedId.current = null;
    if (id) void api.discardPlan(id).catch((error) => notify(errorMessage(error), true));
    setPlan(null);
    setConfirmed(false);
    scan.reset();
    execute.reset();
  }
  function close() {
    clearPlan();
    setSecret("");
    onClose();
  }
  const title =
    mode === "delete"
      ? "批量删除 Webhook"
      : mode === "update"
        ? "批量修改 Webhook"
        : "批量设置 Webhook";
  return (
    <Dialog
      presentation={presentation}
      title={title}
      bodyKey={plan?.id ?? "settings"}
      description={
        connection.scopes === null
          ? "令牌范围未知。批量修改需 api 范围，实际权限由 GitLab 校验。"
          : "核对仓库与变更后确认执行。"
      }
      wide
      busy={busy}
      onClose={close}
      footer={
        <>
          <span className="foot-info">
            {plan ? "只执行本次预览中明确的变更" : "扫描只读取配置，不修改 GitLab"}
          </span>
          {plan ? (
            <>
              <Button disabled={busy} onClick={clearPlan}>
                返回修改
              </Button>
              <Button
                variant={needsConfirmation ? "danger" : "primary"}
                busy={execute.isPending}
                disabled={!executable || scan.isPending}
                onClick={() => execute.mutate()}
              >
                确认执行
                <ArrowRight size={15} />
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={close}>
                取消
              </Button>
              <Button
                variant="primary"
                busy={scan.isPending}
                disabled={!projects.length}
                onClick={() => scan.mutate(choices)}
              >
                <Search size={15} />
                扫描并预览
              </Button>
            </>
          )}
        </>
      }
    >
      {presentation === "page" ? <TaskSteps step={plan ? 3 : 2} /> : <Steps preview={!!plan} />}
      {!plan ? (
        <>
          <Targets projects={projects} />
          {mode === "delete" ? (
            <div className="hint warning">
              删除选中的 {rows.length} 条 Webhook 配置，不删除仓库或其他 Hook。
            </div>
          ) : (
            <>
              {(!rows.length || creationCount > 0) && (
                <label className="form-field full">
                  <span>{guided ? "新增配置使用的 Webhook 地址" : "匹配的 Webhook 地址"}</span>
                  <input
                    value={matchUrl}
                    onChange={(e) => {
                      setMatchUrl(e.target.value);
                      setChoices({});
                    }}
                    placeholder="https://hooks.example.com/gitlab"
                    spellCheck={false}
                  />
                  <small>按完整地址匹配。重复地址需要选择具体配置；同名异址会阻止新增。</small>
                </label>
              )}
              <div className="form-section">
                <h3>要设置的内容</h3>
                <p className="scope-caption">
                  {mode === "create"
                    ? "填写新增配置，下一步逐仓库预览。"
                    : mixed
                      ? "新增使用完整设置；已有只改明确勾选的字段。"
                      : "只改明确勾选的字段，其他设置保持。"}
                </p>
                {namesSupported ? (
                  <div className="edit-field">
                    {mode === "create" ? (
                      <span>名称（新增必填）</span>
                    ) : (
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={fields.name}
                          onChange={(e) => setFields({ ...fields, name: e.target.checked })}
                        />
                        {mixed ? "同时修改已有配置的名称" : "修改名称"}
                      </label>
                    )}
                    <div>
                      <input
                        aria-label="Webhook 名称"
                        value={name}
                        disabled={!creating && !fields.name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="例如：研发通知"
                      />
                      {creating && (
                        <small>
                          {mode === "create"
                            ? "新增配置的名称必填。"
                            : "新增名称必填；上方开关仅控制是否同时改名已有配置。"}
                        </small>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="scope-caption">
                    当前 GitLab 版本不支持 Webhook 名称，将按地址管理。
                  </p>
                )}
                <div className="edit-field">
                  {mode === "create" ? (
                    <span>触发事件（新增配置）</span>
                  ) : (
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={fields.events}
                        onChange={(e) => setFields({ ...fields, events: e.target.checked })}
                      />
                      {mixed ? "同时修改已有配置的触发事件" : "修改触发事件"}
                    </label>
                  )}
                  <div className="checkbox-grid">
                    {Object.entries(eventLabels).map(([key, label]) => (
                      <label className="check-label" key={key}>
                        <input
                          type="checkbox"
                          disabled={!creating && !fields.events}
                          checked={events[key as keyof HookEvents]}
                          onChange={(e) => setEvents({ ...events, [key]: e.target.checked })}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <p className="scope-caption">
                  {creating ? "新增使用下方完整配置。" : ""}
                  修改已有触发事件时，勾选的事件开启，未勾选的事件关闭；未选择修改开关时，已有的五种事件保持。
                </p>
                <div className="edit-field">
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={fields.secret}
                      onChange={(e) => setFields({ ...fields, secret: e.target.checked })}
                    />
                    设置新密钥
                  </label>
                  <div>
                    <input
                      type="password"
                      aria-label="Webhook 接收端密钥"
                      disabled={!fields.secret}
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      autoComplete="off"
                    />
                    <small>
                      已有密钥不回显；不选中时保持不变，空白不会清空。密钥仅用于本次执行。
                    </small>
                  </div>
                </div>
                <details className="help-details">
                  <summary>地址与 TLS 设置</summary>
                  {mode !== "create" && (
                    <div className="edit-field">
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={fields.url}
                          onChange={(e) => setFields({ ...fields, url: e.target.checked })}
                        />
                        {mixed ? "同时更换已有配置的目标地址" : "更换目标地址"}
                      </label>
                      <input
                        aria-label="新的 Webhook 地址"
                        disabled={!fields.url}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="新的接收地址"
                      />
                    </div>
                  )}
                  <div className="edit-field">
                    {mode === "create" ? (
                      <span>TLS 证书校验（新增配置）</span>
                    ) : (
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={fields.ssl}
                          onChange={(e) => setFields({ ...fields, ssl: e.target.checked })}
                        />
                        {mixed ? "同时修改已有配置的 TLS 校验" : "修改 TLS 校验"}
                      </label>
                    )}
                    <label className="check-label">
                      <input
                        type="checkbox"
                        disabled={!creating && !fields.ssl}
                        checked={ssl}
                        onChange={(e) => setSsl(e.target.checked)}
                      />
                      验证接收端证书
                    </label>
                  </div>
                  {creating && (
                    <p className="scope-caption">
                      {mode === "create"
                        ? "新增配置默认验证接收端证书。"
                        : "新增默认验证接收端证书；未勾选修改开关时，已有校验设置保持。"}
                    </p>
                  )}
                </details>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <Preview
            plan={plan}
            onChoose={(projectId, hookId) => {
              if (busy) return;
              const next = { ...choices, [projectId]: hookId };
              setChoices(next);
              scan.mutate(next);
            }}
          />
          {needsConfirmation && (
            <label className="delete-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核对仓库与 Hook，确认删除这些配置。
            </label>
          )}
        </>
      )}
      {(scan.error || execute.error) && (
        <ErrorBox message={errorMessage(scan.error ?? execute.error)} />
      )}
    </Dialog>
  );
}

/** Preview explicit repository and member targets; an inspected user can be preselected for grants. */
export function PermissionDialog({
  connection,
  projects,
  rows = [],
  initialMode = "grant",
  initialUsers = [],
  initialRole,
  onClose,
  onStarted,
  notify,
  presentation = "dialog",
  active = true,
  runOperation,
}: {
  connection: Connection;
  projects: Project[];
  rows?: MemberRow[];
  initialMode?: PermissionRequest["mode"];
  initialUsers?: User[];
  initialRole?: number;
  onClose: () => void;
  onStarted: (task: Task) => void;
  notify: (message: string, error?: boolean) => void;
  presentation?: "dialog" | "page";
  active?: boolean;
  runOperation: OperationRunner;
}) {
  const [kind, setKind] = useState<"user" | "group">("user");
  const [search, setSearch] = useState("");
  const [subjects, setSubjects] = useState<(User | Group)[]>(initialUsers);
  const [role, setRole] = useState(initialRole ?? rows[0]?.member.access_level ?? 30);
  const [setRoleField, setSetRoleField] = useState(initialMode === "grant");
  const [updateExpiry, setUpdateExpiry] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const preparedId = useRef<string | null>(null);
  useEffect(
    () => () => {
      const id = preparedId.current;
      preparedId.current = null;
      if (id) void api.discardPlan(id).catch((error) => notify(errorMessage(error), true));
    },
    [],
  );
  const [confirmed, setConfirmed] = useState(false);
  const lookup = useMutation({
    mutationFn: async () =>
      kind === "user" ? api.users(connection.id, search) : api.groups(connection.id, search),
  });
  const request = (): PermissionRequest => ({
    connectionId: connection.id,
    projectIds: projects.map((project) => project.id),
    subjectIds: subjects.map((subject) => subject.id),
    targets: rows.map((row) => ({ projectId: row.project.id, userId: row.member.id })),
    subjectType: kind,
    mode: initialMode,
    accessLevel: setRoleField ? role : null,
    updateExpiry,
    expiresAt: expiry || null,
  });
  const scan = useMutation({
    mutationFn: () => runOperation(() => api.previewPermissions(request())),
    onSuccess: (value) => {
      preparedId.current = value.id;
      setPlan(value);
    },
  });
  const execute = useMutation({
    mutationFn: () => runOperation(() => api.startPlan(plan!.id)),
    onSuccess: (value) => {
      preparedId.current = null;
      onStarted(value);
    },
  });
  const busy = scan.isPending || execute.isPending;
  useEffect(() => {
    if (active) return;
    clearPlan();
  }, [active]);
  /** Discard the exact prepared plan while retaining editable settings. */
  function clearPlan() {
    const id = preparedId.current;
    preparedId.current = null;
    if (id) void api.discardPlan(id).catch((e) => notify(errorMessage(e), true));
    setPlan(null);
    setConfirmed(false);
    scan.reset();
    execute.reset();
  }
  function close() {
    clearPlan();
    onClose();
  }
  const deleting = initialMode === "revoke";
  const executable =
    plan?.items.some((item) => item.status === "pending") && (!deleting || confirmed);
  return (
    <Dialog
      presentation={presentation}
      title={deleting ? "批量撤销授权" : initialMode === "update" ? "批量修改授权" : "批量授权"}
      bodyKey={plan?.id ?? "settings"}
      description={
        connection.scopes === null
          ? "令牌范围未知。批量修改需 api 范围，实际权限由 GitLab 校验。"
          : "权限由 GitLab 校验，其他来源的授权会被保留。"
      }
      wide
      onClose={close}
      busy={busy}
      footer={
        <>
          <span className="foot-info">{projects.length} 个仓库</span>
          {plan ? (
            <>
              <Button disabled={busy} onClick={clearPlan}>
                返回修改
              </Button>
              <Button
                variant={deleting ? "danger" : "primary"}
                disabled={!executable}
                busy={execute.isPending}
                onClick={() => execute.mutate()}
              >
                确认执行
                <ArrowRight size={15} />
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={close}>
                取消
              </Button>
              <Button
                variant="primary"
                busy={scan.isPending}
                disabled={!projects.length || (!rows.length && !subjects.length)}
                onClick={() => scan.mutate()}
              >
                扫描并预览
              </Button>
            </>
          )}
        </>
      }
    >
      {presentation === "page" ? <TaskSteps step={plan ? 3 : 2} /> : <Steps preview={!!plan} />}
      {plan ? (
        <>
          <Preview plan={plan} />
          {deleting && (
            <label className="delete-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              确认撤销这些直接授权。继承权限和其他访问来源不会被删除。
            </label>
          )}
        </>
      ) : (
        <>
          <Targets projects={projects} />
          {rows.length ? (
            <div className="hint">
              本次处理 {rows.length} 条已选直接授权：
              {[...new Set(rows.map((row) => row.member.name))].join("、")}
            </div>
          ) : (
            <>
              <div className="scope-switch">
                <button
                  className={kind === "user" ? "active" : ""}
                  onClick={() => {
                    setKind("user");
                    setSubjects([]);
                    lookup.reset();
                  }}
                >
                  用户成员
                </button>
                <button
                  className={kind === "group" ? "active" : ""}
                  onClick={() => {
                    setKind("group");
                    setSubjects([]);
                    lookup.reset();
                  }}
                >
                  已有群组共享
                </button>
              </div>
              <div className="subject-search">
                <input
                  aria-label="搜索授权对象"
                  placeholder={kind === "user" ? "搜索用户名或姓名" : "搜索已有群组名称"}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    lookup.reset();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && search.trim()) lookup.mutate();
                  }}
                />
                <Button
                  busy={lookup.isPending}
                  disabled={!search.trim()}
                  onClick={() => lookup.mutate()}
                >
                  <Search size={15} />
                  搜索
                </Button>
              </div>
              <div className="target-chips">
                {subjects.map((subject) => (
                  <button
                    className="target-chip"
                    key={subject.id}
                    onClick={() => setSubjects(subjects.filter((s) => s.id !== subject.id))}
                  >
                    {subject.name}{" "}
                    {"username" in subject ? "@" + subject.username : subject.full_path} ×
                  </button>
                ))}
              </div>
              {lookup.data && (
                <div className="target-picker">
                  {lookup.data.length ? (
                    lookup.data.map((subject) => (
                      <label key={subject.id}>
                        <input
                          type="checkbox"
                          checked={subjects.some((s) => s.id === subject.id)}
                          onChange={(e) =>
                            setSubjects(
                              e.target.checked
                                ? [...subjects, subject]
                                : subjects.filter((s) => s.id !== subject.id),
                            )
                          }
                        />
                        <span>{subject.name}</span>
                        <small>
                          {"username" in subject ? `@${subject.username}` : subject.full_path}
                        </small>
                      </label>
                    ))
                  ) : (
                    <p className="empty-inline">未找到匹配对象，请尝试完整用户名或更具体的名称。</p>
                  )}
                </div>
              )}
              {lookup.error && <ErrorBox message={errorMessage(lookup.error)} />}
            </>
          )}
          {!deleting && (
            <div className="form-section">
              <h3>权限设置</h3>
              <div className="edit-field">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={setRoleField}
                    disabled={initialMode === "grant"}
                    onChange={(e) => setSetRoleField(e.target.checked)}
                  />
                  设置角色
                </label>
                <select
                  aria-label="授权角色"
                  value={role}
                  disabled={!setRoleField}
                  onChange={(e) => setRole(Number(e.target.value))}
                >
                  {[10, 20, 30, 40].map((level) => (
                    <option value={level} key={level}>
                      {roles[level]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="edit-field">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={updateExpiry}
                    onChange={(e) => setUpdateExpiry(e.target.checked)}
                  />
                  设置到期时间
                </label>
                <div>
                  <input
                    type="date"
                    aria-label="授权到期时间"
                    disabled={!updateExpiry}
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                  <small>勾选后留空表示长期有效；未勾选时保持原期限。</small>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {(scan.error || execute.error) && (
        <ErrorBox message={errorMessage(scan.error ?? execute.error)} />
      )}
    </Dialog>
  );
}
