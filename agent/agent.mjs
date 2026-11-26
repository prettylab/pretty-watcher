#!/usr/bin/env node
// Pretty Server Manager agent (watchdog).
//
// Lives in <project>/.pretty/agent.mjs and keeps one websocket open to the
// manager: it answers file manager calls, runs deployments (backup, download,
// deploy), scheduled backups (`make backup`, kept on this server or uploaded
// to the manager), make targets started from the panel, and terminals on the
// host or inside the project's containers. Needs Node.js 22+ and nothing else
// (python3 or `script` for terminals).
//
// Source: @prettylab/pretty-watcher (agent/agent.mjs). The manager serves the
// copy from its own node_modules, so agents always match the manager.
//
// Terminals can be switched off on this server: TERMINAL=off in
// .pretty/manager.env (make targets and everything else keep working).
//
//   node .pretty/agent.mjs pair <manager url>          ask the manager to link this project
//   node .pretty/agent.mjs enroll <manager url> <key>  link with an install key (watchdog installer)
//   node .pretty/agent.mjs run                         the daemon (started by the service)
//   node .pretty/agent.mjs service                     (re)install the background service
//   node .pretty/agent.mjs status                      show the link
//   node .pretty/agent.mjs unpair                      unlink: tell the manager, remove the service and .pretty/
//
// Usually run through `npx pretty manager pair|unpair|status` (@prettylab/pretty-watcher).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const AGENT_VERSION = "1.3.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONFIG = path.join(HERE, "manager.env");
const SOCKET_PATH = "/api/agent/socket";
const MAX_READ = 5 * 1024 * 1024;

const color = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", e: "\x1b[31m", r: "\x1b[0m" }
  : { b: "", d: "", g: "", c: "", y: "", e: "", r: "" };

const log = (...args) => console.log(`[agent ${new Date().toISOString()}]`, ...args);
const fail = (message) => {
  console.error(`${color.e}✖${color.r} ${message}`);
  process.exit(1);
};

if (typeof WebSocket === "undefined") fail("Node.js 22 or newer is required (built-in WebSocket).");

// ---------- config (.pretty/manager.env, KEY=VALUE, also read by update.sh)

const readEnvFile = (file) => {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
  return values;
};

const readConfig = () => readEnvFile(CONFIG);

const writeConfig = (values) => {
  fs.mkdirSync(HERE, { recursive: true });
  const merged = { ...readConfig(), ...values };
  const text = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.writeFileSync(CONFIG, `# Pretty Server Manager link - keep private\n${text}\n`, { mode: 0o600 });
};

// Sets KEY=value lines in the app's .env (created from .env.example if missing).
const setAppEnv = (values) => {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file) && fs.existsSync(path.join(ROOT, ".env.example"))) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), file);
  }
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(file, text);
};

// ---------- what this project is

const tryExec = (command, args) => {
  try {
    return execFileSync(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
};

const projectInfo = () => {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch {}
  const release = readEnvFile(path.join(ROOT, ".pretty-release"));
  const git = fs.existsSync(path.join(ROOT, ".git"));
  return {
    name: pkg.name || path.basename(ROOT),
    version: release.RELEASE_VERSION || pkg.version || null,
    releaseId: release.RELEASE_ID ? Number(release.RELEASE_ID) : null,
    repo: git ? tryExec("git", ["remote", "get-url", "origin"]) : null,
    branch: git ? tryExec("git", ["rev-parse", "--abbrev-ref", "HEAD"]) : null,
    git,
    root: ROOT,
    host: os.hostname(),
    node: process.version,
    agentVersion: AGENT_VERSION,
    backup: hasBackupTarget(),
    backupDir: backupDir(),
    backupRun: currentBackup,
    terminal: terminalEnabled(),
    make: fs.existsSync(path.join(ROOT, "Makefile")),
    commandRun: currentCommand?.runId ?? null,
    deployRun: currentDeploy?.deploymentId ?? null,
  };
};

const socketUrl = (base) => `${base.replace(/^http/, "ws").replace(/\/+$/, "")}${SOCKET_PATH}`;

// Keeps .pretty/ out of git without touching the project's .gitignore.
const excludeFromGit = () => {
  const exclude = path.join(ROOT, ".git", "info", "exclude");
  if (!fs.existsSync(path.dirname(exclude))) return;
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!/^\/?\.pretty\/?$/m.test(text)) fs.appendFileSync(exclude, `${text.endsWith("\n") || !text ? "" : "\n"}.pretty/\n.pretty-release\n`);
};

const fetchUpdateScript = async (base) => {
  const response = await fetch(`${base}/pretty/update.sh`);
  if (!response.ok) throw new Error(`Could not download update.sh (HTTP ${response.status})`);
  fs.writeFileSync(path.join(HERE, "update.sh"), await response.text(), { mode: 0o755 });
};

const stackCommand = () => {
  const stack = readEnvFile(path.join(ROOT, "docker", ".env")).STACK || "prod";
  return fs.existsSync(path.join(ROOT, "Makefile")) ? `make ${stack}` : null;
};

// ---------- linking

// The watcher runs inside the app; in a Docker stack "localhost" is the
// container itself, so a manager on this machine is host.docker.internal.
const watcherUrl = (base) => {
  const dockerized = ["docker/compose.yml", "docker-compose.yml", "compose.yml"].some((file) =>
    fs.existsSync(path.join(ROOT, file)),
  );
  return dockerized ? base.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, "//host.docker.internal") : base;
};

const finishLink = async (base, linked) => {
  writeConfig({
    MANAGER_URL: base,
    AGENT_TOKEN: linked.token,
    PROJECT: linked.slug,
    CHANNEL: linked.channel || "release",
  });
  setAppEnv({ WATCHER_URL: watcherUrl(base), WATCHER_TOKEN: linked.watcherToken });
  excludeFromGit();
  await fetchUpdateScript(base);
  installService();
  console.log(`\n  ${color.g}✔${color.r} Linked as ${color.b}${linked.name || linked.slug}${color.r}`);
  const restart = stackCommand();
  if (restart) {
    console.log(`  ${color.d}Restart the app so the watcher starts reporting:${color.r} ${color.c}${restart}${color.r}`);
  }
};

const pair = async (base) => {
  if (!base) fail("Usage: node .pretty/agent.mjs pair <manager url>");
  base = base.replace(/\/+$/, "");
  const info = projectInfo();
  console.log(`\n  ${color.b}Pairing ${info.name}${color.r} ${color.d}(${ROOT})${color.r}`);
  console.log(`  ${color.d}Connecting to ${base}…${color.r}`);

  await new Promise((resolve) => {
    const socket = new WebSocket(socketUrl(base));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "pair", info })));
    socket.addEventListener("error", () => fail(`Cannot connect to ${base}`));
    socket.addEventListener("close", (event) => {
      if (event.code !== 1000) fail(`Connection closed${event.reason ? `: ${event.reason}` : ""}`);
    });
    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "pair.code") {
        console.log(`\n  Pairing code: ${color.b}${color.c}${message.code}${color.r}`);
        console.log(`  Open the manager, check the code matches and approve the request.`);
        console.log(`  ${color.d}Waiting… (Ctrl+C to cancel)${color.r}`);
      } else if (message.type === "paired") {
        await finishLink(base, message);
        socket.close(1000);
        resolve();
      } else if (message.type === "pair.rejected") {
        fail(`The manager rejected the request${message.reason ? `: ${message.reason}` : ""}.`);
      }
    });
  });
};

const enroll = async (base, key) => {
  if (!base || !key) fail("Usage: node .pretty/agent.mjs enroll <manager url> <install key>");
  base = base.replace(/\/+$/, "");
  const response = await fetch(`${base}/api/agent/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, info: projectInfo() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`Enrolling failed: ${body.detail || body.error || response.status}`);
  await finishLink(base, body);
};

// ---------- background service

const installService = () => {
  const node = process.execPath;
  // Containers and tests run the daemon themselves.
  if (process.env.PRETTY_AGENT_NO_SERVICE === "1") {
    console.log(`  ${color.d}Service skipped (PRETTY_AGENT_NO_SERVICE=1) - run: node .pretty/agent.mjs run${color.r}`);
    return;
  }
  const script = path.join(HERE, "agent.mjs");
  const name = serviceName();
  const unit = `[Unit]
Description=Pretty Server Manager agent (${ROOT})
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${ROOT}
ExecStart=${node} ${script} run
Restart=always
RestartSec=10

[Install]
WantedBy=${process.getuid?.() === 0 ? "multi-user.target" : "default.target"}
`;
  const has = (command) => tryExec("sh", ["-c", `command -v ${command}`]);

  try {
    if (has("systemctl") && process.getuid?.() === 0) {
      fs.writeFileSync(`/etc/systemd/system/${name}.service`, unit);
      execFileSync("systemctl", ["daemon-reload"]);
      execFileSync("systemctl", ["enable", "--now", `${name}.service`], { stdio: "ignore" });
      execFileSync("systemctl", ["restart", `${name}.service`], { stdio: "ignore" });
      console.log(`  ${color.g}✔${color.r} Service ${name} (systemd) started`);
      return;
    }
    if (has("systemctl") && tryExec("systemctl", ["--user", "is-system-running"]) !== null) {
      const dir = path.join(os.homedir(), ".config", "systemd", "user");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.service`), unit);
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      execFileSync("systemctl", ["--user", "enable", "--now", `${name}.service`], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "restart", `${name}.service`], { stdio: "ignore" });
      tryExec("loginctl", ["enable-linger", os.userInfo().username]);
      console.log(`  ${color.g}✔${color.r} Service ${name} (systemd --user) started`);
      return;
    }
  } catch (error) {
    console.log(`  ${color.y}!${color.r} systemd failed (${error.message}), using cron instead`);
  }

  // No systemd (macOS, containers): cron at boot plus a detached process now.
  const line = `@reboot cd ${JSON.stringify(ROOT)} && ${node} ${JSON.stringify(script)} run >> ${JSON.stringify(path.join(HERE, "agent.log"))} 2>&1`;
  const current = tryExec("crontab", ["-l"]) ?? "";
  if (has("crontab") && !current.includes(script)) {
    const next = `${current.trim()}\n${line}\n`.trimStart();
    execFileSync("crontab", ["-"], { input: next });
  }
  stopRunning();
  const out = fs.openSync(path.join(HERE, "agent.log"), "a");
  const child = spawn(node, [script, "run"], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] });
  fs.writeFileSync(path.join(HERE, "agent.pid"), String(child.pid));
  child.unref();
  console.log(`  ${color.g}✔${color.r} Agent started in the background (pid ${child.pid}, cron @reboot)`);
};

const serviceName = () => `pretty-agent-${(readConfig().PROJECT || path.basename(ROOT)).replace(/[^\w-]/g, "")}`;

// Undoes installService(): systemd unit (system or user), cron line, process.
const removeService = () => {
  const name = serviceName();
  const script = path.join(HERE, "agent.mjs");
  const systemUnit = `/etc/systemd/system/${name}.service`;
  const userUnit = path.join(os.homedir(), ".config", "systemd", "user", `${name}.service`);

  if (fs.existsSync(systemUnit)) {
    if (process.getuid?.() === 0) {
      tryExec("systemctl", ["disable", "--now", `${name}.service`]);
      fs.rmSync(systemUnit, { force: true });
      tryExec("systemctl", ["daemon-reload"]);
      console.log(`  ${color.g}✔${color.r} Service ${name} (systemd) removed`);
    } else {
      console.log(`  ${color.y}!${color.r} ${systemUnit} needs root to remove:`);
      console.log(`    ${color.c}sudo systemctl disable --now ${name} && sudo rm ${systemUnit} && sudo systemctl daemon-reload${color.r}`);
    }
  }
  if (fs.existsSync(userUnit)) {
    tryExec("systemctl", ["--user", "disable", "--now", `${name}.service`]);
    fs.rmSync(userUnit, { force: true });
    tryExec("systemctl", ["--user", "daemon-reload"]);
    console.log(`  ${color.g}✔${color.r} Service ${name} (systemd --user) removed`);
  }
  const crontab = tryExec("crontab", ["-l"]);
  if (crontab?.includes(script)) {
    const next = crontab.split("\n").filter((line) => !line.includes(script)).join("\n").trim();
    execFileSync("crontab", ["-"], { input: next ? `${next}\n` : "" });
    console.log(`  ${color.g}✔${color.r} Cron @reboot entry removed`);
  }
  stopRunning();
};

// Removes KEY=... lines from the app's .env.
const unsetAppEnv = (keys) => {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const next = text.split(/\r?\n/).filter((line) => !keys.some((key) => line.startsWith(`${key}=`))).join("\n");
  if (next !== text) fs.writeFileSync(file, next);
};

const unpair = async () => {
  const config = readConfig();
  console.log(`\n  ${color.b}Unpairing ${projectInfo().name}${color.r} ${color.d}(${ROOT})${color.r}`);
  if (config.MANAGER_URL && config.AGENT_TOKEN) {
    try {
      const response = await fetch(`${config.MANAGER_URL}/api/agent/unlink`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.AGENT_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || response.status === 401) {
        console.log(`  ${color.g}✔${color.r} The manager dropped the link${response.status === 401 ? " (it was already gone)" : ""}`);
      } else {
        console.log(`  ${color.y}!${color.r} The manager answered HTTP ${response.status}; delete the project in the panel if it stays`);
      }
    } catch (error) {
      console.log(`  ${color.y}!${color.r} Cannot reach ${config.MANAGER_URL} (${error.message}); delete the project in the panel`);
    }
  }
  removeService();
  unsetAppEnv(["WATCHER_URL", "WATCHER_TOKEN"]);
  fs.rmSync(HERE, { recursive: true, force: true });
  console.log(`  ${color.g}✔${color.r} Removed .pretty/ and WATCHER_URL / WATCHER_TOKEN from .env`);
  const restart = stackCommand();
  if (restart) console.log(`  ${color.d}Restart the app so the watcher stops:${color.r} ${color.c}${restart}${color.r}`);
};

const stopRunning = () => {
  try {
    const pid = Number(fs.readFileSync(path.join(HERE, "agent.pid"), "utf8"));
    if (pid) process.kill(pid);
  } catch {}
};

// ---------- files (confined to the project root)

const resolveInRoot = (relative = "") => {
  const clean = String(relative).replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(ROOT, clean);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) throw new Error("Path outside the project");
  if (target === CONFIG) throw new Error("The manager link file is private");
  return target;
};

const files = {
  async list({ path: rel }) {
    const dir = resolveInRoot(rel);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        const stat = await fsp.lstat(full).catch(() => null);
        return {
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file",
          size: stat?.size ?? 0,
          mtime: stat?.mtimeMs ?? 0,
          private: full === CONFIG,
        };
      }),
    );
    return { path: path.relative(ROOT, dir).split(path.sep).join("/"), entries: items };
  },
  async read({ path: rel }) {
    const file = resolveInRoot(rel);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > MAX_READ) throw new Error(`File is larger than ${MAX_READ / 1024 / 1024} MB`);
    return { size: stat.size, mtime: stat.mtimeMs, content: (await fsp.readFile(file)).toString("base64") };
  },
  async write({ path: rel, content }) {
    const file = resolveInRoot(rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from(String(content ?? ""), "base64"));
    return { ok: true };
  },
  async mkdir({ path: rel }) {
    await fsp.mkdir(resolveInRoot(rel), { recursive: true });
    return { ok: true };
  },
  async rename({ from, to }) {
    await fsp.rename(resolveInRoot(from), resolveInRoot(to));
    return { ok: true };
  },
  async delete({ path: rel }) {
    const target = resolveInRoot(rel);
    if (target === ROOT) throw new Error("Refusing to delete the project root");
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true };
  },
};

// ---------- deployments

// One long job at a time: "deploy", "backup" or "make <target>".
let busy = null;
let currentBackup = null;
let currentCommand = null;
// { deploymentId, child, cancelled } while a deployment runs.
let currentDeploy = null;

const hasHook = () => {
  for (const file of ["Makefile", "scripts/make/core.mk"]) {
    try {
      if (fs.readFileSync(path.join(ROOT, file), "utf8").includes(".pretty/update.sh")) return true;
    } catch {}
  }
  return false;
};

const hasBackupTarget = () =>
  ["Makefile", "scripts/make/core.mk"].some((file) => {
    try {
      return /^backup:/m.test(fs.readFileSync(path.join(ROOT, file), "utf8"));
    } catch {
      return false;
    }
  });

const runStreaming = (command, env, onText) =>
  new Promise((resolve) => {
    if (currentDeploy?.cancelled) return resolve(130);
    // Own process group, so a force stop kills docker compose & co. as well.
    const child = spawn("bash", ["-c", command], {
      cwd: ROOT,
      env: { ...process.env, ...env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (currentDeploy) currentDeploy.child = child;
    child.stdout.on("data", (chunk) => onText(chunk.toString()));
    child.stderr.on("data", (chunk) => onText(chunk.toString()));
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      onText(`${error.message}\n`);
      resolve(1);
    });
  });

const deploy = async (connection, message) => {
  const { deploymentId, release } = message;
  const status = (statusValue, step, extra = {}) =>
    connection.emit({ type: "deploy.status", deploymentId, status: statusValue, step, ...extra });

  if (busy) {
    connection.emit({ type: "deploy.log", deploymentId, text: `A ${busy} is running on this server.\n` });
    status("failed", null);
    return;
  }
  busy = "deploy";
  currentDeploy = { deploymentId, child: null, cancelled: false };
  connection.emit({ type: "info", info: projectInfo() });

  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    connection.emit({ type: "deploy.log", deploymentId, text: buffer });
    buffer = "";
  };
  const timer = setInterval(flush, 1_000);
  const onText = (text) => {
    for (const line of text.split(/(?<=\n)/)) {
      const marker = /^::step (\w+)/.exec(line);
      if (marker) status("running", marker[1]);
      else buffer += line;
    }
    if (buffer.length > 64_000) flush();
  };
  const say = (text) => onText(`\n▸ ${text}\n`);

  try {
    status("running", "backup");
    say(`Deploying ${release.name} ${release.version} into ${ROOT}`);

    if (hasBackupTarget()) {
      say("make backup");
      const code = await runStreaming("make --no-print-directory backup", {}, onText);
      if (code !== 0) throw new Error(`make backup failed (exit ${code})`);
    }
    say("Code snapshot");
    const snapshot = `.pretty/backups/${new Date().toISOString().replace(/[:.]/g, "-")}-code.tar.gz`;
    await fsp.mkdir(path.join(HERE, "backups"), { recursive: true });
    const tarCode = await runStreaming(
      `tar -czf ${JSON.stringify(snapshot)} --exclude=./node_modules --exclude=./.next --exclude=./backups --exclude=./.pretty/backups --exclude=./storage --exclude=./docker/mariadb . && ls -1t .pretty/backups/*-code.tar.gz | tail -n +6 | xargs rm -f`,
      {},
      onText,
    );
    if (tarCode !== 0) throw new Error("Code snapshot failed");
    onText(`Saved ${snapshot}\n`);

    const env = { PRETTY_RELEASE: String(release.id), PRETTY_BACKUP_DONE: "1" };
    if (hasHook()) {
      // make update = .pretty/update.sh (download, unpack) + rebuild the stack.
      say("make update");
      const code = await runStreaming("make --no-print-directory update", env, onText);
      if (code !== 0) throw new Error(`make update failed (exit ${code})`);
    } else {
      say("update.sh");
      const code = await runStreaming("bash .pretty/update.sh", env, onText);
      if (code !== 0) throw new Error(`update.sh failed (exit ${code})`);
      const rebuild = stackCommand();
      if (rebuild) {
        status("running", "deploy");
        say(rebuild);
        const rebuildCode = await runStreaming(rebuild, {}, onText);
        if (rebuildCode !== 0) throw new Error(`${rebuild} failed (exit ${rebuildCode})`);
      } else {
        onText("No Makefile: unpacked only, nothing to rebuild.\n");
      }
    }

    say(`Done: ${release.version}`);
    flush();
    status("done", "deploy", { releaseId: release.id });
  } catch (error) {
    say(currentDeploy?.cancelled ? "Stopped from the panel" : `Failed: ${error.message}`);
    flush();
    status("failed", null);
  } finally {
    clearInterval(timer);
    busy = null;
    currentDeploy = null;
    connection.emit({ type: "info", info: projectInfo() });
  }
};

// ---------- backups
//
// Both modes run the project's own `make backup`, which writes
// <BACKUP_DIR>/<YYYY-MM-DD_HH-MM-SS>/ (database dump, env files, storage...).
//   local   - left in BACKUP_DIR from .env, like a crontab entry would; older
//             than keepDays are removed afterwards.
//   manager - made in a temporary BACKUP_DIR, every file uploaded to the
//             manager, then deleted here.

const STAMP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

function backupDir() {
  return path.resolve(ROOT, readEnvFile(path.join(ROOT, ".env")).BACKUP_DIR || "./backups");
}

const listStamps = async (dir) =>
  (await fsp.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && STAMP.test(entry.name))
    .map((entry) => entry.name)
    .sort();

const walkFiles = async (dir, prefix = "") => {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkFiles(full, name)));
    else if (entry.isFile()) out.push({ name, full, size: (await fsp.stat(full)).size });
  }
  return out;
};

const formatSize = (bytes) =>
  bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

// Removes <dir>/<timestamp> folders older than keepDays, never the newest.
const pruneStamps = async (dir, keepDays, keep) => {
  if (!keepDays || keepDays <= 0) return 0;
  const cutoff = Date.now() - keepDays * 86_400_000;
  const stamps = await listStamps(dir);
  let removed = 0;
  for (const name of stamps.slice(0, -1)) {
    if (name === keep) continue;
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
};

const uploadFile = async (runId, file) => {
  const config = readConfig();
  const url = `${config.MANAGER_URL}/api/agent/backups/${runId}/files?name=${encodeURIComponent(file.name)}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.AGENT_TOKEN}`,
      "Content-Type": "application/octet-stream",
      "X-File-Size": String(file.size),
    },
    body: Readable.toWeb(fs.createReadStream(file.full)),
    duplex: "half",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Upload of ${file.name} failed (HTTP ${response.status}${body.detail || body.error ? `: ${body.detail || body.error}` : ""})`);
  }
};

const backup = async (connection, message) => {
  const runId = Number(message.runId);
  const target = message.target === "manager" ? "manager" : "local";
  const keepDays = Number(message.keepDays) || 0;
  const status = (value, extra = {}) => connection.emit({ type: "backup.status", runId, status: value, ...extra });

  if (busy) {
    status("failed", { error: `A ${busy} is already running on this server - try again later.` });
    return;
  }
  if (!hasBackupTarget()) {
    status("failed", { error: "The project's Makefile has no backup: target." });
    return;
  }
  busy = "backup";
  currentBackup = runId;
  connection.emit({ type: "info", info: projectInfo() });

  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    connection.emit({ type: "backup.log", runId, text: buffer });
    buffer = "";
  };
  const timer = setInterval(flush, 1_000);
  const onText = (text) => {
    buffer += text;
    if (buffer.length > 64_000) flush();
  };
  const say = (text) => onText(`\n▸ ${text}\n`);
  const temp = path.join(HERE, "backups", `run-${runId}`);

  try {
    status("running");
    if (target === "local") {
      const dir = backupDir();
      const before = new Set(await listStamps(dir));
      say(`make backup (into ${dir})`);
      const code = await runStreaming("make --no-print-directory backup", {}, onText);
      if (code !== 0) throw new Error(`make backup failed (exit ${code})`);
      const created = (await listStamps(dir)).filter((name) => !before.has(name)).pop();
      if (!created) throw new Error(`make backup finished but no new folder appeared in ${dir}`);
      const folder = path.join(dir, created);
      const files = await walkFiles(folder);
      const size = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files) onText(`  ${file.name}  ${formatSize(file.size)}\n`);
      const removed = await pruneStamps(dir, keepDays, created);
      if (removed) onText(`Removed ${removed} backup(s) older than ${keepDays} days\n`);
      flush();
      status("done", { folder, size, files: files.length });
    } else {
      await fsp.rm(temp, { recursive: true, force: true });
      await fsp.mkdir(temp, { recursive: true });
      say("make backup (temporary copy for the manager)");
      const code = await runStreaming(`make --no-print-directory backup BACKUP_DIR=${JSON.stringify(temp)}`, {}, onText);
      if (code !== 0) throw new Error(`make backup failed (exit ${code})`);
      const created = (await listStamps(temp)).pop();
      if (!created) throw new Error("make backup finished but wrote nothing");
      const files = await walkFiles(path.join(temp, created));
      if (!files.length) throw new Error("make backup wrote an empty folder");
      const size = files.reduce((sum, file) => sum + file.size, 0);
      say(`Uploading ${files.length} file(s), ${formatSize(size)}`);
      for (const file of files) {
        onText(`  ${file.name}  ${formatSize(file.size)}\n`);
        flush();
        await uploadFile(runId, file);
      }
      flush();
      status("done", { size, files: files.length });
    }
  } catch (error) {
    flush();
    status("failed", { error: error.message });
  } finally {
    clearInterval(timer);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    busy = null;
    currentBackup = null;
    connection.emit({ type: "info", info: projectInfo() });
  }
};

// ---------- terminals
//
// One pseudo-terminal per panel tab, relayed over the manager socket:
//   term.open {id, target, cols, rows}  target = "host" or "container:<service>"
//   term.input {id, data} / term.resize {id, cols, rows} / term.close {id}
// answered with term.opened, term.data {id, data (base64)} and term.exit.
// A pty needs a native module in Node, so a tiny python3 helper makes one
// (with resizing); without python3, `script` does it (fixed size).

const MAX_TERMINALS = 8;
const terminals = new Map();

function terminalEnabled() {
  return !/^(0|off|false|no)$/i.test(readConfig().TERMINAL || "");
}

const has = (command) => !!tryExec("sh", ["-c", `command -v ${command}`]);

// Reads one byte stream from the pty to stdout, stdin to the pty, and
// "<rows> <cols>\n" lines from fd 3 into the window size.
const PTY_HELPER = `
import os, pty, sys, select, struct, fcntl, termios
rows, cols = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
def size(r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
def write_all(target, data):
    while data:
        data = data[os.write(target, data):]
size(rows, cols)
watch = [fd, 0, 3]
pending = b""
while True:
    try:
        ready = select.select(watch, [], [])[0]
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            write_all(fd, data)
        else:
            watch.remove(0)
            os.kill(pid, 1)
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            watch.remove(3)
        pending += data
        while b"\\n" in pending:
            line, pending = pending.split(b"\\n", 1)
            try:
                r, c = (int(value) for value in line.split())
                size(r, c)
            except ValueError:
                pass
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`;

// The project's `docker compose ...` (with -p, -f and env files): the
// Makefile's COMPOSE variable when it has one, else a plain compose file.
const composeCommand = () => {
  if (fs.existsSync(path.join(ROOT, "Makefile"))) {
    try {
      const out = execFileSync("make", ["--no-print-directory", "-s", "-f", "Makefile", "-f", "-", "__pretty_compose"], {
        cwd: ROOT,
        input: "__pretty_compose:\n\t@echo '$(COMPOSE)'\n",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 10_000,
      })
        .toString()
        .trim();
      if (/docker[ -]compose/.test(out)) return out;
    } catch {}
  }
  const file = ["docker/compose.yml", "docker-compose.yml", "compose.yml", "compose.yaml", "docker-compose.yaml"].find((name) =>
    fs.existsSync(path.join(ROOT, name)),
  );
  return file ? `docker compose -f ${JSON.stringify(file)}` : null;
};

const containers = (compose) => {
  if (!compose) return [];
  try {
    const out = execFileSync("sh", ["-c", `${compose} ps --all --format json`], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    })
      .toString()
      .trim();
    // Newer compose prints one object per line, older ones an array.
    const rows = out.startsWith("[") ? JSON.parse(out) : out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const seen = new Map();
    for (const row of rows) {
      const service = row.Service || row.Name;
      if (!service || seen.has(service)) continue;
      seen.set(service, { service, name: row.Name || service, state: String(row.State || "").toLowerCase(), status: row.Status || "" });
    }
    return [...seen.values()].sort((a, b) => a.service.localeCompare(b.service));
  } catch {
    return [];
  }
};

const terminalTargets = () => {
  const compose = composeCommand();
  return {
    enabled: terminalEnabled(),
    pty: has("python3") ? "python3" : has("script") ? "script" : null,
    host: os.hostname(),
    user: os.userInfo().username,
    root: ROOT,
    docker: !!compose,
    containers: containers(compose),
  };
};

const shellFor = (target) => {
  if (target === "host") {
    const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : has("bash") ? "bash" : "sh";
    return [shell, "-l"];
  }
  const service = /^container:([\w.-]{1,64})$/.exec(String(target))?.[1];
  if (!service) throw new Error("Unknown terminal target");
  const compose = composeCommand();
  if (!compose) throw new Error("No docker compose stack in this project");
  return ["sh", "-c", `${compose} exec ${service} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'`];
};

const clampSize = (value, fallback, max) => Math.max(2, Math.min(max, Math.round(Number(value)) || fallback));

const openTerminal = (send, message) => {
  const id = String(message.id || "").slice(0, 64);
  const exit = (code, error) => send({ type: "term.exit", id, code, error });
  if (!id || terminals.has(id)) return;
  if (!terminalEnabled()) return exit(null, "Terminals are switched off on this server (TERMINAL=off in .pretty/manager.env).");
  if (terminals.size >= MAX_TERMINALS) return exit(null, `Already ${MAX_TERMINALS} terminals open on this server.`);

  let argv;
  try {
    argv = shellFor(message.target);
  } catch (error) {
    return exit(null, error.message);
  }
  const rows = clampSize(message.rows, 24, 500);
  const cols = clampSize(message.cols, 80, 1000);
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "C.UTF-8" };
  delete env.CI;

  let child;
  let resizable = false;
  if (has("python3")) {
    child = spawn("python3", ["-c", PTY_HELPER, String(rows), String(cols), ...argv], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    resizable = true;
  } else if (has("script")) {
    const quoted = argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${quoted}`;
    const args = os.platform() === "darwin" ? ["-q", "/dev/null", "sh", "-c", inner] : ["-qfec", inner, "/dev/null"];
    child = spawn("script", args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    return exit(null, "This server has neither python3 nor script(1) - install python3 to use terminals.");
  }

  const session = { child, resizable };
  terminals.set(id, session);
  const forward = (chunk) => send({ type: "term.data", id, data: chunk.toString("base64") });
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("error", (error) => {
    terminals.delete(id);
    exit(null, error.message);
  });
  child.on("close", (code) => {
    if (!terminals.has(id)) return;
    terminals.delete(id);
    exit(code ?? null);
  });
  log(`terminal ${id} opened (${message.target})`);
  send({ type: "term.opened", id, resizable });
};

const terminalMessage = (message) => {
  const session = terminals.get(String(message.id));
  if (!session) return;
  if (message.type === "term.input") {
    session.child.stdin.write(String(message.data ?? ""));
  } else if (message.type === "term.resize" && session.resizable) {
    session.child.stdio[3]?.write(`${clampSize(message.rows, 24, 500)} ${clampSize(message.cols, 80, 1000)}\n`);
  } else if (message.type === "term.close") {
    terminals.delete(String(message.id));
    session.child.kill("SIGTERM");
    setTimeout(() => session.child.kill("SIGKILL"), 5_000).unref();
  }
};

// The panel side of every terminal is gone with the socket.
const closeTerminals = () => {
  for (const [id, session] of terminals) {
    terminals.delete(id);
    session.child.kill("SIGTERM");
  }
};

// ---------- make targets
//
// The panel lists the targets of the root Makefile (grouped by the "# SECTION"
// comment above them) and runs one at a time, like a deployment:
//   make {runId, target, args: ["NAME=value"]}  ->  make.log / make.status

// Makefile helpers, not something to click.
const HIDDEN_TARGETS = new Set(["stack", "envs", "help"]);

const makeTargets = () => {
  let text = "";
  try {
    text = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  let group = null;
  let comment = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^#\s*([A-Z][A-Z0-9 &/_-]{1,40})\s*$/.exec(line);
    if (header) {
      group = header[1].trim();
      comment = null;
      continue;
    }
    const note = /^#\s*(.+)$/.exec(line);
    if (note) {
      comment = note[1].trim();
      continue;
    }
    const target = /^([A-Za-z0-9][\w.-]*)\s*:(?![=:])([^#]*)(?:##\s*(.*))?$/.exec(line);
    if (target && !line.startsWith("\t")) {
      const name = target[1];
      if (!seen.has(name) && !HIDDEN_TARGETS.has(name) && !name.includes("%")) {
        seen.add(name);
        out.push({ name, group: group || "OTHER", description: target[3]?.trim() || comment || null });
      }
    }
    if (!line.startsWith("\t")) comment = note ? comment : null;
  }
  return out;
};

const ARG = /^[A-Za-z_][A-Za-z0-9_]{0,63}=[^\n\r]{0,500}$/;

const runMake = async (connection, message) => {
  const runId = Number(message.runId);
  const target = String(message.target || "");
  const args = Array.isArray(message.args) ? message.args.map(String) : [];
  const status = (value, extra = {}) => connection.emit({ type: "make.status", runId, status: value, ...extra });

  if (busy) return status("failed", { error: `A ${busy} is already running on this server - try again later.` });
  if (!makeTargets().some((entry) => entry.name === target)) return status("failed", { error: `The Makefile has no ${target} target.` });
  const bad = args.find((arg) => !ARG.test(arg));
  if (bad) return status("failed", { error: `Not a NAME=value argument: ${bad}` });

  busy = `make ${target}`;
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    connection.emit({ type: "make.log", runId, text: buffer });
    buffer = "";
  };
  const timer = setInterval(flush, 1_000);
  const onText = (text) => {
    buffer += text;
    if (buffer.length > 64_000) flush();
  };

  try {
    status("running");
    onText(`▸ make ${[target, ...args].join(" ")}\n`);
    // Own process group, so a cancel stops docker compose & co. as well.
    const child = spawn("make", ["--no-print-directory", target, ...args], {
      cwd: ROOT,
      env: { ...process.env, CI: "1", FORCE_COLOR: "1", TERM: "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    currentCommand = { runId, child, cancelled: false };
    connection.emit({ type: "info", info: projectInfo() });
    child.stdout.on("data", (chunk) => onText(chunk.toString()));
    child.stderr.on("data", (chunk) => onText(chunk.toString()));
    const code = await new Promise((resolve) => {
      child.on("close", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
      child.on("error", (error) => {
        onText(`${error.message}\n`);
        resolve(127);
      });
    });
    const cancelled = currentCommand?.cancelled;
    onText(cancelled ? "\n▸ Cancelled\n" : `\n▸ Exit code ${code}\n`);
    flush();
    status(code === 0 && !cancelled ? "done" : "failed", { code, error: cancelled ? "Cancelled from the panel" : null });
  } catch (error) {
    flush();
    status("failed", { error: error.message });
  } finally {
    clearInterval(timer);
    busy = null;
    currentCommand = null;
    connection.emit({ type: "info", info: projectInfo() });
  }
};

const cancelMake = (message) => {
  if (!currentCommand || currentCommand.runId !== Number(message.runId)) return;
  currentCommand.cancelled = true;
  const { child } = currentCommand;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 10_000).unref();
};

// Force stop from the panel: kill the step that runs (its process group).
const cancelDeploy = (message) => {
  if (!currentDeploy || currentDeploy.deploymentId !== Number(message.deploymentId)) return;
  currentDeploy.cancelled = true;
  const { child } = currentDeploy;
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 10_000).unref();
};

// ---------- daemon

const run = () => {
  const config = readConfig();
  if (!config.MANAGER_URL || !config.AGENT_TOKEN) fail("Not linked yet: run `npx pretty manager pair` first.");

  // Messages that must not get lost (deploy logs) wait here while offline.
  const outbox = [];
  let socket = null;
  let delay = 1_000;

  const connection = {
    emit(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      else if (message.type !== "info") outbox.push(message);
    },
  };
  // Terminal traffic is only worth anything live: never queued.
  const live = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const connect = () => {
    socket = new WebSocket(socketUrl(config.MANAGER_URL));
    // A manager that is restarting can accept the TCP connection and never
    // answer; without this the agent would wait in CONNECTING forever.
    // Node's WebSocket does not always fire "close" after a failed connect
    // (close() while CONNECTING only fires "error"), so close, error and the
    // timeout all lead here and only the first one schedules a reconnect.
    const current = socket;
    let retried = false;
    const retry = () => {
      clearTimeout(connectTimer);
      if (retried) return;
      retried = true;
      try {
        if (current.readyState !== WebSocket.CLOSED) current.close();
      } catch {}
      log(`disconnected, retrying in ${Math.round(delay / 1000)} s`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    const connectTimer = setTimeout(() => {
      if (current.readyState === WebSocket.CONNECTING) retry();
    }, 15_000);

    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      delay = 1_000;
      socket.send(JSON.stringify({ type: "hello", token: config.AGENT_TOKEN, info: projectInfo() }));
    });

    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "welcome") {
        log(`connected to ${config.MANAGER_URL} as ${message.slug}`);
        while (outbox.length) socket.send(JSON.stringify(outbox.shift()));
      } else if (message.type === "unauthorized") {
        log("the manager does not know this token anymore - run `npx pretty manager pair` again");
        process.exit(2);
      } else if (message.type === "rpc") {
        const [group, name] = String(message.method).split(".");
        try {
          let result;
          if (group === "fs" && files[name]) result = await files[name](message.params ?? {});
          else if (message.method === "term.targets") result = terminalTargets();
          else if (message.method === "make.targets") result = { targets: makeTargets() };
          else throw new Error(`Unknown method ${message.method}`);
          connection.emit({ type: "rpc.result", id: message.id, ok: true, result });
        } catch (error) {
          connection.emit({ type: "rpc.result", id: message.id, ok: false, error: error.message });
        }
      } else if (message.type === "deploy") {
        void deploy(connection, message);
      } else if (message.type === "backup") {
        void backup(connection, message);
      } else if (message.type === "make") {
        void runMake(connection, message);
      } else if (message.type === "make.cancel") {
        cancelMake(message);
      } else if (message.type === "deploy.cancel") {
        cancelDeploy(message);
      } else if (message.type === "term.open") {
        openTerminal(live, message);
      } else if (message.type?.startsWith("term.")) {
        terminalMessage(message);
      }
    });

    socket.addEventListener("close", () => {
      closeTerminals();
      retry();
    });
    socket.addEventListener("error", () => {
      closeTerminals();
      retry();
    });
  };

  connect();
  setInterval(() => connection.emit({ type: "info", info: projectInfo() }), 60_000);
};

// ---------- entry

const [command, ...args] = process.argv.slice(2);

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });

switch (command) {
  case "pair":
    await pair(args[0] || readConfig().MANAGER_URL || (await ask("Server manager URL: ")));
    break;
  case "enroll":
    await enroll(args[0], args[1]);
    break;
  case "run":
    run();
    break;
  case "service":
    installService();
    break;
  case "unpair":
    await unpair();
    break;
  case "status": {
    const config = readConfig();
    console.log(config.AGENT_TOKEN ? `Linked to ${config.MANAGER_URL} as ${config.PROJECT}` : "Not linked");
    break;
  }
  default:
    console.log("Usage: node .pretty/agent.mjs pair|enroll|run|service|status|unpair");
}
