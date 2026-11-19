// console.* lines and uncaught errors.
import { format } from "node:util";
import { MAX, push, service, state, type State } from "./state";

type Level = "debug" | "info" | "warn" | "error";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export const hookConsole = (onCrash: () => void) => {
  const levels: Array<[keyof State["original"], Level]> = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
  ];
  const original = state().original;

  for (const [method, level] of levels) {
    console[method] = (...args: Array<unknown>) => {
      original[method].apply(console, args);
      try {
        const message = stripAnsi(format(...args)).slice(0, 8_000);
        if (!message.trim()) return;
        if ((state().options.ignoreLogs ?? []).some((regex) => regex.test(message))) return;
        push(state().logs, { at: new Date().toISOString(), level, service: service(), message }, MAX.logs);
      } catch {}
    };
  }

  process.on("uncaughtExceptionMonitor", (error) => {
    push(
      state().logs,
      { at: new Date().toISOString(), level: "error", service: service(), message: `Uncaught: ${error?.stack ?? error}` },
      MAX.logs,
    );
    onCrash();
  });
};
