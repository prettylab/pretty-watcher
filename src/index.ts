// @prettylab/pretty-watcher - logs, HTTP traffic and user actions from a Node app,
// pushed to Pretty Server Manager.
//
// Call startWatcher() once per process (Next instrumentation.ts register(),
// a custom server.ts, a worker...). It needs nothing but Node: it hooks every
// http.Server in the process and the console, and pushes batches to
// <WATCHER_URL>/api/watch/ingest every few seconds with WATCHER_TOKEN.
// Without both it does nothing, and watch() / trackAction() are no-ops.
import { trackAction, watch, watchActor } from "./actions";
import { hookConsole } from "./console";
import { hookHttp } from "./http";
import { autoLabel, compile } from "./labels";
import { state } from "./state";
import { flush, hookExit } from "./transport";
import type { WatcherOptions } from "./types";

export const startWatcher = (options: WatcherOptions = {}) => {
  const current = state();
  const url = (options.url ?? process.env.WATCHER_URL ?? "").replace(/\/+$/, "");
  const token = options.token ?? process.env.WATCHER_TOKEN ?? "";

  current.options = { ...options, url, token };
  current.rules = (options.rules ?? []).map(compile);

  if (!url || !token || current.started) return;
  current.started = true;

  hookConsole(() => void flush());
  hookHttp();
  hookExit();

  const timer = setInterval(() => void flush(), options.intervalMs ?? 3_000);
  timer.unref();
  void flush();
};

// Sends what is queued now (tests, a worker about to finish its job).
export const flushWatcher = () => flush();

export { autoLabel, trackAction, watch, watchActor };
export type {
  ActionInfo,
  ActorResolver,
  Describe,
  DescribeContext,
  RequestDump,
  WatcherOptions,
  WatcherRule,
} from "./types";
