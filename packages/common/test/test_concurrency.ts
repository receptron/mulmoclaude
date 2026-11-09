import { test } from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency } from "../src/index.ts";

const tick = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

async function peakInFlight(itemCount: number, limit: number): Promise<number> {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: itemCount }, (_, index) => index);
  await mapWithConcurrency(items, limit, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick(item % 3);
    inFlight -= 1;
  });
  return peak;
}

test("mapWithConcurrency: results keep input order when completions are out of order", async () => {
  const items = [30, 0, 20, 5, 10, 1];
  const results = await mapWithConcurrency(items, 3, async (delayMs, index) => {
    await tick(delayMs);
    return `${index}:${delayMs}`;
  });
  assert.deepEqual(results, ["0:30", "1:0", "2:20", "3:5", "4:10", "5:1"]);
});

test("mapWithConcurrency: never exceeds the limit, and reaches it when there is enough work", async () => {
  assert.equal(await peakInFlight(50, 4), 4);
  assert.equal(await peakInFlight(50, 1), 1);
  assert.equal(await peakInFlight(3, 64), 3, "no more runners than items");
});

test("mapWithConcurrency: calls the worker exactly once per item", async () => {
  const seen: number[] = [];
  const items = Array.from({ length: 200 }, (_, index) => index);
  await mapWithConcurrency(items, 7, async (item) => {
    seen.push(item);
    await tick(0);
  });
  assert.deepEqual(
    seen.sort((left, right) => left - right),
    items,
  );
});

test("mapWithConcurrency: empty input resolves to [] without calling the worker", async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 8, async () => {
    calls += 1;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("mapWithConcurrency: a non-positive or non-numeric limit still runs serially", async () => {
  assert.equal(await peakInFlight(10, 0), 1);
  assert.equal(await peakInFlight(10, -5), 1);
  assert.equal(await peakInFlight(10, Number.NaN), 1);
  assert.equal(await peakInFlight(10, 2.9), 2, "a fractional limit rounds down");
});

test("mapWithConcurrency: rejects with the worker's error", async () => {
  const failure = new Error("boom");
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw failure;
      return item;
    }),
    failure,
  );
});
