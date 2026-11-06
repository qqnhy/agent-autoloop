// Prevent chat setup from replacing trusted configuration, leaking credentials, or creating fan-out routes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setupChat } from "../clients/workbench/setup-chat.ts";

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "workbench-setup-"));
  const cwd = path.join(home, "project");
  mkdirSync(cwd);
  const configFile = path.join(home, "config.json");
  const rulesFile = path.join(home, "rules.json");
  const config = { url: "http://127.0.0.1:3350", source: { name: "local", key: "SECRET_SOURCE_KEY" } };
  const rules = {
    sources: { local: { name: "本机" } },
    agents: { coder: { name: "编程", worker: "local", use: "codex" } },
    rules: [{ name: "旧规则", when: { source: "local", types: ["old.*"] }, to: "coder", cwd, prompt: "保留" }],
  };
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(rulesFile, JSON.stringify(rules));
  return {
    home,
    cwd,
    config,
    rules,
    configFile,
    rulesFile,
    clean: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("chat setup adds one exact opt-in rule, backs up original bytes, preserves defaults and never copies credentials", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.rulesFile, "utf8");
    const result = setupChat({ name: "项目对话", agent: "coder", cwd: f.cwd }, f);
    const saved = JSON.parse(readFileSync(f.rulesFile, "utf8"));
    assert.deepEqual(saved.sources, f.rules.sources);
    assert.deepEqual(saved.agents, f.rules.agents);
    assert.deepEqual(saved.rules[0], f.rules.rules[0]);
    assert.equal(saved.timezone, undefined);
    assert.equal(saved.rules.length, 2);
    const rule = saved.rules[1];
    assert.deepEqual(rule.when, { source: "local", types: [result.type] });
    assert.match(result.type, /^workbench\.chat\.[a-f0-9]{16}$/);
    assert.equal(rule.to, "coder");
    assert.equal(rule.cwd, f.cwd);
    assert.equal(rule.parallel, 1);
    assert.equal(rule.resume, true);
    assert.match(rule.prompt, /events\[\]\.detail/);
    assert.equal(readFileSync(result.backup, "utf8"), before);
    assert.equal(readFileSync(f.configFile, "utf8"), JSON.stringify(f.config));
    assert.ok(!JSON.stringify({ saved, result }).includes("SECRET_SOURCE_KEY"));
    assert.throws(() => setupChat({ name: "项目对话", agent: "coder", cwd: f.cwd }, f), /重名|已存在/);
    assert.equal(JSON.parse(readFileSync(f.rulesFile, "utf8")).rules.length, 2);
  } finally {
    f.clean();
  }
});

test("setup refuses missing source, agent, directory, relative paths and unsafe names without writing", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.rulesFile, "utf8");
    const base = { name: "项目对话", agent: "coder", cwd: f.cwd };
    for (const change of [
      { agent: "absent" },
      { cwd: path.join(f.home, "absent") },
      { cwd: "." },
      { name: " " },
      { name: "x".repeat(101) },
    ]) {
      assert.throws(() => setupChat({ ...base, ...change }, f));
    }
    for (const source of [undefined, { name: "absent", key: "SECRET_SOURCE_KEY" }, { name: "local", key: "" }]) {
      writeFileSync(f.configFile, JSON.stringify({ ...f.config, source }));
      assert.throws(() => setupChat(base, f));
    }
    assert.equal(readFileSync(f.rulesFile, "utf8"), before);
    assert.deepEqual(readdirSync(f.home).sort(), ["config.json", "project", "rules.json"]);
  } finally {
    f.clean();
  }
});

test("setup refuses wildcard fan-out before changing rules", () => {
  const f = fixture();
  try {
    for (const pattern of ["*", "workbench.*", "workbench.chat.*"]) {
      f.rules.rules[0].when.types = [pattern];
      writeFileSync(f.rulesFile, JSON.stringify(f.rules));
      assert.throws(() => setupChat({ name: "项目对话", agent: "coder", cwd: f.cwd }, f), /匹配/);
      assert.equal(readFileSync(f.rulesFile, "utf8"), JSON.stringify(f.rules));
    }
  } finally {
    f.clean();
  }
});

test("CLI help needs no initialization and output never includes source credentials", () => {
  const f = fixture();
  try {
    const cli = path.resolve("clients/workbench/setup-chat.ts");
    const run = (args: string[], home = f.home) =>
      spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: path.join(home, "rules.json") },
        encoding: "utf8",
      });
    assert.equal(run(["--help"], path.join(f.home, "uninitialized")).status, 0);
    const result = run(["--name", "项目对话", "--agent", "coder", "--cwd", f.cwd]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /项目对话/);
    assert.match(result.stdout, /coder/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("SECRET_SOURCE_KEY"));
  } finally {
    f.clean();
  }
});
