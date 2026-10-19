import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { refreshTasks } from "./taskQueries";

it("keeps the completed state when a final event arrives before the initial read resolves", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let finishInitial!: (value: string) => void;
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["task", "demo"],
    queryFn: () =>
      ++reads === 1
        ? new Promise<string>((resolve) => {
            finishInitial = resolve;
          })
        : Promise.resolve("completed"),
  });
  const unsubscribe = observer.subscribe(() => {});
  await refreshTasks(client);
  finishInitial("running");
  await Promise.resolve();
  expect(client.getQueryData(["task", "demo"])).toBe("completed");
  unsubscribe();
  client.clear();
});
