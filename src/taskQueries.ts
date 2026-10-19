import type { QueryClient } from "@tanstack/react-query";

/** Invalidate alone reuses an initial in-flight read, which can hide the final task event. */
export async function refreshTasks(client: QueryClient): Promise<void> {
  await Promise.all(
    ["task", "tasks"].map(async (key) => {
      await client.cancelQueries({ queryKey: [key] });
      await client.invalidateQueries({ queryKey: [key] });
    }),
  );
}
