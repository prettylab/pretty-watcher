# @prettylab/pretty-watcher

Logs, HTTP traffic and user actions from a Node app, pushed to Pretty Server Manager.
It has no dependencies. It also ships the `pretty manager` command, which links a project
to the manager.

```bash
npm install @prettylab/pretty-watcher
```

## Link a project

```bash
npx pretty manager pair            # asks for the manager URL, shows a code to approve in the panel
npx pretty manager status
npx pretty manager unpair          # drops the link, removes the agent, its service and .pretty/
```

Install the package first: `npx pretty` runs the `pretty` command from the project's
`node_modules`. Without it, npx would fetch the unrelated `pretty` package from npm. In a
folder without the package, use `npx -p @prettylab/pretty-watcher pretty manager pair`. Any other
`pretty ...` command is passed on to `@prettylab/cli`.

`pair` downloads the manager's agent into `.pretty/agent.mjs` and installs it as a
background service. The agent handles deploys, the file manager, backups, make targets
started from the panel and terminals. Pairing also writes `WATCHER_URL` and `WATCHER_TOKEN`
into `.env`. The manager URL can also come from `SERVER_MANAGER_URL` in the environment or
in `.env`.

## The agent (watchdog)

The agent's source is in this package (`agent/agent.mjs`, `agent/update.sh`). Pretty Server
Manager depends on the package and serves that copy at `/pretty/agent.mjs`, so a server
always gets the agent that matches its manager. It needs Node.js 22+ and nothing else.

What it does for the manager's project page:

| Tab | |
|---|---|
| Deploys | backup, download the release, `make update` |
| Backups & files | `make backup` on a schedule; file manager confined to the project folder |
| Terminal → Shell | a shell on the host (in the project folder) or in any running container of the project's compose stack |
| Terminal → Make | the root `Makefile`'s targets, grouped by their `# SECTION` comments; one runs at a time, output kept in the history |

Terminals need `python3` on the server (it makes the pseudo-terminal; without it `script`
is used and the window keeps its first size). Containers are reached through the
Makefile's `COMPOSE` variable, or a plain `docker/compose.yml`. Only the project's managers
can open terminals or run targets, and every terminal opened is in the activity log.

To refuse terminals on one server, add `TERMINAL=off` to `.pretty/manager.env` and restart
the agent (`node .pretty/agent.mjs service`). Make targets keep working.

## Publishing

```bash
npm run release -- --dry-run      # build, test and show the tarball; nothing is uploaded
npm run release -- minor          # bump (patch|minor|major|x.y.z), test, publish, commit + tag
```

`scripts/publish.sh` works for any package: it reads the name and version from
`package.json`, refuses a version that is already on npm or a dirty git tree
(`--allow-dirty`), runs `prepublishOnly`, then publishes (`--tag`, `--otp`, `--no-git`).

To only watch an app, without deploys, add it under Projects → Add project in the manager
and copy the token into `.env` yourself.

## Start it

Call it once per process. Without `WATCHER_URL` and `WATCHER_TOKEN` it does nothing.

```ts
// Next.js: instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWatcher } = await import("@prettylab/pretty-watcher");
    startWatcher({
      service: "app",
      // Resolver: who is signed in, from the cookies (cached for a minute per cookie)
      actor: async ({ cookies }) => (await sessionByToken(cookies.sid))?.user.email,
    });
  }
}
```

With a custom `server.ts`, call `startWatcher()` before `createServer()`.

That alone records the following:

- **every request**: method, path, status, time, bytes, IP and user agent
- **every console line**, uncaught errors, and whether the process stopped or crashed
- **actions**: every POST, PUT, PATCH or DELETE under `/api/`, and every Next Server
  Action. Each is named from its path, with the request and response bodies kept
  (secrets redacted):

| Request | Action | Label |
|---|---|---|
| `POST /api/admin/participant` | `participant.create` | Create participant |
| `PATCH /api/admin/users/12` | `user.update` | Update user · #12 |
| `POST /api/items/Ab3x/unlock` | `item.unlock` | Unlock item |
| `POST /api/login` | `login` | Login |
| `PATCH /api/admin/round/12/activate` | `round.activate` | Activate round · #12 |
| Server Action on `/admin/users` | `user.action` | Action on user |

## Hooks: add details from the app

```ts
import { watch, watchActor, trackAction } from "@prettylab/pretty-watcher";

// Anywhere while a request is handled (route, Server Action, service...):
watch({ target: participant.name, detail: "status → paid" });
watch({ action: "invoice.send", label: "Send invoice" }); // also makes a GET an action

// Who it is, when the app already knows (does not turn the request into an action):
watchActor(user.email);

// Outside a request (websocket message, cron job):
trackAction({ action: "score.save", label: "Judge scored", target: "#3" });
```

Every call is a no-op while the watcher is off, so it is safe to leave in.

## Resolvers: change actions in one place

```ts
startWatcher({
  // Runs for every action before it is sent: fill in fields, rename, or return false to drop it
  describe: ({ action, body, status }) => {
    if (action === "auth.login") return { actor: body?.email };
    if (status === 404) return false;
  },
  // Only for paths the automatic name gets wrong
  rules: [{ method: "POST", path: "/api/register", label: "Registration submitted",
            describe: ({ body }) => ({ actor: body?.email, target: body?.name }) }],
});
```

Priority, highest first: `watch()` in the app, then `rules`, then the automatic name. The
global `describe` gets the result and has the last word.

## Options

| Option | Default | |
|---|---|---|
| `service` | `"app"` | Name of this process in the panel |
| `actor` | – | Cookie → e-mail resolver |
| `describe` | – | Resolver for every action, return `false` to drop it |
| `rules` | `[]` | `{ method, path, action?, label?, describe? }` overrides |
| `trackUnmatched` | `["/api/"]` | Prefixes whose mutations are recorded as actions |
| `ignorePaths` | – | RegExps for requests that are not recorded at all |
| `ignoreLogs` | – | RegExps for console lines that are not forwarded |
| `captureBodies` | `true` | Keep redacted request and response bodies of actions |
| `redact` | – | Extra field names to blank out |
| `url`, `token` | env | `WATCHER_URL`, `WATCHER_TOKEN` |
| `intervalMs` | `3000` | How often batches are sent |

Requires Node 18.17+ for the watcher and Node 22+ for the agent. It works in the Node
runtime only, not Edge.
