/** What the session is waiting for once a turn has ended. */
export type BriefState = "waiting" | "done" | "working";

/** A milestone a turn reached, stamped with when the turn ended (epoch ms). */
export type Step = { at: number; text: string };

/** Where an item of the plan stands. */
export type PlanStatus = "done" | "doing" | "next";

/** One item of the plan: a todo of the session's, or one the summary wrote. */
export type PlanItem = { id: string; text: string; status: PlanStatus };

/** The session's brief: what the band and the panel draw and what `/brief` prints. */
export type Brief = {
  title: string;
  /** The title cut for a zellij tab: at most 16 characters. */
  tab: string;
  story: string;
  now: { state: BriefState; text: string };
  steps: Step[];
  /** The plan the summary wrote, shown only while the session has no todo list. */
  plan: PlanItem[];
  isPinned: boolean;
  /** Whether Haiku named the session from the person's prompts: Claude Code's own title then gives way. */
  isTitled: boolean;
  updatedAt: number;
};

/** The main-loop turn that is running: its prompt, its tool calls so far, and when it started. */
export type Turn = {
  prompt: string;
  /** Tool calls so far. */
  count: number;
  startedAt: number;
};

/** What Claude is doing this second, while a turn runs: no model call behind it. */
export type Live = { text: string; isWaiting: boolean; at: number };

/**
 * A file Claude changed, newest first in the record: its name, and the lines
 * git counts as added and removed against the last commit (null where git
 * can't say: outside a repository, a binary file, not counted yet).
 */
export type FileChange = {
  path: string;
  name: string;
  added: number | null;
  removed: number | null;
};

/** What the session did: its todo list (null before it made one) and the files it changed. */
export type Work = { todos: PlanItem[] | null; files: FileChange[] };

/**
 * The context window's fill and the cost, as Claude Code last measured them,
 * with how much the last few turns added (newest last) and when the
 * conversation was last compacted.
 */
export type Usage = {
  tokens: number;
  percent: number;
  window: number;
  usd: number | null;
  growth: number[];
  compactedAt: number | null;
};

/** A subscription's rate-limit window (`five_hour`, `seven_day`): how much of it is used, and when it resets. */
export type Limit = {
  kind: string;
  percent: number;
  resetsAt: number | null;
};

/** Another session that needs the person, as Claude Code's registry and its sidecar say. */
export type WaitingSession = {
  name: string;
  /** Its zellij tab ("tab 3") in this zellij session, else its folder. */
  where: string;
  /** Since when it needs the person; for a background session, since it started. */
  since: number;
  /**
   * Why: it asks something, wants a permission, is blocked in the background,
   * or finished while its tab was out of sight.
   */
  kind: "question" | "permission" | "blocked" | "finished";
  /** Its question, or what it finished with; empty when unknown. */
  detail: string;
};

/** The other sessions on this machine: how many are open and which need the person. */
export type Others = { open: number; waiting: WaitingSession[] };

/** The repository the session runs in, as `git status` reports it. */
export type Repo = {
  branch: string;
  changed: number;
  untracked: number;
  ahead: number;
  /** The linked worktree the session runs in: its folder's name, and the main repository's path as shown; null in a main checkout. */
  worktree: { name: string; main: string } | null;
};

/** What the footer says: where the session runs, the engine's version, the model and the effort. */
export type About = {
  path: string;
  version: string;
  model: string;
  effort: string | null;
  /** The newest Claude Code release, as its release server names it; null until it answers. */
  latest: string | null;
};

/** A question Claude is asking right now, through AskUserQuestion. */
export type Asked = { at: number; question: string };

/**
 * A subagent running now: the Agent call's description, its type, when it
 * started, what its last tool call did, and the tokens its last reply held.
 */
export type AgentRun = {
  id: string;
  description: string;
  type: string;
  startedAt: number;
  /** Its last tool call in words, as the "now" line says one; empty before its first. */
  activity: string;
  tokens: number;
};

/**
 * One session's presence file, `~/.claude/sidecar/presence/<id>.json`:
 * what other sessions read to list the ones waiting on the person.
 */
export type Presence = {
  sessionId: string;
  name: string;
  state: BriefState;
  question: string;
  since: number;
  cwd: string;
  zellijSession: string | null;
  tabPosition: number | null;
  updatedAt: number;
  isEnded: boolean;
  /**
   * When its last turn ended, where it can tell when it is seen (in zellij);
   * null elsewhere and before its first turn ends.
   */
  finishedAt: number | null;
  /** When its zellij tab was last on screen, or the person last prompted it. */
  seenAt: number;
  /** The last sentence of its reply, once done. */
  said: string;
};

/** What the mod has told zellij, so it repeats nothing and can undo it all. */
export type Zellij = {
  paneId: string | null;
  paneLabel: string | null;
  paneRenamedAt: number;
  tabId: number | null;
  tabLabel: string | null;
  /** The tab's name before the first rename, given back when the session ends. */
  tabOriginal: string | null;
  /** True from the session's end until the next turn: the names are given back, not changed. */
  isReleased: boolean;
  /** The tab's position in its zellij session, from 0: what other sessions call "tab N + 1". */
  tabPosition: number | null;
};

declare module "claude-code" {
  interface PluginState {
    sidecar: {
      brief: Brief | null;
      turn: Turn | null;
      lastTurnAt: number | null;
      tick: number;
      live: Live | null;
      work: Work;
      zellij: Zellij;
      /** Whether the person closed the panel by hand this session. */
      isPanelClosed: boolean;
      usage: Usage | null;
      limits: Limit[];
      /** Tokens per second of the main loop's recent replies, newest last. */
      speeds: number[];
      /** How long the last main-loop turn ran, in ms. */
      lastTurnMs: number | null;
      /** The question Claude is asking the person right now, if any. */
      asked: Asked | null;
      others: Others | null;
      repo: Repo | null;
      about: About | null;
      /** The conversation the brief, turn, work and usage belong to; null before the first. */
      owner: string | null;
      /** Folders added with /add-dir: besides the cwd, the ones git counts lines in. */
      addedDirs: string[];
      /** The subagents running now, oldest first. */
      agents: AgentRun[];
      /** When the person last saw this session: its zellij tab on screen, or a prompt. */
      seenAt: number;
      /** The main loop's last reply: the share of its prompt read from the cache, and when it ended. */
      cache: { hit: number; at: number } | null;
      /**
       * How long the main session's prompt cache lives, when a model switch says or a hit after a
       * longer gap shows; null until then, read as the hour a subscription's main session gets.
       */
      cacheTtl: "5m" | "1h" | null;
      /** The person's prompts as Haiku hears them when it names the session: the first, then the newest. */
      prompts: string[];
      /** How many items the person scrolled each of the panel's lists down with the wheel, by section. */
      scrolled: Record<string, number>;
    };
  }
}
