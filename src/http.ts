// Every http.Server in the process: requests, and actions with their context.
import http from "node:http";
import {
  CAPTURE_BYTES,
  capDump,
  chunkSize,
  decompress,
  formToObject,
  header,
  headerText,
  headersOf,
  parseBody,
  redactValue,
} from "./capture";
import { autoLabel, matchRule, redactPath, targetOf } from "./labels";
import { MAX, push, service, state, type RequestContext } from "./state";
import type { ActionInfo, DescribeContext, RequestDump } from "./types";

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const clientIp = (request: http.IncomingMessage) => {
  const forwarded =
    header(request.headers, "cf-connecting-ip") ??
    header(request.headers, "x-forwarded-for")?.split(",")[0] ??
    header(request.headers, "x-real-ip") ??
    request.socket?.remoteAddress ??
    null;
  return forwarded ? forwarded.trim().replace(/^::ffff:/, "").slice(0, 64) : null;
};

const parseCookies = (raw: string | undefined) => {
  const cookies: Record<string, string> = {};
  for (const part of (raw ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return cookies;
};

const resolveActor = async (request: http.IncomingMessage) => {
  const resolver = state().options.actor;
  if (!resolver) return null;
  const raw = header(request.headers, "cookie") ?? "";
  if (!raw) return null;

  const cache = state().actorCache;
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  try {
    const value = (await resolver({ cookies: parseCookies(raw), headers: request.headers }))?.slice(0, 255) ?? null;
    cache.set(raw, { value, at: Date.now() });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return value;
  } catch {
    return null;
  }
};

const ignoredPath = (path: string) =>
  path.startsWith("/_next/") ||
  path.startsWith("/__nextjs") ||
  path === "/favicon.ico" ||
  (state().options.ignorePaths ?? []).some((regex) => regex.test(path));

// Applies a describe resolver; a broken one never loses the action.
const describeWith = (
  resolver: ((context: DescribeContext) => ActionInfo | false | null | undefined | void) | undefined,
  context: DescribeContext,
): ActionInfo | false => {
  if (!resolver) return {};
  try {
    return resolver(context) ?? {};
  } catch {
    return {};
  }
};

const trackRequest = (request: http.IncomingMessage, response: http.ServerResponse): RequestContext | null => {
  const started = Date.now();
  const method = (request.method ?? "GET").toUpperCase();
  const rawPath = (request.url ?? "/").split("?")[0] || "/";
  if (ignoredPath(rawPath)) return null;

  const options = state().options;
  const context: RequestContext = {};
  const path = redactPath(rawPath);
  const matched = matchRule(method, rawPath);
  const serverAction = method === "POST" && !!header(request.headers, "next-action");
  const tracked =
    !!matched ||
    serverAction ||
    (MUTATIONS.has(method) && (options.trackUnmatched ?? ["/api/"]).some((prefix) => rawPath.startsWith(prefix)));

  // Looked up while the request runs: a logout deletes the session afterwards.
  const actor = tracked ? resolveActor(request) : null;

  const rawQuery = (request.url ?? "").split("?")[1] ?? "";
  const capture = options.captureBodies !== false && (MUTATIONS.has(method) || !!matched);

  // Copies of the body as the app reads it: tapping "data" events never
  // changes who consumes the stream or when.
  const requestChunks: Array<Buffer> = [];
  let requestCaptured = 0;
  let requestSize = 0;
  if (capture) {
    const emitRequest = request.emit;
    request.emit = function (this: http.IncomingMessage, event: string | symbol, ...args: Array<unknown>) {
      if (event === "data" && args[0]) {
        const chunk = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]));
        requestSize += chunk.length;
        if (requestCaptured < CAPTURE_BYTES) {
          const slice = chunk.subarray(0, CAPTURE_BYTES - requestCaptured);
          requestChunks.push(Buffer.from(slice));
          requestCaptured += slice.length;
        }
      }
      return emitRequest.apply(this, [event, ...args] as Parameters<typeof emitRequest>);
    } as typeof request.emit;
  }

  const responseChunks: Array<Buffer> = [];
  let responseCaptured = 0;
  const keepResponse = (chunk: unknown, encoding: unknown) => {
    if (!capture || !chunk || typeof chunk === "function" || responseCaptured >= CAPTURE_BYTES) return;
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk, (typeof encoding === "string" ? encoding : "utf8") as BufferEncoding)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : null;
    if (!buffer) return;
    const slice = buffer.subarray(0, CAPTURE_BYTES - responseCaptured);
    responseChunks.push(slice);
    responseCaptured += slice.length;
  };

  let bytesOut = 0;
  const write = response.write;
  const end = response.end;
  response.write = function (this: http.ServerResponse, chunk: unknown, ...rest: Array<unknown>) {
    bytesOut += chunkSize(chunk, rest[0]);
    keepResponse(chunk, rest[0]);
    return (write as (...args: Array<unknown>) => boolean).call(this, chunk, ...rest);
  } as typeof response.write;
  response.end = function (this: http.ServerResponse, chunk?: unknown, ...rest: Array<unknown>) {
    bytesOut += chunkSize(chunk, rest[0]);
    keepResponse(chunk, rest[0]);
    return (end as (...args: Array<unknown>) => http.ServerResponse).call(this, chunk, ...rest);
  } as typeof response.end;

  const buildDump = (): { dump: RequestDump | null; body: unknown; responseBody: unknown } => {
    const query = rawQuery ? (redactValue(formToObject(new URLSearchParams(rawQuery))) as Record<string, unknown>) : undefined;
    if (!capture) return { dump: query ? { query } : null, body: null, responseBody: null };

    const requestType = header(request.headers, "content-type") ?? null;
    const body = parseBody(Buffer.concat(requestChunks), requestType, requestSize > requestCaptured);

    const responseType = headerText(response.getHeader("content-type"));
    const encoding = headerText(response.getHeader("content-encoding"))?.toLowerCase() || undefined;
    const raw = decompress(Buffer.concat(responseChunks), encoding);
    const responseBody = raw ? parseBody(raw, responseType, responseCaptured >= CAPTURE_BYTES) : `<${encoding} body>`;

    return {
      body,
      responseBody,
      dump: capDump({
        ...(query && { query }),
        headers: headersOf(request.headers),
        body,
        bodySize: requestSize,
        bodyTruncated: requestSize > requestCaptured,
        response: { contentType: responseType, body: responseBody, size: bytesOut, truncated: responseCaptured >= CAPTURE_BYTES },
      }),
    };
  };

  const finish = () => {
    if (context.done) return;
    context.done = true;
    const status = response.writableFinished ? response.statusCode : 499;
    const ip = clientIp(request);
    const at = new Date(started).toISOString();
    let built: ReturnType<typeof buildDump> = { dump: null, body: null, responseBody: null };
    try {
      built = buildDump();
    } catch (error) {
      // Said once: a broken dump must never break the request it describes.
      if (!state().dumpWarned) {
        state().dumpWarned = true;
        state().original.warn("[watcher] could not capture a request:", (error as Error)?.stack ?? error);
      }
    }

    push(
      state().requests,
      {
        at,
        service: service(),
        method,
        path,
        status,
        ms: Date.now() - started,
        bytesIn: Number(header(request.headers, "content-length") ?? 0) || 0,
        bytesOut,
        ip,
        ua: header(request.headers, "user-agent")?.slice(0, 255) ?? null,
        dump: built.dump,
      },
      MAX.requests,
    );

    const info = context.info;
    if (!tracked && !info) return;

    // A watch()-only request has no lookup yet; the session is still there.
    const who = info?.actor ?? context.actor ?? actor ?? resolveActor(request);
    void Promise.resolve(who).then((resolved) => {
      const auto = autoLabel(method, rawPath, serverAction);
      const params = matched?.params ?? {};
      const base: DescribeContext = {
        method,
        path,
        params,
        body: built.body,
        response: built.responseBody,
        status,
        action: matched?.rule.action ?? auto.action,
        label: matched?.rule.label ?? auto.label,
        target: (matched && targetOf(params)) || auto.target,
        actor: resolved ?? null,
      };

      // Rule describe fills gaps (a public form has no session, but its body
      // has the e-mail); watch() in the app wins over both.
      const fromRule = describeWith(matched?.rule.describe, base);
      if (fromRule === false) return;
      const merged: DescribeContext = {
        ...base,
        action: info?.action ?? fromRule.action ?? base.action,
        label: info?.label ?? fromRule.label ?? (info?.action && !matched?.rule.label ? info.action : base.label),
        target: info?.target ?? fromRule.target ?? base.target,
        actor: base.actor ?? fromRule.actor ?? null,
      };
      const detail = info?.detail ?? fromRule.detail ?? null;
      const ok = info?.ok ?? fromRule.ok ?? status < 400;

      // The global resolver has the last word.
      const final = describeWith(options.describe, merged);
      if (final === false) return;

      push(
        state().actions,
        {
          at,
          service: service(),
          action: String(final.action ?? merged.action).slice(0, 64),
          label: String(final.label ?? merged.label).slice(0, 120),
          method,
          path,
          status,
          ok: final.ok ?? ok,
          target: final.target !== undefined ? final.target : merged.target,
          actor: final.actor !== undefined ? final.actor : merged.actor,
          ip,
          detail: final.detail !== undefined ? final.detail : detail,
          dump: built.dump,
        },
        MAX.actions,
      );
    });
  };

  response.once("finish", finish);
  response.once("close", finish);
  return context;
};

// The handler runs inside the request's context, so watch() anywhere in the
// app knows which request it belongs to.
export const hookHttp = () => {
  const emit = http.Server.prototype.emit as (this: http.Server, event: string | symbol, ...args: Array<unknown>) => boolean;
  http.Server.prototype.emit = function (this: http.Server, event: string | symbol, ...args: Array<unknown>) {
    if (event === "request") {
      let context: RequestContext | null = null;
      try {
        context = trackRequest(args[0] as http.IncomingMessage, args[1] as http.ServerResponse);
      } catch {}
      if (context) return state().context.run(context, () => emit.call(this, event, ...args));
    }
    return emit.call(this, event, ...args);
  } as typeof http.Server.prototype.emit;
};
