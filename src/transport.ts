// Batches to <url>/api/watch/ingest, and the last one when the process ends.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { service, state, type Entry } from "./state";

const BATCH = { logs: 2_000, requests: 2_000, actions: 500 };
const BATCH_BYTES = 3 * 1024 * 1024;

const meta = () => {
  const memory = process.memoryUsage();
  return {
    service: service(),
    version: state().options.version ?? process.env.npm_package_version,
    node: process.version,
    host: os.hostname(),
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    rss: memory.rss,
    heap: memory.heapUsed,
    load: os.loadavg()[0],
    env: process.env.NODE_ENV,
  };
};

export const flush = async () => {
  const current = state();
  const { url, token } = current.options;
  if (!url || !token || current.sending || Date.now() < current.nextAt) return;

  current.sending = true;
  // Count and size limits per batch (dumps make entries big); the rest goes
  // with the next push.
  let budget = BATCH_BYTES;
  const take = (list: Array<Entry>, max: number) => {
    const out: Array<Entry> = [];
    for (const entry of list) {
      if (out.length >= max) break;
      const size = JSON.stringify(entry).length;
      if (out.length && size > budget) break;
      budget -= size;
      out.push(entry);
    }
    return out;
  };
  const actions = take(current.actions, BATCH.actions);
  const logs = take(current.logs, BATCH.logs);
  const requests = take(current.requests, BATCH.requests);

  try {
    const response = await fetch(`${url}/api/watch/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "pretty-watcher",
      },
      body: JSON.stringify({ meta: meta(), logs, requests, actions }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) {
      // Wrong or rotated token: say it once a minute at most, keep buffering.
      current.nextAt = Date.now() + 60_000;
      if (current.failures++ % 10 === 0) current.original.warn("[watcher] the manager rejected WATCHER_TOKEN");
      return;
    }
    if (response.status === 404) {
      // Something answered, but not the manager - typically localhost inside
      // a container, which is the app itself.
      current.nextAt = Date.now() + 60_000;
      if (current.failures++ % 10 === 0) {
        current.original.warn(
          `[watcher] ${url} is not Pretty Server Manager (404 on /api/watch/ingest).` +
            (/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)
              ? " Inside Docker localhost is the container itself: use http://host.docker.internal:<manager port> or the manager's public address."
              : ""),
        );
      }
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    current.logs.splice(0, logs.length);
    current.requests.splice(0, requests.length);
    current.actions.splice(0, actions.length);
    current.failures = 0;
  } catch (error) {
    // Manager unreachable: back off up to a minute, keep the newest data.
    current.failures += 1;
    current.nextAt = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(current.failures, 5));
    if (current.failures === 3) current.original.warn("[watcher] cannot reach the manager:", (error as Error).message);
  } finally {
    current.sending = false;
  }
};

// The process is going away, so an async fetch would never finish: a child
// Node process sends the last batch while this one waits (3 s at most).
const SEND_SCRIPT = `let d="";process.stdin.on("data",(c)=>(d+=c)).on("end",async()=>{const{url,token,body}=JSON.parse(d);try{await fetch(url+"/api/watch/ingest",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token,"User-Agent":"pretty-watcher"},body,signal:AbortSignal.timeout(2500)})}catch{}})`;

const sendSync = (body: unknown) => {
  const { url, token } = state().options;
  if (!url || !token) return;
  try {
    execFileSync(process.execPath, ["-e", SEND_SCRIPT], {
      input: JSON.stringify({ url, token, body: JSON.stringify(body) }),
      timeout: 3_000,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {}
};

// A signal or exit code 0 is a stop, any other exit code (an uncaught error)
// is a crash.
export const hookExit = () => {
  let signal: NodeJS.Signals | null = null;
  let sent = false;

  const report = (code: number | null) => {
    if (sent) return;
    sent = true;
    const current = state();
    sendSync({
      meta: { ...meta(), exit: { reason: signal || code === 0 ? "stopped" : "crashed", code, signal, at: Date.now() } },
      logs: current.logs.slice(-200),
      requests: current.requests.slice(-200),
      actions: current.actions.slice(-50),
    });
  };

  process.on("exit", (code) => report(code));

  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(name, () => {
      signal = name;
      // Nobody else handles it: keep Node's default and die from the signal
      // ("exit" does not fire then, so report first).
      if (process.listenerCount(name) === 1) {
        report(null);
        process.removeAllListeners(name);
        process.kill(process.pid, name);
      }
    });
  }
};
