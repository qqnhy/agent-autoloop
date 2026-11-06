// Final replies must survive beyond the short receipt summary without exposing process/protocol data.
// Receipt repairs and worker restarts must retain the original business answer; failures, cancellations,
// oversized output, and an unwritable artifact must not become complete replies or redo completed work.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../protocol/job.ts";
import type { Result } from "../protocol/validate.ts";
import { setup } from "./helpers.ts";

const home = setup("worker-reply");
const { createWorker } = await import("../worker/worker.ts");
mkdirSync(join(home, "plugins", "reply-script"), { recursive: true });
writeFileSync(
  join(home, "plugins", "reply-script", "agent.ts"),
  `
export default {
  command: t => [process.execPath, t.command[0], t.resume ?? ""],
  read(out, code) {
    if (code === null) return {};
    if (code !== 0) return { error: "process failed", started: true };
    return { text: out.split("BUSINESS\\n").at(-1).replace(/^PROTOCOL[^\\n]*\\n/, ""), session: "reply-session" };
  }
};`,
);
let id = 0;
function fixture(script: string) {
  const run = ++id;
  const file = join(home, `reply-${run}.mjs`);
  writeFileSync(file, script);
  const job: Job = {
    run,
    attempt: 1,
    token: "private-worker-token",
    session: null,
    askFirst: [],
    rule: { name: "reply", cwd: home },
    agent: { id: "a", name: "agent", use: "reply-script", access: "read", command: [file] },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  let pending: Job | null = job;
  const results: Result[] = [];
  let cancel = false;
  const hub = {
    async work() {
      const answer = { job: pending, cancel: cancel ? [run] : [] };
      pending = null;
      cancel = false;
      return answer;
    },
    async started() {
      return { ok: true };
    },
    async result(_run: number, _token: string, result: unknown) {
      results.push(result as Result);
      return { rejected: [] };
    },
  };
  const logs: string[] = [];
  const worker = () => createWorker({ hub, name: "reply-test", wait: 0, log: (line) => logs.push(line) });
  const dir = join(home, "worker", "runs", `${run}-1`);
  return {
    run,
    results,
    worker,
    dir,
    logs,
    cancel: () => {
      cancel = true;
    },
    reply: () => JSON.parse(readFileSync(join(dir, "reply.json"), "utf8")),
  };
}
async function until(worker: ReturnType<typeof createWorker>, done: () => boolean) {
  const end = Date.now() + 10000;
  while (!done()) {
    assert.ok(Date.now() < end, "timed out");
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("a real process retains multiline final text but no receipt or process metadata", async () => {
  const text = `完成了\n\n${"详细说明。".repeat(200)}\n最后一段`;
  const f = fixture(
    `console.error("stderr-private"); console.log(${JSON.stringify(`PROTOCOL private transport\n${text}\n\`\`\`agent-autoloop\n{}\n\`\`\``)});`,
  );
  await until(f.worker(), () => f.results.length > 0);
  const reply = f.reply();
  assert.equal(reply.text, text);
  assert.equal(reply.truncated, false);
  assert.equal(reply.session, "reply-session");
  assert.equal(reply.outcome, "done");
  assert.equal(reply.version, 1);
  assert.equal(reply.run, f.run);
  assert.equal(reply.attempt, 1);
  assert.ok(Number.isFinite(Date.parse(reply.at)));
  assert.deepEqual(
    Object.keys(reply).sort(),
    ["version", "run", "attempt", "text", "truncated", "session", "outcome", "at"].sort(),
  );
  assert.doesNotMatch(JSON.stringify(reply), /private-worker-token|PROTOCOL|stderr-private|agent-autoloop|command/);
  assert.equal(statSync(join(f.dir, "reply.json")).mode & 0o777, 0o600);
  assert.ok((f.results[0].summary?.length ?? 0) < text.length);
});

for (const failed of [false, true])
  test(`receipt repair preserves business reply across restart (failed=${failed})`, async () => {
    const text = "原来的业务结果\n完整说明与后续步骤。";
    const f = fixture(
      `if (!process.argv[2]) console.log(${JSON.stringify(`${text}\n\`\`\`agent-autoloop\n{broken}\n\`\`\``)}); else ${failed ? "process.exit(1)" : 'console.log("修好了\\n```agent-autoloop\\n{}\\n```")'};`,
    );
    const worker = f.worker();
    await until(worker, () => worker.entries().some((e) => e.repairs === 1));
    assert.equal(existsSync(join(f.dir, "reply.json")), false);
    await until(f.worker(), () => f.results.length > 0);
    assert.equal(f.reply().text, text);
    assert.equal(f.reply().outcome, "done");
  });

test("failed and cancelled processes never publish their partial answer", async () => {
  const failed = fixture('console.log("partial success"); process.exit(1)');
  await until(failed.worker(), () => failed.results.length > 0);
  assert.equal(failed.results[0].outcome, "failed");
  assert.equal(existsSync(join(failed.dir, "reply.json")), false);
  const cancelled = fixture('console.log("partial answer"); setTimeout(() => {}, 5000)');
  const worker = cancelled.worker();
  await worker.tick();
  cancelled.cancel();
  await until(worker, () => cancelled.results.length > 0);
  assert.equal(cancelled.results[0].outcome, "cancelled");
  assert.equal(existsSync(join(cancelled.dir, "reply.json")), false);
});

test("long Unicode replies are explicitly truncated without splitting characters", async () => {
  const f = fixture('process.stdout.write("😀".repeat(100001))');
  await until(f.worker(), () => f.results.length > 0);
  assert.equal([...f.reply().text].length, 100000);
  assert.equal(f.reply().text, "😀".repeat(100000));
  assert.equal(f.reply().truncated, true);
});

test("clipped snapshots remain marked incomplete even when adapter returns a short answer", async () => {
  const f = fixture('process.stdout.write("PROTOCOL" + "x".repeat(1200000) + "\\nBUSINESS\\n短回复")');
  await until(f.worker(), () => f.results.length > 0);
  assert.equal(f.reply().text, "短回复");
  assert.equal(f.reply().truncated, true);
});

test("artifact write failure cannot rerun or lose completed work", async () => {
  const f = fixture('console.log("已完成")');
  const worker = f.worker();
  await worker.tick();
  mkdirSync(join(f.dir, "reply.json"));
  await until(worker, () => f.results.length > 0);
  await worker.tick();
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].outcome, "done");
  assert.equal(f.logs.filter((line) => line.includes("couldn't save reply")).length, 1);
});

test("a genuine failed business reply retains its failed outcome", async () => {
  const f = fixture('console.log("没跑成：外部服务暂不可用\\n已核实的细节与剩余步骤。")');
  await until(f.worker(), () => f.results.length > 0);
  assert.equal(f.reply().outcome, "failed");
  assert.match(f.reply().text, /剩余步骤/);
});

test("an older in-progress repair can recover original text without a saved body", async () => {
  const f = fixture('console.log(process.argv[2] ? "已修复" : "原始业务正文\\n```agent-autoloop\\n{broken}\\n```")');
  const worker = f.worker();
  await until(worker, () => worker.entries().some((e) => e.repairs === 1));
  const file = join(f.dir, "entry.json");
  const entry = JSON.parse(readFileSync(file, "utf8"));
  delete entry.reply;
  writeFileSync(file, JSON.stringify(entry));
  await until(f.worker(), () => f.results.length > 0);
  assert.equal(f.reply().text, "原始业务正文");
});
