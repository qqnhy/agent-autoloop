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
  if (!response.ok)
    throw new Error(typeof data?.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`);
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
