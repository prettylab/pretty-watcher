import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionInfo, WatcherOptions, WatcherRule } from "./types";

export type Entry = Record<string, unknown>;

// One per incoming request, reachable from anything that runs while the app
// handles it (route handlers, Server Actions, services...).
export type RequestContext = {
  info?: ActionInfo;
  // From watchActor(): used if the request turns out to be an action.
  actor?: string;
  // Set once the response is finished: later watch() calls stand alone.
  done?: boolean;
};

export type CompiledRule = { rule: WatcherRule; regex: RegExp; methods: Array<string> };

type Console4 = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;

export type State = {
  started: boolean;
  options: WatcherOptions;
  rules: Array<CompiledRule>;
  context: AsyncLocalStorage<RequestContext>;
  logs: Array<Entry>;
  requests: Array<Entry>;
  actions: Array<Entry>;
  actorCache: Map<string, { value: string | null; at: number }>;
  failures: number;
  nextAt: number;
  sending: boolean;
  dumpWarned?: boolean;
  original: Console4;
};

export const MAX = { logs: 5_000, requests: 5_000, actions: 1_000 };

// Kept on globalThis: bundlers (Next) may load this package more than once
// per process, and every copy must share the queues and the request context.
const store = globalThis as unknown as { __prettyWatcher?: State };

export const state = (): State =>
  (store.__prettyWatcher ??= {
    started: false,
    options: {},
    rules: [],
    context: new AsyncLocalStorage<RequestContext>(),
    logs: [],
    requests: [],
    actions: [],
    actorCache: new Map(),
    failures: 0,
    nextAt: 0,
    sending: false,
    original: {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    },
  });

export const push = (list: Array<Entry>, entry: Entry, max: number) => {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
};

export const service = () => state().options.service ?? "app";
