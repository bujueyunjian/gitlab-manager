import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { HookDialog } from "./BatchDialogs";
import { buildHookRequest, initialHookMatchUrl, initialHookSettings } from "./hookDraft";
import type { HookDraft } from "./hookDraft";
import type { Connection, Hook, HookRow, Project } from "./types";

/** Fictional IDs and addresses deliberately differ across the existing configurations. */
function project(id: number): Project {
  return {
    id,
    name: "Example " + id,
    path: "example-" + id,
    path_with_namespace: "demo/example-" + id,
    web_url: "https://gitlab.example.com/demo/example-" + id,
    description: null,
    visibility: "private",
    archived: false,
    permissions: null,
  };
}
const events = {
  push_events: true,
  merge_requests_events: false,
  pipeline_events: true,
  issues_events: false,
  tag_push_events: true,
};
const hook: Hook = {
  ...events,
  id: 201,
  name: "Example",
  url: "https://hooks.example.com/first",
  enable_ssl_verification: true,
  token_present: true,
  signing_token_present: false,
};
const rows: HookRow[] = [
  { project: project(2), hook },
  { project: project(3), hook: { ...hook, id: 301, url: "https://hooks.example.com/second" } },
];
const connection: Connection = {
  id: "fixture",
  name: "Example GitLab",
  baseUrl: "https://gitlab.example.com",
  revision: "identity",
  user: { id: 1, name: "Example", username: "example-user", is_admin: false },
  scopes: ["api"],
  expiresAt: null,
  version: "19.0.0",
  checkedAt: "2026-10-26T00:00:00Z",
};
/** Build the same explicit-field form draft consumed by HookDialog, without credentials. */
function draft(): HookDraft {
  return {
    connectionId: "fixture",
    projects: [project(1), project(2), project(3)],
    rows,
    mode: "ensure",
    matchUrl: initialHookMatchUrl(true, "", rows),
    name: "Example",
    url: hook.url,
    events,
    ssl: true,
    secret: "",
    fields: { name: false, url: false, events: true, ssl: false, secret: false },
    namesSupported: true,
    choices: {},
  };
}

it("keeps a named mixed batch creation URL empty until explicit input, and does not replace existing addresses", () => {
  const value = draft();
  expect(value.matchUrl).toBe("");
  let request = buildHookRequest(value);
  expect(request.matchUrl).toBe("");
  expect(request.url).toBeNull();
  expect(request.targets).toEqual([
    { projectId: 2, hookId: 201 },
    { projectId: 3, hookId: 301 },
  ]);
  value.matchUrl = "https://hooks.example.com/new";
  request = buildHookRequest(value);
  expect(request.matchUrl).toBe(value.matchUrl);
  expect(request.url).toBeNull();
  expect(request.creation?.name).toBe("Example");
  value.fields.url = true;
  value.url = "https://hooks.example.com/replace";
  expect(buildHookRequest(value).url).toBe(value.url);
});
it("renders the named mixed batch creation address field on the page and keeps technical mode cards out", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(HookDialog, {
        connection,
        projects: [project(1), project(2), project(3)],
        rows,
        initialMode: "ensure",
        guided: true,
        creationCount: 1,
        initialUrl: "",
        initialName: "Example",
        presentation: "page",
        runOperation: (work) => work(),
        onClose: () => {},
        onStarted: () => {},
        notify: () => {},
      }),
    ),
  );
  expect(markup).toContain("新增配置使用的 Webhook 地址");
  const field = markup.slice(markup.indexOf("新增配置使用的 Webhook 地址"));
  expect(field.slice(0, field.indexOf("</label>"))).toContain('value=""');
  expect(markup).not.toContain('class="batch-mode"');
  expect(markup).not.toContain("<dialog");
  for (const label of ["Push", "合并请求", "流水线", "议题", "标签"])
    expect(markup).toContain(label);
  expect(markup).toContain("未勾选的事件关闭");
  client.clear();
});
it("preserves all five event fields as one explicit group, and omits every unselected existing field", () => {
  const value = draft();
  expect(buildHookRequest(value).events).toEqual(events);
  expect(Object.keys(buildHookRequest(value).events!)).toHaveLength(5);
  value.fields.events = false;
  value.fields.name = false;
  value.fields.ssl = false;
  const request = buildHookRequest(value);
  expect(request.events).toBeNull();
  expect(request.name).toBeNull();
  expect(request.ssl).toBeNull();
  expect(request.secret).toBeNull();
  expect(request.creation?.events).toEqual(events);
});
it("retains exact URL-query input and never sends names to a legacy instance", () => {
  const value = draft();
  value.matchUrl = initialHookMatchUrl(true, "https://hooks.example.com/exact/", rows);
  value.namesSupported = false;
  value.fields.name = true;
  const request = buildHookRequest(value);
  expect(request.matchUrl).toBe("https://hooks.example.com/exact/");
  expect(request.name).toBeNull();
  expect(request.creation?.name).toBeNull();
});

it("mixed creation defaults never borrow disabled TLS, names or unrelated events from an existing Hook", () => {
  const unsafeRows = [
    {
      project: project(2),
      hook: {
        ...hook,
        name: "Existing only",
        enable_ssl_verification: false,
        push_events: false,
        merge_requests_events: false,
        pipeline_events: true,
        issues_events: true,
        tag_push_events: true,
      },
    },
  ];
  const initial = initialHookSettings(unsafeRows, "", true);
  expect(initial.name).toBe("");
  expect(initial.ssl).toBe(true);
  expect(initial.events).toEqual({
    push_events: true,
    merge_requests_events: true,
    pipeline_events: false,
    issues_events: false,
    tag_push_events: false,
  });
  const value = {
    ...draft(),
    ...initial,
    rows: unsafeRows,
    fields: { ...draft().fields, name: false, events: false, ssl: false },
  };
  let request = buildHookRequest(value);
  expect(request.creation?.ssl).toBe(true);
  expect(request.creation?.events).toEqual(initial.events);
  expect(request.ssl).toBeNull();
  expect(request.events).toBeNull();
  expect(request.name).toBeNull();
  expect(unsafeRows[0].hook.enable_ssl_verification).toBe(false);
  value.fields.ssl = true;
  value.ssl = false;
  request = buildHookRequest(value);
  expect(request.ssl).toBe(false);
  expect(request.creation?.ssl).toBe(false);
});

it("mixed SSR shows creation inputs clearly while existing TLS/events switches stay off; create-only has no update-field switches", () => {
  const client = new QueryClient();
  const render = (onlyCreate: boolean) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(HookDialog, {
          connection,
          projects: onlyCreate ? [project(1)] : [project(1), project(2)],
          rows: onlyCreate
            ? []
            : [{ project: project(2), hook: { ...hook, enable_ssl_verification: false } }],
          initialMode: onlyCreate ? "create" : "ensure",
          guided: true,
          creationCount: 1,
          initialUrl: "https://hooks.example.com/new",
          presentation: "page",
          runOperation: (work) => work(),
          onClose: () => {},
          onStarted: () => {},
          notify: () => {},
        }),
      ),
    );
  const mixed = render(false);
  const labels = [...mixed.matchAll(/<label class="check-label">[\s\S]*?<\/label>/g)].map(
    (match) => match[0],
  );
  expect(labels.find((label) => label.includes("同时修改已有配置的 TLS 校验"))).not.toContain(
    'checked=""',
  );
  expect(labels.find((label) => label.includes("同时修改已有配置的触发事件"))).not.toContain(
    'checked=""',
  );
  expect(labels.find((label) => label.includes("验证接收端证书"))).toContain('checked=""');
  expect(mixed).toContain("新增名称必填");
  const create = render(true);
  expect(create).not.toContain("同时修改已有");
  expect(create).not.toContain("更换目标地址");
  expect(create).toContain("名称（新增必填）");
  expect(create).toContain("触发事件（新增配置）");
  client.clear();
});
