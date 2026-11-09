import type { EngineInterface } from "claude-code";

/**
 * A Claude Code configuration folder whose sessions the panel lists: the
 * session's own, or another the `profiles` setting names. `id` and `name` are
 * empty for the session's own folder when no profile names it.
 */
export type Profile = { id: string; name: string; color: string; dir: string };

/** The session's own profile, and the others whose sessions it lists too. */
export type Profiles = { own: Profile; others: readonly Profile[] };

/** The colours of profiles whose entry names none, in the order the profiles are listed. */
const PROFILE_COLORS = ["#4b91ff", "#e0823d", "#a684e8", "#3fb9a8", "#e06c9f"];
const HEX = /^#[0-9a-f]{6}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An absolute folder with `~` expanded and no trailing slash, as Claude Code takes `CLAUDE_CONFIG_DIR`; null for a relative one. */
function folderOf(path: string, home: string): string | null {
  const expanded =
    path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  if (!expanded.startsWith("/") || (path.startsWith("~") && home === ""))
    return null;
  return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
}

/**
 * The `profiles` object of `cc-sidecar/profiles.json` in the person's config
 * folder (`XDG_CONFIG_HOME`, else `~/.config`): one file every profile reads.
 * Claude Code's settings take no object a plugin's manifest doesn't declare,
 * so the profiles live beside them. Undefined when the file is missing or unreadable.
 */
async function profilesFile(
  $: EngineInterface,
  home: string
): Promise<unknown> {
  try {
    const xdg = (await $.env.get("XDG_CONFIG_HOME")) ?? "";
    const config = xdg !== "" ? xdg : home === "" ? "" : `${home}/.config`;
    if (config === "") return undefined;
    const path = `${config}/cc-sidecar/profiles.json`;
    if (!(await $.fs.exists(path))) return undefined;
    const file: unknown = JSON.parse(String(await $.fs.read(path)));
    return isRecord(file) ? file.profiles : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session's own profile, its folder `CLAUDE_CONFIG_DIR` or else
 * `~/.claude` as Claude Code's, and the others `profiles.json` lists, each
 * `{ name?, path, color? }` by id: a profile with no name shows its id, one
 * with no `#rrggbb` colour takes the next default. A profile with no absolute
 * path, or a folder listed before, is left out. Null without a folder to read.
 */
export async function readProfiles(
  $: EngineInterface
): Promise<Profiles | null> {
  const home = (await $.env.get("HOME")) ?? "";
  const set = (await $.env.get("CLAUDE_CONFIG_DIR")) ?? "";
  const ownDir =
    (set === "" ? null : folderOf(set, home)) ??
    (home === "" ? null : `${home}/.claude`);
  if (ownDir === null) return null;

  const entries = await profilesFile($, home);
  const listed: Profile[] = [];
  for (const [id, fields] of Object.entries(
    isRecord(entries) ? entries : {}
  )) {
    if (!isRecord(fields) || typeof fields.path !== "string") continue;
    const dir = folderOf(fields.path, home);
    if (dir === null || listed.some((profile) => profile.dir === dir)) continue;
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    const color = typeof fields.color === "string" ? fields.color : "";
    listed.push({
      id,
      name: name === "" ? id : name,
      color: HEX.test(color)
        ? color
        : PROFILE_COLORS[listed.length % PROFILE_COLORS.length]!,
      dir,
    });
  }
  return {
    own: listed.find((profile) => profile.dir === ownDir) ?? {
      id: "",
      name: "",
      color: "",
      dir: ownDir,
    },
    others: listed.filter((profile) => profile.dir !== ownDir),
  };
}

/** The session's own profile first, then the others. */
export const allProfiles = (profiles: Profiles): Profile[] => [
  profiles.own,
  ...profiles.others,
];

/**
 * One running session as Claude Code registers it, in
 * `<configuration folder>/sessions/<pid>.json`: every session has one, sidecar or not.
 */
export type Registered = {
  /** The profile whose folder registers it. */
  profile: Profile;
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
function asRegistered(value: unknown, profile: Profile): Registered | null {
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
    profile,
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
 * Asks `claude agents --json` which sessions of `profile` are active: the
 * terminal ones still running (a crashed one leaves its registry entry behind)
 * and the ones running on their own. It runs under the session's own
 * configuration folder, and with `CLAUDE_CONFIG_DIR` set to another profile's.
 * Null when it can't say: too old, or failing.
 */
export async function listActive(
  $: EngineInterface,
  at: number,
  profile: Profile,
  isOwn: boolean
): Promise<Active | null> {
  try {
    const ran = await $.process.run(["claude", "agents", "--json"], {
      timeoutMs: TIMEOUT_MS,
      ...(isOwn ? {} : { env: { CLAUDE_CONFIG_DIR: profile.dir } }),
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

/** Every session Claude Code registers now in the folders of `profiles`; none from a registry that can't be read. */
export async function readRegistry(
  $: EngineInterface,
  profiles: readonly Profile[]
): Promise<Registered[]> {
  const found: Registered[] = [];
  for (const profile of profiles) {
    try {
      const dir = `${profile.dir}/sessions`;
      if (!(await $.fs.exists(dir))) continue;
      for (const entry of await $.fs.list(dir)) {
        if (entry.kind !== "file" || !ENTRY.test(entry.name)) continue;
        try {
          const registered = asRegistered(
            JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`))),
            profile
          );
          if (registered !== null) found.push(registered);
        } catch {
          // An entry being written right now reads again at the next look.
        }
      }
    } catch {
      // This registry is read again at the next look.
    }
  }
  return found;
}
