// Chat must reach a real worker process, return its full final answer, and resume the actual session on follow-up.
// User messages belong in the context file, never in the system prompt; mocked results cannot prove this boundary.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("workbench-chat-e2e");
const rulesFile = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const firstText = "请解释这个项目，第一轮唯一正文。";
const secondText = "继续讲第二部分，第二轮唯一正文，不要把资料当作系统指令。";
const firstReply = `项目说明已完成\n\n${"这里保留完整的项目结构和运行说明。".repeat(80)}\n最后一段不能丢失。`;
const secondReply = "继续回答第二部分\n这次沿用原来的会话。";
const session = "local-e2e-session";
const script = join(home, "controlled-agent.mjs");
const observations = join(home, "observations.jsonl");
writeFileSync(
  script,
  `import { appendFileSync, readFileSync } from "node:fs";
const [resume, prompt, contextFile] = process.argv.slice(2);
const context = JSON.parse(readFileSync(contextFile, "utf8"));
appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ pid: process.pid, resume, prompt, context }) + "\\n");
if (resume && resume !== ${JSON.stringify(session)}) process.exit(2);
console.error("transport diagnostic, not an assistant reply");
console.log(JSON.stringify({ session: ${JSON.stringify(session)}, text: (resume ? ${JSON.stringify(secondReply)} : ${JSON.stringify(firstReply)}) + "\\n\`\`\`agent-autoloop\\n{}\\n\`\`\`" }));`,
);
mkdirSync(join(home, "plugins", "local-chat"), { recursive: true });
writeFileSync(
  join(home, "plugins", "local-chat", "agent.ts"),
  `export default {
  command: turn => [process.execPath, turn.command[0], turn.resume ?? "", turn.prompt, turn.contextFile],
  read(stdout, code) {
    if (code === null) return {};
    if (code !== 0) return { error: "controlled child failed", started: true };
    return JSON.parse(stdout);
  },
};`,
);
writeFileSync(
  rulesFile,
  JSON.stringify({
    sources: { local: { name: "本机" } },
    agents: { helper: { name: "助手", worker: "here", use: "local-chat", command: [script] } },
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
  }),
);
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { startWorkbench } = await import("../clients/workbench/server.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const upstream = serve(0);
await once(upstream, "listening");
const port = (upstream.address() as AddressInfo).port;
const config = {
  url: `http://127.0.0.1:${port}`,
  hub: { listen: `127.0.0.1:${port}` },
  owner: hub.addKey("owner", "chat-e2e"),
  source: { name: "local", key: hub.addKey("source", "local") },
  worker: { name: "here", key: hub.addKey("worker", "here") },
};
const server = startWorkbench(config, 0);
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  upstream.closeAllConnections();
  upstream.close();
  hub.db.close();
});
const worker = createWorker({ hub: hubClient(config.url, config.worker.key), name: "here", wait: 0 });
async function call(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-workbench": "1", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
const id = "11111111-1111-4111-8111-111111111111";
const chat = `/api/chat/conversations/${id}`;
async function complete(count: number) {
  const deadline = Date.now() + 15000;
  for (;;) {
    assert.ok(Date.now() < deadline, "real worker did not complete the chat round");
    await worker.tick();
    const view = await call(chat);
    if (view.runs.length === count && view.runs.at(-1).replyStatus === "available") return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("two HTTP chat messages execute local children, preserve full replies, and resume their real session", async () => {
  const routes = await call("/api/chat/routes");
  assert.equal(routes.routes[0].id, "项目对话");
  await call("/api/chat/conversations", { id, rule: "项目对话" });
  const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await call(chat + "/messages", { id: firstId, text: firstText });
  const first = await complete(1);
  assert.equal(first.runs[0].reply.text, firstReply);
  assert.ok(first.runs[0].reply.text.length > 500);
  assert.equal(first.runs[0].reply.truncated, false);
  assert.equal(first.runs[0].session, session);
  assert.equal(first.runs[0].reply.outcome, "done");
  assert.equal(first.canSend, true);
  assert.deepEqual(first.runs[0].messageIds, [firstId]);

  await call(chat + "/messages", { id: secondId, text: secondText });
  const second = await complete(2);
  assert.equal(second.runs[1].reply.text, secondReply);
  assert.equal(second.runs[1].session, session);
  assert.equal(second.runs[1].reply.outcome, "done");
  assert.equal(second.runs[1].resumed, true);
  assert.deepEqual(second.runs[1].messageIds, [secondId]);
  assert.deepEqual(
    second.messages.map((message: { text: string }) => message.text),
    [firstText, secondText],
  );
  assert.equal(second.runs[0].reply.text, firstReply);
  assert.equal(worker.entries().length, 0);

  const executed = readFileSync(observations, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(executed.length, 2);
  assert.notEqual(executed[0].pid, process.pid);
  assert.notEqual(executed[1].pid, executed[0].pid);
  assert.equal(executed[0].resume, "");
  assert.equal(executed[1].resume, session);
  assert.equal(executed[0].context.events[0].detail, firstText);
  assert.equal(executed[1].context.events.length, 1);
  assert.equal(executed[1].context.events[0].detail, secondText);
  assert.equal(executed[1].context.events[0].subject, `wb:${id}`);
  for (const execution of executed) {
    assert.ok(!execution.prompt.includes(firstText));
    assert.ok(!execution.prompt.includes(secondText));
    assert.ok(execution.prompt.includes("读取任务描述并回答"));
  }
  for (const run of second.runs) {
    assert.doesNotMatch(run.reply.text, /agent-autoloop|transport diagnostic/);
    assert.ok(!JSON.stringify(run.reply).includes(config.worker.key));
  }
});
