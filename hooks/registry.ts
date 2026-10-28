import type { EngineInterface } from "claude-code";

/**
 * One running session as Claude Code registers it, in
 * `~/.claude/sessions/<pid>.json`: every session has one, sidecar or not.
 */
export type Registered = {
  pid: number;
  sessionId: string;
  cwd: string;
  /** `interactive` for a terminal's session; another word for one that runs on its own. */
  kind: string;
  /** Claude Code's title for it (its generator's, or /rename's); empty before it has one. */
  name: string;
  status: "busy" | "idle" | "waiting";
  /** What a waiting session waits for, in Claude Code's words ("permission prompt", "input needed"); empty otherwise. */
  waitingFor: string;
  /** When its status last changed. */
  since: number;
  /** When Claude Code last wrote the entry. */
  updatedAt: number;
};

/** A session running on its own, with no terminal, as `claude agents --json` lists it. */
export type Background = {
  sessionId: string;
  cwd: string;
  name: string;
  startedAt: number;
  /** `running`, `blocked` (on the person), `done`. */
  state: string;
};

/** The sessions `claude agents --json` called active, and when it was asked. */
export type Active = {
  at: number;
  sessionIds: ReadonlySet<string>;
  background: readonly Background[];
};

/** A process's own entry, `<pid>.json`: the other files beside it, a session's secret among them, are never read. */
const ENTRY = /^\d+\.json$/;
const STATUSES: readonly unknown[] = ["busy", "idle", "waiting"];

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** An entry as the sidecar reads it, or null when it lacks what it needs. */
function asRegistered(value: unknown): Registered | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  if (
    !isNumber(fields.pid) ||
    typeof fields.sessionId !== "string" ||
    typeof fields.cwd !== "string" ||
    !STATUSES.includes(fields.status)
  )
    return null;
  return {
    pid: fields.pid,
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    kind: typeof fields.kind === "string" ? fields.kind : "interactive",
    name: typeof fields.name === "string" ? fields.name : "",
    status: fields.status as Registered["status"],
    waitingFor:
      fields.status === "waiting"
        ? typeof fields.waitingFor === "string"
          ? fields.waitingFor
          : "permission prompt"
        : "",
    since: isNumber(fields.statusUpdatedAt)
      ? fields.statusUpdatedAt
      : isNumber(fields.updatedAt)
      ? fields.updatedAt
      : 0,
    updatedAt: isNumber(fields.updatedAt) ? fields.updatedAt : 0,
  };
}

const TIMEOUT_MS = 5000;

/**
 * Asks `claude agents --json` which sessions are active: the terminal ones
 * still running (a crashed one leaves its registry entry behind) and the ones
 * running on their own. Null when it can't say: too old, or failing.
 */
export async function listActive(
  $: EngineInterface,
  at: number
): Promise<Active | null> {
  try {
    const ran = await $.process.run(["claude", "agents", "--json"], {
      timeoutMs: TIMEOUT_MS,
    });
    if (ran.exitCode !== 0) return null;
    const listed: unknown = JSON.parse(ran.stdout);
    if (!Array.isArray(listed)) return null;
    const sessionIds = new Set<string>();
    const background: Background[] = [];
    for (const item of listed as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const fields = item as Record<string, unknown>;
      if (typeof fields.sessionId !== "string") continue;
      sessionIds.add(fields.sessionId);
      if (fields.kind !== "background") continue;
      background.push({
        sessionId: fields.sessionId,
        cwd: typeof fields.cwd === "string" ? fields.cwd : "",
        name: typeof fields.name === "string" ? fields.name : "",
        startedAt: isNumber(fields.startedAt) ? fields.startedAt : at,
        state: typeof fields.state === "string" ? fields.state : "",
      });
    }
    return { at, sessionIds, background };
  } catch {
    return null;
  }
}

/** Every session Claude Code registers now; none when the registry can't be read. */
export async function readRegistry($: EngineInterface): Promise<Registered[]> {
  try {
    const home = await $.env.get("HOME");
    if (home === undefined || home === "") return [];
    const dir = `${home}/.claude/sessions`;
    if (!(await $.fs.exists(dir))) return [];
    const found: Registered[] = [];
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== "file" || !ENTRY.test(entry.name)) continue;
      try {
        const registered = asRegistered(
          JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`)))
        );
        if (registered !== null) found.push(registered);
      } catch {
        // An entry being written right now reads again at the next look.
      }
    }
    return found;
  } catch {
    return [];
  }
}
