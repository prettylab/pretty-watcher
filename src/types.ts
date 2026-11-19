import type http from "node:http";

// Who / what / why of one action. Every field is optional: whatever is left
// out is filled in by rules, resolvers or the automatic label.
export type ActionInfo = {
  // Stable key, e.g. "participant.update".
  action?: string;
  // Shown in the panel, e.g. "Update participant".
  label?: string;
  target?: string | null;
  actor?: string | null;
  detail?: string | null;
  ok?: boolean;
};

// What a describe resolver gets for one action.
export type DescribeContext = {
  method: string;
  // Path as stored (long tokens replaced with ":token").
  path: string;
  // Named segments of the matched rule (empty without one).
  params: Record<string, string>;
  // Parsed and redacted request / response bodies (null when not captured).
  body: unknown;
  response: unknown;
  status: number;
  // What the watcher would store so far.
  action: string;
  label: string;
  target: string | null;
  actor: string | null;
};

// Returns fields to change, or false to not record this action at all.
export type Describe = (context: DescribeContext) => ActionInfo | false | null | undefined | void;

export type WatcherRule = {
  // One method or several; "*" matches any.
  method: string | Array<string>;
  // "/api/admin/participant/:id" - ":name" matches one segment, a trailing
  // "/*" any rest.
  path: string;
  // Both default to the automatic label.
  action?: string;
  label?: string;
  describe?: Describe;
};

export type ActorResolver = (request: {
  cookies: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}) => Promise<string | null | undefined> | string | null | undefined;

export type WatcherOptions = {
  // Name of this process in the panel ("app", "websockets", ...).
  service?: string;
  // Who did it: e-mail of the signed-in user, looked up from the cookies.
  // Called at most once a minute per cookie string.
  actor?: ActorResolver;
  // Runs for every action before it is queued: fill in target / detail,
  // rename it, or return false to drop it.
  describe?: Describe;
  // Optional overrides for paths the automatic label names badly.
  rules?: Array<WatcherRule>;
  // Mutations (POST/PUT/PATCH/DELETE) under these prefixes are recorded as
  // actions. Default ["/api/"]. Next Server Actions always are.
  trackUnmatched?: Array<string>;
  // Requests whose path matches are not recorded at all.
  ignorePaths?: Array<RegExp>;
  // Console lines that match are not forwarded.
  ignoreLogs?: Array<RegExp>;
  // Keep a copy of what actions send and get back. Default true.
  captureBodies?: boolean;
  // Extra field names to blank out, on top of passwords, tokens, cookies...
  redact?: RegExp;
  version?: string;
  // Default WATCHER_URL / WATCHER_TOKEN.
  url?: string;
  token?: string;
  intervalMs?: number;
};

// What was sent and answered, as stored in the manager. Secrets are replaced
// with "[redacted]" before anything leaves the app.
export type RequestDump = {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  bodySize?: number;
  bodyTruncated?: boolean;
  response?: { contentType: string | null; body: unknown; size: number; truncated: boolean };
};
