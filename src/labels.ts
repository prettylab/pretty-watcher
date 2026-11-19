// Names for actions: optional rules first, otherwise read from the path.
import { isSecret } from "./capture";
import { state, type CompiledRule } from "./state";
import type { WatcherRule } from "./types";

const TOKEN = /^[A-Za-z0-9_-]+$/;

// Tokens and ids in paths: long random segments become ":token" so secrets
// (edit links, reset tokens) never leave the app.
export const redactPath = (path: string) =>
  path
    .split("/")
    .map((part) => (part.length >= 32 && TOKEN.test(part) ? ":token" : part))
    .join("/");

export const compile = (rule: WatcherRule): CompiledRule => {
  const pattern = rule.path
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*$/, "(?:/.*)?")
    .replace(/:(\w+)/g, "(?<$1>[^/]+)");
  const methods = (Array.isArray(rule.method) ? rule.method : [rule.method]).map((m) => m.toUpperCase());
  return { rule, regex: new RegExp(`^${pattern}/?$`), methods };
};

export const matchRule = (method: string, path: string) => {
  for (const entry of state().rules) {
    if (!entry.methods.includes("*") && !entry.methods.includes(method)) continue;
    const match = entry.regex.exec(path);
    if (match) return { rule: entry.rule, params: match.groups ?? {} };
  }
  return null;
};

const looksSecret = (value: string) => value.length >= 24 && TOKEN.test(value);

// Rule parameters as "#12" / "slug: summer" (secret-looking ones skipped).
export const targetOf = (params: Record<string, string>) => {
  const values = Object.entries(params).filter(([name, value]) => value && !isSecret(name) && !looksSecret(value));
  if (!values.length) return null;
  return values
    .map(([name, value]) => (/^\d+$/.test(value) ? `#${value}` : `${name}: ${value}`))
    .join(", ")
    .slice(0, 255);
};

const VERBS: Record<string, string> = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete", GET: "view" };
const SKIP = /^(api|admin|v\d+)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Numbers, uuids, tokens, and short public ids ("Ab3x", "x7"): any segment
// with a digit in it.
const isId = (part: string) => /\d/.test(part) || UUID.test(part) || looksSecret(part) || part.startsWith(":");

// One-word paths that are a verb on their own: POST /api/login is "Login".
const VERB_WORDS = new Set(
  "login logout signin signout signup register cleanup reset verify confirm import export sync refresh subscribe unsubscribe search upload download checkout".split(" "),
);

// "items" -> "item", "categories" -> "category", "addresses" -> "address".
const singular = (word: string) => {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(word) || word.length <= 3) return word;
  if (/(ches|shes|xes|sses|ses)$/i.test(word)) return word.slice(0, -2);
  return /s$/i.test(word) ? word.slice(0, -1) : word;
};

const words = (text: string) => text.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
const key = (text: string) => words(text).replace(/\s+/g, "_");

// Reads a name from the request itself:
//   POST   /api/admin/participant          participant.create  "Create participant"
//   PATCH  /api/admin/users/12             user.update         "Update user"          #12
//   PATCH  /api/admin/round/12/activate    round.activate      "Activate round"       #12
//   POST   /api/projects/5/members         member.create       "Create member"        #5
//   POST   /api/items/Ab3x/unlock          item.unlock         "Unlock item"
//   POST   /api/login                      login               "Login"
//   POST   /admin/users (Server Action)    user.action         "Action on user"
// A last word that ends in "s" without a dash is taken as a nested
// collection, anything else as the verb.
export const autoLabel = (method: string, rawPath: string, serverAction = false) => {
  const parts = rawPath
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter((part) => !SKIP.test(part));

  const ids = parts.filter(isId).filter((part) => /^\d+$/.test(part));
  const names = parts.filter((part) => !isId(part));
  const last = parts[parts.length - 1];
  const endsWithWord = last !== undefined && !isId(last);

  let resource: string;
  let verb: string;
  if (!serverAction && names.length === 1 && endsWithWord && VERB_WORDS.has(last.toLowerCase())) {
    const label = words(last);
    return { action: key(last).slice(0, 64), label: (label.charAt(0).toUpperCase() + label.slice(1)).slice(0, 120), target: null };
  }
  if (serverAction) {
    resource = names[names.length - 1] ?? "home";
    verb = "action";
  } else if (endsWithWord && names.length >= 2 && (last.includes("-") || !/s$/i.test(last))) {
    verb = names[names.length - 1];
    resource = names[names.length - 2];
  } else {
    resource = names[names.length - 1] ?? "home";
    verb = VERBS[method] ?? method.toLowerCase();
  }

  resource = singular(resource);
  // "auth/login" is just "Login", "round/12/end-round" just "End round".
  const standalone = /^(login|logout|signin|signout|signup|register)$/i.test(verb) || words(verb).split(" ").includes(words(resource));
  const label = serverAction ? `Action on ${words(resource)}` : standalone ? words(verb) : `${words(verb)} ${words(resource)}`;
  return {
    action: `${key(resource)}.${key(verb)}`.slice(0, 64),
    label: (label.charAt(0).toUpperCase() + label.slice(1)).slice(0, 120),
    target: ids.length ? ids.map((id) => `#${id}`).join(", ") : null,
  };
};
