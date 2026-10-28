import { mock } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";
import type {
  AgentStatus,
  ModelCompleteInput,
  ModelCompleteResult,
  ModelForkRequest,
  ModelForkResult,
  On,
  RenderNode,
  RenderPropsOf,
} from "claude-code";

export const PLUGIN = "sidecar";
export const SESSION = "sess-1";
export const MINUTE = 60_000;
export const START = Date.UTC(2026, 9, 19, 13, 0);

const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * What the faked Anthropic API answers one call with: the reply's text, a
 * reply held until the mocked clock passes `afterMs`, or a failure.
 */
export type Reply =
  | string
  | { text: string; afterMs: number }
  | { fail: "api-error" | "empty-reply" | "aborted" | "nothing-to-fork" };

export const reply = (fields: Record<string, unknown>): string =>
  JSON.stringify(fields);

/** The pane this session's Claude Code runs in, as the fake zellij knows it. */
export const PANE_ID = "14";
export const TAB_ID = 4;
export const TAB_NAME = "Tab #5";

/**
 * Stands in for the `zellij` binary at the process edge: one session with a
 * shell tab and the tab holding this Claude pane. It answers the actions the
 * mod runs, keeps the names they set, and can be switched off to fail.
 */
export type FakeZellij = {
  /** Every `zellij` command line the mod ran, oldest first. */
  runs: string[][];
  /** The pane's name as set by `rename-pane`; null when unset or undone. */
  paneName: string | null;
  /** The tab's name, as `rename-tab-by-id` left it. */
  tabName: string;
  /** While true, every command exits 1, as a zellij that is gone does. */
  isDown: boolean;
  /** How long each command takes on the mocked clock, as a busy zellij does; 0 answers at once. */
  delayMs: number;
  /** The tab on screen, as `current-tab-info` names it: another tab than this session's unless a test says. */
  activeTabId: number;
};

/**
 * Stands in for the `git` binary at the process edge: the project's changes
 * against the last commit, by absolute path, as `git diff --numstat` counts
 * them ("12\t3", or "-\t-" for a binary file), the untracked files with
 * their line counts, and the untracked files .gitignore leaves out. Switched
 * off, every command fails as outside a repo.
 */
export type FakeGit = {
  changed: Record<string, string>;
  untracked: Record<string, number>;
  ignored: string[];
  /** What `git status --porcelain=v2 --branch` prints for the session's repository. */
  status: string;
  isDown: boolean;
  /** The linked worktree the session runs in: its folder and the main repository's .git; null in a normal checkout. */
  worktree: { root: string; commonDir: string } | null;
  /**
   * The repository's own `core.fsmonitor` command, as a hostile `.git/config` sets it: git runs
   * it on status, diff and ls-files unless the command line turns it off; null when unset.
   */
  fsmonitor: string | null;
  /** The folders git ran the fsmonitor command in, oldest first. */
  fsmonitorRuns: string[];
  /** The folder of every git command the mod ran (`-C <dir>`), oldest first. */
  dirs: string[];
  /** Files added to the index of a repository with no commit yet, with their line counts. */
  staged: Record<string, number>;
  /** True in a repository with no commit yet: `HEAD` names nothing, so every file is new. */
  isUnborn: boolean;
  /** While true, every command outlasts its timeout, as git does in a huge repository: the call rejects. */
  isTimingOut: boolean;
  /**
   * The folders where git wrote `.git/index` back, oldest first: `status` and `diff HEAD` refresh
   * it whenever they can take its lock, unless `--no-optional-locks` says not to, and a commit the
   * person runs meanwhile fails on the lock.
   */
  indexWrites: string[];
};

/** The person's home, and the repository the session runs in, under it. */
export const HOME = "/home/dev";
export const CWD = `${HOME}/.dotfiles`;
/** Where sessions keep their presence files. */
export const PRESENCE = `${HOME}/.claude/sidecar/presence`;
/** Where Claude Code registers every running session: one `<pid>.json` each. */
export const SESSIONS = `${HOME}/.claude/sessions`;
/** This session's process, as Claude Code's registry names it. */
export const PID = 4242;

/** One session's entry in Claude Code's registry, as Claude Code writes it. */
export type RegistryEntry = {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: "interactive" | "background";
  /** Claude Code's title for the session: its generator's, or /rename's. */
  name?: string;
  status: "busy" | "idle" | "waiting";
  /** What a waiting session waits for: "permission prompt", "input needed", "dialog open", ... */
  waitingFor?: string;
  startedAt: number;
  updatedAt: number;
  statusUpdatedAt: number;
};

/** Writes a session's registry entry, as Claude Code does when its state changes. */
export function register(
  harness: Harness,
  entry: Partial<RegistryEntry> & { pid: number; sessionId: string }
): void {
  const now = harness.clock.now();
  const path = `${SESSIONS}/${entry.pid}.json`;
  const before = JSON.parse(
    harness.files[path] ?? "{}"
  ) as Partial<RegistryEntry>;
  harness.files[path] = JSON.stringify({
    cwd: CWD,
    kind: "interactive",
    status: "idle",
    startedAt: START,
    ...before,
    ...entry,
    updatedAt: now,
    statusUpdatedAt:
      entry.status === undefined ? before.statusUpdatedAt ?? now : now,
  });
  harness.mtimes[path] = now;
}

/** Claude Code names this session (its title generator, or /rename): its registry entry's name. */
export function nameSession(harness: Harness, name: string): void {
  register(harness, { pid: PID, sessionId: harness.sessionId, name });
}
/** This session's tab's position in the zellij session: "tab 3" to the others. */
export const TAB_POSITION = 2;

/** One model reply in a step: Claude's text, what it cost and how long it streamed. */
export type StepPlan = {
  text: string;
  model?: string;
  input?: number;
  output?: number;
  /** Prompt tokens the reply read from the cache, and wrote to it. */
  cacheRead?: number;
  cacheWrite?: number;
  ms?: number;
};

export type Harness = {
  clock: MockClock;
  git: FakeGit;
  /** The Haiku requests the mod made, oldest first: one per prompt, naming the session. */
  asked: ModelCompleteInput[];
  /** The full-transcript forks the mod made, oldest first. */
  forked: ModelForkRequest[];
  /** What the next Haiku calls answer, in order; once none is queued, Haiku is down (an API error). */
  replies: Reply[];
  /** What the next forks answer, in order. */
  forkReplies: Reply[];
  /** Toasts and log lines the mod showed. */
  shownLines: string[];
  zellij: FakeZellij;
  /** The panes the mod opened, by id, with whether the person asked for each. */
  opened: { id: string; title: string }[];
  /** Every `$.ui.open` the mod made, by pane id, oldest first. */
  opens: string[];
  /** The dock width each of those opens asked for, in body columns. */
  openWidths: (number | undefined)[];
  /** What the next model steps of a turn answer, in order. */
  stepPlans: StepPlan[];
  /** The files the mod's `$.fs` reads and writes, by absolute path. */
  files: Record<string, string>;
  /** Whether a pane opened now would be placed, as a wide fullscreen terminal does. */
  canPlace: boolean;
  /** The version Claude Code's release server names latest; null while it cannot be reached. */
  latestRelease: string | null;
  /** The conversation Claude Code runs now: /clear and /resume change it. */
  sessionId: string;
  /** The folder the session runs in, outside a linked worktree. */
  cwd: string;
  /** When each of `files` was last written, as `fs.list` reports it. */
  mtimes: Record<string, number>;
  /** What the plugin's store holds, by key, in insertion order. */
  store: Map<string, unknown>;
  /** The key of every `$.store.set` the mod made, oldest first. */
  storeSets: string[];
  /**
   * The JSON text the store holds at most, its 4 MiB in the engine; a write
   * that would take it over rejects. Null: no limit.
   */
  storeLimit: number | null;
  /** Every path the mod's `$.fs` read, oldest first. */
  reads: string[];
  /** The sessions `claude agents --json` lists that run on their own, with no terminal. */
  background: BackgroundSession[];
  /** Sessions whose registry entry is still on disk but that `claude agents` no longer lists: they are gone. */
  gone: Set<string>;
  /** While true, `claude agents` fails, as one too old to know `--json` does. */
  isAgentsDown: boolean;
  /**
   * The subagents Claude Code runs, by id, as `$.agent.list()` reports them, how long that call
   * takes on the mocked clock (0 answers at once), and how many times the mod made it.
   */
  agents: {
    statuses: Map<string, AgentStatus>;
    listDelayMs: number;
    lists: number;
  };
};

/** A session `claude agents --json` lists as running on its own. */
export type BackgroundSession = {
  id: string;
  sessionId: string;
  cwd: string;
  name: string;
  startedAt: number;
  state: "running" | "blocked" | "done";
};

/** How much JSON text a store holds, as the engine measures it against its 4 MiB. */
export const storeSize = (entries: ReadonlyMap<string, unknown>): number =>
  JSON.stringify(Object.fromEntries(entries)).length;

export type BootOptions = {
  store?: Record<string, unknown>;
  /** The environment the session runs in; inside zellij unless said otherwise. */
  env?: Record<string, string>;
};

export const IN_ZELLIJ = {
  ZELLIJ: "0",
  ZELLIJ_SESSION_NAME: "sincere-magpie",
  ZELLIJ_PANE_ID: PANE_ID,
};

const RAN = {
  stderr: "",
  isStdoutTruncated: false,
  isStderrTruncated: false,
};

/** The global options git takes as bare flags before `-C`. */
const GIT_FLAGS = new Set(["--no-optional-locks", "--literal-pathspecs"]);

/**
 * Whether a pathspec names `path` as git matches one without `--literal-pathspecs`: the path
 * itself, or a glob in which `*`, `?` and `[...]` match, so `v[12].md` names `v1.md` too.
 */
function isNamedBy(pathspec: string, path: string): boolean {
  if (pathspec === path) return true;
  const source = pathspec
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\[!/g, "[^");
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}

/** `git -C <dir> diff --numstat HEAD -- <path>`, `ls-files --others` and `diff --no-index`, as git answers them. */
function runGit(git: FakeGit, argv: readonly string[]) {
  const ran = (exitCode: number, stdout = "", stderr = "") => ({
    ...RAN,
    exitCode,
    stdout,
    stderr,
  });
  // `git [-c <key>=<value>] [--<flag>] ... -C <dir> <command>`: settings on the command line beat the repository's.
  const settings: string[] = [];
  const flags: string[] = [];
  let at = 1;
  for (;;) {
    const arg = argv[at] ?? "";
    if (arg === "-c") {
      settings.push(argv[at + 1] ?? "");
      at += 2;
    } else if (GIT_FLAGS.has(arg)) {
      flags.push(arg);
      at += 1;
    } else break;
  }
  if (git.isDown || argv[0] !== "git" || argv[at] !== "-C")
    return ran(128, "", "fatal: not a git repository");
  const dir = argv[at + 1] ?? "";
  git.dirs.push(dir);
  const command = argv[at + 2] ?? "";
  const isFsmonitorOff = settings.some((setting) =>
    /^core\.fsmonitor=(false|)$/.test(setting)
  );
  if (
    git.fsmonitor !== null &&
    !isFsmonitorOff &&
    ["status", "diff", "ls-files"].includes(command)
  )
    git.fsmonitorRuns.push(dir);
  // The diff flags that keep a repository's external diff and textconv drivers from running.
  const args = argv
    .slice(at + 2)
    .filter((arg) => arg !== "--no-ext-diff" && arg !== "--no-textconv")
    .join(" ");
  const path = argv[argv.length - 1] ?? "";
  const name = path.split("/").pop() ?? path;
  const isRefreshing =
    command === "status" ||
    (command === "diff" && args.includes(" HEAD ") && !git.isUnborn);
  if (isRefreshing && !flags.includes("--no-optional-locks"))
    git.indexWrites.push(dir);
  // Every file git knows of that the pathspec names, in git's order.
  const named = (known: readonly string[]): string[] =>
    known
      .filter((one) =>
        flags.includes("--literal-pathspecs")
          ? one === path
          : isNamedBy(path, one)
      )
      .sort();
  const lines = (paths: string[], line: (one: string) => string): string =>
    paths.map((one) => `${line(one)}\n`).join("");
  const nameOf = (one: string): string => one.split("/").pop() ?? one;
  if (args === "status --porcelain=v2 --branch") return ran(0, git.status);
  if (args === "rev-parse --verify --quiet HEAD")
    return git.isUnborn ? ran(1) : ran(0, "1a2b3c\n");
  if (
    args ===
    "rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir"
  ) {
    const tree = git.worktree;
    const name = tree?.root.split("/").pop() ?? "";
    return tree === null
      ? ran(0, `${CWD}\n${CWD}/.git\n${CWD}/.git\n`)
      : ran(
          0,
          `${tree.root}\n${tree.commonDir}/worktrees/${name}\n${tree.commonDir}\n`
        );
  }
  if (args.startsWith("diff --numstat HEAD -- "))
    return git.isUnborn
      ? ran(128, "", "fatal: bad revision 'HEAD'")
      : ran(
          0,
          lines(
            named(Object.keys(git.changed)),
            (one) => `${git.changed[one]}\t${nameOf(one)}`
          )
        );
  if (args.startsWith("ls-files --others --exclude-standard -- "))
    return ran(0, lines(named(Object.keys(git.untracked)), nameOf));
  if (args.startsWith("ls-files --others --ignored --exclude-standard -- "))
    return ran(0, lines(named(git.ignored), nameOf));
  if (args.startsWith("diff --numstat --no-index -- /dev/null ")) {
    const count = git.untracked[path] ?? git.staged[path];
    return count === undefined ? ran(0) : ran(1, `${count}\t0\t${name}\n`);
  }
  return ran(129, "", `unknown git command: ${args}`);
}

/** The options the zellij actions the mod runs know: the pane (`-p <id>`), and list-panes' json and tab. */
const FLAGS = new Set(["-p", "-j", "-t"]);

/**
 * `claude agents --json`: the active sessions, the terminal ones from the
 * registry (less those gone) and the ones running on their own.
 */
function runAgents(harness: Harness, argv: readonly string[]) {
  if (harness.isAgentsDown || argv.join(" ") !== "claude agents --json")
    return {
      ...RAN,
      exitCode: 1,
      stdout: "",
      stderr: "error: unknown option '--json'",
    };
  const interactive = Object.keys(harness.files)
    .filter((path) => /^\d+\.json$/.test(path.slice(SESSIONS.length + 1)))
    .filter((path) => path.startsWith(`${SESSIONS}/`))
    .map((path) => JSON.parse(harness.files[path] ?? "{}") as RegistryEntry)
    .filter((entry) => !harness.gone.has(entry.sessionId))
    .map((entry) => ({
      pid: entry.pid,
      cwd: entry.cwd,
      kind: entry.kind,
      startedAt: entry.startedAt,
      sessionId: entry.sessionId,
      name: entry.name,
      status: entry.status,
    }));
  const background = harness.background.map((session) => ({
    ...session,
    kind: "background",
  }));
  return {
    ...RAN,
    exitCode: 0,
    stdout: JSON.stringify([...background, ...interactive], null, 2),
  };
}

/** `rm -f -- <path>...`: removes each of the files, as the real one does, and none it is not given. */
function runRm(harness: Harness, argv: readonly string[]) {
  const ending = argv.indexOf("--");
  const paths = ending < 0 ? argv.slice(2) : argv.slice(ending + 1);
  for (const path of paths) {
    delete harness.files[path];
    delete harness.mtimes[path];
  }
  return { ...RAN, exitCode: 0, stdout: "" };
}

function runZellij(zellij: FakeZellij, argv: readonly string[]) {
  zellij.runs.push([...argv]);
  const fail = { ...RAN, exitCode: 1, stdout: "", stderr: "no zellij session" };
  if (zellij.isDown || argv[0] !== "zellij" || argv[1] !== "action")
    return fail;
  const ok = (stdout = "") => ({ ...RAN, exitCode: 0, stdout });
  const [, , action, ...args] = argv;
  // As zellij's argument parser reads them: `-p <id>` is the pane option, any other word starting
  // with `-` before a `--` is an unknown option, and everything after `--` is a plain argument.
  const ending = args.indexOf("--");
  const options = ending < 0 ? args : args.slice(0, ending);
  const pane = options.indexOf("-p");
  const rest = [
    ...options.filter((_, i) => pane < 0 || (i !== pane && i !== pane + 1)),
    ...(ending < 0 ? [] : args.slice(ending + 1)),
  ];
  const unknown = options.find(
    (arg, i) =>
      arg.startsWith("-") && !FLAGS.has(arg) && (pane < 0 || i !== pane + 1)
  );
  if (unknown !== undefined)
    return {
      ...RAN,
      exitCode: 2,
      stdout: "",
      stderr: `error: unexpected argument '${unknown}' found`,
    };
  const paneArg = () => (pane < 0 ? undefined : options[pane + 1]);
  switch (action) {
    case "current-tab-info":
      return ok(
        JSON.stringify({
          tab_id: zellij.activeTabId,
          position: zellij.activeTabId === TAB_ID ? TAB_POSITION : 0,
          name: zellij.activeTabId === TAB_ID ? zellij.tabName : "Tab #3",
          active: true,
        })
      );
    case "list-panes":
      return ok(
        JSON.stringify([
          {
            id: 2,
            is_plugin: false,
            title: "~",
            tab_id: 1,
            tab_name: "Tab #3",
          },
          {
            id: 9,
            is_plugin: true,
            title: "bar",
            tab_id: TAB_ID,
            tab_name: zellij.tabName,
          },
          {
            id: Number(PANE_ID),
            is_plugin: false,
            title: zellij.paneName ?? "✳ Claude Code",
            tab_id: TAB_ID,
            tab_position: TAB_POSITION,
            tab_name: zellij.tabName,
          },
        ])
      );
    case "rename-pane":
      if (paneArg() !== `terminal_${PANE_ID}`) return fail;
      zellij.paneName = rest[rest.length - 1] ?? "";
      return ok();
    case "undo-rename-pane":
      if (paneArg() !== `terminal_${PANE_ID}`) return fail;
      zellij.paneName = null;
      return ok();
    case "rename-tab-by-id":
      if (rest[0] !== String(TAB_ID)) return fail;
      zellij.tabName = rest[1] ?? "";
      return ok();
    default:
      return fail;
  }
}

let tasks = 0;

/** What Claude Code's own tools answer, for the tools the mod reads results of. */
function toolResult(e: { tool: string } & Record<string, unknown>): unknown {
  switch (e.tool) {
    case "TaskCreate":
      return { task: { id: String(++tasks), subject: e.subject } };
    case "TaskUpdate":
      return { success: true, taskId: e.taskId, updatedFields: [] };
    case "TodoWrite":
      return { oldTodos: [], newTodos: e.todos };
    case "Edit": {
      // One hunk: the old string's lines out, the new string's in.
      const removed = String(e.old_string).split("\n");
      const added = String(e.new_string).split("\n");
      return {
        filePath: e.file_path,
        oldString: e.old_string,
        newString: e.new_string,
        originalFile: null,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: removed.length,
            newStart: 1,
            newLines: added.length,
            lines: [
              ...removed.map((line) => `-${line}`),
              ...added.map((line) => `+${line}`),
            ],
          },
        ],
        userModified: false,
        replaceAll: false,
      };
    }
    case "Write":
      // A file written for the first time: Claude Code sends no patch for one.
      return {
        type: "create",
        filePath: e.file_path,
        content: e.content,
        structuredPatch: [],
        originalFile: null,
      };
    default:
      return "ok";
  }
}

async function answer(
  clock: MockClock,
  next: Reply | undefined
): Promise<ModelForkResult> {
  if (next === undefined)
    throw new Error("the test queued no reply for this model call");
  if (typeof next === "string")
    return { isAnswered: true, text: next, usage: NO_USAGE };
  if ("text" in next) {
    await clock.sleep(next.afterMs);
    return { isAnswered: true, text: next.text, usage: NO_USAGE };
  }
  switch (next.fail) {
    case "api-error":
      return {
        isAnswered: false,
        reason: "api-error",
        status: 529,
        error: "overloaded",
        usage: NO_USAGE,
      };
    case "nothing-to-fork":
      return { isAnswered: false, reason: "nothing-to-fork" };
    default:
      return { isAnswered: false, reason: next.fail, usage: NO_USAGE };
  }
}

/**
 * Stands in for Claude Code beneath the mod: the session, its commands, its
 * turns and tools, the band's own empty drawing, and the faked model calls.
 * Starts the session, as Claude Code does before the first prompt.
 */
export async function boot(
  $: Engine,
  on: On,
  store: Record<string, unknown> = {},
  env: Record<string, string> = IN_ZELLIJ,
  latestRelease: string | null = "2.1.300",
  /** False: the mod joins a conversation it never saw start, as after /clear, /resume or a hot reload. */
  isStarted = true
): Promise<Harness> {
  const clock = mock.clock(on, { now: START });
  const harness: Harness = {
    clock,
    asked: [],
    forked: [],
    replies: [],
    forkReplies: [],
    shownLines: [],
    zellij: {
      runs: [],
      paneName: null,
      tabName: TAB_NAME,
      isDown: false,
      delayMs: 0,
      activeTabId: 1,
    },
    git: {
      changed: {},
      untracked: {},
      ignored: [],
      status: "# branch.oid 1a2b3c\n# branch.head main\n",
      isDown: false,
      worktree: null,
      fsmonitor: null,
      fsmonitorRuns: [],
      dirs: [],
      staged: {},
      isUnborn: false,
      isTimingOut: false,
      indexWrites: [],
    },
    opened: [],
    opens: [],
    openWidths: [],
    stepPlans: [],
    files: {},
    canPlace: true,
    latestRelease,
    sessionId: SESSION,
    cwd: CWD,
    mtimes: {},
    store: new Map(Object.entries(store)),
    storeSets: [],
    storeLimit: null,
    reads: [],
    background: [],
    gone: new Set(),
    isAgentsDown: false,
    agents: { statuses: new Map(), listDelayMs: 0, lists: 0 },
  };
  // The plugin's store, in memory and in insertion order as the engine keeps it; every write is
  // noted, and refused when it would take the store over its limit.
  on("store.get", ($, e) => ({ value: harness.store.get(e.key) }));
  on("store.set", ($, e) => {
    harness.storeSets.push(e.key);
    const next = new Map(harness.store);
    next.set(e.key, JSON.parse(JSON.stringify(e.value)));
    if (harness.storeLimit !== null && storeSize(next) > harness.storeLimit)
      throw new Error("the store would be over its limit of JSON text");
    harness.store = next;
    return { value: undefined };
  });
  on("store.delete", ($, e) => {
    harness.store.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", () => ({ value: [...harness.store.keys()] }));
  mock.env(on, { HOME, ...env });

  // Claude Code's release server, faked at the network's edge.
  on("http.fetch", () => {
    const headers: Record<string, string> = { "content-type": "text/plain" };
    return {
      value:
        harness.latestRelease === null
          ? { status: 503, ok: false, headers, text: "" }
          : {
              status: 200,
              ok: true,
              headers,
              text: `${harness.latestRelease}\n`,
            },
    };
  });

  on("fs.write", ($, e) => {
    harness.files[e.path] = e.text;
    harness.mtimes[e.path] = clock.now();
    return { value: undefined };
  });
  on("fs.read", ($, e) => {
    harness.reads.push(e.path);
    const text = harness.files[e.path];
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  on("fs.exists", ($, e) => ({
    value:
      e.path in harness.files ||
      Object.keys(harness.files).some((path) => path.startsWith(`${e.path}/`)),
  }));
  on("fs.list", ($, e) => ({
    value: Object.keys(harness.files)
      .filter(
        (path) =>
          path.startsWith(`${e.path}/`) &&
          !path.slice(e.path.length + 1).includes("/")
      )
      .map((path) => ({
        name: path.slice(e.path.length + 1),
        kind: "file" as const,
        size: harness.files[path]?.length ?? 0,
        mtimeMs: harness.mtimes[path] ?? clock.now(),
      })) as never,
  }));
  on("session.version", () => ({
    value: { version: "2.1.300", base: "2.1.300" },
  }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.compact", ($, e) => ({ messages: e.messages } as never));

  on("process.run", async ($, e) => {
    // Past its timeout the host kills git, and the mod's call rejects.
    if (e.argv[0] === "git")
      return harness.git.isTimingOut
        ? { deny: "git ran past its timeout" }
        : { value: runGit(harness.git, e.argv) };
    if (e.argv[0] === "rm") return { value: runRm(harness, e.argv) };
    if (e.argv[0] === "claude") return { value: runAgents(harness, e.argv) };
    if (harness.zellij.delayMs > 0) await clock.sleep(harness.zellij.delayMs);
    return { value: runZellij(harness.zellij, e.argv) };
  });
  on("session.cwd", () => ({
    value: harness.git.worktree?.root ?? harness.cwd,
  }));
  on("session.measure", ($, e) => ({ changed: e.changed }));
  on("ui.open", ($, e) => {
    harness.opened = [
      ...harness.opened.filter((pane) => pane.id !== e.id),
      { id: e.id, title: e.title ?? e.id },
    ];
    harness.opens.push(e.id);
    harness.openWidths.push(e.columns);
    return {
      value: harness.canPlace
        ? { isPlaced: true }
        : { isPlaced: false, reason: "too-narrow" },
    };
  });
  on("ui.panes", () => ({
    value: harness.opened.map((pane) => ({
      id: pane.id,
      title: "Brief",
      isShown: harness.canPlace,
      isFocused: false,
      isPlaced: harness.canPlace,
    })),
  }));
  on("ui.close", ($, e) => {
    harness.opened = harness.opened.filter((pane) => pane.id !== e.id);
    return { value: undefined };
  });
  // Claude Code moves the pane's window to e.offset; the panel is as tall as the dock, so nothing moves.
  on("ui.scroll", () => ({}));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("turn.step", async function* ($, e) {
    const plan = harness.stepPlans.shift() ?? { text: "" };
    if (plan.ms !== undefined) await clock.sleep(plan.ms);
    const usage =
      plan.output === undefined
        ? null
        : {
            model: plan.model ?? e.model,
            input_tokens: plan.input ?? 0,
            output_tokens: plan.output,
            cache_read_input_tokens: plan.cacheRead ?? 0,
            cache_creation_input_tokens: plan.cacheWrite ?? 0,
          };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: plan.text,
      toolUses: [],
      stopReason: "tool_use",
      usage,
    } as never;
  });

  on("model.complete", async ($, e) => {
    harness.asked.push(e);
    return {
      value: (await answer(
        clock,
        harness.replies.shift() ?? { fail: "api-error" }
      )) as ModelCompleteResult,
    };
  });
  on("model.fork", async ($, e) => {
    harness.forked.push(e);
    return { value: await answer(clock, harness.forkReplies.shift()) };
  });
  on("ui.toast", ($, e) => {
    harness.shownLines.push(String(e.text));
    return { value: undefined };
  });
  on("ui.log", ($, e) => {
    harness.shownLines.push(String(e.text));
    return { value: undefined };
  });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: harness.sessionId }));
  // Claude Code starts a subagent for an Agent tool call: its loop's events carry this id, and
  // `$.agent.list()` lists it running until its loop's turn ends.
  const agentStatuses = harness.agents.statuses;
  on("agent.spawn", () => {
    const agentId = `agent-${agentStatuses.size + 1}`;
    agentStatuses.set(agentId, "running");
    return { model: "claude-opus-5-5", agentId };
  });
  on("agent.list", async () => {
    harness.agents.lists++;
    if (harness.agents.listDelayMs > 0)
      await clock.sleep(harness.agents.listDelayMs);
    return {
      value: [...agentStatuses].map(([id, status]) => ({
        id,
        description: id,
        type: "general-purpose",
        status,
      })),
    };
  });
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  // Claude Code's /rename: the session's registry entry takes the new name.
  on("command.run", { command: "rename" }, ($, e) => {
    nameSession(harness, e.args.trim());
    return { text: "Renamed the session." };
  });
  on("command.run", ($, e) => ({ text: `Unknown command: /${e.command}` }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", ($, e) => {
    if (e.agentId !== undefined) agentStatuses.set(e.agentId, "completed");
    return { text: e.answer };
  });
  on("tool.call", async ($, e) => {
    // A question stays open until the person answers it, here a minute later.
    if (e.tool === "AskUserQuestion") await clock.sleep(MINUTE);
    return { result: toolResult(e) } as never;
  });
  on("classic.UserPromptSubmit", () => ({}));
  on("classic.DirectoryAdded", () => ({}));
  on("classic.PreModelSwitch", () => ({}));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return Box({ key: "engine" });
  });

  // Claude Code registers this session before its first prompt, with no title yet.
  register(harness, { pid: PID, sessionId: harness.sessionId });

  if (isStarted)
    await $.session.start({
      cwd: CWD,
      surface: "terminal",
      isInteractive: true,
    });
  return harness;
}

let turns = 0;

/** Starts a turn as Claude Code does when a prompt is sent; resolves its id. */
export async function startTurn(
  $: Engine,
  prompt: string,
  agentId?: string
): Promise<string> {
  const turnId = `turn-${++turns}`;
  await $.turn.start({
    text: prompt,
    turnId,
    ...(agentId === undefined ? {} : { agentId }),
  });
  return turnId;
}

/** Runs `count` tool calls in the session's loop. */
export async function useTools($: Engine, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await $.tool.call({
      tool: "Read",
      file_path: `/home/dev/.dotfiles/file-${i}.ts`,
    });
  }
}

export type TurnEnd = {
  answer?: string;
  reason?: "answer" | "aborted" | "error";
  agentId?: string;
};

/** Ends a turn as Claude Code does once the model's reply is final. */
export async function endTurn(
  $: Engine,
  turnId: string,
  end: TurnEnd = {}
): Promise<void> {
  const reason = end.reason ?? "answer";
  await $.turn.complete({
    answer: end.answer ?? "",
    durationMs: 1000,
    isAborted: reason === "aborted",
    turnId,
    reason,
    ...(end.agentId === undefined ? {} : { agentId: end.agentId }),
  });
}

export type TurnSpec = TurnEnd & { prompt?: string; tools?: number };

/** One whole turn: a prompt, its tool calls, and the final reply. */
export async function runTurn($: Engine, spec: TurnSpec = {}): Promise<void> {
  const turnId = await startTurn($, spec.prompt ?? "", spec.agentId);
  await useTools($, spec.tools ?? 0);
  await endTurn($, turnId, spec);
}

/**
 * A brief as a test wants it: Claude Code's title, the story, what is next,
 * and a milestone or a plan, which only `/brief refresh` writes now.
 */
export type BriefFields = {
  title: string;
  story?: string;
  now?: { state: string; text: string };
  step?: string | null;
  plan?: unknown[];
};

/** Claude's final reply that leaves `fields` as the brief: the story, then what is next, asked when waiting. */
export function replyFor(fields: BriefFields): string {
  const next = fields.now?.text ?? "";
  const said =
    next === "" || /[.!?]$/.test(next)
      ? next
      : `${next}${fields.now?.state === "waiting" ? "?" : "."}`;
  return [fields.story ?? "", said].filter((part) => part !== "").join(" ");
}

/**
 * A turn that leaves `fields` as the brief: Claude Code names the session,
 * Claude replies; a milestone or a plan comes from `/brief refresh` after it.
 */
export async function briefWith(
  harness: Harness,
  $: Engine,
  fields: BriefFields,
  prompt = "go"
): Promise<void> {
  nameSession(harness, fields.title);
  await runTurn($, { prompt, answer: replyFor(fields) });
  await harness.clock.settle();
  if ((fields.step ?? null) === null && (fields.plan ?? []).length === 0)
    return;
  harness.forkReplies.push(reply({ ...fields }));
  await runCommand($, "brief", "refresh");
  await harness.clock.settle();
}

export type BandProps = RenderPropsOf["AbovePrompt"];

export const bandProps = (over: Partial<BandProps> = {}): BandProps => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
  ...over,
});

/** Draws the band above the prompt on the terminal, as Claude Code does. */
export const mountBand = ($: Engine, over: Partial<BandProps> = {}) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "AbovePrompt",
    props: bandProps(over),
    viewport: { columns: 105, rows: 30, isFullscreen: false },
  });

/** The text a drawn tree shows, a column's rows on lines of their own. */
export function textOf(node: RenderNode | undefined): string {
  if (node === undefined) return "";
  if (typeof node === "string") return node;
  const children =
    "children" in node && Array.isArray(node.children)
      ? (node.children as RenderNode[])
      : [];
  const isColumn =
    node.type === "Box" && node.props?.flexDirection === "column";
  return children.map(textOf).join(isColumn ? "\n" : "");
}

/** The props of a drawing's outermost Box; none when the engine drew its own. */
export function boxProps(node: RenderNode): Record<string, unknown> {
  return typeof node !== "string" && node.type === "Box"
    ? { ...node.props }
    : {};
}

/** The elements a drawn node holds, in order. */
export function childrenOf(node: RenderNode): RenderNode[] {
  return typeof node !== "string" &&
    "children" in node &&
    Array.isArray(node.children)
    ? (node.children as RenderNode[])
    : [];
}

export const shown = async (band: {
  drawn: () => Promise<RenderNode>;
}): Promise<string> => textOf(await band.drawn());

/** Runs a slash command as the person typing it at the prompt does. */
export const runCommand = ($: Engine, command: string, args = "") =>
  $.command.run({
    command,
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 105 },
  });

/** Draws the band in Claude Code's fullscreen layout, where a pane docks beside the transcript. */
export const mountFullscreenBand = ($: Engine, over: Partial<BandProps> = {}) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "AbovePrompt",
    props: bandProps({ bodyColumns: 160, ...over }),
    viewport: { columns: 209, rows: 57, isFullscreen: true },
  });

export type PanelProps = RenderPropsOf["Pane"];

/** Draws the brief panel docked on the right of a wide fullscreen terminal, as Claude Code does. */
export const mountPanel = ($: Engine, over: Partial<PanelProps> = {}) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: "terminal",
    component: "Pane",
    requestId: "brief",
    props: {
      title: "Brief",
      isFocused: false,
      bodyColumns: 44,
      placement: "dock",
      scroll: { offset: 0, bodyRows: 50 },
      view: {},
      ...over,
    } as PanelProps,
    viewport: { columns: 209, rows: 57, isFullscreen: true },
  });

let steps = 0;

/**
 * One model step of a running turn, as Claude Code streams it: Claude's text
 * before the tool calls it is about to make.
 */
export async function step(
  harness: Harness,
  $: Engine,
  turnId: string,
  text: string,
  agentId?: string
): Promise<void> {
  await replyStep(harness, $, turnId, { text }, agentId);
}

/**
 * One model reply of a running turn, as Claude Code streams it, with its
 * token usage; one that takes `ms` streams while the mocked clock moves on.
 */
export async function replyStep(
  harness: Harness,
  $: Engine,
  turnId: string,
  plan: StepPlan,
  agentId?: string
): Promise<void> {
  harness.stepPlans.push(plan);
  const stream = $.turn.step({
    turnId,
    index: ++steps,
    model: plan.model ?? "claude-opus-5-5",
    effort: "xhigh",
    messageCount: steps,
    ...(agentId === undefined ? {} : { agentId }),
  });
  const drained = (async () => {
    for await (const _ of stream) {
      // the chunks are Claude Code's to draw; the mod reads the step's result
    }
  })();
  if (plan.ms !== undefined) await harness.clock.advance(plan.ms);
  await drained;
}

/** Claude Code compacts the main conversation. */
export const compact = ($: Engine) =>
  $.session.compact({
    trigger: "auto",
    messages: [
      {
        role: "user",
        text: "Summary of the conversation so far.",
        toolUses: [],
      },
    ],
  } as never);

let otherPids = 5000;

/**
 * Another session running the sidecar: its presence file, as its copy of the
 * mod writes it, and its registry entry, as its Claude Code writes it. One
 * that ended, or went quiet over three minutes ago, has no entry any more.
 */
export function otherSession(
  harness: Harness,
  fields: {
    id: string;
    name: string;
    state: "waiting" | "working" | "done";
    question?: string;
    since?: number;
    cwd?: string;
    zellijSession?: string | null;
    tabPosition?: number | null;
    updatedAt?: number;
    isEnded?: boolean;
    /** When its last turn ended, as a session that can tell when it is seen says; null otherwise. */
    finishedAt?: number | null;
    /** When its tab was last on screen, or the person last prompted it. */
    seenAt?: number;
    /** The last sentence of its reply. */
    said?: string;
    /** What it waits for, as its Claude Code tells the registry ("dialog open", "permission prompt"). */
    waitingFor?: string;
  }
): void {
  const now = harness.clock.now();
  const cwd = fields.cwd ?? `${HOME}/projects/notes`;
  const updatedAt = fields.updatedAt ?? now;
  harness.mtimes[`${PRESENCE}/${fields.id}.json`] = updatedAt;
  harness.files[`${PRESENCE}/${fields.id}.json`] = JSON.stringify({
    sessionId: fields.id,
    name: fields.name,
    state: fields.state,
    question: fields.question ?? "",
    since: fields.since ?? now,
    cwd,
    zellijSession:
      fields.zellijSession === undefined
        ? "sincere-magpie"
        : fields.zellijSession,
    tabPosition: fields.tabPosition === undefined ? 1 : fields.tabPosition,
    updatedAt,
    isEnded: fields.isEnded ?? false,
    finishedAt: fields.finishedAt ?? null,
    seenAt: fields.seenAt ?? 0,
    said: fields.said ?? "",
  });
  if (fields.isEnded === true || now - updatedAt > 3 * MINUTE) return;
  register(harness, {
    pid: ++otherPids,
    sessionId: fields.id,
    cwd,
    name: fields.name,
    status:
      fields.waitingFor !== undefined
        ? "waiting"
        : fields.state === "working"
        ? "busy"
        : "idle",
    ...(fields.waitingFor === undefined
      ? {}
      : { waitingFor: fields.waitingFor }),
  });
}

/** Ends the session as Claude Code does when the person quits. */
export const endSession = ($: Engine) =>
  $.session.end({
    reason: "prompt_input_exit",
    sessionId: SESSION,
    resume: { id: SESSION },
  });

/**
 * Claude Code's /clear (or /resume of another conversation): the conversation ends, and the
 * process goes on under `nextId` with no session.start, only draws and turns.
 */
export async function switchConversation(
  harness: Harness,
  $: Engine,
  reason: "clear" | "resume",
  nextId: string
): Promise<void> {
  const ending = harness.sessionId;
  await $.session.end({ reason, sessionId: ending, resume: { id: ending } });
  harness.sessionId = nextId;
  // The process's registry entry now names the next conversation, untitled until Claude Code names it.
  const path = `${SESSIONS}/${PID}.json`;
  const entry = JSON.parse(harness.files[path] ?? "{}") as RegistryEntry;
  delete entry.name;
  harness.files[path] = JSON.stringify({ ...entry, sessionId: nextId });
}

/** Claude Code starts a subagent for one of the main loop's Agent tool calls; resolves its id. */
export async function spawnAgent(
  $: Engine,
  description: string,
  type = "general-purpose"
): Promise<string> {
  const spawned = await $.agent.spawn({
    tool_use_id: `toolu_${description.replace(/\W+/g, "_")}`,
    prompt: `Research: ${description}`,
    description,
    subagentType: type,
    provider: { plugin: "engine", tier: "core" },
  } as never);
  return spawned.agentId ?? "";
}

/** The zellij commands the mod ran, each as one line without the leading `zellij action`. */
export const zellijLines = (harness: Harness): string[] =>
  harness.zellij.runs.map((argv) => argv.slice(2).join(" "));

/** Draws the fullscreen band and lets what the drawing set off land, as Claude Code's first frame does. */
export async function drawFullscreen(harness: Harness, $: Engine) {
  await shown(await mountFullscreenBand($));
  await harness.clock.settle();
}

/** Claude Code measures the session after a main-thread turn: the context window's fill and the cost. */
export const measure = (
  $: Engine,
  figures: {
    tokens: number;
    percent: number;
    usd?: number;
    window?: number;
    limits?: { kind: string; percentUsed: number; resetsAt?: number }[];
  }
) =>
  $.session.measure({
    context: {
      tokens: figures.tokens,
      window: figures.window ?? 200_000,
      percent: figures.percent,
    },
    rateLimits: (figures.limits ?? []).map((limit) => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      ...(limit.resetsAt === undefined
        ? {}
        : { resetsAt: new Date(limit.resetsAt).toISOString() }),
    })),
    ...(figures.usd === undefined ? {} : { cost: { usd: figures.usd } }),
    changed: [
      "context",
      ...(figures.limits === undefined ? [] : ["rateLimits" as const]),
      ...(figures.usd === undefined ? [] : ["cost" as const]),
    ],
  });

/** The colours of every Text a drawn tree shows whose text holds `needle`, in drawing order. */
export function colorsOf(
  node: RenderNode | undefined,
  needle: string
): string[] {
  if (node === undefined || typeof node === "string") return [];
  if (node.type === "Text" && textOf(node).includes(needle)) {
    const color = (node.props as { color?: string } | undefined)?.color;
    return color === undefined ? [] : [color];
  }
  const children =
    "children" in node && Array.isArray(node.children)
      ? (node.children as RenderNode[])
      : [];
  return children.flatMap((child) => colorsOf(child, needle));
}

/** The colour of the first Text a drawn tree shows whose text holds `needle`. */
export function colorOf(
  node: RenderNode | undefined,
  needle: string
): string | undefined {
  if (node === undefined || typeof node === "string") return undefined;
  if (node.type === "Text" && textOf(node).includes(needle))
    return (node.props as { color?: string } | undefined)?.color;
  const children =
    "children" in node && Array.isArray(node.children)
      ? (node.children as RenderNode[])
      : [];
  for (const child of children) {
    const found = colorOf(child, needle);
    if (found !== undefined) return found;
  }
  return undefined;
}
