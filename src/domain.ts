import type { ItemStatus, PlanItem, Project, Resolution } from "./types";

export const roles: Record<number, string> = {
  10: "Guest",
  15: "Planner",
  20: "Reporter",
  25: "Security Manager",
  30: "Developer",
  40: "Maintainer",
  50: "Owner",
};
export const actionLabels = {
  create: "新增",
  update: "更新",
  delete: "删除",
  skip: "跳过",
  conflict: "待选择",
  blocked: "无法执行",
};
export const statusLabels: Record<ItemStatus, string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  unknown: "结果未知",
  skipped: "跳过",
  blocked: "无法执行",
};
export const eventLabels = {
  push_events: "Push",
  merge_requests_events: "合并请求",
  pipeline_events: "流水线",
  issues_events: "议题",
  tag_push_events: "标签",
};

export function roleName(level: number | null): string {
  return level === null ? "未提供" : (roles[level] ?? `角色 ${level}`);
}
export function accessLevel(project: Project): number | null {
  const levels = [
    project.permissions?.project_access?.access_level,
    project.permissions?.group_access?.access_level,
  ].filter((v): v is number => v !== undefined);
  return levels.length ? Math.max(...levels) : null;
}

export function inputLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Ambiguous names never select their first match. Duplicate addresses collapse by project ID. */
export function resolvedSelection(rows: Resolution[], choices: Record<number, number>): Project[] {
  const projects = new Map<number, Project>();
  rows.forEach((row, index) => {
    if (row.error) return;
    const candidate =
      row.candidates.length === 1
        ? row.candidates[0]
        : row.candidates.find((p) => p.id === choices[index]);
    if (candidate) projects.set(candidate.id, candidate);
  });
  return [...projects.values()];
}

export function taskCounts(items: PlanItem[]): Record<ItemStatus, number> {
  const counts = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    blocked: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}

export function dateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function uniqueProjects(rows: { project: Project }[]): Project[] {
  return [...new Map(rows.map((row) => [row.project.id, row.project])).values()];
}
