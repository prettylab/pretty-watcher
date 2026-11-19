// The public hooks: watch() inside a request, trackAction() anywhere.
import { MAX, push, service, state } from "./state";
import type { ActionInfo } from "./types";

const defined = (info: ActionInfo) =>
  Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as ActionInfo;

// Records an action that is not a plain HTTP request (a websocket message,
// a job...). Safe to call when the watcher is off.
export const trackAction = (entry: ActionInfo & { action: string; label?: string; ip?: string | null }) => {
  if (!state().started) return;
  push(
    state().actions,
    {
      at: new Date().toISOString(),
      service: service(),
      action: entry.action.slice(0, 64),
      label: (entry.label ?? entry.action).slice(0, 120),
      method: null,
      path: null,
      status: null,
      ok: entry.ok ?? true,
      target: entry.target ?? null,
      actor: entry.actor ?? null,
      ip: entry.ip ?? null,
      detail: entry.detail ?? null,
    },
    MAX.actions,
  );
};

// Describes what the current request does. Call it anywhere while the app
// handles a request (route handler, Server Action, service, model...): the
// request is then recorded as an action with these fields, even if it is a
// GET or not under /api. Several calls merge, the last value wins.
//
// Outside a request (websocket message, cron job) it records a standalone
// action instead, named by `action` (default "custom").
// Safe to call when the watcher is off.
export const watch = (info: ActionInfo) => {
  const current = state();
  if (!current.started) return;
  const context = current.context.getStore();
  if (context && !context.done) {
    context.info = { ...context.info, ...defined(info) };
    return;
  }
  trackAction({ ...info, action: info.action ?? "custom" });
};

// Who is doing the current request, when the app already knows (its own
// session check, a login that just succeeded). Unlike watch() it does not
// turn the request into an action by itself, so it is fine to call it on
// every request, e.g. in the auth helper. Ignored outside a request.
export const watchActor = (actor: string | null | undefined) => {
  const context = state().context.getStore();
  if (actor && context && !context.done) context.actor = actor.slice(0, 255);
};
