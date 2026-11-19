// Request / response copies: parsing, redaction and size limits.
import type http from "node:http";
import zlib from "node:zlib";
import { state } from "./state";
import type { RequestDump } from "./types";

export const CAPTURE_BYTES = 64 * 1024;
const DUMP_BYTES = 48 * 1024;
const SECRET_KEYS = /pass(word|wd)?|secret|token|authori[sz]ation|cookie|csrf|api[-_]?key|private[-_]?key|card[-_]?number|cvv|cvc|iban/i;
const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization", "x-csrf-token", "x-api-key"]);

export const isSecret = (key: string) => SECRET_KEYS.test(key) || (state().options.redact?.test(key) ?? false);

export const header = (headers: http.IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// Response headers can be numbers or arrays (Next sets some as arrays).
export const headerText = (value: number | string | Array<string> | undefined | null) =>
  value === undefined || value === null ? null : Array.isArray(value) ? value.join(", ") : String(value);

export const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 12 || value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 4_000)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 200).map((item) => redactValue(item, depth + 1));
    return value.length > 200 ? [...items, `… ${value.length - 200} more`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecret(key) && item !== null && item !== "" ? "[redacted]" : redactValue(item, depth + 1);
  }
  return out;
};

export const formToObject = (params: URLSearchParams) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const current = out[key];
    out[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return out;
};

// Multipart: text fields with their values, files as name / type / size only.
const parseMultipart = (buffer: Buffer, contentType: string) => {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return { multipart: true };
  const fields: Record<string, unknown> = {};
  const files: Array<Record<string, unknown>> = [];
  for (const part of buffer.toString("latin1").split(`--${boundary}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const content = part.slice(split + 4).replace(/\r\n$/, "");
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (filename !== undefined) {
      files.push({ field: name, filename, type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null, size: content.length });
    } else {
      fields[name] = Buffer.from(content, "latin1").toString("utf8").slice(0, 4_000);
    }
  }
  return { fields: redactValue(fields), files };
};

export const parseBody = (buffer: Buffer, contentType: string | null, truncated: boolean): unknown => {
  if (!buffer.length) return null;
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("multipart/form-data")) return parseMultipart(buffer, type);
  const text = buffer.toString("utf8");
  if (type.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return redactValue(JSON.parse(text));
    } catch {
      if (truncated) return `${text.slice(0, 8_000)}… (truncated JSON)`;
    }
  }
  if (type.includes("x-www-form-urlencoded")) return redactValue(formToObject(new URLSearchParams(text)));
  if (type.startsWith("text/") || type.includes("xml") || type.includes("javascript") || !/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 2_000))) {
    return text.length > 8_000 ? `${text.slice(0, 8_000)}… (${buffer.length} bytes)` : text;
  }
  return `<binary ${buffer.length} bytes${contentType ? `, ${contentType}` : ""}>`;
};

export const decompress = (buffer: Buffer, encoding: string | undefined) => {
  try {
    const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    if (encoding === "gzip") return zlib.gunzipSync(buffer, options);
    if (encoding === "deflate") return zlib.inflateSync(buffer, options);
    if (encoding === "br") return zlib.brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  } catch {
    return null;
  }
  return buffer;
};

export const headersOf = (headers: http.IncomingHttpHeaders) => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = SECRET_HEADERS.has(name) ? "[redacted]" : (Array.isArray(value) ? value.join(", ") : value).slice(0, 500);
  }
  return out;
};

// Keeps the stored dump under DUMP_BYTES by shortening the biggest parts.
export const capDump = (dump: RequestDump): RequestDump => {
  let text = JSON.stringify(dump);
  if (text.length <= DUMP_BYTES) return dump;
  const shrink = (value: unknown) => {
    const json = JSON.stringify(value) ?? "";
    return json.length > 12_000 ? `${json.slice(0, 12_000)}… (${json.length} chars)` : value;
  };
  dump = {
    ...dump,
    headers: undefined,
    body: shrink(dump.body),
    ...(dump.response && { response: { ...dump.response, body: shrink(dump.response.body) } }),
  };
  text = JSON.stringify(dump);
  return text.length <= DUMP_BYTES
    ? dump
    : { ...dump, body: "(too large)", response: dump.response && { ...dump.response, body: "(too large)" } };
};

export const chunkSize = (chunk: unknown, encoding?: unknown) => {
  if (!chunk || typeof chunk === "function") return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, (typeof encoding === "string" ? encoding : "utf8") as BufferEncoding);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
};
