// Local conversation records belong to this client. Scheduling and run state still come only from the hub's HTTP API.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../host/config.ts";
import { HOME, RULES_FILE } from "../../host/home.ts";
import { eventRule, typeMatches } from "../../kernel/rules.ts";
import { parseRules } from "../../protocol/rules.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAT_TYPE = /^workbench\.chat\.[a-z0-9_-]+$/;
const ACTIVE = new Set(["queued", "claimed", "unknown"]);
type Call = (path: string, body?: unknown, source?: boolean) => Promise<any>;
type Route = {
  id: string;
  name: string;
  agent: string;
  agentName: string;
  cwd: string;
  resume: boolean;
  source: string;
  type: string;
};
type Message = {
  id: string;
  text: string;
  at: string;
  status: "accepted" | "uncertain";
  eventId?: number;
  error?: string;
};
type Reply = { text: string; truncated: boolean; at: string; outcome: string };
type Run = {
  id: number;
  state: string;
  summary: string;
  error: string;
  session: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  notBefore: string | null;
  reply?: Reply;
  replyStatus: "available" | "unavailable" | "waiting";
  messageIds: string[];
  resumed: boolean | null;
  cardIds: number[];
  attempts: number;
};
type Conversation = {
  id: string;
  title: string;
  rule: string;
  agent: string;
  cwd: string;
  subject: string;
  source: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  runs: Run[];
  blocked?: string;
  checkedThrough?: number;
};

export class ChatError extends Error {
  status: number;
  notSubmitted: boolean;
  constructor(status: number, message: string, notSubmitted = false) {
    super(message);
    this.status = status;
    this.notSubmitted = notSubmitted;
  }
}
function object(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ChatError(400, "请求字段不正确");
  return value as Record<string, unknown>;
}
function identifier(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new ChatError(400, "对话或消息编号不正确");
}
const descriptor = ({
  messages: _messages,
  runs: _runs,
  blocked: _blocked,
  checkedThrough: _checked,
  ...conversation
}: Conversation) => conversation;
const sameRoute = (chat: Conversation, route: Route) =>
  chat.rule === route.id &&
  chat.agent === route.agent &&
  chat.cwd === route.cwd &&
  chat.source === route.source &&
  chat.type === route.type;

export function createChatService(config: Config, call: Call) {
  const directory = join(HOME, "workbench", "chats");
  const inFlight = new Set<string>();
  const reading = new Map<string, ReturnType<typeof refresh>>();
  const file = (id: string) => {
    identifier(id);
    return join(directory, `${id}.json`);
  };
  const load = (id: string): Conversation => {
    const path = file(id);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new ChatError(404, "没有这个任务对话");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const save = (chat: Conversation) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = file(chat.id);
    writeFileSync(`${path}.tmp`, JSON.stringify(chat), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };

  async function routes(state?: any): Promise<{ routes: Route[]; problem: string | null }> {
    if (!config.source?.key || !config.hub)
      return { routes: [], problem: "网页聊天需要本机中台的来源配置；请先初始化本机中台，并配置一条聊天规则。" };
    let rules;
    try {
      rules = parseRules(
        readFileSync(RULES_FILE, "utf8"),
        Date.now(),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    } catch {
      return { routes: [], problem: "本机规则文件无法读取或无效，请先运行中台 check 修正。" };
    }
    state ??= await call("/v1/state");
    const found: Route[] = [];
    for (const rule of rules.rules) {
      if (
        !eventRule(rule) ||
        rule.when.source !== config.source.name ||
        rule.when.types.length !== 1 ||
        !CHAT_TYPE.test(rule.when.types[0]) ||
        !rule.parallel ||
        rule.resume !== true
      )
        continue;
      const type = rule.when.types[0];
      const matching = rules.rules.filter(
        (r) => eventRule(r) && r.when.source === rule.when.source && typeMatches(r.when.types, type),
      );
      const active = state.lines.filter((r: any) => r.source === rule.when.source && typeMatches(r.types, type));
      if (matching.length !== 1 || active.length !== 1 || active[0].id !== rule.name || active[0].agent !== rule.to)
        continue;
      const agent = rules.agents[rule.to];
      found.push({
        id: rule.name,
        name: rule.name,
        agent: rule.to,
        agentName: agent.name,
        cwd: rule.cwd,
        resume: true,
        source: rule.when.source,
        type,
      });
    }
    return {
      routes: found,
      problem: found.length
        ? null
        : "还没有可用的聊天规则。请在本机运行 workbench:chat，选择已配置的 Agent 和项目目录；有通配符冲突或尚未生效的规则不会启用。",
    };
  }

  function list() {
    if (!existsSync(directory)) return { conversations: [] };
    const conversations = readdirSync(directory)
      .filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)))
      .map((name) => descriptor(load(name.slice(0, -5))));
    return { conversations: conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }

  async function create(body: unknown) {
    const value = object(body, ["id", "rule", "title"]);
    identifier(value.id);
    if (
      typeof value.rule !== "string" ||
      (value.title !== undefined && (typeof value.title !== "string" || [...value.title].length > 100))
    )
      throw new ChatError(400, "请选择聊天规则，标题最多 100 字", true);
    if (existsSync(file(value.id))) {
      const existing = load(value.id);
      if (existing.rule !== value.rule) throw new ChatError(409, "这个对话编号已用于另一条规则");
      return { conversation: descriptor(existing) };
    }
    const available = await routes();
    const route = available.routes.find((item) => item.id === value.rule);
    if (!route) throw new ChatError(400, available.problem ?? "这条规则没有启用网页聊天", true);
    const at = new Date().toISOString();
    const conversation: Conversation = {
      id: value.id,
      title: (value.title as string)?.trim() || "新任务对话",
      rule: route.id,
      agent: route.agent,
      cwd: route.cwd,
      subject: `wb:${value.id}`,
      source: route.source,
      type: route.type,
      createdAt: at,
      updatedAt: at,
      messages: [],
      runs: [],
    };
    save(conversation);
    return { conversation: descriptor(conversation) };
  }

  function localReply(run: Run, facts: any[]): Reply | undefined {
    if (!["done", "nothing"].includes(run.state)) return undefined;
    const allChanges = facts.flatMap((fact) => fact.changes);
    const last = allChanges.filter((change: any) => change.table === "runs" && change.row?.id === run.id).at(-1)?.row;
    const version = facts.find((fact) => fact.seq === last?.rules_version);
    const rules = version?.changes.find((change: any) => change.table === "config" && change.key === "rules")?.row
      ?.value;
    if (!config.worker || rules?.agents?.[last?.agent]?.worker !== config.worker.name) return undefined;
    const path = join(HOME, "worker", "runs", `${run.id}-${run.attempts + 1}`, "reply.json");
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
      const body = JSON.parse(readFileSync(path, "utf8"));
      if (
        body.version !== 1 ||
        body.run !== run.id ||
        body.attempt !== run.attempts + 1 ||
        body.outcome !== run.state ||
        body.session !== run.session ||
        typeof body.text !== "string" ||
        typeof body.truncated !== "boolean"
      )
        return undefined;
      return { text: body.text, truncated: body.truncated, at: String(body.at), outcome: body.outcome };
    } catch {
      return undefined;
    }
  }

  function collect(chat: Conversation, id: number, facts: any[]): Run | undefined {
    const changes = facts.flatMap((fact) => fact.changes);
    const row = changes.filter((change: any) => change.table === "runs" && change.row?.id === id).at(-1)?.row;
    if (!row || row.rule !== chat.rule || row.lane !== chat.subject) return undefined;
    const relations = new Set(
      changes
        .filter((change: any) => change.table === "run_events" && change.row?.run_id === id)
        .map((change: any) => change.row.event_id),
    );
    const events = changes
      .filter((change: any) => change.table === "events" && change.row && relations.has(change.row.id))
      .map((change: any) => change.row);
    const messageIds: string[] = [];
    for (const message of chat.messages) {
      const event = events.find(
        (event: any) => event.source === chat.source && event.key === `wb:${chat.id}:${message.id}`,
      );
      if (!event) continue;
      message.status = "accepted";
      message.eventId = event.id;
      delete message.error;
      messageIds.push(message.id);
    }
    const previous = chat.runs.find((run) => run.id === id);
    const run: Run = {
      id,
      state: row.state,
      summary: row.summary ?? "",
      error: row.error ?? "",
      session: row.session ?? null,
      claimedAt: row.claimed_at,
      finishedAt: row.finished_at,
      notBefore: row.not_before,
      messageIds,
      resumed: null,
      attempts: row.attempts,
      cardIds: [
        ...new Set<number>(
          changes
            .filter((change: any) => change.table === "cards" && change.row?.run_id === id)
            .map((change: any) => change.row.id),
        ),
      ],
      replyStatus: ACTIVE.has(row.state) ? "waiting" : "unavailable",
    };
    const reply = previous?.reply ?? localReply(run, facts);
    if (reply) {
      run.reply = reply;
      run.replyStatus = "available";
    }
    return run;
  }

  function view(id: string) {
    let pending = reading.get(id);
    if (!pending) {
      pending = refresh(id).finally(() => reading.delete(id));
      reading.set(id, pending);
    }
    return pending;
  }

  async function refresh(id: string) {
    const chat = load(id);
    const state = await call("/v1/state");
    const allRuns = new Map<number, any>(state.runs.map((run: any) => [run.id, run]));
    const linked = new Set(chat.runs.flatMap((run) => run.messageIds));
    let page = state;
    let pages = 1;
    const newest = Math.max(chat.checkedThrough ?? 0, ...allRuns.keys());
    const unlinked = chat.messages.some((message) => !linked.has(message.id));
    // Answers and timers can create rounds without a new chat message. Scan every unseen interval, not just messages.
    const needsPage = () =>
      page.hasMore &&
      (unlinked ||
        ((chat.messages.length > 0 || chat.runs.length > 0) && page.nextBefore > (chat.checkedThrough ?? 0)));
    while (needsPage() && pages < 100) {
      page = await call(`/v1/state?before=${page.nextBefore}`);
      for (const run of page.runs) allRuns.set(run.id, run);
      pages++;
    }
    const historyComplete = !needsPage();
    if (historyComplete) chat.checkedThrough = newest;
    const relevant = [...allRuns.values()].filter(
      (run) => run.rule === chat.rule && run.events?.some((event: any) => event.subject === chat.subject),
    );
    const ids = new Set<number>(relevant.map((run) => run.id));
    for (const run of chat.runs)
      if (ACTIVE.has(run.state) || run.id === chat.runs.at(-1)?.id || run.replyStatus === "unavailable")
        ids.add(run.id);
    for (const runId of ids) {
      const facts = await call(`/v1/runs/${runId}/why`);
      const run = collect(chat, runId, facts);
      if (!run) continue;
      const index = chat.runs.findIndex((item) => item.id === runId);
      if (index === -1) chat.runs.push(run);
      else chat.runs[index] = run;
    }
    chat.runs.sort((a, b) => a.id - b.id);
    let previousSession: string | null = null;
    for (const run of chat.runs) {
      run.resumed = run.session ? (previousSession ? run.session === previousSession : false) : null;
      if (run.session) previousSession = run.session;
    }
    const cardIds = new Set(chat.runs.flatMap((run) => run.cardIds));
    const cards = state.cards.filter((card: any) => cardIds.has(card.id));
    const available = await routes(state);
    // A send can finish during the hub reads. Never regress its accepted status or lose a routing warning.
    const latest = load(id);
    for (const message of latest.messages) {
      const index = chat.messages.findIndex((item) => item.id === message.id);
      if (index === -1) chat.messages.push(message);
      else if (message.status === "accepted" || chat.messages[index].status !== "accepted")
        chat.messages[index] = message;
    }
    chat.title = latest.title;
    chat.updatedAt = latest.updatedAt;
    chat.blocked = latest.blocked;
    const route = available.routes.find((item) => sameRoute(chat, item));
    let blockReason =
      chat.blocked ?? (!route ? "聊天规则已变化、未生效或存在匹配冲突，请在本机核对配置后新建对话。" : "");
    if (!blockReason && !historyComplete) blockReason = "历史记录尚未完整核对，暂不发送新消息。";
    if (!blockReason && chat.runs.some((run) => ACTIVE.has(run.state)))
      blockReason = "本轮仍在排队、执行或状态未知，结束后再发送下一条消息。";
    if (!blockReason && cards.some((card: any) => card.kind === "ask" && card.state === "open"))
      blockReason = "有待回答卡片，请先在“待你回答”中明确选择；普通聊天不代替审批。";
    const knownMessages = new Set(chat.runs.flatMap((run) => run.messageIds));
    if (
      !blockReason &&
      chat.messages.some((message) => message.status === "uncertain" || !knownMessages.has(message.id))
    )
      blockReason = "上一条消息尚未核对到运行。若提交结果未知，请用原消息编号重试，不要另发一条。";
    save(chat);
    return {
      conversation: descriptor(chat),
      messages: chat.messages,
      runs: chat.runs,
      cards,
      canSend: !blockReason,
      blockReason,
      historyComplete,
    };
  }

  async function send(id: string, body: unknown) {
    const value = object(body, ["id", "text"]);
    identifier(value.id);
    let chat = load(id);
    const existing = chat.messages.find((message) => message.id === value.id);
    if (typeof value.text !== "string" || !value.text.trim() || [...value.text].length > 4000)
      throw new ChatError(400, "消息要有内容，最多 4000 字", !existing && !inFlight.has(id));
    const words = value.text.trim();
    if (existing && existing.text !== words) throw new ChatError(409, "同一个消息编号不能改成不同内容");
    if (existing?.status === "accepted") return { message: existing };
    if (inFlight.has(id)) throw new ChatError(409, "正在提交这条对话的消息，请稍后刷新确认");
    inFlight.add(id);
    try {
      const snapshot = await view(id);
      chat = load(id);
      const confirmed = chat.messages.find((message) => message.id === value.id);
      if (confirmed?.status === "accepted") return { message: confirmed };
      const available = await routes();
      if (!available.routes.some((route) => sameRoute(chat, route)))
        throw new ChatError(409, "聊天规则已变化或存在匹配冲突，未发送消息", !existing);
      if (!existing && !snapshot.canSend) throw new ChatError(409, snapshot.blockReason, true);
      if (
        existing &&
        (chat.blocked ||
          snapshot.runs.some((run) => ACTIVE.has(run.state)) ||
          snapshot.cards.some((card: any) => card.kind === "ask"))
      )
        throw new ChatError(409, snapshot.blockReason || "请先核对上一轮状态");
      const message: Message = confirmed ?? {
        id: value.id,
        text: words,
        at: new Date().toISOString(),
        status: "uncertain",
      };
      if (!confirmed) chat.messages.push(message);
      message.error = "提交结果待确认";
      chat.updatedAt = message.at;
      if (chat.title === "新任务对话") chat.title = [...words].slice(0, 40).join("");
      save(chat);
      let answer;
      try {
        answer = await call(
          "/v1/events",
          {
            id: `wb:${chat.id}:${message.id}`,
            type: chat.type,
            subject: chat.subject,
            summary: [...words].slice(0, 200).join(""),
            detail: words,
          },
          true,
        );
      } catch (error) {
        const latest = load(id);
        const pending = latest.messages.find((item) => item.id === message.id)!;
        pending.error = "未能确认提交结果。可刷新核对，或使用同一消息编号重试。";
        save(latest);
        throw error;
      }
      const latest = load(id);
      const submitted = latest.messages.find((item) => item.id === message.id)!;
      submitted.status = "accepted";
      submitted.eventId = answer.event;
      delete submitted.error;
      if (!Array.isArray(answer.routed) || answer.routed.length !== 1 || answer.routed[0] !== chat.rule)
        latest.blocked = "中台实际路由与预检不同，请检查规则；已停止这段对话的新消息。";
      save(latest);
      return { message: submitted };
    } finally {
      inFlight.delete(id);
    }
  }

  return { routes, list, create, view, send };
}
