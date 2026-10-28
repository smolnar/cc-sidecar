import type { EngineInterface } from "claude-code";

import type { Others, Presence, WaitingSession } from "../types";
import { cut } from "./brief";
import type { Active, Registered } from "./registry";

/** A session not heard from for this long is taken for gone. */
const QUIET_AFTER = 3 * 60_000;
/** A live session writes each minute: a file this old, or one its session ended, is removed. */
const FORGET_AFTER = 60 * 60_000;
const TIMEOUT_MS = 3000;
/** How much of another session's name and question the panel takes. */
const NAME_MAX = 40;
const QUESTION_MAX = 120;

const STATES: readonly unknown[] = ["waiting", "working", "done"];

/**
 * Where every session keeps its presence file, one file each, so no two
 * sessions ever write the same one; null without a home directory.
 */
async function presenceDir($: EngineInterface): Promise<string | null> {
  const home = await $.env.get("HOME");
  return home === undefined || home === ""
    ? null
    : `${home}/.claude/sidecar/presence`;
}

/** Writes this session's presence for the others to read; a failure changes nothing. */
export async function writePresence(
  $: EngineInterface,
  presence: Presence
): Promise<void> {
  try {
    const dir = await presenceDir($);
    if (dir !== null)
      await $.fs.write(
        `${dir}/${presence.sessionId}.json`,
        JSON.stringify(presence)
      );
  } catch {
    // The others just don't see this session until the next write.
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * A parsed file as the panel reads it, or null when a field the panel needs is
 * missing or of another type. A file an older copy wrote, without the fields
 * that tell when it finished and was seen, reads as never finished unseen.
 */
function asPresence(value: unknown): Presence | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  const isPresence =
    typeof fields.sessionId === "string" &&
    typeof fields.name === "string" &&
    STATES.includes(fields.state) &&
    typeof fields.question === "string" &&
    isNumber(fields.since) &&
    typeof fields.cwd === "string" &&
    (fields.zellijSession === null ||
      typeof fields.zellijSession === "string") &&
    (fields.tabPosition === null ||
      (Number.isInteger(fields.tabPosition) &&
        (fields.tabPosition as number) >= 0)) &&
    isNumber(fields.updatedAt) &&
    typeof fields.isEnded === "boolean";
  if (!isPresence) return null;
  return {
    ...(fields as Presence),
    finishedAt: isNumber(fields.finishedAt) ? fields.finishedAt : null,
    seenAt: isNumber(fields.seenAt) ? fields.seenAt : 0,
    said: typeof fields.said === "string" ? fields.said : "",
  };
}

const folder = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;

/** Removes presence files no session will write again; what fails is tried at the next look. */
async function forget($: EngineInterface, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    // `--`: a file name is never read as an option.
    await $.process.run(["rm", "-f", "--", ...paths], {
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    // The files stay until the next look.
  }
}

/**
 * The presence files of the other sessions, fresh ones by session id; files
 * of sessions that ended or left long ago are removed on the way.
 */
async function readPresences(
  $: EngineInterface,
  selfId: string,
  now: number
): Promise<Map<string, Presence>> {
  const fresh = new Map<string, Presence>();
  const dir = await presenceDir($);
  if (dir === null || !(await $.fs.exists(dir))) return fresh;
  const gone: string[] = [];
  for (const entry of await $.fs.list(dir)) {
    if (
      entry.kind !== "file" ||
      !entry.name.endsWith(".json") ||
      entry.name === `${selfId}.json`
    )
      continue;
    const path = `${dir}/${entry.name}`;
    let presence: Presence | null = null;
    try {
      presence = asPresence(JSON.parse(String(await $.fs.read(path))));
    } catch {
      // A file being written right now reads again at the next look.
    }
    if (presence === null) {
      if (now - entry.mtimeMs > FORGET_AFTER) gone.push(path);
    } else if (presence.isEnded || now - presence.updatedAt > FORGET_AFTER) {
      gone.push(path);
    } else if (now - presence.updatedAt <= QUIET_AFTER) {
      fresh.set(presence.sessionId, presence);
    }
  }
  await forget($, gone);
  return fresh;
}

/** What Claude Code's registry says a waiting session waits for, when it is a permission. */
const PERMISSIONS: ReadonlySet<string> = new Set([
  "permission prompt",
  "sandbox request",
]);

/**
 * The other sessions and the ones that need the person, from Claude Code's
 * registry (every terminal session, sidecar or not), what `claude agents`
 * calls active (`active`; null when it can't say), and the sidecar's presence
 * files, which add a question's words, the zellij tab, and whether a session
 * finished out of sight. Those waiting come first, the longest-waiting first;
 * those finished unseen after them.
 */
export async function readOthers(
  $: EngineInterface,
  selfId: string,
  zellijSession: string | null,
  now: number,
  registry: readonly Registered[],
  active: Active | null
): Promise<Others> {
  const presences = await readPresences($, selfId, now);
  // A crashed session leaves its entry behind: claude agents no longer lists it.
  const live = registry.filter(
    (entry) =>
      entry.sessionId !== selfId &&
      (active === null ||
        active.sessionIds.has(entry.sessionId) ||
        entry.updatedAt >= active.at)
  );
  const waiting: WaitingSession[] = [];
  for (const entry of live) {
    const presence = presences.get(entry.sessionId);
    const name = cut(
      presence?.name || entry.name || folder(entry.cwd),
      NAME_MAX
    );
    const where =
      zellijSession !== null &&
      presence !== undefined &&
      presence.zellijSession === zellijSession &&
      presence.tabPosition !== null
        ? `tab ${presence.tabPosition + 1}`
        : cut(folder(entry.cwd), NAME_MAX);
    const question = cut(
      presence?.state === "waiting" ? presence.question : "",
      QUESTION_MAX
    );
    if (entry.status === "waiting") {
      const kind = PERMISSIONS.has(entry.waitingFor)
        ? "permission"
        : "question";
      waiting.push({
        name,
        where,
        since: entry.since,
        kind,
        detail: kind === "question" ? question : "",
      });
    } else if (entry.status === "idle" && presence?.state === "waiting") {
      // Its reply ended on a question: the turn is over, the person is asked.
      waiting.push({
        name,
        where,
        since: presence.since,
        kind: "question",
        detail: question,
      });
    } else if (
      entry.status === "idle" &&
      presence !== undefined &&
      presence.finishedAt !== null &&
      presence.seenAt < presence.finishedAt
    ) {
      waiting.push({
        name,
        where,
        since: presence.finishedAt,
        kind: "finished",
        detail: cut(presence.said, QUESTION_MAX),
      });
    }
  }
  // Background sessions count as open, but one blocked on you is left out of NEEDS YOU for now.
  const background = (active?.background ?? []).filter(
    (session) => session.state !== "done"
  );
  waiting.sort(
    (a, b) =>
      Number(a.kind === "finished") - Number(b.kind === "finished") ||
      a.since - b.since
  );
  return { open: live.length + 1 + background.length, waiting };
}
