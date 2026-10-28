import type { Brief, BriefState, PlanItem, PlanStatus, Step } from "../types";

export const TITLE_MAX = 60;
export const STORY_MAX = 300;
export const NOW_MAX = 90;
export const STEP_MAX = 60;
export const STEPS_KEPT = 8;
export const MINUTE = 60_000;
export const RECAP_AFTER_MS = 10 * MINUTE;

/** What one summary call says about the session, already checked and cut to size. */
export type Reply = {
  title: string;
  /** The tab name the reply gave, cut to 16 characters; empty when it gave none. */
  tab: string;
  story: string;
  now: { state: BriefState; text: string };
  step: string | null;
  plan: PlanItem[];
};

export const TAB_MAX = 16;
export const PLAN_MAX = 5;

const STATES: readonly BriefState[] = ["waiting", "done", "working"];
const PLAN_STATUSES: readonly PlanStatus[] = ["done", "doing", "next"];

/** The plan a reply wrote: up to five items of known status, each cut to a step's length. */
function planOf(value: unknown): PlanItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null) return [];
      const fields = item as Record<string, unknown>;
      const text = textOf(fields.text);
      const status = PLAN_STATUSES.find((known) => known === fields.status);
      return text === "" || status === undefined
        ? []
        : [{ text: cut(text, STEP_MAX), status }];
    })
    .slice(0, PLAN_MAX)
    .map((item, i) => ({ id: `summary-${i + 1}`, ...item }));
}

const textOf = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** Escape sequences a terminal acts on: CSI (`ESC [`, or C1's 0x9b), OSC up to BEL or ST, and ESC with one more. */
const ESCAPES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
/** Control characters and bidirectional overrides: a terminal or zellij acts on them, a reader never needs them. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Folds whitespace, drops escape sequences and control characters, and cuts
 * `text` to `max` characters, ending a cut one with an ellipsis. Text from the
 * model, its tools and other sessions passes here before zellij or a drawing.
 */
export function cut(text: string, max: number): string {
  const folded = text
    .replace(ESCAPES, "")
    .replace(/\s+/g, " ")
    .replace(CONTROLS, "")
    .trim();
  const chars = [...folded];
  return chars.length <= max
    ? folded
    : chars
        .slice(0, max - 1)
        .join("")
        .trimEnd() + "…";
}

/**
 * Reads the model's reply: the first JSON object in it, wherever it sits.
 * Fields it leaves out fall back to the previous brief; without any title
 * the reply is unusable and null is returned.
 */
export function parseReply(text: string, previous: Brief | null): Reply | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const fields = data as Record<string, unknown>;

  const title = textOf(fields.title) || previous?.title || "";
  if (title === "") return null;
  const now =
    typeof fields.now === "object" && fields.now !== null
      ? (fields.now as Record<string, unknown>)
      : {};
  const step = textOf(fields.step);

  return {
    title: cut(title, TITLE_MAX),
    tab: cut(textOf(fields.tab), TAB_MAX),
    story: cut(textOf(fields.story) || previous?.story || "", STORY_MAX),
    now: {
      state: STATES.find((state) => state === now.state) ?? "done",
      text: cut(textOf(now.text), NOW_MAX),
    },
    step: step === "" ? null : cut(step, STEP_MAX),
    plan: planOf(fields.plan),
  };
}

/** The brief after a reply: a pinned or Haiku's title stays, a step is added, the last eight are kept. */
export function applyReply(
  previous: Brief | null,
  reply: Reply,
  at: number
): Brief {
  const isPinned = previous?.isPinned ?? false;
  const isTitled = previous?.isTitled ?? false;
  const steps = previous?.steps ?? [];
  const isKept = previous !== null && (isPinned || isTitled);
  const title = isKept ? previous.title : reply.title;
  return {
    title,
    tab: isPinned ? tabName(title) : isKept ? previous.tab : reply.tab,
    story: reply.story,
    now: reply.now,
    steps:
      reply.step === null
        ? steps
        : [...steps, { at, text: reply.step }].slice(-STEPS_KEPT),
    plan: reply.plan,
    isPinned,
    isTitled,
    updatedAt: at,
  };
}

/** The brief with `title` pinned, or a new one holding only that title. */
export function pinTitle(
  previous: Brief | null,
  title: string,
  at: number
): Brief {
  const pinned = cut(title, TITLE_MAX);
  const tab = tabName(pinned);
  if (previous !== null)
    return { ...previous, title: pinned, tab, isPinned: true };
  return {
    title: pinned,
    tab,
    story: "",
    now: { state: "done", text: "" },
    steps: [],
    plan: [],
    isPinned: true,
    isTitled: false,
    updatedAt: at,
  };
}

/**
 * A brief read back from the store, as this version draws it, or null when
 * the value is not one. A brief saved before tab names and plans gets none.
 */
export function asBrief(value: unknown): Brief | null {
  if (!isBrief(value)) return null;
  const saved = value as Brief & Partial<Pick<Brief, "tab" | "plan">>;
  // Cut again: a brief an older version saved may hold what the drawing refuses.
  return {
    ...saved,
    title: cut(saved.title, TITLE_MAX),
    tab: typeof saved.tab === "string" ? cut(saved.tab, TAB_MAX) : "",
    story: cut(saved.story, STORY_MAX),
    now: { ...saved.now, text: cut(saved.now.text, NOW_MAX) },
    steps: saved.steps.map((step) => ({
      ...step,
      text: cut(step.text, STEP_MAX),
    })),
    plan: Array.isArray(saved.plan) ? planOf(saved.plan) : [],
    // A brief saved before Haiku named sessions holds Claude Code's title.
    isTitled: saved.isTitled === true,
  };
}

/** Whether a value read back from the store has every field a brief before 0.2 had. */
function isBrief(value: unknown): value is Brief {
  if (typeof value !== "object" || value === null) return false;
  const brief = value as Record<string, unknown>;
  const now = brief.now as Record<string, unknown> | null | undefined;
  return (
    typeof brief.title === "string" &&
    typeof brief.story === "string" &&
    typeof now === "object" &&
    now !== null &&
    STATES.some((state) => state === now.state) &&
    typeof now.text === "string" &&
    Array.isArray(brief.steps) &&
    brief.steps.every(
      (step: unknown) =>
        typeof step === "object" &&
        step !== null &&
        typeof (step as Step).at === "number" &&
        typeof (step as Step).text === "string"
    ) &&
    typeof brief.isPinned === "boolean" &&
    typeof brief.updatedAt === "number"
  );
}

/** A span of time as the band says it: `4m`, `2h`, `3d`. */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export const updatedAgo = (ms: number): string =>
  ms < MINUTE ? "updated just now" : `updated ${span(ms)} ago`;

/** How a state reads in the band and in `/brief`. */
export const STATE_LABEL: Record<BriefState, string> = {
  waiting: "Waiting on you",
  done: "Done",
  working: "In progress",
};

/**
 * Markdown as plain prose: no code blocks, headings, rules or tables; each
 * list item a sentence of its own; links, emphasis and code marks dropped.
 */
export function plainText(markdown: string): string {
  const parts: string[] = [];
  let isCode = false;
  for (const raw of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      isCode = !isCode;
      continue;
    }
    const line = raw.trim();
    if (
      isCode ||
      line === "" ||
      /^#{1,6}\s/.test(line) ||
      line.startsWith("|") ||
      /^([-*_])\1{2,}$/.test(line)
    )
      continue;
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const text = (item?.[1] ?? line.replace(/^>\s?/, ""))
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/\*([^*\s][^*]*)\*/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .trim();
    parts.push(item !== null && !/[.!?:;]$/.test(text) ? `${text}.` : text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * A title as a zellij tab names it: the whole words that fit in 16
 * characters, or the title cut when not even its first word does.
 */
export function tabName(title: string): string {
  const clean = cut(title, Number.MAX_SAFE_INTEGER);
  if ([...clean].length <= TAB_MAX) return clean;
  let kept = "";
  for (const word of clean.split(" ")) {
    const next = kept === "" ? word : `${kept} ${word}`;
    if ([...next].length > TAB_MAX) break;
    kept = next;
  }
  return kept === "" ? cut(clean, TAB_MAX) : kept;
}

/** The sentences of plain text, each with its own stop. */
const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence !== "");

/**
 * The brief after a turn, with no model call: Claude Code's title (a pinned
 * one, or Haiku's, stays), the reply's opening as the story, and its last
 * sentence as what is next, waiting on the person when it asks a question.
 */
export function briefFromTurn(
  previous: Brief | null,
  title: string,
  answer: string,
  at: number
): Brief {
  const said = sentencesOf(plainText(answer));
  const last = said[said.length - 1] ?? "";
  const isKept = previous !== null && (previous.isPinned || previous.isTitled);
  const kept = isKept ? previous.title : cut(title, TITLE_MAX);
  return {
    title: kept,
    tab: isKept ? previous.tab : tabName(kept),
    story: cut(said.slice(0, -1).join(" "), STORY_MAX),
    now: {
      state: /\?["')\]]*$/.test(last) ? "waiting" : "done",
      text: cut(last.replace(/[.:!]+$/, ""), NOW_MAX),
    },
    steps: previous?.steps ?? [],
    plan: previous?.plan ?? [],
    isPinned: previous?.isPinned ?? false,
    isTitled: previous?.isTitled ?? false,
    updatedAt: at,
  };
}

const RULES = `Reply with one JSON object and nothing else:
{"title": string, "tab": string, "story": string, "now": {"state": "waiting" | "done" | "working", "text": string}, "step": string | null, "plan": [{"text": string, "status": "done" | "doing" | "next"}]}

- title: the goal of the whole session in at most ${TITLE_MAX} characters, starting with a verb, like "Replace zjstatus with a lean bar plugin". Keep the current title unless the goal of the session has clearly changed.
- tab: the title as a short name for a terminal tab, at most ${TAB_MAX} characters, like "Lean bar plugin".
- story: one or two short sentences: how the session started and where it stands now. Rewrite it; don't append to it.
- now.state: "waiting" when Claude asked the user something or needs a decision or approval; "done" when the work asked for is finished; "working" only when work is still running in the background.
- now.text: what the user needs to know or do next, in at most 70 characters, with no final period.
- step: a milestone the conversation last reached (a cause found, tests passing, a decision made) in at most 50 characters, or null when it reached none.
- plan: the session's work as up to ${PLAN_MAX} short items in order: "done" for finished ones, "doing" for the one under way, "next" for what is left. Only what the conversation shows; an empty list when there is no clear plan.`;

const currentBrief = (previous: Brief | null): string[] => {
  if (previous === null) return ["Current brief: none yet."];
  const lines = [
    `Current brief: ${JSON.stringify({
      title: previous.title,
      story: previous.story,
      now: previous.now,
    })}`,
  ];
  if (previous.isPinned)
    lines.push(
      `The user pinned the title "${previous.title}": return it unchanged.`
    );
  return lines;
};

/** The prompt that rebuilds the brief from the whole conversation, sent as a fork of it. */
export function refreshPrompt(previous: Brief | null): string {
  return [
    "Write a short brief of this whole conversation so far, so that the user can tell at a glance what this session is about when switching between sessions. Use no tools.",
    "",
    ...currentBrief(previous),
    "",
    RULES,
  ].join("\n");
}

/** The whole brief as `/brief` prints it. */
export function formatBrief(brief: Brief, now: number): string {
  const state =
    STATE_LABEL[brief.now.state] +
    (brief.now.text === "" ? "" : `: ${brief.now.text}`);
  const lines = [brief.isPinned ? `${brief.title} (pinned)` : brief.title];
  if (brief.story !== "") lines.push(brief.story);
  lines.push(state, updatedAgo(now - brief.updatedAt));
  if (brief.steps.length > 0) {
    lines.push(
      "",
      "Steps:",
      ...brief.steps.map((step) => `- ${span(now - step.at)} ago: ${step.text}`)
    );
  }
  return lines.join("\n");
}
