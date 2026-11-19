#!/usr/bin/env node
// `pretty manager` - links the project in the current folder to Pretty Server
// Manager. The work is done by the agent (.pretty/agent.mjs). Its source is
// agent/agent.mjs in this package, but it is always downloaded from the
// manager, which serves the copy of the package version it runs.
//
//   npx pretty manager pair [manager url]   ask the manager to link this project
//   npx pretty manager unpair               unlink it and remove the agent
//   npx pretty manager status               show the link
//
// Any other `pretty ...` command goes to @prettylab/cli when it is installed:
// both packages provide the `pretty` command.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

const ROOT = process.cwd();
const HERE = path.join(ROOT, ".pretty");
const AGENT = path.join(HERE, "agent.mjs");

const color = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", c: "\x1b[36m", e: "\x1b[31m", r: "\x1b[0m" }
  : { b: "", d: "", c: "", e: "", r: "" };

const fail = (message: string): never => {
  console.error(`${color.e}✖${color.r} ${message}`);
  process.exit(1);
};

const readEnv = (file: string) => {
  const values: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
  return values;
};

const linkedUrl = () => readEnv(path.join(HERE, "manager.env")).MANAGER_URL;

const ask = (question: string) =>
  new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const download = async (base: string) => {
  let response: Response;
  try {
    response = await fetch(`${base}/pretty/agent.mjs`, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    return fail(`Cannot reach ${base}: ${(error as Error).message}`);
  }
  if (!response.ok) fail(`${base} is not Pretty Server Manager (HTTP ${response.status} on /pretty/agent.mjs)`);
  fs.mkdirSync(HERE, { recursive: true });
  fs.writeFileSync(AGENT, await response.text());
};

const agent = (...args: Array<string>) => {
  const result = spawnSync(process.execPath, [AGENT, ...args], { cwd: ROOT, stdio: "inherit" });
  process.exit(result.status ?? 1);
};

const requireNode22 = () => {
  if (Number(process.versions.node.split(".")[0]) < 22) fail(`Node.js 22 or newer is required (this is ${process.version})`);
};

// Hands the command to @prettylab/cli (from the project, else global).
const forward = (argv: Array<string>): never => {
  let script: string | null = null;
  for (const base of [path.join(ROOT, "package.json"), import.meta.url]) {
    try {
      const require = createRequire(base);
      const manifest = require.resolve("@prettylab/cli/package.json");
      const bin = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> }).bin;
      const file = typeof bin === "string" ? bin : bin?.pretty;
      if (file) script = path.resolve(path.dirname(manifest), file);
      break;
    } catch {}
  }
  if (!script) {
    const result = spawnSync("npx", ["--yes", "--package=@prettylab/cli", "pretty", ...argv], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  const result = spawnSync(process.execPath, [script, ...argv], { stdio: "inherit" });
  process.exit(result.status ?? 1);
};

const [group, command, ...args] = process.argv.slice(2);
if (group !== "manager") forward(process.argv.slice(2));

switch (command) {
  case "pair": {
    requireNode22();
    let base =
      args[0] ||
      process.env.SERVER_MANAGER_URL ||
      readEnv(path.join(ROOT, ".env")).SERVER_MANAGER_URL ||
      linkedUrl() ||
      (await ask("Server manager URL: "));
    base = base.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) fail("Give the manager address, e.g. https://manager.example.com");
    await download(base);
    agent("pair", base);
    break;
  }
  case "unpair": {
    if (!fs.existsSync(AGENT)) fail("This project is not linked (no .pretty/agent.mjs here)");
    requireNode22();
    // A fresh agent knows how to unpair; an old copy may not.
    const base = linkedUrl();
    if (base) {
      try {
        const response = await fetch(`${base}/pretty/agent.mjs`, { signal: AbortSignal.timeout(10_000) });
        if (response.ok) fs.writeFileSync(AGENT, await response.text());
      } catch {}
    }
    agent("unpair");
    break;
  }
  case "status":
    if (!fs.existsSync(AGENT)) {
      console.log("Not linked");
      break;
    }
    agent("status");
    break;
  default:
    console.log(`Usage:
  ${color.c}npx pretty manager pair${color.r} ${color.d}[manager url]${color.r}   link this project (approve the code in the manager)
  ${color.c}npx pretty manager unpair${color.r}               unlink it, remove the agent and its service
  ${color.c}npx pretty manager status${color.r}               show the link`);
    if (command && command !== "help" && command !== "--help") process.exit(1);
}
