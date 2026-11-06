// Failure cases: chat can pick arbitrary agents/directories/commands, fan out into unrelated rules, merge two
// conversations, duplicate a message after a lost response, mistake a summary for the final reply, or lose history.
// Follow-up runs and their unanswered cards must remain visible after unrelated runs move them off the first page.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("workbench-chat");
const rulesFile = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const rules = {
  sources: { local: { name: "本机" } },
  agents: { helper: { name: "助手", worker: "here", use: "command", command: ["true"] } },
  channels: {},
  rules: [
    {
      name: "项目对话",
      when: { source: "local", types: ["workbench.chat.project"] },
      to: "helper",
      cwd: home,
      prompt: "读取任务描述并回答",
      parallel: 1,
      resume: true,
    },
  ],
};
writeFileSync(rulesFile, JSON.stringify(rules));
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { startWorkbench } = await import("../clients/workbench/server.ts");
const upstream = serve(0);
await once(upstream, "listening");
const config = {
  url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  hub: { listen: `127.0.0.1:${(upstream.address() as AddressInfo).port}` },
  owner: hub.addKey("owner", "chat"),
  source: { name: "local", key: hub.addKey("source", "local") },
  worker: { name: "here", key: "not-exposed" },
};
let server = startWorkbench(config, 0);
await once(server, "listening");
let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  upstream.closeAllConnections();
  upstream.close();
  hub.db.close();
});
const call = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-workbench": "1", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
};
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const msg1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const msg2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const chat = (id = first) => `/api/chat/conversations/${id}`;

test("only explicitly enabled fixed rules are selectable, with no credential or command leakage", async () => {
  const result = await call("/api/chat/routes");
  assert.equal(result.status, 200);
  assert.equal(result.data.routes[0].id, "项目对话");
  assert.equal(result.data.routes[0].cwd, home);
  assert.ok(!JSON.stringify(result.data).includes(config.source.key));
  assert.ok(!JSON.stringify(result.data).includes("command"));
  assert.equal((await call("/api/chat/conversations", { id: first, rule: "项目对话", cwd: "/etc" })).status, 400);
  const rejected = await call("/api/chat/conversations", { id: first, rule: "other" });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.notSubmitted, true);
  assert.equal((await call("/api/chat/conversations", { id: first, rule: "项目对话" })).status, 200);
});

test("a real chat event wakes the configured agent, stable retries deduplicate, and different payloads conflict", async () => {
  const sent = await call(chat() + "/messages", { id: msg1, text: "请先解释项目，不要修改文件。" });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.message.status, "accepted");
  assert.equal((await call(chat() + "/messages", { id: msg1, text: "改为删除" })).status, 409);
  assert.equal((await call(chat() + "/messages", { id: msg1, text: "请先解释项目，不要修改文件。" })).status, 200);
  const job = hub.claimNext("here", "chat-first")!;
  assert.equal(job.rule.cwd, home);
  assert.equal(job.context.events.length, 1);
  assert.equal(job.context.events[0].detail, "请先解释项目，不要修改文件。");
  assert.equal(job.context.events[0].subject, `wb:${first}`);
  const rejected = await call(chat() + "/messages", { id: msg2, text: "不要并行执行" });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.notSubmitted, true);
  hub.finish(job.run, job.token, { outcome: "done", summary: "这里只是摘要", session: "actual-session" });
  let view = (await call(chat())).data;
  assert.equal(view.runs[0].replyStatus, "unavailable");
  assert.equal(view.runs[0].reply, undefined);
  const dir = join(home, "worker", "runs", `${job.run}-1`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "reply.json"),
    JSON.stringify({
      version: 1,
      run: job.run,
      attempt: 1,
      text: "这是完整答复。\n第二段包含详细说明。",
      truncated: false,
      session: "actual-session",
      outcome: "done",
      at: new Date().toISOString(),
    }),
  );
  view = (await call(chat())).data;
  assert.equal(view.runs[0].reply.text, "这是完整答复。\n第二段包含详细说明。");
  assert.equal(view.runs[0].messageIds[0], msg1);
  assert.equal((await call(chat() + "/messages", { id: msg2, text: "继续解释第二部分" })).status, 200);
  const next = hub.claimNext("here", "chat-next")!;
  assert.equal(next.session, "actual-session");
  hub.finish(next.run, next.token, {
    outcome: "done",
    summary: "第二轮摘要",
    session: "actual-session",
    ask: [{ title: "需要修改吗？", text: "请明确选择", options: ["修改", "不修改"] }],
  });
  view = (await call(chat())).data;
  assert.equal(view.runs.at(-1).resumed, true);
  assert.equal(view.canSend, false);
  assert.ok(view.blockReason.includes("卡片"));
  assert.equal(
    (await call(chat() + "/messages", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", text: "同意" })).status,
    409,
  );
});

test("another conversation has its own subject and session; stored history survives a workbench restart", async () => {
  await call("/api/chat/conversations", { id: second, rule: "项目对话" });
  await call(chat(second) + "/messages", { id: msg1, text: "这是独立事项" });
  const job = hub.claimNext("here", "other-chat")!;
  assert.equal(job.session, null);
  assert.equal(job.context.events[0].subject, `wb:${second}`);
  hub.finish(job.run, job.token, { outcome: "done", summary: "独立答复", session: "different-session" });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = startWorkbench(config, 0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const restored = (await call(chat())).data;
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.runs[0].reply.text, "这是完整答复。\n第二段包含详细说明。");
  assert.equal((await call("/api/chat/conversations")).data.conversations.length, 2);
});

test("changed or ambiguous trusted routing blocks further messages instead of silently changing the target", async () => {
  const saved = readFileSync(rulesFile, "utf8");
  const changed = JSON.parse(saved);
  changed.rules.push({ ...changed.rules[0], name: "误匹配", when: { source: "local", types: ["*"] } });
  writeFileSync(rulesFile, JSON.stringify(changed));
  hub.reloadRules();
  assert.equal((await call("/api/chat/routes")).data.routes.length, 0);
  assert.equal((await call(chat(second) + "/messages", { id: msg2, text: "不能投给另一条规则" })).status, 409);
  writeFileSync(rulesFile, saved);
  hub.reloadRules();
});

test("a slow refresh cannot overwrite a message accepted while its hub read was pending", async () => {
  const { createChatService } = await import("../clients/workbench/chat.ts");
  const id = "33333333-3333-4333-8333-333333333333";
  await call("/api/chat/conversations", { id, rule: "项目对话" });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createChatService(config, async (path) => {
    await paused;
    return (await fetch(config.url + path, { headers: { authorization: `Bearer ${config.owner}` } })).json();
  });
  const pending = service.view(id);
  const file = join(home, "workbench", "chats", `${id}.json`);
  const latest = JSON.parse(readFileSync(file, "utf8"));
  latest.title = "正在发送的新任务";
  latest.messages.push({ id: msg1, text: "新消息", at: new Date().toISOString(), status: "accepted", eventId: 99 });
  latest.blocked = "实际路由不一致";
  writeFileSync(file, JSON.stringify(latest));
  release();
  const view = await pending;
  assert.equal(view.messages[0].status, "accepted");
  assert.equal(view.conversation.title, "正在发送的新任务");
  assert.equal(view.canSend, false);
  assert.equal(view.blockReason, "实际路由不一致");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).blocked, "实际路由不一致");
});

test("unviewed answer follow-ups and their cards survive falling behind the global run page", async () => {
  const id = "44444444-4444-4444-8444-444444444444";
  assert.equal((await call("/api/chat/conversations", { id, rule: "项目对话" })).status, 200);
  assert.equal((await call(chat(id) + "/messages", { id: msg1, text: "请先提问再继续" })).status, 200);
  const initial = hub.claimNext("here", "history-initial")!;
  hub.finish(initial.run, initial.token, {
    outcome: "done",
    summary: "先等回答",
    session: "history-session",
    ask: [{ title: "第一步继续吗？", text: "明确选择", options: ["继续", "不继续"] }],
  });
  const archived = (await call(chat(id))).data;
  hub.answer(archived.cards[0].id, { choice: 0 });
  const followup = hub.claimNext("here", "history-followup")!;
  hub.finish(followup.run, followup.token, {
    outcome: "done",
    summary: "完成了后续检查",
    session: "history-session",
    ask: [{ title: "第二步继续吗？", text: "再次明确选择", options: ["继续", "不继续"] }],
  });
  for (let n = 0; n < 61; n++) {
    hub.ingest("local", {
      id: `history-unrelated-${n}`,
      type: "workbench.chat.project",
      subject: `history-unrelated-${n}`,
    });
    const other = hub.claimNext("here", `history-unrelated-claim-${n}`)!;
    hub.finish(other.run, other.token, { outcome: "done", summary: "其他事项完成" });
  }
  const restored = (await call(chat(id))).data;
  assert.ok(
    restored.runs.some((run: any) => run.id === followup.run),
    "the completed follow-up must not disappear",
  );
  assert.ok(restored.cards.some((card: any) => card.title === "第二步继续吗？"));
  assert.equal(restored.canSend, false);
  assert.match(restored.blockReason, /卡片/);
  assert.equal(restored.historyComplete, true);
});

test("a lost HTTP reply is recovered from actual hub facts without submitting the message twice", async () => {
  const { createChatService } = await import("../clients/workbench/chat.ts");
  const id = "55555555-5555-4555-8555-555555555555";
  let submissions = 0;
  const service = createChatService(config, async (path, body, source) => {
    const result = await fetch(config.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${source ? config.source.key : config.owner}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await result.json();
    assert.equal(result.ok, true);
    if (source && ++submissions === 1) throw new Error("simulated lost response after hub acceptance");
    return data;
  });
  await service.create({ id, rule: "项目对话" });
  await assert.rejects(service.send(id, { id: msg1, text: "只执行一次" }), /lost response/);
  let view = await service.view(id);
  assert.equal(view.messages[0].status, "accepted");
  assert.equal(view.runs.length, 1);
  assert.equal(view.canSend, false);
  await service.send(id, { id: msg1, text: "只执行一次" });
  assert.equal(submissions, 1);
  const job = hub.claimNext("here", "lost-response")!;
  assert.equal(job.context.events[0].subject, `wb:${id}`);
  hub.finish(job.run, job.token, { outcome: "done", summary: "执行了一次" });
  view = await service.view(id);
  assert.equal(view.canSend, true);
  assert.equal(view.runs.length, 1);
  assert.doesNotMatch(
    readFileSync(join(home, "workbench", "chats", `${id}.json`), "utf8"),
    new RegExp(config.source.key),
  );
});

test("an already accepted in-flight message must never be labelled not submitted on concurrent retry", async () => {
  const { createChatService } = await import("../clients/workbench/chat.ts");
  const id = "66666666-6666-4666-8666-666666666666";
  let release!: () => void;
  let accepted!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reachedHub = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const service = createChatService(config, async (path, body, source) => {
    const response = await fetch(config.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${source ? config.source.key : config.owner}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.ok, true);
    if (source) {
      accepted();
      await paused;
    }
    return data;
  });
  await service.create({ id, rule: "项目对话" });
  const firstSend = service.send(id, { id: msg1, text: "已经被中台接收" });
  await reachedHub;
  try {
    await assert.rejects(service.send(id, { id: msg1, text: "已经被中台接收" }), (error: any) => {
      assert.equal(error.status, 409);
      assert.equal(error.notSubmitted, false);
      return true;
    });
  } finally {
    release();
    await firstSend;
  }
  const view = await service.view(id);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].status, "accepted");
  assert.equal(view.runs.length, 1);
  const job = hub.claimNext("here", "concurrent-retry")!;
  hub.finish(job.run, job.token, { outcome: "done", summary: "只接收了一次" });
});
