import type { Brief, FileChange, Limit, PlanItem, Repo, Usage } from "../types";
import { MINUTE, cut, span } from "./brief";

/** What a colour means: the band above the prompt draws it in the Claude Code theme, the panel in PALETTE. */
export type Tone =
  | "success"
  | "warning"
  | "error"
  | "suggestion"
  | "claude"
  | "subtle"
  | "track";

/** The panel's colours, from the Ghostty theme (GitHub Dark VS Code); calm gauges are blue. */
export const PALETTE: Record<Tone, string> = {
  success: "#57cb66",
  warning: "#f0d264",
  error: "#e05561",
  suggestion: "#4b91ff",
  claude: "#a684e8",
  subtle: "#6b7688",
  track: "#373e47",
};

/** One line's coloured note, or none. */
export type Note = { text: string; tone: Tone } | null;

/** The cells `text` takes in a monospace terminal, one per code point. */
export const cells = (text: string): number => [...text].length;

/** `text` in at most `room` cells, its end replaced by … when cut; spaces are kept. */
export function clip(text: string, room: number): string {
  const chars = [...text];
  if (chars.length <= room) return text;
  if (room <= 0) return "";
  return (
    chars
      .slice(0, room - 1)
      .join("")
      .trimEnd() + "…"
  );
}

/** The spaces between a left and a right part, so the right part ends on the line's last cell. */
export const gap = (left: string, right: string, width: number): string =>
  " ".repeat(Math.max(1, width - cells(left) - cells(right)));

/** A bar `cells` wide: the filled part for `percent`, the rest shaded. */
export function bar(
  percent: number,
  width: number
): { filled: string; empty: string } {
  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width))
  );
  // Half a row tall: the row under the bar keeps the other half as room.
  return { filled: "▀".repeat(filled), empty: "▀".repeat(width - filled) };
}

const SPARKS = "▁▂▃▄▅▆▇█";

/** Values as a sparkline, scaled from their lowest to their highest. */
export function sparkline(values: readonly number[]): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return values
    .map(
      (value) =>
        SPARKS[
          high === low ? 4 : Math.round(((value - low) / (high - low)) * 7)
        ] ?? "▁"
    )
    .join("");
}

/** A count as the sidebar says it: `1.52M`, `142k`, `880`. */
export function short(count: number): string {
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(Math.round(count));
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** A time of day: `18:50`. */
export function clock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A day and time: `Thu 09:00`. */
export function dayClock(at: number): string {
  return `${
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(at).getDay()]
  } ${clock(at)}`;
}

/** A running time to the second: `12s`, `4m 12s`, `1h 04m`. */
export function elapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

// ---------- limits ----------

const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5 hours",
  seven_day: "Week",
};

export const isShownLimit = (limit: Limit): boolean =>
  limit.kind in LIMIT_NAMES;

export const limitName = (limit: Limit): string =>
  LIMIT_NAMES[limit.kind] ?? limit.kind;

export const limitTone = (percent: number): Tone =>
  percent >= 85 ? "error" : percent >= 60 ? "warning" : "suggestion";

const whenOf = (limit: Limit): ((at: number) => string) =>
  limit.kind === "seven_day" ? dayClock : clock;

/** When the window resets, as its header says it: `resets 18:50`, `resets Thu 09:00`. */
export const resetLabel = (limit: Limit): string =>
  limit.resetsAt === null ? "" : `resets ${whenOf(limit)(limit.resetsAt)}`;

// ---------- context ----------

const COMPACTED_SHOWN = 10 * MINUTE;
export const GROWTH_KEPT = 5;

export const contextTone = (percent: number): Tone =>
  percent >= 92 ? "error" : percent >= 80 ? "warning" : "suggestion";

/** How many more turns fit, at what the last turns added, or what compaction just did. */
export function contextNote(usage: Usage, now: number): Note {
  if (usage.compactedAt !== null && now - usage.compactedAt <= COMPACTED_SHOWN)
    return {
      text: `compacted ${span(
        now - usage.compactedAt
      )} ago · the brief and plan were kept`,
      tone: "success",
    };
  if (usage.growth.length === 0) return null;
  const perTurn =
    usage.growth.reduce((sum, added) => sum + added, 0) / usage.growth.length;
  const turns = Math.floor((usage.window - usage.tokens) / perTurn);
  if (turns <= 1)
    return {
      text: "auto-compact next turn · /compact now keeps the brief",
      tone: "error",
    };
  if (turns < 5)
    return {
      text: `nearly full · auto-compact in ~${turns} turns`,
      tone: "warning",
    };
  return { text: `about ${turns} turns of room`, tone: "subtle" };
}

// ---------- speed and tokens ----------

export const SPEEDS_KEPT = 15;

export function speedSummary(speeds: readonly number[]): {
  latest: number;
  avg: number;
  peak: number;
} {
  return {
    latest: speeds[speeds.length - 1] ?? 0,
    avg: Math.round(
      speeds.reduce((sum, speed) => sum + speed, 0) / Math.max(1, speeds.length)
    ),
    peak: Math.max(...speeds),
  };
}

// ---------- fitting the dock ----------

/** `text` word-wrapped into rows of at most `width` cells; a word wider than a row is broken. */
export function wrapText(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(/\s+/).filter((one) => one !== "")) {
    let rest = [...word];
    while (rest.length > width) {
      if (row !== "") rows.push(row);
      row = "";
      rows.push(rest.slice(0, width).join(""));
      rest = rest.slice(width);
    }
    const piece = rest.join("");
    if (piece === "") continue;
    if (row === "") row = piece;
    else if (cells(row) + 1 + cells(piece) <= width) row += ` ${piece}`;
    else {
      rows.push(row);
      row = piece;
    }
  }
  if (row !== "") rows.push(row);
  return rows;
}

/** Items a list shows before its section gives way, or all of fewer; the rows left over list more. */
export const LISTED_AT_LEAST = 3;

/** A form that lists items: its heading's rows and each item's, in order. */
export type ListSize = { head: number; items: readonly number[] };

/** The rows a list takes showing its first `listed` items, and a row counting the rest. */
export const listRows = (list: ListSize, listed: number): number =>
  list.head +
  list.items.slice(0, listed).reduce((sum, rows) => sum + rows, 0) +
  (listed < list.items.length ? 1 : 0);

/** Which form each section is drawn in, how many items each list shows, whether blank rows part them, and the sections left out. */
export type Fit = {
  form: Record<string, number>;
  listed: Record<string, number>;
  hasGaps: boolean;
  hidden: string[];
};

/**
 * Picks each section's form so the panel fits `budget` rows. `sizes` holds every present
 * section's rows per form, fullest first, a hidden form as 0, a form that lists items as a
 * ListSize; `fixed` the rows always drawn (title, state, footer). Each step of `order` moves one
 * section a form down (`gaps` drops the blank rows between sections), taken until the rest fits:
 * a blank row before each section and the footer, and one row naming the hidden sections. A list
 * counts LISTED_AT_LEAST items while the forms are picked; then the rows left over list more of
 * each, an item at a time and the lists in turn, until the panel reaches the dock's height.
 */
export function fitBlocks(
  sizes: Record<string, readonly (number | ListSize)[]>,
  order: readonly string[],
  budget: number,
  fixed: number
): Fit {
  const keys = Object.keys(sizes);
  const form: Record<string, number> = Object.fromEntries(
    keys.map((key) => [key, 0])
  );
  const listed: Record<string, number> = {};
  let hasGaps = true;
  const hidden: string[] = [];
  const sizeOf = (key: string) => sizes[key]?.[form[key] ?? 0] ?? 0;
  const listedOf = (key: string, list: ListSize) =>
    listed[key] ?? Math.min(LISTED_AT_LEAST, list.items.length);
  const rowsOf = (key: string) => {
    const size = sizeOf(key);
    return typeof size === "number"
      ? size
      : listRows(size, listedOf(key, size));
  };
  const total = () => {
    const shown = keys.filter((key) => rowsOf(key) > 0);
    const gaps = hasGaps ? shown.length + 1 : 0;
    return (
      fixed +
      shown.reduce((sum, key) => sum + rowsOf(key), 0) +
      gaps +
      (hidden.length > 0 ? 1 : 0)
    );
  };
  for (const step of order) {
    if (total() <= budget) break;
    if (step === "gaps") hasGaps = false;
    else if ((form[step] ?? 0) < (sizes[step]?.length ?? 1) - 1) {
      form[step] = (form[step] ?? 0) + 1;
      if (rowsOf(step) === 0) hidden.push(step);
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of keys) {
      const size = sizeOf(key);
      if (typeof size === "number") continue;
      const was = listedOf(key, size);
      if (was >= size.items.length) continue;
      listed[key] = was + 1;
      if (total() <= budget) grew = true;
      else listed[key] = was;
    }
  }
  for (const key of keys) {
    const size = sizeOf(key);
    if (typeof size !== "number") listed[key] = listedOf(key, size);
  }
  return { form, listed, hasGaps, hidden };
}

// ---------- changed files ----------

const DIFF_CELLS = 10;

export type FileRow = { name: string; plus: string; minus: string };

/** A row per changed file, its bar scaled against the largest change of all, so it keeps its size however many are listed. */
export function changedRows(files: readonly FileChange[]): FileRow[] {
  const largest = Math.max(
    1,
    ...files.map((file) => (file.added ?? 0) + (file.removed ?? 0))
  );
  const scaled = (count: number | null): number =>
    count === null || count <= 0
      ? 0
      : Math.max(1, Math.round((count / largest) * DIFF_CELLS));
  return files.map((file) => ({
    name: file.name,
    plus: "+".repeat(scaled(file.added)),
    minus: "−".repeat(scaled(file.removed)),
  }));
}

// ---------- plan and recap ----------

/** The plan's heading on the right: one cell per item, filled for each done, and the count. */
export function planCount(items: readonly PlanItem[]): {
  done: string;
  left: string;
  count: string;
} {
  const done = items.filter((item) => item.status === "done").length;
  const width = Math.min(items.length, 10);
  const filled = Math.round((done / Math.max(1, items.length)) * width);
  return {
    done: "█".repeat(filled),
    left: "░".repeat(width - filled),
    count: ` ${done} / ${items.length}`,
  };
}

/** The finished items as one line: `✓ 2 done: Copy the mod, Write the tests`. */
export function foldedDone(
  items: readonly PlanItem[],
  width: number
): string | null {
  const done = items.filter((item) => item.status === "done");
  if (done.length === 0) return null;
  return cut(
    `✓ ${done.length} done: ${done.map((item) => item.text).join(", ")}`,
    width
  );
}

/** The last two steps with their ages: `14m block bars switched · 6m session list in`. */
export function recentSteps(brief: Brief, now: number): string | null {
  const steps = brief.steps.slice(-2);
  if (steps.length === 0) return null;
  return steps.map((step) => `${span(now - step.at)} ${step.text}`).join(" · ");
}

// ---------- footer ----------

/** The path and the repository's state: `~/.dotfiles:main !2 ?1 ⇡1`. */
export function whereLine(path: string, repo: Repo | null): string {
  if (repo === null) return path;
  const marks = [
    repo.changed > 0 ? `!${repo.changed}` : "",
    repo.untracked > 0 ? `?${repo.untracked}` : "",
    repo.ahead > 0 ? `⇡${repo.ahead}` : "",
  ].filter((mark) => mark !== "");
  return `${path}:${repo.branch}${
    marks.length === 0 ? "" : ` ${marks.join(" ")}`
  }`;
}

/** Whether `latest` is a newer release than the running `version`; false when either is unknown. */
export function isBehind(version: string, latest: string | null): boolean {
  const parts = (text: string | null) =>
    /^(\d+)\.(\d+)\.(\d+)/
      .exec(text ?? "")
      ?.slice(1)
      .map(Number) ?? null;
  const running = parts(version);
  const newest = parts(latest);
  if (running === null || newest === null) return false;
  const i = newest.findIndex((part, j) => part !== running[j]);
  return i >= 0 && (newest[i] ?? 0) > (running[i] ?? 0);
}

/**
 * The footer's engine line in `width` cells: `● Claude Code 2.1.300 · Opus 5.5 · xhigh`, its dot
 * yellow while a newer release is out, leaving out the effort, then the model, before it would wrap.
 */
export function engineParts(
  version: string,
  latest: string | null,
  model: string,
  effort: string | null,
  width: number
): { text: string; tone?: Tone; bold?: boolean; dim?: boolean }[] {
  const head = `● Claude Code ${version}`;
  const tail =
    [effort === null ? model : `${model} · ${effort}`, model].find(
      (text) => cells(head) + cells(` · ${text}`) <= width
    ) ?? null;
  return [
    { text: "●", tone: isBehind(version, latest) ? "warning" : "success" },
    { text: " Claude Code", bold: true },
    { text: ` ${version}`, dim: true },
    ...(tail === null ? [] : [{ text: ` · ${tail}`, dim: true }]),
  ];
}

/** A model id as people say it: `claude-opus-5-5` → `Opus 5.5`. */
export function modelLabel(model: string): string {
  const parts = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(model);
  if (parts === null) return model;
  const name =
    (parts[1] ?? "").charAt(0).toUpperCase() + (parts[1] ?? "").slice(1);
  return `${name} ${parts[2]}${parts[3] === undefined ? "" : `.${parts[3]}`}`;
}

/** `git status --porcelain=v2 --branch`, as the footer counts it. */
export function parseStatus(output: string): Repo {
  const repo: Repo = {
    branch: "HEAD",
    changed: 0,
    untracked: 0,
    ahead: 0,
    worktree: null,
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head "))
      repo.branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.ab "))
      repo.ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    else if (/^[12u] /.test(line)) repo.changed++;
    else if (line.startsWith("? ")) repo.untracked++;
  }
  return repo;
}
