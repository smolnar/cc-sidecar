import { describe, expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

import {
  boot,
  briefWith,
  measure,
  mountPanel,
  shown,
  startTurn,
} from "./harness";
import type { Harness } from "./harness";

const BRIEF = {
  title: "Add live session titles",
  story: "You asked for a panel on the right like OpenCode's.",
  now: { state: "waiting", text: "Which fixes should I apply?" },
  step: "panel docks on the right",
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
];

/** A first turn that leaves a brief behind. */
async function briefed(h: Harness, $: Engine): Promise<void> {
  await briefWith(h, $, BRIEF, "build the panel");
}

const edit = (path: string) =>
  ({
    tool: "Edit",
    file_path: path,
    old_string: "a",
    new_string: "b",
  } as const);

/** The rows of one section of the panel, from its heading to the next blank row. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.trim() === "");
  return lines.slice(start, end < 0 ? undefined : end);
}

describe("the panel, laid out as OpenCode's sidebar", () => {
  test("shows title, recap, plan, now, then changed files and context in that order", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await measure($, { tokens: 142_318, percent: 71, usd: 3.41 });
    await startTurn($, "go");
    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    await $.tool.call(edit("/home/dev/.dotfiles/app.rb"));

    const text = await shown(await mountPanel($));
    const order = [
      "Add live session titles",
      "RECAP",
      "PLAN",
      "NOW",
      "CHANGED",
      "CONTEXT",
    ].map((heading) => text.indexOf(heading));

    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("shows the tokens, how full the context is and what the session cost", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await measure($, { tokens: 142_318, percent: 71, usd: 3.41 });
    const context = section(await shown(await mountPanel($)), "CONTEXT");

    expect(context[0]).toMatch(/\$3\.41 spent$/);
    expect(context[1]).toMatch(/^71% +142k of 200k tokens$/);
  });

  test("follows the context as later turns fill it", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await measure($, { tokens: 20_000, percent: 10, usd: 0.4 });
    const panel = await mountPanel($);

    await measure($, { tokens: 61_250, percent: 31, usd: 1.05 });
    const context = section(await shown(panel), "CONTEXT");

    expect(context[0]).toMatch(/\$1\.05 spent$/);
    expect(context[1]).toMatch(/^31% +61k of 200k tokens$/);
  });

  test("leaves out the cost where Claude Code keeps no ledger", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await measure($, { tokens: 9_400, percent: 5 });
    const context = section(await shown(await mountPanel($)), "CONTEXT");

    expect(context[1]).toMatch(/^5% +9k of 200k tokens$/);
    expect(context.join("\n")).not.toContain("spent");
  });

  test("shows no context before Claude Code has measured the session", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    expect(await shown(await mountPanel($))).not.toContain("CONTEXT");
  });

  test("counts each changed file's added and removed lines from git", async ($, on) => {
    const h = await boot($, on);
    h.git.changed["/home/dev/.dotfiles/app/models/user.rb"] = "12\t3";
    await briefed(h, $);
    await startTurn($, "go");

    await $.tool.call(edit("/home/dev/.dotfiles/app/models/user.rb"));
    await h.clock.settle();
    const changed = section(await shown(await mountPanel($)), "CHANGED");

    expect(changed[0]).toMatch(/\+12 −3 · 1 file$/);
    expect(changed[1]).toMatch(/^user\.rb +\+{8}−{2}$/);
  });

  test("updates a file's counts when Claude edits it again", async ($, on) => {
    const h = await boot($, on);
    h.git.changed["/home/dev/.dotfiles/app.rb"] = "2\t1";
    await briefed(h, $);
    await startTurn($, "go");
    await $.tool.call(edit("/home/dev/.dotfiles/app.rb"));
    await h.clock.settle();

    h.git.changed["/home/dev/.dotfiles/app.rb"] = "9\t4";
    await $.tool.call(edit("/home/dev/.dotfiles/app.rb"));
    await h.clock.settle();
    const changed = section(await shown(await mountPanel($)), "CHANGED");

    expect(changed[0]).toMatch(/\+9 −4 · 1 file$/);
    expect(changed.join("\n")).not.toContain("+2 −1");
  });

  test("counts a new untracked file's lines as added", async ($, on) => {
    const h = await boot($, on);
    h.git.untracked["/home/dev/.dotfiles/new.ts"] = 40;
    await briefed(h, $);
    await startTurn($, "go");

    await $.tool.call({
      tool: "Write",
      file_path: "/home/dev/.dotfiles/new.ts",
      content: "x",
    });
    await h.clock.settle();
    const changed = section(await shown(await mountPanel($)), "CHANGED");

    expect(changed[0]).toMatch(/\+40 · 1 file$/);
    expect(changed[1]).toMatch(/^new\.ts +\+{10}$/);
  });

  test("shows a binary file by its name alone", async ($, on) => {
    const h = await boot($, on);
    h.git.changed["/home/dev/.dotfiles/logo.png"] = "-\t-";
    await briefed(h, $);
    await startTurn($, "go");

    await $.tool.call({
      tool: "Write",
      file_path: "/home/dev/.dotfiles/logo.png",
      content: "x",
    });
    await h.clock.settle();
    const changed = section(await shown(await mountPanel($)), "CHANGED");

    expect(changed[0]).toMatch(/ 1 file$/);
    expect(changed[1]?.trim()).toBe("logo.png");
  });

  test("leaves Claude's edit outside a git repository off the list", async ($, on) => {
    const h = await boot($, on);
    h.git.isDown = true;
    await briefed(h, $);
    await startTurn($, "go");

    await $.tool.call(edit("/tmp/scratch/notes.md"));
    await h.clock.settle();
    const changed = section(await shown(await mountPanel($)), "CHANGED");

    expect(changed).toEqual([]);
    expect(h.shownLines).toHaveLength(0);
  });
});
