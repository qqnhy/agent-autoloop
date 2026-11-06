// A separate client: the hub stays headless. Credentials stay in this loopback process.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readConfig, type Config } from "../../host/config.ts";
import { createChatService, ChatError } from "./chat.ts";

const ASSETS: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const MAX_BODY = 16 * 1024;
const ID = /^[1-9][0-9]*$/;

class ClientError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const json = (res: ServerResponse, status: number, value: unknown) =>
  res.writeHead(status, { ...HEADERS, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(value));

async function jsonBody(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new ClientError(415, "回答要使用 JSON 格式");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY) throw new ClientError(413, "回答内容太长");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ClientError(413, "回答内容太长");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ClientError(400, "回答不是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientError(400, "回答格式不正确");
  return value as Record<string, unknown>;
}

function apiPath(url: URL, method: string) {
  if (method === "GET" && url.pathname === "/api/state") {
    const keys = [...url.searchParams.keys()];
    const before = url.searchParams.get("before");
    if (keys.some((key) => key !== "before") || keys.length > 1 || (before !== null && !ID.test(before))) {
      throw new ClientError(400, "分页参数不正确");
    }
    return `/v1/state${before ? `?before=${before}` : ""}`;
  }
  if (!url.search) {
    if (method === "GET" && /^\/api\/runs\/[1-9][0-9]*\/why$/.test(url.pathname)) {
      return url.pathname.replace("/api/", "/v1/");
    }
    if (method === "POST" && /^\/api\/cards\/[1-9][0-9]*\/answer$/.test(url.pathname)) {
      return url.pathname.replace("/api/", "/v1/");
    }
  }
  throw new ClientError(404, "没有这个接口");
}

export function startWorkbench(config: Config, port = 4318) {
  if (!config.owner) throw new Error("这台电脑没有本人的密钥。请在已安装并初始化中台的本人电脑上启动工作台。");
  const hub = new URL(config.url);
  if (!["http:", "https:"].includes(hub.protocol) || hub.username || hub.password || hub.search || hub.hash) {
    throw new Error("config.json 中的中台地址不正确");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口要在 1 到 65535 之间");
  const assets = new Map(
    Object.entries(ASSETS).map(([path, [file, type]]) => [
      path,
      { content: readFileSync(join(import.meta.dirname, "public", file)), type },
    ]),
  );
  const hubCall = async (path: string, body?: unknown, source = false) => {
    const key = source ? config.source?.key : config.owner;
    if (!key) throw new ClientError(400, "缺少消息来源配置");
    let response: Response;
    let data: any;
    try {
      response = await fetch(hub.href.replace(/\/$/, "") + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      data = await response.json();
    } catch {
      throw new ClientError(502, "未能确认中台响应，请刷新核对提交结果后再操作。");
    }
    if (!response.ok) throw new ClientError(response.status, data?.error ?? "中台请求失败");
    return data;
  };
  const chats = createChatService(config, hubCall);
  const server = createServer(async (req, res) => {
    try {
      const authority = `127.0.0.1:${req.socket.localPort}`;
      const origin = `http://${authority}`;
      // Loopback binding alone does not prevent DNS rebinding or a third-party web page from using the owner's key.
      if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin)) {
        throw new ClientError(403, "只接受工作台自身的本机请求");
      }
      const url = new URL(req.url ?? "/", origin);
      const asset = assets.get(url.pathname);
      if (req.method === "GET" && asset && !url.search) {
        res.writeHead(200, { ...HEADERS, "content-type": asset.type }).end(asset.content);
        return;
      }
      const path = url.pathname.startsWith("/api/chat/") ? null : apiPath(url, req.method ?? "GET");
      if (req.headers["x-workbench"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") {
        throw new ClientError(403, "请从本机工作台打开此操作");
      }
      if (url.pathname.startsWith("/api/chat/")) {
        if (url.search) throw new ClientError(400, "聊天请求不接受查询参数");
        const body = req.method === "POST" ? await jsonBody(req) : undefined;
        const match = /^\/api\/chat\/conversations\/([0-9a-f-]+)(\/messages)?$/.exec(url.pathname);
        let result;
        if (req.method === "GET" && url.pathname === "/api/chat/routes") result = await chats.routes();
        else if (req.method === "GET" && url.pathname === "/api/chat/conversations") result = chats.list();
        else if (req.method === "POST" && url.pathname === "/api/chat/conversations") result = await chats.create(body);
        else if (req.method === "GET" && match && !match[2]) result = await chats.view(match[1]);
        else if (req.method === "POST" && match?.[2]) result = await chats.send(match[1], body);
        else throw new ClientError(404, "没有这个聊天接口");
        json(res, 200, result);
        return;
      }
      const parsed = req.method === "POST" ? await jsonBody(req) : undefined;
      if (parsed && Object.keys(parsed).some((key) => !["choice", "text"].includes(key)))
        throw new ClientError(400, "回答只接受选项和补充文字");
      const body = parsed ? JSON.stringify(parsed) : undefined;
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      let response: Response;
      let data: unknown;
      try {
        response = await fetch(hub.href.replace(/\/$/, "") + path, {
          method: req.method,
          headers: { authorization: `Bearer ${config.owner}`, "content-type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.any([gone.signal, AbortSignal.timeout(10000)]),
        });
        data = await response.json();
      } catch {
        throw new ClientError(
          502,
          "未能确认中台响应。请检查中台是否运行；如果刚提交了回答，刷新确认卡片状态后再操作。",
        );
      }
      json(res, response.status, data);
    } catch (error) {
      if (res.destroyed) return;
      if (!req.complete) res.setHeader("connection", "close");
      json(res, error instanceof ClientError || error instanceof ChatError ? error.status : 500, {
        ...(error instanceof ChatError && error.notSubmitted ? { notSubmitted: true } : {}),
        error:
          error instanceof ClientError || error instanceof ChatError ? error.message : "工作台暂时无法处理这个请求",
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(port, "127.0.0.1");
  return server;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log(
        "用法：npm run workbench -- [--port 4318]\n读取现有 AGENT_AUTOLOOP_HOME/config.json，仅监听 127.0.0.1。",
      );
    } else {
      if (args.length && (args.length !== 2 || args[0] !== "--port" || !ID.test(args[1]))) {
        throw new Error("用法：npm run workbench -- [--port 4318]");
      }
      const server = startWorkbench(readConfig(), args.length ? Number(args[1]) : 4318);
      server.on("listening", () => {
        const address = server.address();
        if (address && typeof address === "object") console.log(`工作台：http://127.0.0.1:${address.port}`);
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.error(error.code === "EADDRINUSE" ? "端口被占用了，请用 --port 换一个端口" : "工作台启动失败");
        process.exitCode = 1;
      });
      const stop = () => {
        server.closeAllConnections();
        server.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "工作台启动失败");
    process.exitCode = 1;
  }
}
