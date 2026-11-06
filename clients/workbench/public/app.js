"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const array = (value) => (Array.isArray(value) ? value : []);
const labels = {
  claimed: "正在运行",
  queued: "排队中",
  unknown: "状态未知",
  done: "本轮结束",
  nothing: "没事可做",
  cancelled: "已停止",
};
const model = {
  state: null,
  runs: new Map(),
  selected: null,
  next: null,
  loading: false,
  paging: false,
  detailVersion: 0,
  drafts: new Map(),
  askNodes: new Map(),
};
const time = (value) => {
  if (value === null || value === undefined || value === "") return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
};
const badge = (state) =>
  el(
    "span",
    labels[state] || `未知状态：${state ?? "未提供"}`,
    `badge ${Object.hasOwn(labels, state) ? state : "unknown"}`,
  );
const empty = (text) => el("p", text, "empty");
function link(value, title) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const a = el("a", title);
    a.href = url.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  } catch {
    return null;
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "X-Workbench": "1", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`服务返回了无法读取的响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const error = new Error(typeof data?.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`);
    error.notSubmitted = data?.notSubmitted === true;
    throw error;
  }
  return data;
}
function preserveFocus(container, render) {
  const focused = container.contains(document.activeElement) ? document.activeElement?.dataset?.focus : null;
  render();
  if (focused)
    [...container.querySelectorAll("[data-focus]")]
      .find((node) => node.dataset.focus === focused)
      ?.focus({ preventScroll: true });
}
function renderStats() {
  const state = model.state;
  const asks = array(state.cards).filter((c) => c.kind === "ask" && c.state === "open");
  const values = [
    ["正在运行", state.totals?.running],
    ["排队中", state.totals?.queued],
    ["待回答", asks.length],
    ["今日结束的轮次", state.totals?.doneToday],
  ];
  $("stats").replaceChildren(
    ...values.map(([label, value]) => {
      const node = el("div", null, "stat");
      node.append(el("span", label), el("strong", value ?? "—"));
      return node;
    }),
  );
  $("nav-count").textContent = String(asks.length);
  $("ask-count").textContent = String(asks.length);
}
function renderRules() {
  const rules = array(model.state.lines);
  const selected = $("rule-filter").value;
  const names = [...new Set([...rules.map((r) => r.id), ...[...model.runs.values()].map((r) => r.rule)])].filter(
    Boolean,
  );
  const options = [new Option("全部规则", ""), ...names.map((name) => new Option(name, name))];
  $("rule-filter").replaceChildren(...options);
  $("rule-filter").value = names.includes(selected) ? selected : "";
  $("rules").replaceChildren(
    ...(rules.length
      ? rules.map((rule) => {
          const node = el("article", null, "rule-card");
          node.append(
            el("h3", rule.name),
            el("p", `${rule.source ?? "来源未知"} → ${rule.agent ?? "Agent 未知"}`),
            el("p", rule.every || array(rule.types).join(" · ") || "未提供触发方式"),
          );
          if (rule.next) node.append(el("p", `下次触发：${time(rule.next)}`));
          const totals = el("div", null, "rule-status");
          totals.append(
            el("span", `运行 ${rule.totals?.running ?? "—"}`),
            el("span", `排队 ${rule.totals?.queued ?? "—"}`),
            el("span", `未知 ${rule.totals?.unknown ?? "—"}`),
          );
          node.append(totals);
          return node;
        })
      : [empty("暂无任务规则。规则在中台配置文件中管理。")]),
  );
}
function renderRuns() {
  const search = $("search").value.trim().toLowerCase();
  const status = $("status-filter").value;
  const rule = $("rule-filter").value;
  const runs = [...model.runs.values()]
    .sort((a, b) => b.id - a.id)
    .filter(
      (run) =>
        (!status || run.state === status) &&
        (!rule || run.rule === rule) &&
        (!search ||
          [
            run.id,
            run.rule,
            run.agent,
            run.summary,
            run.error,
            ...array(run.events).flatMap((e) => [e.type, e.subject, e.summary]),
          ]
            .join(" ")
            .toLowerCase()
            .includes(search)),
    );
  $("run-count").textContent = `${runs.length} 条匹配 / 已加载 ${model.runs.size} 轮`;
  preserveFocus($("runs"), () =>
    $("runs").replaceChildren(
      ...(runs.length
        ? runs.map((run) => {
            const button = el("button", null, "run-row");
            button.type = "button";
            button.dataset.focus = `run-${run.id}`;
            button.setAttribute("aria-pressed", String(run.id === model.selected));
            const head = el("div", null, "row-head");
            head.append(el("span", run.rule || "未命名规则", "row-title"), badge(run.state));
            button.append(
              head,
              el("p", `#${run.id} · ${run.agent || "Agent 未知"} · ${time(run.createdAt)}`, "meta"),
              el("p", run.summary || run.error || "尚无运行摘要", "run-summary"),
            );
            button.addEventListener("click", () => {
              model.selected = run.id;
              renderRuns();
              loadDetail();
            });
            return button;
          })
        : [
            empty(
              model.runs.size
                ? "已加载记录中没有匹配结果。可调整筛选或加载更早的轮次。"
                : "还没有运行记录。事件触发后会显示在这里。",
            ),
          ]),
    ),
  );
  $("load-more").disabled = model.paging || model.next === null;
  $("load-more").textContent = model.paging ? "正在加载…" : model.next === null ? "已加载到最早记录" : "加载更早的轮次";
}
function cardAnswer(card) {
  const choice = Number.isInteger(card.choice) ? array(card.options)[card.choice] : null;
  return [choice, card.answer].filter(Boolean).join(" · ") || card.result || "没有回答文字";
}
function renderDecisions() {
  const cards = array(model.state.recentCards);
  $("decisions").replaceChildren(
    ...(cards.length
      ? cards.map((card) => {
          const node = el("article", null, "decision-card");
          const state = { decided: "已回答", done: "已执行", closed: "已结案" }[card.state] || `状态：${card.state}`;
          node.append(
            el("p", `${state} · #${card.id} · ${time(card.decidedAt || card.closedAt)}`, "meta"),
            el("h3", card.title),
            el("p", cardAnswer(card), "body-text"),
          );
          return node;
        })
      : [empty("还没有回答或结案记录。")]),
  );
}
function draftFor(id) {
  if (!model.drafts.has(id))
    model.drafts.set(id, { choice: "", text: "", busy: false, uncertain: false, sent: false, message: "" });
  return model.drafts.get(id);
}
function renderAsks() {
  const cards = array(model.state.cards).filter((card) => card.kind === "ask" && card.state === "open");
  const open = new Set(cards.map((card) => card.id));
  for (const [id, entry] of model.askNodes)
    if (!open.has(id)) {
      entry.node.remove();
      model.askNodes.delete(id);
    }
  $("asks")
    .querySelectorAll(":scope > .empty")
    .forEach((node) => node.remove());
  if (!cards.length) {
    $("asks").append(empty("目前没有待回答的问题。需要你的判断时，会出现在这里。"));
    return;
  }
  for (const card of cards) {
    const draft = draftFor(card.id);
    if (draft.uncertain) {
      draft.uncertain = false;
      draft.message = "已重新核对：卡片仍待回答。草稿已保留，请确认后再提交。";
    }
    const signature = JSON.stringify([card.version, card.title, card.text, card.options, card.recommend]);
    let entry = model.askNodes.get(card.id);
    if (entry && entry.signature !== signature && !draft.busy) {
      if ($("asks").contains(document.activeElement) && entry.node.contains(document.activeElement)) {
        entry.message.textContent = "问题已更新，请移开输入焦点后刷新，核对最新选项再提交。";
        entry.submit.disabled = true;
        continue;
      }
      entry.node.remove();
      model.askNodes.delete(card.id);
      entry = null;
      draft.choice = "";
    }
    if (!entry) {
      entry = createAsk(card, draft, signature);
      model.askNodes.set(card.id, entry);
      $("asks").append(entry.node);
    }
    entry.message.textContent = draft.message;
    entry.submit.disabled = draft.busy || draft.uncertain || draft.sent;
    entry.submit.textContent = draft.busy
      ? "正在提交…"
      : draft.sent
        ? draft.alreadyHandled
          ? "卡片已处理"
          : "回答已提交"
        : "提交回答 →";
  }
}
function createAsk(card, draft, signature) {
  const node = el("article", null, "ask-card");
  node.append(
    el("p", `待回答 · #${card.id}${card.rule ? ` · ${card.rule}` : ""}`, "meta"),
    el("h3", card.title),
    el("p", card.text || "没有补充说明", "body-text"),
  );
  const form = el("form", null, "ask-form");
  const fieldset = el("fieldset");
  fieldset.append(el("legend", "选择一个选项，或写下其他想法"));
  [...array(card.options), "其他想法（仅提交文字）"].forEach((option, index) => {
    const label = el("label", null, "option");
    const input = el("input");
    input.type = "radio";
    input.name = `choice-${card.id}`;
    input.value = index === array(card.options).length ? "" : String(index);
    input.checked = draft.choice !== "" && draft.choice === input.value;
    input.addEventListener("change", () => {
      draft.choice = input.value;
    });
    label.append(
      input,
      el("span", `${option}${card.recommend === index && index < array(card.options).length ? "（Agent 建议）" : ""}`),
    );
    fieldset.append(label);
  });
  const label = el("label", "补充说明（选择选项时可不填）");
  label.htmlFor = `answer-${card.id}`;
  const text = el("textarea");
  text.id = `answer-${card.id}`;
  text.maxLength = 4000;
  text.placeholder = "写下你的判断或下一步…";
  text.value = draft.text;
  text.addEventListener("input", () => {
    draft.text = text.value;
  });
  const submit = el("button", "提交回答 →", "button");
  submit.type = "submit";
  const message = el("p", draft.message, "form-message");
  message.setAttribute("role", "status");
  form.append(fieldset, label, text, submit, message);
  node.append(form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (draft.busy || draft.sent || draft.uncertain || submit.disabled) return;
    if (draft.choice === "" && !draft.text.trim()) {
      message.textContent = "请选择一个选项，或填写回答。";
      text.focus();
      return;
    }
    draft.busy = true;
    submit.disabled = true;
    submit.textContent = "正在提交…";
    fieldset.disabled = true;
    text.disabled = true;
    const body = {};
    if (draft.choice !== "") body.choice = Number(draft.choice);
    if (draft.text.trim()) body.text = draft.text.trim();
    try {
      const result = await api(`/api/cards/${card.id}/answer`, { method: "POST", body: JSON.stringify(body) });
      draft.sent = true;
      draft.alreadyHandled = result.changed === false;
      draft.message =
        result.changed === false
          ? "卡片已由先前的操作处理，本次回答未覆盖已有决定。"
          : "回答已提交。后续处理由中台继续调度。";
    } catch (error) {
      draft.uncertain = true;
      draft.message = `未能确认提交结果：${error.message}。草稿已保留；正在重新核对卡片，请勿重复提交。`;
    } finally {
      draft.busy = false;
      message.textContent = draft.message;
      submit.textContent = draft.sent ? (draft.alreadyHandled ? "卡片已处理" : "回答已提交") : "请刷新核对状态";
      fieldset.disabled = draft.sent;
      text.disabled = draft.sent;
      await refresh();
    }
  });
  return { node, signature, message, submit };
}
function detailBase(run) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    el("p", `运行详情 / #${run.id}`, "eyebrow"),
    badge(run.state),
    el("h2", run.rule),
    el("p", run.summary || "尚无运行摘要", "body-text"),
  );
  if (run.error) fragment.append(el("p", run.error, "error-banner body-text"));
  if (run.state === "unknown")
    fragment.append(el("p", "接单程序失去音信，实际执行状态未知。不能视为已经结束。", "scope-note"));
  if (run.stopping) fragment.append(el("p", "已请求停止，等待接单程序确认。", "scope-note"));
  const grid = el("dl", null, "detail-grid");
  for (const [label, value] of [
    ["Agent", run.agent || "未记录"],
    ["失败尝试次数", run.attempts ?? "未记录"],
    ["创建时间", time(run.createdAt)],
    ["领取时间", time(run.claimedAt)],
    ["结束时间", time(run.finishedAt)],
    ["会话", run.session || "未记录"],
  ]) {
    const pair = el("div");
    pair.append(el("dt", label), el("dd", value));
    grid.append(pair);
  }
  fragment.append(grid);
  appendConversationLink(fragment, run);
  if (run.state === "queued" && run.notBefore) fragment.append(el("p", `最早领取时间：${time(run.notBefore)}`, "meta"));
  const session = link(run.link, "打开运行会话 ↗");
  if (session) fragment.append(session);
  fragment.append(el("h3", "触发事件（最多显示最近 20 条）"));
  if (!array(run.events).length) fragment.append(el("p", "没有事件信息", "muted"));
  for (const event of array(run.events)) {
    const node = el("div", null, "event");
    node.append(
      el("p", `${event.source} / ${event.type}${event.subject ? ` · ${event.subject}` : ""}`, "meta"),
      el("p", event.summary || "没有摘要", "body-text"),
    );
    const source = link(event.link, "查看来源 ↗");
    if (source) node.append(source);
    fragment.append(node);
  }
  fragment.append(el("h3", "事实时间线"));
  return fragment;
}
const factLabels = {
  rules: "规则版本",
  event: "收到事件",
  claim: "领取任务",
  started: "开始处理",
  finish: "提交回执",
  answer: "收到回答",
  resolve: "卡片结案",
  stop: "请求停止",
  tick: "调度检查",
};
function timeline(facts, id) {
  const list = el("ol", null, "timeline");
  const prior = new Map();
  const changes = facts.flatMap((fact) => array(fact.changes));
  const relations = new Map();
  for (const { table, key, row } of changes) {
    if (table === "run_events") {
      if (row) relations.set(key, row);
      else relations.delete(key);
    }
  }
  const ownEvents = new Set([...relations.values()].filter((row) => row.run_id === id).map((row) => row.event_id));
  const versions = new Set(
    changes.filter((c) => c.table === "runs" && c.row?.id === id).map((c) => c.row.rules_version),
  );
  for (const fact of facts) {
    const lines = [];
    const ownRun = array(fact.changes).some((c) => c.table === "runs" && c.row?.id === id);
    const receipt = fact.type === "finish" && ownRun;
    if (fact.type === "rules" && versions.has(fact.seq)) lines.push(`规则版本 #${fact.seq}`);
    for (const change of array(fact.changes)) {
      const row = change.row;
      const key = `${change.table}:${change.key}`;
      const before = prior.get(key);
      if (change.table === "runs" && row?.id === id) {
        if (!before || before.state !== row.state) lines.push(`状态：${labels[row.state] || row.state}`);
        if (row.claimed_at && row.claimed_at !== before?.claimed_at)
          lines.push(`领取：${row.agent} · 规则版本 #${row.rules_version}`);
        if (row.session && row.session !== before?.session) lines.push(`会话：${row.session}`);
        if (row.summary && row.summary !== before?.summary) lines.push(`回执：${row.summary}`);
        if (row.error && row.error !== before?.error) lines.push(`运行错误：${row.error}`);
      }
      if (change.table === "cards" && row) {
        const own = row.run_id === id;
        if (!before && own) lines.push(`${row.kind === "ask" ? "提问" : "通知"}：${row.title}`);
        if (row.decided_at && row.decided_at !== before?.decided_at && (own || ownEvents.has(row.answer_event))) {
          let options = [];
          try {
            options = JSON.parse(row.options || "[]");
          } catch {
            /* Raw facts remain available below. */
          }
          lines.push(`${row.by || "本人"}回答：${row.answer || options[row.choice] || "未记录文字"}`);
        }
        if (row.closed_at && row.closed_at !== before?.closed_at && (own || receipt))
          lines.push(`结案：${row.result || row.title}`);
      }
      if (change.table === "events" && row && !before && (ownEvents.has(row.id) || receipt))
        lines.push(
          `事件：${row.source} / ${row.type}${row.subject ? ` · ${row.subject}` : ""}${row.summary ? `\n${row.summary}` : ""}`,
        );
      if (change.table === "timers" && row && !before && receipt)
        lines.push(`安排复查：${row.about || row.key} · ${time(row.at)}`);
      if (row) prior.set(key, row);
      else prior.delete(key);
    }
    if (!lines.length && !ownRun) continue;
    const item = el("li");
    item.append(
      el("time", time(fact.at)),
      el("div", `${factLabels[fact.type] || fact.type || "事实"} · #${fact.seq}`, "timeline-title"),
    );
    if (lines.length) item.append(el("p", lines.join("\n")));
    list.append(item);
  }
  return list;
}
async function loadDetail(quiet = false) {
  const id = model.selected;
  const run = model.runs.get(id);
  if (!run) return;
  const version = ++model.detailVersion;
  if (!quiet) {
    model.detailSignature = null;
    $("detail").replaceChildren(detailBase(run), empty("正在读取事实时间线…"));
  }
  try {
    const facts = await api(`/api/runs/${id}/why`);
    if (version !== model.detailVersion || model.selected !== id) return;
    if (!Array.isArray(facts)) throw new Error("时间线格式不正确");
    const signature = JSON.stringify([model.runs.get(id), facts]);
    if (quiet && signature === model.detailSignature) return;
    const expanded = quiet && Boolean($("detail").querySelector("details[open]"));
    const focused = quiet && $("detail").contains(document.activeElement) ? document.activeElement : null;
    const focusedHref = focused?.tagName === "A" ? focused.href : null;
    const focusedSummary = focused?.tagName === "SUMMARY";
    model.detailSignature = signature;
    $("detail").replaceChildren(
      detailBase(model.runs.get(id)),
      facts.length ? timeline(facts, id) : empty("暂无事实记录"),
    );
    const details = el("details", null, "raw-facts");
    details.open = expanded;
    details.append(el("summary", "查看原始事实 JSON"), el("pre", JSON.stringify(facts, null, 2)));
    $("detail").append(details);
    if (focusedSummary) details.querySelector("summary").focus({ preventScroll: true });
    else if (focusedHref)
      [...$("detail").querySelectorAll("a")].find((a) => a.href === focusedHref)?.focus({ preventScroll: true });
  } catch (error) {
    if (version !== model.detailVersion || model.selected !== id) return;
    $("detail").replaceChildren(
      detailBase(model.runs.get(id)),
      el("p", `时间线读取失败：${error.message}`, "error-banner"),
    );
    const retry = el("button", "重试读取时间线", "button secondary");
    retry.type = "button";
    retry.addEventListener("click", () => loadDetail());
    $("detail").append(retry);
  }
}
async function refresh() {
  if (model.loading) return;
  model.loading = true;
  $("refresh").disabled = true;
  try {
    const state = await api("/api/state");
    if (!state || !Array.isArray(state.runs) || !Array.isArray(state.cards) || !Array.isArray(state.lines))
      throw new Error("中台状态格式不正确");
    const first = !model.state;
    const previousNewest = Math.max(0, ...model.runs.keys());
    model.state = state;
    const currentIds = new Set(state.runs.map((run) => run.id));
    let removedActive = false;
    for (const [id, run] of model.runs) {
      if (["claimed", "queued", "unknown"].includes(run.state) && !currentIds.has(id)) {
        model.runs.delete(id);
        removedActive = true;
        if (model.selected === id) {
          model.selected = null;
          model.detailVersion++;
          $("detail").replaceChildren(empty("这轮已离开当前活动列表。请加载更早的轮次，查看更新后的记录。"));
        }
      }
    }
    for (const run of state.runs) model.runs.set(run.id, run);
    if (first || removedActive) model.next = state.hasMore ? state.nextBefore : null;
    else if (state.hasMore && state.nextBefore > previousNewest) model.next = state.nextBefore;
    $("global-error").hidden = true;
    $("connection").className = "connection online";
    $("connection").textContent = "中台已连接";
    $("updated").textContent = `最近同步 ${time(state.now)} · 浏览器本地时间`;
    renderStats();
    renderAsks();
    renderRules();
    renderRuns();
    renderDecisions();
    if (model.selected !== null) loadDetail(true);
  } catch (error) {
    $("connection").className = "connection offline";
    $("connection").textContent = "连接异常";
    $("global-error").hidden = false;
    $("global-error").textContent =
      `无法刷新中台状态：${error.message}。${model.state ? "当前显示上次读取的记录，可能已过时；回答草稿已保留。" : "请检查工作台服务和中台连接配置，然后重试。"}`;
    if (!model.state) {
      for (const id of ["asks", "runs", "rules", "decisions"])
        $(id).replaceChildren(empty("无法读取数据，请刷新重试。"));
      $("run-count").textContent = "数据不可用";
      $("load-more").disabled = true;
    }
  } finally {
    model.loading = false;
    $("refresh").disabled = false;
  }
}
$("refresh").addEventListener("click", async () => {
  await refresh();
  if (model.selected !== null) loadDetail();
});
for (const id of ["search", "status-filter", "rule-filter"])
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    if (model.state) renderRuns();
  });
$("load-more").addEventListener("click", async () => {
  if (model.paging || model.next === null) return;
  model.paging = true;
  renderRuns();
  try {
    const page = await api(`/api/state?before=${encodeURIComponent(model.next)}`);
    if (!Array.isArray(page.runs)) throw new Error("运行列表格式不正确");
    for (const run of page.runs) if (!model.runs.has(run.id)) model.runs.set(run.id, run);
    model.next = page.hasMore ? page.nextBefore : null;
    $("page-note").textContent = "搜索与筛选仅覆盖已加载记录";
    renderRules();
  } catch (error) {
    $("page-note").textContent = `加载失败：${error.message}。可重试。`;
  } finally {
    model.paging = false;
    renderRuns();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
window.addEventListener("online", refresh);
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 15000);

const chat = {
  routes: [],
  conversations: [],
  selected: null,
  detail: null,
  version: 0,
  indexVersion: 0,
  detailLoading: null,
  drafts: new Map(),
  creating: false,
  creation: null,
  signature: null,
};
function chatDraft(id = chat.selected) {
  if (!chat.drafts.has(id)) chat.drafts.set(id, { text: "", pending: null, busy: false, notice: "" });
  return chat.drafts.get(id);
}
function chatError(message) {
  $("chat-error").hidden = !message;
  $("chat-error").textContent = message || "";
}
function appendConversationLink(fragment, run) {
  const conversation = chat.conversations.find((item) =>
    array(run.events).some((event) => event.subject === item.subject),
  );
  if (!conversation) return;
  const button = el("button", "打开这个任务的对话 →", "button secondary chat-open");
  button.type = "button";
  button.addEventListener("click", () => {
    selectChat(conversation.id);
    $("chat-section").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  fragment.append(button);
}
function renderChatList() {
  preserveFocus($("chat-list"), () => {
    $("chat-list").replaceChildren(
      ...chat.conversations.map((conversation) => {
        const button = el("button", null, `chat-list-item${chat.selected === conversation.id ? " selected" : ""}`);
        button.type = "button";
        button.dataset.focus = conversation.id;
        button.setAttribute("aria-current", chat.selected === conversation.id ? "true" : "false");
        button.append(
          el("strong", conversation.title || "未命名任务"),
          el("span", conversation.agent, "meta"),
          el("span", time(conversation.updatedAt), "meta"),
        );
        button.addEventListener("click", () => selectChat(conversation.id));
        return button;
      }),
    );
    if (!chat.conversations.length) $("chat-list").append(empty("还没有任务对话。选择上方 Agent，开始第一个需求。"));
  });
}
function renderChatRoutes() {
  const selected = chat.creation?.rule || $("chat-route").value;
  $("chat-route").replaceChildren(
    ...chat.routes.map((route) => {
      const option = el("option", `${route.name} · ${route.agentName || route.agent}`);
      option.value = route.id;
      return option;
    }),
  );
  if (chat.routes.some((route) => route.id === selected)) $("chat-route").value = selected;
  $("chat-route").disabled = !chat.routes.length || Boolean(chat.creation);
  $("chat-create").disabled = !chat.routes.length || chat.creating;
  $("chat-create").textContent = chat.creating ? "正在创建…" : chat.creation ? "重试创建同一对话" : "＋ 新建对话";
  renderChatRouteInfo();
}
function renderChatRouteInfo() {
  const route = chat.routes.find((item) => item.id === $("chat-route").value);
  $("chat-route-info").textContent = route
    ? `Agent：${route.agentName || route.agent}\n工作目录：${route.cwd}\n${route.resume ? "允许接续会话，实际情况以每轮记录为准。" : "每轮使用新会话。"}`
    : "";
}
async function loadChatIndex() {
  const version = ++chat.indexVersion;
  try {
    const [routes, conversations] = await Promise.all([api("/api/chat/routes"), api("/api/chat/conversations")]);
    if (version !== chat.indexVersion) return;
    if (!Array.isArray(routes.routes) || !Array.isArray(conversations.conversations))
      throw new Error("对话列表格式不正确");
    chat.routes = routes.routes;
    chat.conversations = conversations.conversations;
    renderChatRoutes();
    renderChatList();
    $("chat-setup").hidden = chat.routes.length > 0 && !routes.problem;
    $("chat-setup").textContent =
      routes.problem ||
      (!chat.routes.length
        ? '还没有开放给工作台的对话规则。请在本机配置：npm run workbench:chat -- --name "项目对话" --agent <已配置 Agent ID> --cwd <项目路径>。此处不会执行配置命令。'
        : "");
    chatError("");
    if (model.selected !== null) {
      model.detailSignature = null;
      loadDetail(true);
    }
  } catch (error) {
    if (version !== chat.indexVersion) return;
    chatError(`无法读取任务对话：${error.message}。可刷新重试，未发送内容仍保留在此页面。`);
  }
}
function renderChatComposer() {
  const selected = Boolean(chat.selected);
  const draft = selected ? chatDraft() : null;
  const detail = chat.detail;
  $("chat-text").disabled = !selected;
  $("chat-text").readOnly = Boolean(draft?.pending || draft?.busy);
  $("chat-length").textContent = `${$("chat-text").value.length} / 4000`;
  $("chat-send").disabled =
    !selected || !detail?.canSend || Boolean(draft?.pending || draft?.busy) || !draft?.text.trim();
  $("chat-send").textContent = draft?.busy ? "正在提交…" : "发送消息 →";
  $("chat-retry").hidden = !draft?.pending || draft.busy;
  $("chat-status").textContent = !selected
    ? "请先选择或新建对话。"
    : draft.busy
      ? "正在提交消息，请勿重复发送。"
      : draft.pending
        ? "尚未确认这条消息是否送达。内容已锁定；请核对并使用下方按钮重试原消息，不要另建一条重复消息。"
        : detail
          ? detail.canSend
            ? draft.notice || "发送会交给中台调度；回复在本轮结束后显示。"
            : detail.blockReason || "暂时不能发送，请等待当前任务状态确认。"
          : "正在读取任务状态；你可以先写草稿。";
}
function renderChatHistory(detail) {
  const history = $("chat-history");
  const signature = JSON.stringify([detail.messages, detail.runs, detail.historyComplete]);
  if (signature === chat.signature) return;
  chat.signature = signature;
  const atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
  const scrollTop = history.scrollTop;
  const entries = [];
  for (const message of array(detail.messages)) entries.push({ at: message.at, message });
  for (const run of array(detail.runs))
    entries.push({ at: run.reply?.at || run.finishedAt || run.claimedAt || 0, run });
  entries.sort((a, b) => (new Date(a.at).getTime() || 0) - (new Date(b.at).getTime() || 0));
  preserveFocus(history, () => {
    history.replaceChildren();
    if (!detail.historyComplete)
      history.append(el("p", "部分早期记录不可用，下面显示当前可读取的历史。", "scope-note"));
    for (const entry of entries) {
      const node = el("article", null, entry.message ? "chat-message chat-user" : "chat-message chat-agent");
      if (entry.message) {
        const message = entry.message;
        node.append(el("p", `你 · ${time(message.at)}`, "meta"), el("p", message.text, "body-text"));
        node.append(el("p", message.status === "accepted" ? "中台已接收" : "送达结果未确认", "meta"));
        if (message.error) node.append(el("p", message.error, "form-message"));
        if (message.status === "uncertain") {
          const retry = el("button", "核对并重试这条原消息", "button secondary");
          retry.type = "button";
          retry.dataset.focus = `retry-${message.id}`;
          retry.addEventListener("click", () => sendChatMessage({ id: message.id, text: message.text }));
          node.append(retry);
        }
      } else {
        const run = entry.run;
        node.append(el("p", `Agent · 轮次 #${run.id} · ${time(entry.at)}`, "meta"), badge(run.state));
        if (run.replyStatus === "available" && run.reply) {
          node.append(el("p", run.reply.text || "此轮未返回文字。", "body-text"));
          if (run.reply.truncated) node.append(el("p", "回复较长，当前内容已截断。", "scope-note"));
        } else if (run.replyStatus === "waiting")
          node.append(el("p", "等待本轮结束后读取最终回复。这里不是实时输出。", "muted"));
        else {
          node.append(el("p", "仅运行摘要，完整回复不可用（旧版或远端 worker / 输出已过期）", "scope-note"));
          node.append(el("p", run.summary || "暂无运行摘要。", "body-text"));
        }
        if (run.error) node.append(el("p", run.error, "error-banner body-text"));
        const messageCount = array(run.messageIds).length;
        node.append(
          el("p", `本轮关联 ${messageCount} 条用户消息${messageCount > 1 ? "，由中台合并处理" : ""}。`, "meta"),
        );
        node.append(
          el(
            "p",
            run.session
              ? `会话：${run.session} · ${run.resumed === true ? "已接续已有会话" : run.resumed === false ? "本轮新建会话" : "未记录是否接续"}`
              : "尚无会话记录。",
            "meta",
          ),
        );
        if (run.notBefore && run.state === "queued") node.append(el("p", `最早领取：${time(run.notBefore)}`, "meta"));
      }
      history.append(node);
    }
    if (!entries.length) history.append(empty("还没有消息。写下你的需求，开始这项任务。"));
  });
  history.scrollTop = atBottom ? history.scrollHeight : scrollTop;
}
async function loadChatDetail() {
  const id = chat.selected;
  if (!id) return;
  if (chat.detailLoading?.id === id && chat.detailLoading.version === chat.version) return;
  const version = ++chat.version;
  chat.detailLoading = { id, version };
  try {
    const detail = await api(`/api/chat/conversations/${encodeURIComponent(id)}`);
    if (id !== chat.selected || version !== chat.version) return;
    if (!detail.conversation || !Array.isArray(detail.messages) || !Array.isArray(detail.runs))
      throw new Error("对话记录格式不正确");
    chat.detail = detail;
    const draft = chatDraft(id);
    if (
      draft.pending &&
      detail.messages.some((message) => message.id === draft.pending.id && message.status === "accepted")
    ) {
      if (draft.text === draft.pending.text) draft.text = "";
      draft.pending = null;
      draft.notice = "消息已由中台接收。";
      $("chat-text").value = draft.text;
    }
    $("chat-title").textContent = detail.conversation.title || "任务对话";
    $("chat-context").textContent = `Agent：${detail.conversation.agent} · 工作目录：${detail.conversation.cwd}`;
    renderChatHistory(detail);
    $("chat-cards").replaceChildren();
    const cards = array(detail.cards).filter((card) => card.kind === "ask" && card.state === "open");
    if (cards.length) {
      const note = el("div", null, "scope-note");
      note.append(el("p", `Agent 有 ${cards.length} 个问题需要你明确回答。请在问题卡片提交，聊天消息不算卡片回答。`));
      const anchor = el("a", "前往待你回答 ↓");
      anchor.href = "#questions";
      note.append(anchor);
      $("chat-cards").append(note);
    }
    renderChatComposer();
    chatError("");
  } catch (error) {
    if (id !== chat.selected || version !== chat.version) return;
    chat.detail = null;
    renderChatComposer();
    chatError(`对话读取失败：${error.message}。显示的记录可能已过时；草稿已保留，请刷新重试。`);
  } finally {
    if (chat.detailLoading?.version === version) chat.detailLoading = null;
  }
}
function selectChat(id) {
  if (chat.selected === id) {
    loadChatDetail();
    return;
  }
  chat.selected = id;
  chat.detail = null;
  chat.signature = null;
  chat.version++;
  $("chat-text").value = chatDraft(id).text;
  $("chat-title").textContent = chat.conversations.find((item) => item.id === id)?.title || "任务对话";
  $("chat-context").textContent = "正在读取 Agent 和工作目录…";
  $("chat-history").replaceChildren(empty("正在读取对话记录…"));
  $("chat-cards").replaceChildren();
  renderChatList();
  renderChatComposer();
  loadChatDetail();
}
async function sendChatMessage(retry = null) {
  const id = chat.selected;
  if (!id) return;
  const draft = chatDraft(id);
  if (draft.busy) return;
  if (retry && draft.pending && retry.id !== draft.pending.id) {
    chatError("请先核对当前尚未确认的消息，再处理其他消息。");
    return;
  }
  if (!retry && (draft.pending || !chat.detail?.canSend || !draft.text.trim())) return;
  const message = retry || { id: crypto.randomUUID(), text: draft.text };
  draft.pending = message;
  draft.busy = true;
  chat.version++;
  renderChatComposer();
  try {
    const result = await api(`/api/chat/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify(message),
    });
    if (result.message?.status === "accepted") {
      if (draft.text === message.text) draft.text = "";
      draft.pending = null;
      draft.notice = "消息已由中台接收。";
    }
  } catch (error) {
    if (error.notSubmitted === true) draft.pending = null;
    draft.notice =
      error.notSubmitted === true
        ? `消息未提交：${error.message}。草稿已保留，可以修改后再发送。`
        : `未能确认发送结果：${error.message}`;
    if (id === chat.selected) chatError(draft.notice);
  } finally {
    draft.busy = false;
    if (id === chat.selected) {
      $("chat-text").value = draft.text;
      renderChatComposer();
      await loadChatDetail();
    }
  }
}
$("chat-route").addEventListener("change", renderChatRouteInfo);
$("chat-text").addEventListener("input", () => {
  if (!chat.selected) return;
  chatDraft().text = $("chat-text").value;
  chatDraft().notice = "";
  renderChatComposer();
});
$("chat-compose").addEventListener("submit", (event) => {
  event.preventDefault();
  sendChatMessage();
});
$("chat-retry").addEventListener("click", () => {
  if (chatDraft().pending) sendChatMessage(chatDraft().pending);
});
$("chat-new").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (chat.creating || !$("chat-route").value) return;
  chat.creation ||= { id: crypto.randomUUID(), rule: $("chat-route").value };
  chat.creating = true;
  renderChatRoutes();
  try {
    const result = await api("/api/chat/conversations", { method: "POST", body: JSON.stringify(chat.creation) });
    const conversation = result.conversation || result;
    if (!conversation.id) throw new Error("服务未返回对话编号");
    chat.creation = null;
    await loadChatIndex();
    selectChat(conversation.id);
    $("chat-text").focus();
  } catch (error) {
    if (error.notSubmitted === true) chat.creation = null;
    chatError(
      error.notSubmitted === true
        ? `对话未创建：${error.message}。请重新选择可用的任务规则。`
        : `未能确认创建结果：${error.message}。重试会使用同一对话编号。`,
    );
  } finally {
    chat.creating = false;
    renderChatRoutes();
  }
});
$("chat-refresh").addEventListener("click", async () => {
  await loadChatIndex();
  await loadChatDetail();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadChatDetail();
});
loadChatIndex();
setInterval(() => {
  if (!document.hidden && chat.selected && !chatDraft().busy) loadChatDetail();
}, 5000);
