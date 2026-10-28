import { atom, read, update } from "claude-code";
import type {
  CommandRunResult,
  EngineInterface,
  PluginOptions,
  Register,
} from "claude-code";

import type {
  About,
  AgentRun,
  Asked,
  Brief,
  BriefState,
  Limit,
  Live,
  Others,
  Presence,
  Repo,
  Turn,
  Usage,
  WaitingSession,
  Work,
  Zellij,
} from "../types";
import {
  MINUTE,
  RECAP_AFTER_MS,
  STATE_LABEL,
  TAB_MAX,
  tabName,
  TITLE_MAX,
  applyReply,
  asBrief,
  briefFromTurn,
  cut,
  formatBrief,
  parseReply,
  pinTitle,
  refreshPrompt,
  span,
  updatedAgo,
} from "./brief";
import {
  countLines,
  isInside,
  repoStatus,
  resolvePath,
  worktreeOf,
} from "./git";
import type { Counted } from "./git";
import {
  GLYPH,
  applyTool,
  asWork,
  describeActivity,
  frameTitle,
  planView,
  progressSentence,
  showing,
  tabLabel,
  titleOf,
} from "./live";
import { readOthers, writePresence } from "./presence";
import { listActive, readRegistry } from "./registry";
import type { Active, Registered } from "./registry";
import {
  TITLE_MODEL,
  keptPrompts,
  ownWords,
  parseTitle,
  promptForTitle,
  titlePrompt,
  titledBrief,
} from "./title";
import {
  GROWTH_KEPT,
  SPEEDS_KEPT,
  bar,
  cells,
  changedRows,
  clip,
  contextNote,
  contextTone,
  PALETTE,
  elapsed,
  engineParts,
  fitBlocks,
  foldedDone,
  gap,
  isShownLimit,
  limitName,
  limitTone,
  modelLabel,
  parseStatus,
  planCount,
  recentSteps,
  resetLabel,
  scrollWindow,
  short,
  sparkline,
  speedSummary,
  whereLine,
  wrapText,
} from "./sidebar";
import type { ListWindow, Note, Tone } from "./sidebar";
import {
  activeTabId,
  renamePane,
  renameTab,
  tabOf,
  unnamePane,
} from "./zellij";

const brief = atom({ plugin: "sidecar", key: "brief" } as const, null);
const turn = atom({ plugin: "sidecar", key: "turn" } as const, null);
const lastTurnAt = atom(
  { plugin: "sidecar", key: "lastTurnAt" } as const,
  null
);
const tick = atom({ plugin: "sidecar", key: "tick" } as const, 0);
const live = atom({ plugin: "sidecar", key: "live" } as const, null);
const EMPTY_WORK: Work = { todos: null, files: [] };
const work = atom({ plugin: "sidecar", key: "work" } as const, EMPTY_WORK);
const zellij = atom(
  { plugin: "sidecar", key: "zellij" } as const,
  {
    paneId: null,
    paneLabel: null,
    paneRenamedAt: 0,
    tabId: null,
    tabLabel: null,
    tabOriginal: null,
    isReleased: false,
    tabPosition: null,
  } as Zellij
);
const isPanelClosed = atom(
  { plugin: "sidecar", key: "isPanelClosed" } as const,
  false
);
const usage = atom({ plugin: "sidecar", key: "usage" } as const, null);
const limits = atom(
  { plugin: "sidecar", key: "limits" } as const,
  [] as Limit[]
);
const speeds = atom(
  { plugin: "sidecar", key: "speeds" } as const,
  [] as number[]
);
const lastTurnMs = atom(
  { plugin: "sidecar", key: "lastTurnMs" } as const,
  null
);
const asked = atom({ plugin: "sidecar", key: "asked" } as const, null);
const others = atom({ plugin: "sidecar", key: "others" } as const, null);
const repo = atom({ plugin: "sidecar", key: "repo" } as const, null);
const about = atom({ plugin: "sidecar", key: "about" } as const, null);
const owner = atom({ plugin: "sidecar", key: "owner" } as const, null);
const addedDirs = atom(
  { plugin: "sidecar", key: "addedDirs" } as const,
  [] as string[]
);
const agents = atom(
  { plugin: "sidecar", key: "agents" } as const,
  [] as AgentRun[]
);
const seenAt = atom({ plugin: "sidecar", key: "seenAt" } as const, 0);
const cache = atom({ plugin: "sidecar", key: "cache" } as const, null);
const cacheTtl = atom({ plugin: "sidecar", key: "cacheTtl" } as const, null);
const prompts = atom(
  { plugin: "sidecar", key: "prompts" } as const,
  [] as string[]
);
const scrolled = atom(
  { plugin: "sidecar", key: "scrolled" } as const,
  {} as Record<string, number>
);
/**
 * The prompt cache's two lifetimes. A subscription's main session caches for an hour (Claude
 * Code's promptCacheTtl); its subagents and helper calls for 5 minutes (subagentPromptCacheTtl).
 * The cache line is the main session's.
 */
const SHORT_CACHE_MS = 5 * MINUTE;
const LONG_CACHE_MS = 60 * MINUTE;
/** How long Haiku may take to name the session before the title stays as it is. */
const TITLE_TIMEOUT_MS = 20_000;

/** How often this session looks at Claude Code's registry, the presence files and its own tab. */
const OTHERS_EVERY_MS = 10_000;
/** How often it asks `claude agents` which sessions are still running: a process each time. */
const ACTIVE_EVERY_MS = 30_000;
const SECOND = 1000;
/** Where Claude Code's own updater reads the newest release of the `latest` channel. */
const RELEASES_URL = "https://downloads.claude.ai/claude-code-releases/latest";
const RELEASE_EVERY_MS = 60 * MINUTE;

const STORE_PREFIX = "brief:";
const WORK_PREFIX = "work:";
const STORE_KEPT = 200;
const RECAP_STEPS = 3;
const PANEL = "brief";
const PANEL_TITLE = "Brief";
/** The dock's width, in body columns: a narrow column beside the transcript, as OpenCode's. */
const PANEL_COLUMNS = 60;
/**
 * The panel's background, from the `panelBackground` setting: a `#rrggbb` colour, or none, so the
 * terminal's own shows through.
 */
const panelBackground = (options: PluginOptions): string | undefined => {
  const colour = options.panelBackground;
  return typeof colour === "string" && /^#[0-9a-f]{6}$/i.test(colour)
    ? colour
    : undefined;
};
const PANEL_OPEN = { id: PANEL, title: PANEL_TITLE, columns: PANEL_COLUMNS };
/** The panel's sections above the spare rows, and below them, in the order drawn. */
const TOP_SECTIONS = ["recap", "plan", "now", "agents", "changed"] as const;
const BOTTOM_SECTIONS = ["context", "speed", "limits", "needs"] as const;
const SECTION_NAMES: Record<string, string> = {
  recap: "RECAP",
  plan: "PLAN",
  now: "NOW",
  agents: "AGENTS",
  changed: "CHANGED",
  context: "CONTEXT",
  speed: "SPEED",
  limits: "LIMITS",
  needs: "NEEDS YOU",
};
/**
 * How the panel gives way when it is taller than the dock, least needed first: each entry moves
 * one section a form down (full, trimmed, rolled into one row, hidden); `gaps` drops the blank rows.
 */
const FIT_ORDER = [
  "recap",
  "speed",
  "recap",
  "changed",
  "needs",
  "plan",
  "agents",
  "context",
  "limits",
  "context",
  "agents",
  "now",
  "needs",
  "now",
  "gaps",
  "speed",
  "changed",
  "recap",
  "plan",
  "agents",
  "limits",
  "context",
  "needs",
] as const;
/** Room between the panel's edges and what it shows. */
const PANEL_PADDING_X = 1;
const PANEL_PADDING_Y = 0;
/** zellij is asked at most this often, however fast Claude works. */
const RENAME_EVERY_MS = 1000;
const USAGE =
  "Usage: /brief prints the brief · /brief panel opens the panel · /brief title <text> pins a title · /brief title unpins it · /brief refresh rebuilds it from the whole conversation";

/**
 * Keeps `value` under this session's key, and only the newest entries under
 * `prefix`. The oldest go first, so a full store makes room; a write the store
 * still refuses leaves the session's last value in place.
 */
async function keep(
  $: EngineInterface,
  prefix: string,
  value: unknown
): Promise<void> {
  try {
    const key = prefix + (await $.session.id());
    const others = (await $.store.keys()).filter(
      (stored) => stored.startsWith(prefix) && stored !== key
    );
    for (const old of others.slice(
      0,
      Math.max(0, others.length - (STORE_KEPT - 1))
    ))
      await $.store.delete(old);
    // Deleted and set again, the key moves to the end of the store's order: the newest, pruned last.
    const before = await $.store.get(key);
    await $.store.delete(key);
    try {
      await $.store.set(key, value);
    } catch (refused) {
      if (before !== undefined) await $.store.set(key, before);
      throw refused;
    }
  } catch {
    // Everything works without the store; only a restart loses what it held.
  }
}

/** Keeps the brief for the band and, under the session's id, for the next start. */
async function save($: EngineInterface, next: Brief): Promise<void> {
  await update($, brief, () => next);
  syncZellij($);
  await keep($, STORE_PREFIX, next);
  await publishPresence($);
}

// ---------- the other sessions, and this one as they see it ----------

/** What this session is doing, as its presence file tells the others. */
async function presenceNow(
  $: EngineInterface,
  isEnded: boolean
): Promise<Presence | null> {
  const current = await read($, brief);
  const running = await read($, turn);
  const title = titleOf(current, running?.prompt ?? "");
  if (title === null) return null;
  const question = await read($, asked);
  const endedAt = (await read($, lastTurnAt)) ?? current?.updatedAt ?? 0;
  let state: BriefState = current?.now.state ?? "done";
  let text = current?.now.text ?? "";
  let since = endedAt;
  if (question !== null) {
    state = "waiting";
    text = question.question;
    since = question.at;
  } else if (running !== null) {
    state = "working";
    text = "";
    since = running.startedAt;
  }
  const told = await read($, zellij);
  return {
    sessionId: await $.session.id(),
    name: current !== null && current.tab !== "" ? current.tab : tabName(title),
    state,
    question: state === "waiting" ? text : "",
    since,
    cwd: await $.session.cwd(),
    zellijSession: (await $.env.get("ZELLIJ_SESSION_NAME")) ?? null,
    tabPosition: told.tabPosition,
    updatedAt: await $.clock.now(),
    isEnded,
    // Only in zellij can it tell when its tab is on screen (lookAtTab): elsewhere it says nothing.
    finishedAt: told.paneId === null ? null : await read($, lastTurnAt),
    seenAt: await read($, seenAt),
    said: state === "done" ? text : "",
  };
}

/** Tells the other sessions what this one is doing; a failure changes nothing. */
async function publishPresence(
  $: EngineInterface,
  isEnded = false
): Promise<void> {
  try {
    const presence = await presenceNow($, isEnded);
    if (presence !== null) await writePresence($, presence);
  } catch {
    // The others see this session again at its next write.
  }
}

/** What `claude agents` last called active; null until it answers, and while it fails. */
let active: Active | null = null;

/**
 * Reads Claude Code's registry and the presence files: follows Claude Code's
 * title for this session, and redraws the others only when something changed.
 */
async function lookAtOthers($: EngineInterface): Promise<void> {
  try {
    const registry = await readRegistry($);
    await followTitle($, registry);
    const seen: Others = await readOthers(
      $,
      await $.session.id(),
      (await $.env.get("ZELLIJ_SESSION_NAME")) ?? null,
      await $.clock.now(),
      registry,
      active
    );
    const before = await read($, others);
    if (JSON.stringify(before) !== JSON.stringify(seen))
      await update($, others, () => seen);
  } catch {
    // The list stays as it was until the next look.
  }
}

/** Asks `claude agents` which sessions are running, then looks again with its answer. */
async function lookAtActive($: EngineInterface): Promise<void> {
  active = await listActive($, await $.clock.now());
  await lookAtOthers($);
}

/**
 * Notes that the person sees this session when its zellij tab is on screen;
 * if it had finished out of sight, the others hear it is seen now.
 */
async function lookAtTab($: EngineInterface): Promise<void> {
  try {
    const told = await read($, zellij);
    if (told.paneId === null) return;
    const ours = told.tabId ?? (await tabOf($, told.paneId))?.id ?? null;
    if (ours === null || (await activeTabId($)) !== ours) return;
    const now = await $.clock.now();
    const before = await read($, seenAt);
    await update($, seenAt, () => now);
    const finishedAt = await read($, lastTurnAt);
    if (finishedAt !== null && before < finishedAt) await publishPresence($);
  } catch {
    // Seen or not, it is told at the next look.
  }
}

/** Changes one running subagent's row; a subagent no longer listed stays gone. */
async function updateAgent(
  $: EngineInterface,
  id: string,
  change: (run: AgentRun) => AgentRun
): Promise<void> {
  try {
    await update($, agents, (current) =>
      current.some((run) => run.id === id)
        ? current.map((run) => (run.id === id ? change(run) : run))
        : current
    );
  } catch {
    // The row keeps its last reading.
  }
}

/** What `$.agent.list()` says of a subagent still under way. */
const UNDER_WAY: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
]);

/** Drops the rows of subagents Claude Code no longer runs: one killed may end with no turn of its own. */
async function lookAtAgents($: EngineInterface): Promise<void> {
  try {
    const running = await read($, agents);
    if (running.length === 0) return;
    const statuses = new Map(
      (await $.agent.list()).map((agent) => [agent.id, agent.status])
    );
    // Only the rows Claude Code says ended go: one that started while it answered stays, as does what came in meanwhile.
    const ended = new Set(
      running
        .filter((run) => !UNDER_WAY.has(statuses.get(run.id) ?? ""))
        .map((run) => run.id)
    );
    if (ended.size > 0)
      await update($, agents, (current) =>
        current.filter((run) => !ended.has(run.id))
      );
  } catch {
    // The rows stay until the next look.
  }
}

/** Asks the release server for the newest Claude Code; offline, the footer makes no claim. */
async function checkRelease($: EngineInterface): Promise<void> {
  try {
    const answer = await $.http.fetch(RELEASES_URL);
    const latest = answer.text.trim();
    if (!answer.ok || !/^\d+\.\d+\.\d+$/.test(latest)) return;
    await update($, about, (current) =>
      current === null ? null : { ...current, latest }
    );
  } catch {
    // Unreachable: the dot stays as it was.
  }
}

/** The conversation this copy of the module set up; null until it has, and after a hot reload. */
let setUpFor: string | null = null;
let isSettingUp = false;
let sessionTimers: { cancel: () => void }[] = [];
/** The record as the store last took it, so a turn that changed nothing writes nothing. */
let storedWork: string | null = null;

/** Whether this copy of the module has set up the conversation Claude Code runs now. */
async function isSetUp($: EngineInterface): Promise<boolean> {
  return setUpFor === (await $.session.id()) && (await read($, about)) !== null;
}

/**
 * Forgets what the last conversation left in the host's values: its brief,
 * turn, plan and files, context, question and subagents. The limits, speeds,
 * zellij and the other sessions are the process's, and stay.
 */
async function forgetConversation($: EngineInterface): Promise<void> {
  await update($, brief, () => null);
  await update($, turn, () => null);
  await update($, lastTurnAt, () => null);
  await update($, lastTurnMs, () => null);
  await update($, live, () => null);
  await update($, work, () => EMPTY_WORK);
  await update($, usage, () => null);
  await update($, asked, () => null);
  await update($, agents, () => []);
  await update($, cache, () => null);
  await update($, prompts, () => []);
  await update($, scrolled, () => ({}));
  storedWork = JSON.stringify(EMPTY_WORK);
}

/**
 * What a conversation needs once: its saved brief and plan, its zellij pane, the footer's
 * facts and the timers. Claude Code raises no session.start after /clear or /resume, and a hot
 * reload cancels the timers, so a draw that finds this undone asks for it (askForSetUp). The
 * host's values outlive both: those of another conversation are forgotten first.
 */
async function setUpSession($: EngineInterface): Promise<void> {
  if (await isSetUp($)) return;
  const id = await $.session.id();
  setUpFor = id;
  // A hot reload finds its own conversation's values, newer than the store's.
  const isNew = (await read($, owner)) !== id;
  if (isNew) {
    await forgetConversation($);
    await update($, owner, () => id);
  }
  if ((await read($, brief)) === null) {
    const saved = asBrief(await $.store.get(STORE_PREFIX + id));
    if (saved !== null) await update($, brief, () => saved);
  }
  const savedWork = isNew ? asWork(await $.store.get(WORK_PREFIX + id)) : null;
  if (savedWork !== null) {
    await update($, work, () => savedWork);
    storedWork = JSON.stringify(savedWork);
  }
  const paneId = (await $.env.get("ZELLIJ_PANE_ID")) ?? null;
  await update($, zellij, (state) => ({
    ...state,
    paneId: paneId === "" ? null : paneId,
  }));
  await update($, tick, () => 0);
  for (const timer of sessionTimers) timer.cancel();
  sessionTimers = [
    // Each minute the ages redraw and the other sessions hear this one is still here.
    $.clock.every(MINUTE, () => {
      void $.clock.now().then((now) => update($, tick, () => now));
      void publishPresence($);
    }),
    $.clock.every(OTHERS_EVERY_MS, () => {
      void lookAtOthers($);
      void lookAtAgents($);
      void lookAtTab($);
    }),
    $.clock.every(ACTIVE_EVERY_MS, () => {
      void lookAtActive($);
    }),
    // The footer's dot turns yellow once a newer Claude Code is out; a long session hears of one hourly.
    $.clock.every(RELEASE_EVERY_MS, () => {
      void checkRelease($);
    }),
  ];
  await update($, about, () => null);
  try {
    const version = (await $.session.version()).version;
    const model = modelLabel(await $.session.model());
    const path = await shownPath($);
    await update(
      $,
      about,
      (): About => ({ path, version, model, effort: null, latest: null })
    );
  } catch {
    // The footer shows what it has.
  }
  void checkRelease($);
  void lookAtActive($);
  void refreshRepo($);
  void lookAtOthers($);
  void publishPresence($);
  syncZellij($);
}

/** Sets the conversation up just after this draw, which may not write itself. */
function askForSetUp($: EngineInterface): void {
  if (isSettingUp) return;
  isSettingUp = true;
  $.clock.after(0, () => {
    void setUpSession($).finally(() => {
      isSettingUp = false;
    });
  });
}

/** Asks git for the branch and the changes the footer shows. */
async function refreshRepo($: EngineInterface): Promise<void> {
  try {
    const cwd = await $.session.cwd();
    const status = await repoStatus($, cwd);
    const tree =
      status === null || status === "unknown" ? null : await worktreeOf($, cwd);
    // Git failed or ran past its timeout: the footer keeps what it showed.
    if (status === "unknown" || tree === "unknown") return;
    const next: Repo | null =
      status === null
        ? null
        : {
            ...parseStatus(status.output),
            worktree:
              tree === null
                ? null
                : {
                    name: tree.root.slice(tree.root.lastIndexOf("/") + 1),
                    main: await homeShortened($, tree.main),
                  },
          };
    if (JSON.stringify(await read($, repo)) !== JSON.stringify(next))
      await update($, repo, () => next);
  } catch {
    // The footer keeps the path alone.
  }
}

/** `path` with the home directory spelled `~`. */
async function homeShortened(
  $: EngineInterface,
  path: string
): Promise<string> {
  const home = (await $.env.get("HOME"))?.replace(/\/+$/, "") ?? "";
  // Only a whole folder: HOME /home/al leaves /home/alice as it is.
  return home !== "" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/** The cwd with the home directory spelled `~`. */
async function shownPath($: EngineInterface): Promise<string> {
  return homeShortened($, await $.session.cwd());
}

/** One model reply: its tokens by bucket, and for the main loop its speed, model and effort. */
async function noteReply(
  $: EngineInterface,
  agentId: string | undefined,
  model: string,
  effort: unknown,
  replied: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null,
  ms: number
): Promise<void> {
  if (agentId === undefined) {
    await update($, about, (current) =>
      current === null
        ? null
        : {
            ...current,
            model: modelLabel(replied?.model ?? model),
            effort: typeof effort === "string" ? effort : current.effort,
          }
    );
  }
  if (replied === null) return;
  if (
    agentId === undefined &&
    replied.output_tokens >= MIN_SPEED_TOKENS &&
    ms > 0
  ) {
    const speed = Math.round(replied.output_tokens / (ms / SECOND));
    await update($, speeds, (current) =>
      [...current, speed].slice(-SPEEDS_KEPT)
    );
  }
}

/**
 * Notes the main loop's last reply's cache: the share of its prompt read from
 * the cache. A hit after a gap longer than 5 minutes shows the cache lives an hour.
 */
async function noteCache(
  $: EngineInterface,
  used: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  },
  startedAt: number
): Promise<void> {
  const prompt =
    used.input_tokens +
    used.cache_read_input_tokens +
    used.cache_creation_input_tokens;
  if (prompt === 0) return;
  const before = await read($, cache);
  if (
    before !== null &&
    used.cache_read_input_tokens > 0 &&
    startedAt - before.at > SHORT_CACHE_MS
  )
    await update($, cacheTtl, () => "1h");
  const at = await $.clock.now();
  await update($, cache, () => ({
    hit: used.cache_read_input_tokens / prompt,
    at,
  }));
}

/** The cache row under the context bar: the hit rate and when the main session's cache goes cold, an hour on unless a model switch said 5 minutes. */
function cacheLine(
  cached: { hit: number; at: number },
  ttl: "5m" | "1h" | null,
  now: number
): string {
  const left =
    cached.at + (ttl === "5m" ? SHORT_CACHE_MS : LONG_CACHE_MS) - now;
  if (left <= 0) return "cache cold · next turn rewrites it";
  return `cache ${Math.round(cached.hit * 100)}% hit · cold in ~${Math.ceil(
    left / MINUTE
  )}m`;
}

/** Replies shorter than this say little about speed. */
const MIN_SPEED_TOKENS = 20;

/** The first question an AskUserQuestion call puts to the person. */
const questionOf = (input: object): string => {
  const questions = (input as { questions?: unknown }).questions;
  const first = Array.isArray(questions)
    ? (questions[0] as { question?: unknown } | undefined)
    : undefined;
  return typeof first?.question === "string"
    ? cut(first.question, 120)
    : "Waiting on your answer";
};

/**
 * Writes the record to the store when it changed since the last write: once a
 * turn ends and as the session ends, not on every tool call.
 */
async function persistWork($: EngineInterface): Promise<void> {
  const current = await read($, work);
  const text = JSON.stringify(current);
  if (text === storedWork) return;
  storedWork = text;
  await keep($, WORK_PREFIX, current);
}

/** The tools whose calls change a file, so it is listed and counted again. */
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * A changed file's lines as git counts them; `off` where git doesn't know the
 * file (outside a repository, or one .gitignore leaves out) or may not run;
 * `unknown` where git failed or ran past its timeout.
 * Git runs only for a file in the session's folder or one added with /add-dir:
 * a repository elsewhere could run its own commands through git.
 */
async function gitCounts($: EngineInterface, path: string): Promise<Counted> {
  try {
    const cwd = await $.session.cwd();
    const resolved = resolvePath(path, cwd);
    const isOwn =
      resolved !== null &&
      isInside(resolved, [cwd, ...(await read($, addedDirs))]);
    return isOwn ? await countLines($, resolved) : "off";
  } catch {
    return "unknown";
  }
}

/**
 * The record with the file at `path` given git's counts: off the list where git
 * keeps no such file, as it was where git said nothing.
 */
const withCounts = (record: Work, path: string, counts: Counted): Work => {
  if (counts === "unknown") return record;
  return {
    ...record,
    files:
      counts === "off"
        ? record.files.filter((file) => file.path !== path)
        : record.files.map((file) =>
            file.path === path ? { ...file, ...counts } : file
          ),
  };
};

/**
 * Lists the file a tool call changed first, with git's counts. The list holds
 * only files in git: one git doesn't know stays off it.
 */
async function listChanged(
  $: EngineInterface,
  tool: string,
  input: object,
  result: unknown,
  path: string
): Promise<void> {
  const counts = await gitCounts($, path);
  await update($, work, (record) =>
    withCounts(applyTool(record, tool, input, result), path, counts)
  );
}

/**
 * Counts every listed file with git again as a turn ends, so a commit or the
 * person's own edits since Claude's show, and a file git no longer knows
 * leaves the list. A file git says nothing of, failing or slow, keeps its row.
 */
async function recountFiles($: EngineInterface): Promise<void> {
  try {
    for (const { path } of (await read($, work)).files) {
      const counts = await gitCounts($, path);
      if (counts === "unknown") continue;
      const listed = (await read($, work)).files.find(
        (file) => file.path === path
      );
      if (
        listed === undefined ||
        (counts !== "off" &&
          listed.added === counts.added &&
          listed.removed === counts.removed)
      )
        continue;
      await update($, work, (record) => withCounts(record, path, counts));
    }
  } catch {
    // The counts are a nicety: the panel keeps the last ones.
  }
}

// ---------- zellij: the frame title on top and the tab's name ----------

let zellijQueue: Promise<void> = Promise.resolve();
let renameTimer: { cancel: () => void } | null = null;

/** What the pane and its tab should be called now, or null before there is a title. */
async function wantedLabels(
  $: EngineInterface
): Promise<{ pane: string; tab: string } | null> {
  const current = await read($, brief);
  const running = await read($, turn);
  const title = titleOf(current, running?.prompt ?? "");
  if (title === null) return null;
  const now = showing(current, running, await read($, live));
  return {
    pane: frameTitle(title, now, running !== null),
    tab: tabLabel(current, title, now),
  };
}

/** Brings zellij in line with the brief, one sync at a time; never throws. */
function syncZellij($: EngineInterface): void {
  zellijQueue = zellijQueue.then(() => applyZellij($)).catch(() => undefined);
}

async function applyZellij($: EngineInterface): Promise<void> {
  const told = await read($, zellij);
  if (told.paneId === null || told.isReleased) return;
  const wanted = await wantedLabels($);
  if (
    wanted === null ||
    (wanted.pane === told.paneLabel && wanted.tab === told.tabLabel)
  )
    return;

  const now = await $.clock.now();
  const wait = told.paneRenamedAt + RENAME_EVERY_MS - now;
  if (wait > 0) {
    renameTimer ??= $.clock.after(wait, () => {
      renameTimer = null;
      syncZellij($);
    });
    return;
  }

  await update($, zellij, (state) => ({ ...state, paneRenamedAt: now }));
  if (
    wanted.pane !== told.paneLabel &&
    (await renamePane($, told.paneId, wanted.pane))
  )
    await update($, zellij, (state) => ({ ...state, paneLabel: wanted.pane }));
  if (wanted.tab === told.tabLabel) return;
  const tab = await tabOf($, told.paneId);
  if (tab === null || !(await renameTab($, tab.id, wanted.tab))) return;
  // ● marked waiting before 0.5: a tab an older copy named is ours too.
  const isOurs = /\s[◐◆●✓]$/.test(tab.name);
  const hadPosition = told.tabPosition;
  await update($, zellij, (state) => ({
    ...state,
    tabId: tab.id,
    tabLabel: wanted.tab,
    tabOriginal: state.tabOriginal ?? (isOurs ? null : tab.name),
    tabPosition: tab.position,
  }));
  if (hadPosition !== tab.position) await publishPresence($);
}

/**
 * Gives the pane and the tab back the names they had before this session
 * renamed them, after any rename already under way, and holds off every
 * later one (a summary landing late) until the next turn starts.
 */
async function releaseZellij($: EngineInterface): Promise<void> {
  renameTimer?.cancel();
  renameTimer = null;
  await update($, zellij, (state) => ({ ...state, isReleased: true }));
  zellijQueue = zellijQueue.then(() => restoreNames($)).catch(() => undefined);
  await zellijQueue;
}

async function restoreNames($: EngineInterface): Promise<void> {
  const told = await read($, zellij);
  if (told.paneId === null) return;
  if (told.paneLabel !== null) await unnamePane($, told.paneId);
  if (
    told.tabId !== null &&
    told.tabLabel !== null &&
    told.tabOriginal !== null
  )
    await renameTab($, told.tabId, told.tabOriginal);
  await update($, zellij, (state) => ({
    ...state,
    paneLabel: null,
    tabLabel: null,
    tabId: null,
  }));
}

// ---------- the live line ----------

async function setLive($: EngineInterface, next: Live | null): Promise<void> {
  await update($, live, () => next);
  syncZellij($);
}

/** Notes what a model step of the main loop said it does next. */
async function noteProgress($: EngineInterface, answer: string): Promise<void> {
  const sentence = progressSentence(answer);
  if (sentence === null) return;
  await setLive($, {
    text: sentence,
    isWaiting: false,
    at: await $.clock.now(),
  });
}

// ---------- the brief, from Claude Code's title and Claude's reply ----------

/** This session's entry in Claude Code's registry, among `entries`, or read now. */
async function ownEntry(
  $: EngineInterface,
  entries?: readonly Registered[]
): Promise<Registered | null> {
  const id = await $.session.id();
  return (
    (entries ?? (await readRegistry($))).find(
      (entry) => entry.sessionId === id
    ) ?? null
  );
}

/**
 * Folds one ended turn into the brief with no model call: Haiku's title or a
 * pinned one, else Claude Code's (the prompt's own words before it has one),
 * the reply's opening and its last sentence. Nothing for `conversation` once
 * /clear or /resume replaced it.
 */
async function noteTurn(
  $: EngineInterface,
  ended: Turn | null,
  answer: string,
  conversation: string
): Promise<void> {
  if ((await $.session.id()) !== conversation) return;
  const current = await read($, brief);
  const title =
    (await ownEntry($))?.name ||
    current?.title ||
    cut(ownWords(ended?.prompt ?? ""), TITLE_MAX);
  if (title === "") return;
  await save($, briefFromTurn(current, title, answer, await $.clock.now()));
}

/** Takes Claude Code's title when it names the session; a pinned title, or Haiku's, stays. */
async function followTitle(
  $: EngineInterface,
  entries: readonly Registered[]
): Promise<void> {
  const name = (await ownEntry($, entries))?.name ?? "";
  const current = await read($, brief);
  if (name === "" || current === null || current.isPinned || current.isTitled)
    return;
  const title = cut(name, TITLE_MAX);
  if (title !== current.title)
    await save($, { ...current, title, tab: tabName(title) });
}

async function pin($: EngineInterface, title: string): Promise<void> {
  await save($, pinTitle(await read($, brief), title, await $.clock.now()));
}

async function runTitle(
  $: EngineInterface,
  title: string
): Promise<CommandRunResult> {
  if (title !== "") {
    await pin($, title);
    return { text: `Pinned the title: ${title}` };
  }
  const current = await read($, brief);
  if (current === null || !current.isPinned)
    return { text: "The title is not pinned." };
  await save($, { ...current, isPinned: false });
  return {
    text: "The title is no longer pinned: the next turn may rename it.",
  };
}

async function runRefresh($: EngineInterface): Promise<CommandRunResult> {
  const conversation = await $.session.id();
  const forked = await $.model.fork({
    prompt: refreshPrompt(await read($, brief)),
  });
  if ((await $.session.id()) !== conversation)
    return { text: "The conversation changed: the brief was left as it is." };
  if (!forked.isAnswered) {
    return {
      text:
        forked.reason === "nothing-to-fork"
          ? "Nothing to summarize yet."
          : `Could not rebuild the brief (${forked.reason}).`,
    };
  }
  const latest = await read($, brief);
  const parsed = parseReply(forked.text, latest);
  if (parsed === null)
    return { text: "Could not rebuild the brief: the summary was unreadable." };
  // The title stays Haiku's, a pinned one or Claude Code's; the rest, and a milestone it names, is the summary's.
  const title = cut((await ownEntry($))?.name || parsed.title, TITLE_MAX);
  const rebuilt = applyReply(
    latest,
    { ...parsed, title, tab: tabName(title) },
    await $.clock.now()
  );
  await save($, rebuilt);
  return {
    text: `Rebuilt the brief from the whole conversation: ${rebuilt.title}`,
  };
}

/** Counts the title calls, so an answer a newer prompt overtook changes nothing. */
let titleCalls = 0;
/** Cuts the title call still running once a newer prompt asks again. */
let stopTitle: AbortController | null = null;

/**
 * Asks Haiku for the session's title as a prompt starts, from the person's
 * prompts so far and none of Claude's replies. The band, the panel, zellij and
 * the other sessions show it once it answers, and Claude Code takes it at the
 * next prompt. A pinned title stays and costs no call; an answer that failed,
 * holds no title, was overtaken by a newer prompt or belongs to a
 * conversation /clear replaced changes nothing. Briefs are written one at a
 * time: `enqueue` queues the write.
 */
async function retitle(
  $: EngineInterface,
  prompt: string,
  enqueue: (job: () => Promise<void>) => void
): Promise<void> {
  try {
    const heard = promptForTitle(prompt);
    if (heard === "") return;
    const said = keptPrompts(await read($, prompts), heard);
    await update($, prompts, () => said);
    const current = await read($, brief);
    if (current?.isPinned === true) return;

    const call = ++titleCalls;
    stopTitle?.abort();
    const stop = new AbortController();
    stopTitle = stop;
    const conversation = await $.session.id();
    const answered = await $.model.complete(
      {
        model: TITLE_MODEL,
        prompt: titlePrompt(said, current?.isTitled ? current.title : null),
        effort: "low",
        timeoutMs: TITLE_TIMEOUT_MS,
      },
      { signal: stop.signal }
    );
    if (call !== titleCalls || !answered.isAnswered) return;
    const named = parseTitle(answered.text);
    if (named === null) return;
    enqueue(async () => {
      if ((await $.session.id()) !== conversation) return;
      const latest = await read($, brief);
      if (latest?.isPinned === true) return;
      await save(
        $,
        titledBrief(latest, named.title, named.tab, await $.clock.now())
      );
    });
  } catch {
    // The title stays as it was: Haiku's last, or Claude Code's.
  }
}

/** The mark of a session that finished while its tab was out of sight: lighter than one blocked on you. */
const UNSEEN = "◇";

/** What another session needs from the person, on the row under its name. */
function needsDetail(session: WaitingSession): string {
  switch (session.kind) {
    case "question":
      return session.detail || "asks you something";
    case "permission":
      return "wants permission";
    case "blocked":
      return "blocked";
    case "finished":
      return session.detail === "" ? "finished" : `finished: ${session.detail}`;
  }
}

const toolCalls = (count: number): string =>
  `${count} tool call${count === 1 ? "" : "s"}`;

export const register: Register = (on, options) => {
  const background = panelBackground(options);
  // Briefs are written one at a time, so each one builds on the brief the last one wrote.
  let queue: Promise<void> = Promise.resolve();
  // While a turn runs, the state line counts its time to the second.
  let secondTimer: { cancel: () => void } | null = null;
  // The lists the panel last drew cut short: the dock rows each spans, for the wheel to find, and how far it scrolls.
  let scrollable: { key: string; first: number; last: number; end: number }[] =
    [];

  const enqueue = (job: () => Promise<void>): void => {
    queue = queue.then(job).catch(() => undefined);
  };

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "brief",
      description:
        "Print the session brief, open its panel, pin its title, or rebuild it",
      argumentHint: "[panel | title <text> | refresh]",
    });
    setUpFor = null;
    await setUpSession($);
    return next(e);
  });

  // One short bound covers the whole exit: the other sessions hear first, zellij may take the rest.
  on("session.end", async ($, e, next) => {
    await publishPresence($, true);
    await persistWork($);
    await releaseZellij($);
    return next(e);
  }).catch(($, e, next) => next(e));

  // A model switch says how long the prompt cache lives.
  on("classic.PreModelSwitch", async ($, e, next) => {
    const switched = await next(e);
    await update($, cacheTtl, () => e.cache_ttl);
    return switched;
  }).catch(($, e, next) => next(e));

  on("classic.DirectoryAdded", async ($, e, next) => {
    const added = await next(e);
    const dir = resolvePath(e.directory, await $.session.cwd());
    if (dir !== null)
      await update($, addedDirs, (dirs) =>
        dirs.includes(dir) ? dirs : [...dirs, dir]
      );
    return added;
  }).catch(($, e, next) => next(e));

  // A subagent the Agent tool started: listed until its loop's turn ends.
  on("agent.spawn", async ($, e, next) => {
    const spawned = await next(e);
    try {
      // A teammate runs its loop in a pane of its own, so no event here would end it.
      if (spawned.agentId !== undefined && spawned.teammateId === undefined) {
        const run: AgentRun = {
          id: spawned.agentId,
          description: cut(e.description, 60) || e.subagentType,
          type: e.subagentType,
          startedAt: await $.clock.now(),
          activity: "",
          tokens: 0,
        };
        await update($, agents, (current) => [
          ...current.filter((one) => one.id !== run.id),
          run,
        ]);
      }
    } catch {
      // The list is a nicety: the subagent runs without its row.
    }
    return spawned;
  });

  // After each main-thread turn Claude Code measures the session: context, cost and limits.
  on("session.measure", async ($, e, next) => {
    const measured = await next(e);
    const at = await $.clock.now();
    const { tokens: filled, percent, window } = e.context;
    if (filled !== undefined && percent !== undefined) {
      await update($, usage, (before): Usage => {
        const added = before === null ? 0 : filled - before.tokens;
        return {
          tokens: filled,
          percent,
          window,
          usd: e.cost?.usd ?? before?.usd ?? null,
          growth:
            added > 0
              ? [...(before?.growth ?? []), added].slice(-GROWTH_KEPT)
              : before?.growth ?? [],
          compactedAt: before?.compactedAt ?? null,
        };
      });
    }
    await update($, limits, () =>
      e.rateLimits.map((reported): Limit => {
        const resetsAt =
          reported.resetsAt === undefined ? NaN : Date.parse(reported.resetsAt);
        return {
          kind: reported.kind,
          percent: reported.percentUsed,
          resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
        };
      })
    );
    return measured;
  }).catch(($, e, next) => next(e));

  // A compaction empties the context: its pace starts over, and the panel says it happened.
  on("session.compact", async ($, e, next) => {
    const compacted = await next(e);
    if (e.agentId === undefined) {
      const at = await $.clock.now();
      await update($, usage, (before) =>
        before === null ? null : { ...before, growth: [], compactedAt: at }
      );
    }
    return compacted;
  }).catch(($, e, next) => next(e));

  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    await setUpSession($);
    await update($, zellij, (state) => ({ ...state, isReleased: false }));
    const now = await $.clock.now();
    await update($, turn, () => ({ prompt: e.text, count: 0, startedAt: now }));
    await update($, seenAt, () => now);
    await setLive($, null);
    await update($, asked, () => null);
    void publishPresence($);
    // Haiku names the session while the turn runs; the turn never waits on it.
    void retitle($, e.text, enqueue);
    secondTimer?.cancel();
    secondTimer = $.clock.every(SECOND, () => {
      void $.clock.now().then((at) => update($, tick, () => at));
    });
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const startedAt = await $.clock.now();
    const stepped = yield* next(e);
    try {
      const ms = (await $.clock.now()) - startedAt;
      await noteReply($, e.agentId, e.model, e.effort, stepped.usage, ms);
      if (e.agentId === undefined) {
        await noteProgress($, stepped.answer);
        if (stepped.usage !== null)
          await noteCache($, stepped.usage, startedAt);
      } else if (stepped.usage !== null) {
        // What its last reply held, as Claude Code counts a subagent's tokens.
        const used = stepped.usage;
        const tokens =
          used.input_tokens +
          used.cache_read_input_tokens +
          used.cache_creation_input_tokens +
          used.output_tokens;
        await updateAgent($, e.agentId, (run) => ({ ...run, tokens }));
      }
    } catch {
      // The live line and the figures are a nicety: a step goes on without them.
    }
    return stepped;
  });

  on("tool.call", async ($, e, next) => {
    if (e.agentId !== undefined) {
      const doing = describeActivity(String(e.tool), e);
      if (doing !== null)
        await updateAgent($, e.agentId, (run) => ({
          ...run,
          activity: doing.text,
        }));
      return next(e);
    }
    const tool = String(e.tool);
    await update($, turn, (current) =>
      current === null ? null : { ...current, count: current.count + 1 }
    );
    const activity = describeActivity(tool, e);
    if (activity !== null)
      await setLive($, { ...activity, at: await $.clock.now() });
    if (activity?.isWaiting === true) {
      const at = await $.clock.now();
      await update($, asked, (): Asked => ({ at, question: questionOf(e) }));
      await publishPresence($);
    }

    const ran = await next(e);
    if (!("deny" in ran && ran.deny !== undefined)) {
      const before = await read($, work);
      const after = applyTool(before, tool, e, ran.result);
      if (after !== before) {
        // The store takes the record once the turn ends (persistWork).
        const changed = after.files[0];
        if (FILE_TOOLS.has(tool) && changed !== undefined) {
          await listChanged($, tool, e, ran.result, changed.path);
          void refreshRepo($);
        }
        // Onto the record as it is now: calls Claude makes at once each add their own change.
        else
          await update($, work, (record) =>
            applyTool(record, tool, e, ran.result)
          );
      }
    }
    if (activity?.isWaiting === true) {
      await update($, asked, () => null);
      await setLive($, null);
      await publishPresence($);
    }
    return ran;
  }).catch(($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId !== undefined) {
      // A subagent's loop ended: it leaves the list.
      try {
        await update($, agents, (current) =>
          current.filter((run) => run.id !== e.agentId)
        );
      } catch {
        // Its row goes at the next look (lookAtAgents).
      }
      return done;
    }

    secondTimer?.cancel();
    secondTimer = null;
    const ended = await read($, turn);
    await update($, turn, () => null);
    await update($, live, () => null);
    await update($, asked, () => null);
    const endedAt = await $.clock.now();
    await update($, lastTurnAt, () => endedAt);
    if (ended !== null)
      await update($, lastTurnMs, () => endedAt - ended.startedAt);
    syncZellij($);
    void publishPresence($);
    void refreshRepo($);
    void recountFiles($).then(() => persistWork($));
    await persistWork($);

    const isEmpty =
      (ended?.prompt ?? "") === "" &&
      e.answer === "" &&
      (ended?.count ?? 0) === 0;
    if (e.reason === "error" || e.reason === "refusal" || isEmpty) return done;

    const conversation = await $.session.id();
    enqueue(() => noteTurn($, ended, e.answer, conversation));
    return done;
  });

  on("command.run", { command: "brief" }, async ($, e) => {
    const args = e.args.trim();
    if (args === "refresh") return runRefresh($);
    if (args === "panel") {
      await $.ui.open(PANEL_OPEN);
      return { text: "Opened the brief panel." };
    }
    if (args === "title" || args.startsWith("title "))
      return runTitle($, args.slice("title".length).trim());
    if (args !== "") return { text: USAGE };

    const current = await read($, brief);
    if (current === null)
      return { text: "No brief yet: it appears once Claude has replied." };
    return { text: formatBrief(current, await $.clock.now()) };
  }).catch(() => ({
    text: "The brief could not be read: see claude --debug.",
  }));

  // Haiku's title, or one pinned with /brief title or /rename, is handed to Claude Code at the next prompt.
  on("classic.UserPromptSubmit", async ($, e, next) => {
    const submitted = await next(e);
    const current = await read($, brief);
    if (
      current === null ||
      !(current.isPinned || current.isTitled) ||
      e.session_title === current.title
    )
      return submitted;
    return { ...submitted, sessionTitle: current.title };
  }).catch(($, e, next) => next(e));

  // A title the person gives with /rename is theirs: pinned, so Haiku names the session no more.
  on("command.run", { command: "rename" }, async ($, e, next) => {
    const renamed = await next(e);
    const title = e.args.trim();
    if (title !== "") enqueue(() => pin($, title));
    return renamed;
  }).catch(($, e, next) => next(e));

  // Closed by hand, the panel stays closed for the rest of the session; /brief panel brings it back.
  on("ui.close", { id: PANEL }, async ($, e, next) => {
    if (e.origin.kind === "person") await update($, isPanelClosed, () => true);
    return next(e);
  }).catch(($, e, next) => next(e));

  // The panel is exactly the dock's height, so the wheel never moves it: over a list cut short it
  // moves that list alone, an item a row. Elsewhere, and for the scroll keys, Claude Code's own.
  on(
    "ui.scroll",
    { component: "Pane", requestId: PANEL },
    async ($, e, next) => {
      const row = e.pointer?.row;
      const list = scrollable.find(
        (view) => row !== undefined && row >= view.first && row <= view.last
      );
      if (list === undefined) return next(e);
      // Ticks come faster than the panel draws: each moves the list from where the last left it.
      const within = (offset: number) =>
        Math.min(Math.max(offset, 0), list.end);
      await update($, scrolled, (was) => {
        const from = within(was[list.key] ?? 0);
        const to = within(from + e.by);
        return to === was[list.key] ? was : { ...was, [list.key]: to };
      });
      return {};
    }
  ).catch(($, e, next) => next(e));

  // In the fullscreen layout a pane docks beside the transcript, so the panel opens by itself. The
  // terminal raises no session.attach: the band's drawing is the first place that says it is fullscreen.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (!(await isSetUp($))) askForSetUp($);
    if (e.viewport?.isFullscreen === true) {
      const panel = (await $.ui.panes()).find((pane) => pane.id === PANEL);
      if (panel === undefined && !(await read($, isPanelClosed)))
        void $.ui.open(PANEL_OPEN).catch(() => {});
      if (panel?.isPlaced === true && panel.isShown) return next(e);
    }

    const current = await read($, brief);
    if (e.props.hasSurvey || current === null) return next(e);

    const { Box, Text } = $.ui.resolve(e);
    await read($, tick);
    const now = await $.clock.now();
    const running = await read($, turn);
    const doing = await read($, live);
    const plan = planView(await read($, work), current);
    const endedAt = (await read($, lastTurnAt)) ?? current.updatedAt;
    const idle = now - endedAt;
    const isRecap = !e.props.isWorking && idle >= RECAP_AFTER_MS;
    const doingItem = plan?.items.find((item) => item.status === "doing");

    const state = e.props.isWorking ? (
      <Box key="state" flexDirection="row">
        <Text color="suggestion">◐ Working</Text>
        {running !== null && (
          <Text dimColor>{` · ${toolCalls(running.count)}`}</Text>
        )}
        {doing !== null && <Text>{` · ${doing.text}`}</Text>}
      </Box>
    ) : (
      <Box key="state" flexDirection="row">
        {current.now.state === "waiting" && (
          <Text color="warning" bold>
            {GLYPH.waiting} {STATE_LABEL.waiting}
          </Text>
        )}
        {current.now.state === "done" && (
          <Text color="success">✓ {STATE_LABEL.done}</Text>
        )}
        {current.now.state === "working" && (
          <Text color="suggestion">◐ {STATE_LABEL.working}</Text>
        )}
        {current.now.text !== "" && <Text>{`  ${current.now.text}`}</Text>}
      </Box>
    );

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box key="head" flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" flexShrink={1}>
            <Text color="claude">✻ </Text>
            <Text bold wrap="truncate-end">
              {current.title}
            </Text>
          </Box>
          <Box paddingLeft={2} flexShrink={0}>
            {isRecap ? (
              <Text color="claude">{`you were away ${span(idle)}`}</Text>
            ) : (
              <Text dimColor>{updatedAgo(now - current.updatedAt)}</Text>
            )}
          </Box>
        </Box>
        {current.story !== "" && (
          <Box key="story" paddingLeft={2}>
            <Text dimColor wrap="wrap">
              {current.story}
            </Text>
          </Box>
        )}
        {isRecap &&
          current.steps.slice(-RECAP_STEPS).map((step, i) => (
            <Box key={`step-${i}`} flexDirection="row" paddingLeft={2}>
              <Text dimColor>{`${span(now - step.at)} ago`.padEnd(9)}</Text>
              <Text>{step.text}</Text>
            </Box>
          ))}
        {plan !== null && (
          <Box key="plan" flexDirection="row" paddingLeft={2}>
            <Text dimColor>
              {plan.source === "todos"
                ? `Plan ${plan.done} of ${plan.items.length} done`
                : "Plan (from the summary)"}
            </Text>
            {doingItem !== undefined && (
              <Text>{` · ${GLYPH.working} ${doingItem.text}`}</Text>
            )}
          </Box>
        )}
        <Box paddingLeft={2}>{state}</Box>
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANEL }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    await read($, tick);
    const width = Math.max(24, e.props.bodyColumns - 2 * PANEL_PADDING_X);
    const now = await $.clock.now();
    const current = await read($, brief);
    const running = await read($, turn);
    const doing = await read($, live);
    const question = await read($, asked);
    const recorded = await read($, work);
    const measured = await read($, usage);
    const windows = (await read($, limits)).filter(isShownLimit);
    const replySpeeds = await read($, speeds);
    const lastMs = await read($, lastTurnMs);
    const endedAt = (await read($, lastTurnAt)) ?? current?.updatedAt ?? now;
    const elsewhere = await read($, others);
    const repoNow = await read($, repo);
    const cached = await read($, cache);
    const ttl = await read($, cacheTtl);
    const engine = await read($, about);
    if (engine === null || !(await isSetUp($))) askForSetUp($);
    const runningAgents = await read($, agents);
    const offsets = await read($, scrolled);
    const plan = planView(recorded, current);
    const title = titleOf(current, running?.prompt ?? "");

    type Part = { text: string; tone?: Tone; bold?: boolean; dim?: boolean };
    const parts = (key: string, list: Part[]) =>
      list.map((part, i) => (
        <Text
          key={`${key}-${i}`}
          color={part.tone === undefined ? undefined : PALETTE[part.tone]}
          bold={part.bold}
          dimColor={part.dim}
        >
          {part.text}
        </Text>
      ));
    /** `list` in at most `room` cells, the part that crosses the edge ending in …. */
    const clipParts = (list: Part[], room: number): Part[] => {
      const kept: Part[] = [];
      let left = room;
      for (const part of list) {
        if (left <= 0) break;
        const shown = clip(part.text, left);
        kept.push({ ...part, text: shown });
        left -= cells(shown);
        if (shown !== part.text) break;
      }
      return kept;
    };
    /** One row exactly `width` cells wide: the right part ends on the last cell, the left cut to make room. */
    const row = (key: string, left: Part[], right: Part[] = []) => {
      const rightText = right.map((p) => p.text).join("");
      const fitted = clipParts(left, width - cells(rightText) - 1);
      return (
        <Box key={key} flexDirection="row">
          {parts(`${key}-l`, fitted)}
          <Text>
            {gap(fitted.map((p) => p.text).join(""), rightText, width)}
          </Text>
          {parts(`${key}-r`, right)}
        </Box>
      );
    };
    /** One row of parts, cut at the panel's edge. */
    const line = (key: string, list: Part[]) => (
      <Box key={key} flexDirection="row">
        {parts(key, clipParts(list, width))}
      </Box>
    );
    const blank = (key: string) => <Text key={key}> </Text>;
    const heading = (text: string): Part => ({ text, dim: true });

    // ---------- the state line and NOW ----------
    let state: Part | null = null;
    let nowLine: Part | null = null;
    let nowDetail = "";
    if (question !== null) {
      state = {
        text: `${GLYPH.waiting} Waiting on you · ${span(now - question.at)}`,
        tone: "warning",
      };
      nowLine = {
        text: `${GLYPH.waiting} ${question.question}`,
        tone: "warning",
      };
      nowDetail = `  asked ${span(now - question.at)} ago`;
    } else if (running !== null) {
      state = {
        text: `◐ Working · ${elapsed(now - running.startedAt)}`,
        tone: "suggestion",
      };
      nowLine = { text: `◐ ${doing?.text ?? "Working"}`, tone: "suggestion" };
      nowDetail = `  ${toolCalls(running.count)} this turn`;
    } else if (current !== null) {
      const said = current.now.text;
      if (current.now.state === "waiting") {
        state = {
          text: `${GLYPH.waiting} Waiting on you · ${span(now - endedAt)}`,
          tone: "warning",
        };
        nowLine = {
          text: `${GLYPH.waiting} ${said || STATE_LABEL.waiting}`,
          tone: "warning",
        };
        nowDetail = `  asked ${span(now - endedAt)} ago`;
      } else if (current.now.state === "working") {
        state = { text: `◐ ${STATE_LABEL.working}`, tone: "suggestion" };
        nowLine = {
          text: `◐ ${said || STATE_LABEL.working}`,
          tone: "suggestion",
        };
      } else {
        state = {
          text: `✓ Done${lastMs === null ? "" : ` · ${elapsed(lastMs)}`}`,
          tone: "success",
        };
        nowLine = { text: `✓ ${said || STATE_LABEL.done}`, tone: "success" };
        nowDetail = `  replied ${span(now - endedAt)} ago`;
      }
    }

    // Every row below is one terminal row: long texts are wrapped here, the rest clipped,
    // so the panel can count its rows and fit itself to the dock.
    type Row = ReturnType<typeof line>;
    const text = (key: string, value: string, style: Omit<Part, "text"> = {}) =>
      line(key, [{ ...style, text: value }]);
    const rolled = (
      key: string,
      label: Part,
      left: Part[],
      right: Part[] = []
    ) =>
      row(
        key,
        [label, ...(left.length > 0 ? [{ text: "  " }, ...left] : [])],
        right
      );
    const label = (name: string): Part => ({ text: `▸ ${name}`, dim: true });
    /** A note's rows: wrapped, never cut, since a time or a count in it is the point. */
    const noteRows = (key: string, note: Note): Row[] =>
      note === null
        ? []
        : wrapText(note.text, width).map((part, i) =>
            line(`${key}-${i}`, [
              {
                text: part,
                tone: note.tone === "subtle" ? undefined : note.tone,
                dim: note.tone === "subtle",
              },
            ])
          );

    // ---------- always drawn: the title, the state line and the footer ----------
    const titleRows: Row[] =
      title === null
        ? wrapText(
            "No brief yet: it appears once Claude has replied.",
            width
          ).map((part, i) => text(`title-${i}`, part, { dim: true }))
        : [text("title", title, { bold: true })];
    const stateRows: Row[] = state === null ? [] : [line("state", [state])];
    // In a linked worktree the path is the main repository's, and the worktree is named under it.
    const worktree = repoNow?.worktree ?? null;
    const footerRows: Row[] =
      engine === null
        ? []
        : [
            text("where", whereLine(worktree?.main ?? engine.path, repoNow), {
              dim: true,
            }),
            ...(worktree === null
              ? []
              : [
                  line("worktree", [
                    { text: "⎇ worktree ", dim: true },
                    { text: worktree.name },
                  ]),
                ]),
            line(
              "engine",
              engineParts(
                engine.version,
                engine.latest,
                engine.model,
                engine.effort,
                width
              )
            ),
          ];

    // ---------- the sections, each in its forms: fullest first, hidden last ----------
    /** A form that lists items, as many as the dock has room for: its heading rows, each item's rows, and the row counting the rest. */
    type Listing = {
      head: Row[];
      items: Row[][];
      more: (count: number) => Row;
    };
    const isListing = (form: Row[] | Listing): form is Listing =>
      !Array.isArray(form);
    const moreRow =
      (key: string, unit = "") =>
      (count: number) =>
        text(`${key}-more`, `… ${count} more${unit}`, { dim: true });
    const blocks: Record<string, (Row[] | Listing)[]> = {};

    if (
      current !== null &&
      (current.story !== "" || current.steps.length > 0)
    ) {
      const head = text("recap", "RECAP", { dim: true });
      const story = wrapText(current.story, width).map((part, i) =>
        text(`story-${i}`, part)
      );
      const steps = recentSteps(current, now);
      const stepRows =
        steps === null ? [] : [text("steps", steps, { dim: true })];
      blocks.recap = [
        [head, ...story, ...stepRows],
        [head, ...story],
        [
          rolled(
            "recap-rolled",
            label("RECAP"),
            current.story === "" ? [] : [{ text: current.story }],
            [{ text: `+${story.length + stepRows.length} lines`, dim: true }]
          ),
        ],
        [],
      ];
    }

    if (plan !== null) {
      const counted = planCount(plan.items);
      const done = plan.items.filter((item) => item.status === "done").length;
      const doingItem = plan.items.find((item) => item.status === "doing");
      const next = plan.items.find((item) => item.status === "next");
      const folded = foldedDone(plan.items, width);
      const lead: Part =
        doingItem !== undefined
          ? { text: `${GLYPH.working} ${doingItem.text}`, bold: true }
          : next !== undefined
          ? { text: `○ ${next.text}` }
          : { text: "✓ all done", tone: "success" };
      blocks.plan = [
        {
          head: [
            row(
              "plan",
              [heading("PLAN")],
              plan.source === "todos"
                ? [
                    { text: counted.done, tone: "success" },
                    { text: counted.left, dim: true },
                    { text: counted.count, dim: true },
                  ]
                : [heading("from the summary")]
            ),
            ...(folded === null
              ? []
              : [text("plan-done", folded, { dim: true })]),
          ],
          items: plan.items
            .filter((item) => item.status !== "done")
            .map((item) => [
              text(
                `plan-${item.id}`,
                `${item.status === "doing" ? GLYPH.working : "○"} ${item.text}`,
                { bold: item.status === "doing" }
              ),
            ]),
          more: moreRow("plan"),
        },
        [
          rolled(
            "plan-rolled",
            label("PLAN"),
            [lead],
            [{ text: `${done} / ${plan.items.length}`, dim: true }]
          ),
        ],
        [],
      ];
    }

    if (nowLine !== null) {
      const head = text("now", "NOW", { dim: true });
      blocks.now = [
        [
          head,
          ...wrapText(nowLine.text, width).map((part, i) =>
            line(`now-line-${i}`, [{ ...nowLine, text: part }])
          ),
          ...(nowDetail === ""
            ? []
            : [text("now-detail", nowDetail, { dim: true })]),
        ],
        [head, line("now-line", [nowLine])],
        [line("now-rolled", [heading("NOW  "), nowLine])],
      ];
    }

    // ---------- the subagents running now: what each does, for how long, at what size ----------
    if (runningAgents.length > 0) {
      const count: Part = {
        text: `${runningAgents.length} running`,
        dim: true,
      };
      const head = row("agents", [heading("AGENTS")], [count]);
      const nameRow = (run: AgentRun, i: number) =>
        row(
          `agent-${i}`,
          [{ text: `${GLYPH.working} ${run.description}`, tone: "suggestion" }],
          [
            {
              text:
                run.tokens > 0
                  ? `${span(now - run.startedAt)} · ${short(run.tokens)}`
                  : span(now - run.startedAt),
              dim: true,
            },
          ]
        );
      const more = moreRow("agents");
      blocks.agents = [
        {
          head: [head],
          items: runningAgents.map((run, i) => [
            nameRow(run, i),
            ...(run.activity === ""
              ? []
              : [text(`agent-${i}-doing`, `  ${run.activity}`, { dim: true })]),
          ]),
          more,
        },
        {
          head: [head],
          items: runningAgents.map((run, i) => [nameRow(run, i)]),
          more,
        },
        [
          rolled(
            "agents-rolled",
            label("AGENTS"),
            [{ text: runningAgents[0]?.description ?? "" }],
            [count]
          ),
        ],
        [],
      ];
    }

    if (recorded.files.length > 0) {
      const rows = changedRows(recorded.files);
      const added = recorded.files.reduce(
        (sum, file) => sum + (file.added ?? 0),
        0
      );
      const removed = recorded.files.reduce(
        (sum, file) => sum + (file.removed ?? 0),
        0
      );
      const count = recorded.files.length;
      const counts: Part[] = [
        ...(added > 0 ? [{ text: `+${added}`, tone: "success" as const }] : []),
        ...(removed > 0
          ? [
              {
                text: `${added > 0 ? " " : ""}−${removed}`,
                tone: "error" as const,
              },
            ]
          : []),
        {
          text: `${added + removed > 0 ? " · " : ""}${count} ${
            count === 1 ? "file" : "files"
          }`,
          dim: true,
        },
      ];
      blocks.changed = [
        {
          head: [row("changed", [heading("CHANGED")], counts)],
          items: rows.map((file, i) => [
            row(
              `file-${i}`,
              [{ text: cut(file.name, width - 12) }],
              [
                { text: file.plus, tone: "success" },
                { text: file.minus, tone: "error" },
              ]
            ),
          ]),
          more: moreRow("changed", " files"),
        },
        [row("changed-rolled", [label("CHANGED")], counts)],
        [],
      ];
    }

    if (measured !== null) {
      const tone = contextTone(measured.percent);
      const filled = bar(measured.percent, width);
      const percent: Part = {
        text: `${Math.round(measured.percent)}%`,
        bold: true,
        tone: measured.percent >= 80 ? tone : undefined,
      };
      const tokens: Part = {
        text: `${short(measured.tokens)} of ${short(measured.window)} tokens`,
        dim: true,
      };
      const gauge = [
        row(
          "context",
          [heading("CONTEXT")],
          measured.usd === null
            ? []
            : [{ text: `$${measured.usd.toFixed(2)} spent`, dim: true }]
        ),
        row("context-fill", [percent], [tokens]),
        line("context-bar", [
          { text: filled.filled, tone },
          { text: filled.empty, tone: "track" },
        ]),
      ];
      const notes = noteRows("context-note", contextNote(measured, now));
      const cacheRows =
        cached === null
          ? []
          : [text("context-cache", cacheLine(cached, ttl, now), { dim: true })];
      blocks.context = [
        [...gauge, ...cacheRows, ...notes],
        gauge,
        [rolled("context-rolled", label("CONTEXT"), [percent], [tokens])],
        [],
      ];
    }

    if (replySpeeds.length > 0) {
      const speed = speedSummary(replySpeeds);
      const latest: Part = { text: `${speed.latest} t/s`, bold: true };
      const summary: Part = {
        text: `avg ${speed.avg} · peak ${speed.peak}`,
        dim: true,
      };
      blocks.speed = [
        [
          row("speed", [heading("SPEED")], [summary]),
          line("speed-line", [
            latest,
            { text: "  " },
            { text: sparkline(replySpeeds), tone: "suggestion" },
          ]),
        ],
        [rolled("speed-rolled", label("SPEED"), [latest], [summary])],
        [],
      ];
    }

    if (windows.length > 0) {
      // Each window: its name, percent and reset, then its bar; no note under it.
      const windowRows = windows.flatMap((limit) => {
        const tone = limitTone(limit.percent);
        const filled = bar(limit.percent, width);
        return [
          row(
            `limit-${limit.kind}`,
            [
              { text: limitName(limit), bold: true },
              { text: "  " },
              { text: `${Math.round(limit.percent)}%`, tone, bold: true },
            ],
            [{ text: resetLabel(limit), dim: true }]
          ),
          line(`limit-${limit.kind}-bar`, [
            { text: filled.filled, tone },
            { text: filled.empty, tone: "track" },
          ]),
        ];
      });
      const head = text("limits", "LIMITS", { dim: true });
      blocks.limits = [
        [head, ...windowRows],
        [
          rolled(
            "limits-rolled",
            label("LIMITS"),
            windows.flatMap((limit, i): Part[] => [
              ...(i > 0 ? [{ text: " · ", dim: true }] : []),
              { text: `${limitName(limit)} ` },
              {
                text: `${Math.round(limit.percent)}%`,
                tone: limitTone(limit.percent),
                bold: true,
              },
            ])
          ),
        ],
        [],
      ];
    }

    if (elsewhere !== null && elsewhere.waiting.length > 0) {
      const count: Part = {
        text: `${elsewhere.waiting.length} of ${elsewhere.open} sessions`,
        dim: true,
      };
      const needsLabel: Part = {
        text: "NEEDS YOU",
        tone: "warning",
        bold: true,
      };
      // ◆ blocked on the person (asking, wanting permission, blocked in the background); ◇ finished out of sight.
      const names = elsewhere.waiting.map((session, i) => {
        const isFinished = session.kind === "finished";
        return row(
          `waiting-${i}`,
          [
            {
              text: `${isFinished ? UNSEEN : GLYPH.waiting} ${session.name}`,
              tone: isFinished ? "suggestion" : "warning",
              bold: !isFinished,
            },
          ],
          [
            {
              text: `${session.where} · ${
                session.kind === "blocked"
                  ? "background"
                  : span(now - session.since)
              }`,
              dim: true,
            },
          ]
        );
      });
      const head = row("needs-you", [needsLabel], [count]);
      const more = moreRow("waiting");
      blocks.needs = [
        {
          head: [head],
          items: names.map((name, i) => {
            const session = elsewhere.waiting[i];
            return session === undefined
              ? [name]
              : [name, text(`waiting-${i}-detail`, needsDetail(session))];
          }),
          more,
        },
        { head: [head], items: names.map((name) => [name]), more },
        [
          row(
            "needs-rolled",
            [{ ...needsLabel, text: "▸ NEEDS YOU" }],
            [count]
          ),
        ],
        [],
      ];
    }

    // ---------- fitting: the fullest forms that fit the dock, the footer always ----------
    const fit = fitBlocks(
      Object.fromEntries(
        Object.entries(blocks).map(([key, forms]) => [
          key,
          forms.map((form) =>
            isListing(form)
              ? {
                  head: form.head.length,
                  items: form.items.map((item) => item.length),
                }
              : form.length
          ),
        ])
      ),
      FIT_ORDER,
      e.props.scroll.bodyRows - 2 * PANEL_PADDING_Y,
      titleRows.length + stateRows.length + footerRows.length
    );
    /** A listing's rows: the items its window shows, with a row counting those above and one those below. */
    const listingRows = (
      key: string,
      form: Listing,
      view: ListWindow
    ): Row[] => {
      const below = form.items.length - view.first - view.count;
      return [
        ...form.head,
        ...(view.first > 0
          ? [text(`${key}-above`, `↑ ${view.first} above`, { dim: true })]
          : []),
        ...form.items.slice(view.first, view.first + view.count).flat(),
        ...(below > 0 ? [form.more(below)] : []),
      ];
    };
    /** A group's rows, and the rows of it each list the dock cuts short spans, from the group's top. */
    const group = (keys: readonly string[]) => {
      const rows: Row[] = [];
      const lists: typeof scrollable = [];
      for (const key of keys) {
        const form = blocks[key]?.[fit.form[key] ?? 0] ?? [];
        let view: ListWindow | null = null;
        let drawn: Row[] = [];
        if (isListing(form)) {
          view = scrollWindow(
            form.items.map((item) => item.length),
            fit.listed[key] ?? 0,
            offsets[key] ?? 0
          );
          drawn = listingRows(key, form, view);
        } else drawn = form;
        if (drawn.length === 0) continue;
        if (fit.hasGaps) rows.push(blank(`${key}-gap`));
        if (view !== null && view.end > 0)
          lists.push({
            key,
            first: rows.length,
            last: rows.length + drawn.length - 1,
            end: view.end,
          });
        rows.push(...drawn);
      }
      return { rows, lists };
    };
    const hiddenRows =
      fit.hidden.length === 0
        ? []
        : [
            text(
              "hidden",
              `▸ hidden: ${fit.hidden
                .map((key) => SECTION_NAMES[key] ?? key)
                .join(" · ")}`,
              { dim: true }
            ),
          ];
    const footerBlock = [
      ...(fit.hasGaps && footerRows.length + hiddenRows.length > 0
        ? [blank("footer-gap")]
        : []),
      ...hiddenRows,
      ...footerRows,
    ];
    const top = group(TOP_SECTIONS);
    const bottom = group(BOTTOM_SECTIONS);
    // The top group starts under the title and the state line; the bottom group ends on the footer.
    const shift = (lists: typeof scrollable, by: number) =>
      lists.map((list) => ({
        ...list,
        first: list.first + by,
        last: list.last + by,
      }));
    scrollable = [
      ...shift(
        top.lists,
        PANEL_PADDING_Y + titleRows.length + stateRows.length
      ),
      ...shift(
        bottom.lists,
        e.props.scroll.bodyRows -
          PANEL_PADDING_Y -
          footerBlock.length -
          bottom.rows.length
      ),
    ];

    // Exactly the dock's height; the spare rows fall between CHANGED and CONTEXT. Should even the
    // smallest forms not fit, the top gives way from its end and the bottom from its start, never the footer.
    return (
      <Box
        flexDirection="column"
        width={width + 2 * PANEL_PADDING_X}
        height={e.props.scroll.bodyRows}
        paddingX={PANEL_PADDING_X}
        paddingY={PANEL_PADDING_Y}
        backgroundColor={background}
      >
        <Box
          key="top"
          flexDirection="column"
          flexShrink={1000}
          minHeight={0}
          overflow="hidden"
        >
          <Box flexDirection="column" flexShrink={0}>
            {[...titleRows, ...stateRows, ...top.rows]}
          </Box>
        </Box>
        <Box key="spacer" flexGrow={1} />
        <Box
          key="bottom"
          flexDirection="column"
          justifyContent="flex-end"
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
        >
          <Box flexDirection="column" flexShrink={0}>
            {bottom.rows}
          </Box>
        </Box>
        <Box key="footer" flexDirection="column" flexShrink={0}>
          {footerBlock}
        </Box>
      </Box>
    );
  });
};
