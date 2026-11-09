/** Run `worker` over `items` with at most `limit` in flight, preserving
 *  input order in the results. The call rejects with the first `worker`
 *  rejection, but the other runners keep draining the queue — make
 *  `worker` total (never throw) when every item must be attempted. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One shared iterator IS the work queue: each runner pulls the next
  // entry, so no runner can hand `worker` an index past the end.
  const pending = items.entries();
  const runnerCount = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);
  const runners = Array.from({ length: runnerCount }, async () => {
    for (const [index, item] of pending) {
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}
