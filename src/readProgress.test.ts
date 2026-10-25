import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { ReadProgress } from "./types";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("window", { isTauri: true, crypto: globalThis.crypto });
});
afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

/** Exercise the real Channel callback protocol provided by Tauri's official IPC mock. */
function send(channel: Channel<ReadProgress>, index: number, message: ReadProgress) {
  const runtime = window as unknown as {
    __TAURI_INTERNALS__: { runCallback: (id: number, value: unknown) => void };
  };
  runtime.__TAURI_INTERNALS__.runCallback(channel.id, { index, message });
}

it("routes concurrent read progress to its own invocation and forwards the requested resource kind", async () => {
  const channels: number[] = [];
  mockIPC(async (command, args) => {
    const payload = args as Record<string, unknown>;
    const channel = payload.onProgress as Channel<ReadProgress>;
    channels.push(channel.id);
    const total = command === "resolve_projects" ? 2 : 3;
    if (command === "read_resources") expect(payload.kind).toBe("members");
    else expect(payload.inputs).toEqual(["demo/one", "demo/two"]);
    send(channel, 0, { total, completed: 0, failed: 0 });
    await Promise.resolve();
    send(channel, 1, { total, completed: total, failed: 1 });
    return [];
  });
  const { api } = await import("./api");
  const resolve: ReadProgress[] = [];
  const resources: ReadProgress[] = [];
  await Promise.all([
    api.resolve("fixture", ["demo/one", "demo/two"], (progress) => resolve.push(progress)),
    api.resources("fixture", [1, 2, 3], "members", (progress) => resources.push(progress)),
  ]);
  expect(new Set(channels).size).toBe(2);
  expect(resolve.map((progress) => progress.completed)).toEqual([0, 2]);
  expect(resources.map((progress) => progress.completed)).toEqual([0, 3]);
  expect(resources.at(-1)?.failed).toBe(1);
});

it("propagates a read failure without inventing a successful final progress update", async () => {
  mockIPC((_, args) => {
    send((args as Record<string, unknown>).onProgress as Channel<ReadProgress>, 0, {
      total: 3,
      completed: 1,
      failed: 1,
    });
    throw { message: "模拟读取失败", status: 403 };
  });
  const { api } = await import("./api");
  const updates: ReadProgress[] = [];
  await expect(
    api.resources("fixture", [1, 2, 3], "hooks", (progress) => updates.push(progress)),
  ).rejects.toThrow("模拟读取失败");
  expect(updates).toEqual([{ total: 3, completed: 1, failed: 1 }]);
});
