// End to end: a fake manager, an app server, real HTTP requests.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { autoLabel, flushWatcher, startWatcher, trackAction, watch, watchActor } from "../dist/index.js";

// A second copy of the package, as a bundler would load it: must share state.
const cjs = createRequire(import.meta.url)("../dist/index.cjs");

const batches = [];
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const manager = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    batches.push(JSON.parse(body));
    response.end("{}");
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const app = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = request.url ?? "/";

  if (url.startsWith("/api/admin/participant")) {
    await tick();
    watch({ detail: "status → paid" });
  } else if (url === "/invoices/5/send") {
    // GET outside /api: only an action because watch() was called, deep in
    // an async chain, from the other copy of the package.
    await tick();
    await Promise.resolve().then(() => cjs.watch({ action: "invoice.send", label: "Send invoice", target: "#5" }));
  } else if (url === "/api/register") {
    watchActor("from-session@example.com");
  } else if (url === "/api/secret") {
    // dropped by the global describe resolver
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
});

let appPort;

before(async () => {
  const managerPort = await listen(manager);
  appPort = await listen(app);
  startWatcher({
    url: `http://127.0.0.1:${managerPort}`,
    token: "test-token",
    service: "test",
    intervalMs: 60_000,
    // the fake manager lives in this process too
    ignorePaths: [/^\/api\/watch\//],
    actor: ({ cookies }) => (cookies.sid === "abc" ? "admin@example.com" : null),
    rules: [{ method: "POST", path: "/api/register", label: "Registration submitted", describe: ({ body }) => ({ target: body?.name }) }],
    describe: (action) => (action.path === "/api/secret" ? false : undefined),
  });
});

after(() => {
  app.close();
  manager.close();
});

const call = (method, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${appPort}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => response.json());

test("auto labels", () => {
  assert.deepEqual(autoLabel("POST", "/api/admin/participant"), { action: "participant.create", label: "Create participant", target: null });
  assert.deepEqual(autoLabel("PATCH", "/api/admin/participant/12"), { action: "participant.update", label: "Update participant", target: "#12" });
  assert.deepEqual(autoLabel("PATCH", "/api/admin/round/12/activate"), { action: "round.activate", label: "Activate round", target: "#12" });
  assert.deepEqual(autoLabel("POST", "/api/projects/5/members"), { action: "members.create", label: "Create members", target: "#5" });
  assert.deepEqual(autoLabel("PATCH", "/api/admin/round/set-positions"), { action: "round.set_positions", label: "Set positions round", target: null });
  assert.deepEqual(autoLabel("POST", "/admin/users", true), { action: "users.action", label: "Action on users", target: null });
});

test("requests become actions with context, rules and resolvers", async () => {
  await call("PATCH", "/api/admin/participant/12", { status: "paid", password: "hunter2" }, { cookie: "sid=abc" });
  await call("GET", "/invoices/5/send");
  await call("POST", "/api/register", { name: "Anna" });
  await call("POST", "/api/secret", { x: 1 });
  await call("POST", "/admin/users", ["x"], { "next-action": "7f00ab" });
  await call("GET", "/plain");
  trackAction({ action: "score.save", label: "Judge scored", target: "#3" });
  watch({ action: "job.done", detail: "outside a request" });

  await new Promise((resolve) => setTimeout(resolve, 50));
  await flushWatcher();

  const actions = batches.flatMap((batch) => batch.actions);
  const requests = batches.flatMap((batch) => batch.requests);
  const by = (key) => actions.find((action) => action.action === key);

  assert.equal(requests.length, 6, "every request is recorded");

  const update = by("participant.update");
  assert.equal(update.label, "Update participant");
  assert.equal(update.target, "#12");
  assert.equal(update.actor, "admin@example.com");
  assert.equal(update.detail, "status → paid");
  assert.equal(update.dump.body.password, "[redacted]");

  const send = by("invoice.send");
  assert.equal(send.label, "Send invoice");
  assert.equal(send.method, "GET");

  const register = by("register.create");
  assert.equal(register.label, "Registration submitted");
  assert.equal(register.target, "Anna");
  assert.equal(register.actor, "from-session@example.com");

  assert.equal(by("secret.create"), undefined, "describe() returning false drops it");
  assert.equal(by("users.action").label, "Action on users");
  assert.equal(actions.find((action) => action.path === "/plain"), undefined, "plain GETs are not actions");
  assert.equal(by("score.save").label, "Judge scored");
  assert.equal(by("job.done").detail, "outside a request");
  assert.equal(actions.length, 6);
});
