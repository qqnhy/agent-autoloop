// Failure cases: a queued run with a real creation time sorts before the user message that caused it, or a run with no
// recorded time falls back to 1970, jumps ahead of the conversation and shows an epoch date instead of "未记录".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../clients/workbench/public/history.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const history = (context as any).chatHistory;
const message = { at: "2026-11-17T08:12:53.000Z", message: { id: "m" } };

test("a queued run ordered by its real creation time follows the user message that caused it", () => {
  const created = "2026-11-17T08:12:53.500Z";
  const run = { at: history.runAt({ id: 1, kind: "queued", createdAt: created }), run: { id: 1 } };
  assert.equal(run.at, created);
  const order = Array.from(history.sort([run, message]), (entry: any) => entry.at);
  assert.deepEqual(order, [message.at, run.at]);
});

test("a run's timeline time prefers its reply, finish and claim time before creation, never zero", () => {
  assert.equal(history.runAt({ reply: { at: "2026-11-17T08:13:00.000Z" } }), "2026-11-17T08:13:00.000Z");
  assert.equal(
    history.runAt({ finishedAt: "2026-11-17T08:12:59.000Z", claimedAt: "2026-11-17T08:12:58.000Z" }),
    "2026-11-17T08:12:59.000Z",
  );
  assert.equal(history.runAt({ claimedAt: "2026-11-17T08:12:58.000Z" }), "2026-11-17T08:12:58.000Z");
  assert.equal(history.runAt({ createdAt: "2026-11-17T08:12:53.500Z" }), "2026-11-17T08:12:53.500Z");
  assert.equal(history.runAt({ createdAt: null }), null);
});

test("entries without a recorded time sort after dated ones and are labelled instead of shown as 1970", () => {
  const missing = { at: null, run: { id: 2 } };
  const invalid = { at: "not-a-time", run: { id: 3 } };
  const order = Array.from(history.sort([missing, invalid, message]), (entry: any) => entry.at);
  assert.deepEqual(order, [message.at, null, "not-a-time"]);
  assert.equal(history.time(order[1]), "未记录");
  assert.equal(history.time(order[2]), "时间未知");
  assert.doesNotMatch(history.time(order[1]), /1970/);
});
