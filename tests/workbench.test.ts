// Failure cases: the browser gets owner credentials; an unrelated site or a rebound hostname reads or answers;
// the client becomes an unrestricted owner proxy; answering a real card fails to resume its run or applies twice;
// hub errors, redirects, unknown state and pagination are concealed as successful or invented results.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

setup("workbench");
const { startWorkbench } = await import("../clients/workbench/server.ts");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const running: Server[] = [];
const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function ready(server: Server) {
  running.push(server);
  await once(server, "listening");
  return address(server);
}
const upstream = await ready(serve(0));
const owner = hub.addKey("owner", "workbench-test");
const base = await ready(startWorkbench({ url: upstream, owner }, 0));
after(() => {
  for (const server of running) {
    server.closeAllConnections();
    server.close();
  }
  hub.db.close();
});
const api = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { "x-workbench": "1", ...init.headers } });

test("only fixed static assets are public, and they never contain the owner key", async () => {
  for (const path of ["/", "/app.js", "/styles.css"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    assert.ok(!(await response.text()).includes(owner));
  }
  assert.equal((await fetch(base + "/config.json")).status, 404);
  assert.equal((await fetch(base + "/api/state")).status, 403);
});

test("cross-origin requests and rebound hosts cannot read or change anything", async () => {
  for (const path of ["/api/state", "/api/cards/1/answer"]) {
    const response = await api(path, {
      method: path.endsWith("answer") ? "POST" : "GET",
      headers: { origin: "https://unrelated.example", "content-type": "application/json" },
      ...(path.endsWith("answer") && { body: '{"choice":0}' }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(base + "/api/state", { headers: { host: "rebound.example", "x-workbench": "1" } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await api("/api/state", { headers: { origin: base } })).status, 200);
});

test("only state, why and explicit answers are exposed, with no arbitrary owner operations", async () => {
  for (const path of ["/api/runs/1/cancel", "/v1/state", "/api/keys/owner/main", "/api/cards/1/resolve"]) {
    assert.equal((await api(path, { method: "POST", body: "{}" })).status, 404, path);
  }
  assert.equal((await api("/api/cards/1/answer")).status, 404);
  assert.equal((await api("/api/state?before=nope")).status, 400);
  assert.equal((await api("/api/state?url=https://other.example")).status, 400);
  assert.equal(
    (await api("/api/cards/1/answer", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }))
      .status,
    415,
  );
  assert.equal(
    (
      await api("/api/cards/1/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(20000),
      })
    ).status,
    413,
  );
});

test("real run state, history and pagination are preserved, and a real answer wakes work exactly once", async () => {
  hub.ingest("app", {
    id: "workbench-1",
    type: "feedback.new",
    subject: "web-task",
    summary: "<script>external text</script>",
  });
  const job = hub.claimNext("w1", "workbench-first")!;
  hub.finish(job.run, job.token, {
    outcome: "done",
    summary: "本轮结束，等待选择",
    ask: [{ title: "下一步怎么做？", text: "这是协议卡片，不是版本审批。", options: ["继续", "调整"] }],
  });
  const response = await api("/api/state");
  const state = await response.json();
  assert.equal(state.runs.find((run: any) => run.id === job.run).state, "done");
  const direct = await fetch(upstream + "/v1/state", { headers: { authorization: `Bearer ${owner}` } }).then((r) =>
    r.json(),
  );
  assert.deepEqual(state.runs, direct.runs);
  assert.deepEqual(await (await api(`/api/runs/${job.run}/why`)).json(), hub.why(job.run));
  const page = await (await api(`/api/state?before=${job.run}`)).json();
  assert.ok(page.runs.every((run: any) => run.id < job.run));
  const card = state.cards.find((card: any) => card.title === "下一步怎么做？");
  const answer = () =>
    api(`/api/cards/${card.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: '{"choice":1}',
    }).then((r) => r.json());
  assert.deepEqual(await answer(), { changed: true, state: "decided" });
  assert.deepEqual(await answer(), { changed: false, state: "decided" });
  const continued = hub.claimNext("w1", "workbench-continued")!;
  assert.equal(continued.context.answers[0].choice, 1);
  assert.equal(continued.context.answers[0].card, card.id);
});

test("older active runs stay visible while history has a real second page", async () => {
  hub.ingest("ops", { id: "old-active", type: "alert.raised", subject: "old" });
  const old = hub.claimNext("w2", "old-active")!;
  for (let i = 0; i < 65; i++) {
    hub.ingest("app", { id: `page-${i}`, type: "feedback.new", subject: `page-${i}` });
    const job = hub.claimNext("w1", `page-${i}`)!;
    hub.finish(job.run, job.token, { outcome: "done", summary: "分页验收" });
  }
  const first = await (await api("/api/state")).json();
  assert.equal(first.hasMore, true);
  assert.ok(first.nextBefore > old.run);
  assert.equal(first.runs.find((run: any) => run.id === old.run).state, "claimed");
  const next = await (await api(`/api/state?before=${first.nextBefore}`)).json();
  assert.ok(next.runs.length > 0);
  assert.ok(next.runs.every((run: any) => run.id < first.nextBefore));
  assert.equal(next.hasMore, false);
  assert.equal(next.nextBefore, null);
  // A stale worker's actual state is unknown, not done or an empty list.
  const later = Date.now() + 20 * 60_000;
  hub.heartbeat("w2", [], later);
  hub.tick(later);
  const unknown = await (await api("/api/state")).json();
  assert.equal(unknown.runs.find((run: any) => run.id === old.run).state, "unknown");
});

test("revoked keys and upstream failures stay failures; redirects never receive owner credentials", async () => {
  const wrong = await ready(startWorkbench({ url: upstream, owner: "revoked" }, 0));
  const refused = await fetch(wrong + "/api/state", { headers: { "x-workbench": "1" } });
  assert.equal(refused.status, 401);
  assert.match((await refused.json()).error, /密钥/);
  const redirect = await ready(
    createServer((_req, res) => res.writeHead(302, { location: upstream + "/v1/state" }).end()).listen(0, "127.0.0.1"),
  );
  const redirected = await ready(startWorkbench({ url: redirect, owner }, 0));
  assert.equal((await fetch(redirected + "/api/state", { headers: { "x-workbench": "1" } })).status, 502);
  const broken = await ready(startWorkbench({ url: "http://127.0.0.1:1", owner }, 0));
  const failed = await fetch(broken + "/api/state", { headers: { "x-workbench": "1" } });
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes(owner));
});
