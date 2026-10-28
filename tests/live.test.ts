import { describe, expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

import {
  MINUTE,
  PRESENCE,
  SESSION,
  TAB_NAME,
  boot,
  briefWith,
  drawFullscreen,
  endSession,
  endTurn,
  mountBand,
  mountFullscreenBand,
  mountPanel,
  nameSession,
  runCommand,
  runTurn,
  shown,
  startTurn,
  step,
  zellijLines,
} from "./harness";
import type { BriefFields, Harness } from "./harness";

const SECOND = 1000;

const BRIEF: BriefFields = {
  title: "Add live session titles",
  story:
    "You asked for a title on top and a live line. The mod now renames the zellij pane.",
  now: { state: "waiting", text: "Which fixes should I apply?" },
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

const readFile = (name: string) =>
  ({ tool: "Read", file_path: `/home/dev/.dotfiles/${name}` } as const);

const editFile = (name: string) =>
  ({
    tool: "Edit",
    file_path: `/home/dev/.dotfiles/${name}`,
    old_string: "a",
    new_string: "b",
  } as const);

/** A first turn that leaves a brief behind, waiting on the person. */
async function briefed(
  h: Harness,
  $: Engine,
  fields: BriefFields = BRIEF
): Promise<void> {
  await briefWith(h, $, fields, "build the live titles");
  await h.clock.advance(SECOND);
}

const renames = (h: Harness, action: string) =>
  zellijLines(h).filter((line) => line.startsWith(action));

describe("the title on top: the zellij pane's frame", () => {
  test("names the pane '✻ title · ◐ now' and follows each tool call", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await startTurn($, "yes, go");
    await $.tool.call(readFile("config.kdl"));
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Reading config.kdl"
    );

    await $.tool.call(editFile("where-was-i.html"));
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Editing where-was-i.html"
    );
  });

  test("uses the first prompt as the title until the first summary arrives", async ($, on) => {
    const h = await boot($, on);

    await startTurn($, "build the live titles");
    await $.tool.call(readFile("config.kdl"));
    await h.clock.advance(SECOND);

    expect(h.zellij.paneName).toBe(
      "✻ build the live titles · ◐ Reading config.kdl"
    );
  });

  test("shows Claude's progress sentence, and the newest of sentence and tool call wins", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const turnId = await startTurn($, "yes, go");
    await step(
      h,
      $,
      turnId,
      "Copied. Next I'll run the existing tests to confirm the kit works."
    );
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Next I'll run the existing tests to confirm the kit works"
    );

    await $.tool.call({
      tool: "Bash",
      command: "claude plugin test .",
      description: "Run the test suite",
    });
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Run the test suite"
    );
  });

  test("describes each kind of tool call in words", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");
    const said = async (): Promise<string> => {
      await h.clock.advance(SECOND);
      return (h.zellij.paneName ?? "").replace(
        "✻ Add live session titles · ◐ ",
        ""
      );
    };

    await $.tool.call({
      tool: "Write",
      file_path: "/home/dev/.dotfiles/new.ts",
      content: "x",
    });
    expect(await said()).toBe("Writing new.ts");
    await $.tool.call({ tool: "Bash", command: "bun test" });
    expect(await said()).toBe("Running bun test");
    await $.tool.call({
      tool: "WebSearch",
      query: "zellij tab names",
      mode: "standard",
    });
    expect(await said()).toBe("Searching the web for zellij tab names");
    await $.tool.call({
      tool: "Agent",
      description: "Research live titles",
      prompt: "go",
    } as never);
    expect(await said()).toBe("Agent: Research live titles");
  });

  test("switches to the reply's state when the turn ends", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◆ Waiting on you: Which fixes should I apply?"
    );

    await runTurn($, {
      prompt: "fix it",
      answer: "Fixed the rename. Tests pass.",
      tools: 1,
    });
    await h.clock.settle();
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ✓ Done: Tests pass"
    );
  });

  test("marks the pane as waiting while Claude asks you a question", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await startTurn($, "yes, go");
    const asking = $.tool.call({
      tool: "AskUserQuestion",
      questions: [],
    } as never);
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◆ Waiting on your answer"
    );

    await h.clock.advance(MINUTE);
    await asking;
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe("✻ Add live session titles · ◐ Working");
  });

  test("renames the pane at most once a second, and the last state wins", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    const before = renames(h, "rename-pane").length;

    await startTurn($, "yes, go");
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])
      await $.tool.call(readFile(name));
    await h.clock.advance(SECOND);

    expect(renames(h, "rename-pane").length - before).toBeLessThanOrEqual(2);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Reading e.ts"
    );
  });

  test("keeps a pinned title in the frame", async ($, on) => {
    const h = await boot($, on);
    await runCommand($, "brief", "title Ship the live brief");
    await briefed(h, $);

    expect(h.zellij.paneName).toBe(
      "✻ Ship the live brief · ◆ Waiting on you: Which fixes should I apply?"
    );
  });

  test("keeps the live line moving after a turn ends", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await runTurn($, { prompt: "next", answer: "Done.", tools: 0 });
    await h.clock.settle();

    await startTurn($, "and now?");
    await $.tool.call(readFile("bar.rs"));
    await h.clock.advance(SECOND);

    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Reading bar.rs"
    );
  });

  test("ignores a subagent's own steps and tool calls", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const turnId = await startTurn($, "yes, go");
    await $.tool.call({
      tool: "Agent",
      description: "Research live titles",
      prompt: "go",
    } as never);
    await h.clock.advance(SECOND);
    await step(h, $, turnId, "Searching GitHub for zellij plugins.", "agent-1");
    await $.tool.call({ ...readFile("deep.ts"), agentId: "agent-1" } as never);
    await h.clock.advance(SECOND);

    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Agent: Research live titles"
    );
  });
});

describe("titles on the zellij tabs", () => {
  test("renames the session's tab to its short title and state", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    expect(h.zellij.tabName).toBe("Add live session ◆");

    await startTurn($, "yes, go");
    await h.clock.advance(SECOND);
    expect(h.zellij.tabName).toBe("Add live session ◐");
  });

  test("renames the tab only when its label changes, not on every tool call", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");
    await h.clock.advance(SECOND);
    const before = renames(h, "rename-tab-by-id").length;

    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await $.tool.call(readFile(name));
      await h.clock.advance(SECOND);
    }

    expect(renames(h, "rename-tab-by-id").length).toBe(before);
  });

  test("names the tab with the title's whole words that fit in 16 characters", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $, {
      ...BRIEF,
      title: "Replace zjstatus with a lean bar plugin",
    });

    expect(h.zellij.tabName).toBe("Replace zjstatus ◆");
  });

  test("gives the pane and the tab their own names back when the session ends", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    expect(h.zellij.paneName).not.toBeNull();

    await endSession($);

    expect(h.zellij.paneName).toBeNull();
    expect(h.zellij.tabName).toBe(TAB_NAME);
  });

  test("keeps the names given back when Claude Code renames the session after it ended", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await endSession($);
    nameSession(h, "Ship the live brief");
    await h.clock.advance(10 * SECOND);

    expect(h.zellij.paneName).toBeNull();
    expect(h.zellij.tabName).toBe(TAB_NAME);
  });

  test("names the pane again when a turn starts after /clear ended the last conversation", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await $.session.end({
      reason: "clear",
      sessionId: SESSION,
      resume: { id: SESSION },
    });
    expect(h.zellij.paneName).toBeNull();

    await startTurn($, "a fresh start");
    await $.tool.call(readFile("new.ts"));
    await h.clock.advance(SECOND);

    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Reading new.ts"
    );
  });
});

describe("outside zellij, or when zellij fails", () => {
  test("runs no zellij command outside zellij, and the panel still shows what Claude is doing", async ($, on) => {
    const h = await boot($, on, {}, {});
    await briefed(h, $);
    await startTurn($, "yes, go");
    await $.tool.call(readFile("config.kdl"));
    await h.clock.advance(SECOND);

    expect(h.zellij.runs).toHaveLength(0);
    expect(await shown(await mountPanel($))).toContain("◐ Reading config.kdl");
  });

  test("shows nothing when zellij fails, and tries again on the next change", async ($, on) => {
    const h = await boot($, on);
    h.zellij.isDown = true;
    await briefed(h, $);
    await startTurn($, "yes, go");
    await $.tool.call(readFile("a.ts"));
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBeNull();
    expect(h.shownLines).toHaveLength(0);

    h.zellij.isDown = false;
    await $.tool.call(readFile("b.ts"));
    await h.clock.advance(SECOND);

    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Reading b.ts"
    );
    expect(h.zellij.tabName).toBe("Add live session ◐");
  });
});

describe("the panel on the right", () => {
  test("opens by itself when the fullscreen layout first draws, once", async ($, on) => {
    const h = await boot($, on);

    await drawFullscreen(h, $);
    await drawFullscreen(h, $);

    expect(h.opens).toEqual(["brief"]);
  });

  test("asks the dock for a narrow column, opened by itself or with /brief panel", async ($, on) => {
    const h = await boot($, on);

    await drawFullscreen(h, $);
    await runCommand($, "brief", "panel");

    expect(h.openWidths).toEqual([60, 60]);
  });

  test("does not open by itself on the main screen", async ($, on) => {
    const h = await boot($, on);

    await shown(await mountBand($));
    await h.clock.settle();

    expect(h.opens).toHaveLength(0);
  });

  test("/brief panel opens it at any width", async ($, on) => {
    const h = await boot($, on);

    const ran = await runCommand($, "brief", "panel");

    expect(ran.text).toBe("Opened the brief panel.");
    expect(h.opens).toEqual(["brief"]);
  });

  test("shows the title, story and what Claude is doing now", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");
    await $.tool.call(readFile("a.ts"));
    await $.tool.call(readFile("config.kdl"));

    const text = await shown(await mountPanel($));

    expect(text).toContain("Add live session titles");
    expect(text).toContain("The mod now renames the zellij pane.");
    expect(text).toContain("NOW");
    expect(text).toContain("◐ Reading config.kdl");
    expect(text).toContain("2 tool calls this turn");
  });

  test("shows the reply's state once the turn has ended", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const text = await shown(await mountPanel($));

    expect(text).toContain("◆ Waiting on you");
    expect(text).toContain("Which fixes should I apply?");
  });

  test("lists the todo list as the plan, with what is done", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");

    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    const text = await shown(await mountPanel($));

    expect(text).toMatch(/PLAN +█░░ 1 \/ 3\n/);
    expect(text).toContain("✓ 1 done: Copy the mod");
    expect(text).toContain("◐ Write the failing tests");
    expect(text).toContain("○ Implement");
  });

  test("follows tasks as Claude creates, updates and deletes them", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");
    const create = async (subject: string): Promise<string> => {
      const made = (await $.tool.call({
        tool: "TaskCreate",
        subject,
        description: subject,
      })) as {
        result: { task: { id: string } };
      };
      return made.result.task.id;
    };

    const copy = await create("Copy the mod");
    const tests = await create("Write tests");
    const drop = await create("Drop me");
    await $.tool.call({
      tool: "TaskUpdate",
      taskId: copy,
      status: "completed",
    });
    await $.tool.call({
      tool: "TaskUpdate",
      taskId: tests,
      status: "in_progress",
      subject: "Write the tests",
    });
    await $.tool.call({ tool: "TaskUpdate", taskId: drop, status: "deleted" });
    const text = await shown(await mountPanel($));

    expect(text).toMatch(/PLAN +█░ 1 \/ 2\n/);
    expect(text).toContain("✓ 1 done: Copy the mod");
    expect(text).toContain("◐ Write the tests");
    expect(text).not.toContain("Drop me");
  });

  test("keeps every task update Claude makes at once, as when it finishes one task and starts the next", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");
    const made = (await Promise.all(
      ["Copy the mod", "Write tests", "Implement"].map((subject) =>
        $.tool.call({ tool: "TaskCreate", subject, description: subject })
      )
    )) as { result: { task: { id: string } } }[];
    const [copy = "", tests = ""] = made.map((call) => call.result.task.id);

    await Promise.all([
      $.tool.call({ tool: "TaskUpdate", taskId: copy, status: "completed" }),
      $.tool.call({ tool: "TaskUpdate", taskId: tests, status: "in_progress" }),
    ]);
    const text = await shown(await mountPanel($));

    expect(text).toMatch(/PLAN +█░░ 1 \/ 3\n/);
    expect(text).toContain("✓ 1 done: Copy the mod");
    expect(text).toContain("◐ Write tests");
    expect(text).toContain("○ Implement");
  });

  test("keeps a file Claude edits and a task it updates at once", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");
    const made = (await $.tool.call({
      tool: "TaskCreate",
      subject: "Copy the mod",
      description: "Copy the mod",
    })) as { result: { task: { id: string } } };

    await Promise.all([
      $.tool.call(editFile("one.ts")),
      $.tool.call({
        tool: "TaskUpdate",
        taskId: made.result.task.id,
        status: "in_progress",
      }),
    ]);
    const text = await shown(await mountPanel($));

    expect(text).toContain("◐ Copy the mod");
    expect(text.slice(text.indexOf("CHANGED"))).toContain("one.ts");
  });

  test("shows /brief refresh's plan while the session has no todo list, until it makes one", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $, {
      ...BRIEF,
      plan: [
        { text: "Find why recaps stopped", status: "done" },
        { text: "Build the live brief", status: "doing" },
        { text: "Install it everywhere", status: "next" },
      ],
    });
    const panel = await mountPanel($);
    const before = await shown(panel);
    expect(before).toMatch(/PLAN +from the summary\n/);
    expect(before).toContain("✓ 1 done: Find why recaps stopped");
    expect(before).toContain("◐ Build the live brief");
    expect(before).toContain("○ Install it everywhere");

    await startTurn($, "yes, go");
    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    const after = await shown(panel);

    expect(after).toMatch(/PLAN +█░░ 1 \/ 3\n/);
    expect(after).not.toContain("Find why recaps stopped");
  });

  test("lists the files Claude changed, newest first, without repeats", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await startTurn($, "yes, go");

    for (const name of [
      "one.ts",
      "two.ts",
      "three.ts",
      "four.ts",
      "five.ts",
      "six.ts",
      "seven.ts",
    ])
      await $.tool.call(editFile(name));
    await $.tool.call(editFile("three.ts"));
    await $.tool.call(readFile("read-only.ts"));
    const text = await shown(await mountPanel($));
    const files = text
      .slice(text.indexOf("CHANGED"))
      .split("\n")
      .map((row) => row.trim());

    expect(files.slice(1, 9)).toEqual([
      "three.ts",
      "seven.ts",
      "six.ts",
      "five.ts",
      "four.ts",
      "two.ts",
      "one.ts",
      "",
    ]);
    expect(files[0]).toMatch(/7 files$/);
    expect(files.join("\n")).not.toContain("read-only.ts");
  });

  test("brings the plan and the files back when the session starts again", async ($, on) => {
    const saved = {
      title: "Add live session titles",
      tab: "Live titles",
      story: "Picked up again.",
      now: { state: "done", text: "" },
      steps: [],
      plan: [],
      isPinned: false,
      updatedAt: Date.UTC(2026, 9, 19, 12, 0),
    };
    await boot($, on, {
      [`brief:${SESSION}`]: saved,
      [`work:${SESSION}`]: {
        todos: [{ id: "1", text: "Write the failing tests", status: "doing" }],
        files: ["register.tsx"],
      },
    });

    const text = await shown(await mountPanel($));

    expect(text).toContain("◐ Write the failing tests");
    expect(text).toContain("register.tsx");
  });
});

describe("the band above the prompt", () => {
  test("steps aside while the panel is docked beside the transcript", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    await drawFullscreen(h, $);

    const band = await mountFullscreenBand($);

    expect(h.opens).toEqual(["brief"]);
    expect(await shown(band)).not.toContain("Add live session titles");
  });

  test("shows title, what Claude is doing and plan progress when the panel has no room", async ($, on) => {
    const h = await boot($, on);
    h.canPlace = false;
    await briefed(h, $);
    await drawFullscreen(h, $);
    await startTurn($, "yes, go");
    await $.tool.call({ tool: "TodoWrite", todos: TODOS } as never);
    await $.tool.call(readFile("config.kdl"));

    const band = await mountFullscreenBand($, { isWorking: true });
    const text = await shown(band);

    expect(text).toContain("Add live session titles");
    expect(text).toContain("◐ Working · 2 tool calls · Reading config.kdl");
    expect(text).toContain("Plan 1 of 3 done · ◐ Write the failing tests");
  });
});

const ESC = "\u001b";
const BEL = "\u0007";
/** Whether `text` holds a control character or a bidirectional override a terminal would act on. */
const hasControl = (text: string | null | undefined): boolean =>
  /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(text ?? "");

describe("text from the model and its tools, on its way to zellij", () => {
  test("strips escape sequences from Claude Code's title before zellij names the pane and tab", async ($, on) => {
    const h = await boot($, on);

    await briefed(h, $, {
      ...BRIEF,
      title: `${ESC}]52;c;ZXZpbA==${BEL}Add ${ESC}[31mlive${ESC}[0m session titles`,
    });

    expect(h.zellij.tabName).toBe("Add live session ◆");
    expect(h.zellij.paneName?.startsWith("✻ Add live session titles · ")).toBe(
      true
    );
    expect(hasControl(h.zellij.paneName)).toBe(false);
  });

  test("strips escape sequences from a Bash description and a progress sentence", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    const turnId = await startTurn($, "yes, go");
    await $.tool.call({
      tool: "Bash",
      command: "ls",
      description: `List ${ESC}[2Jfiles${BEL}`,
    });
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe("✻ Add live session titles · ◐ List files");

    await step(h, $, turnId, `Next ${ESC}]0;pwned${BEL}I'll run the tests.`);
    await h.clock.advance(SECOND);
    expect(h.zellij.paneName).toBe(
      "✻ Add live session titles · ◐ Next I'll run the tests"
    );
  });

  test("writes no escape sequences into the presence file the other sessions read", async ($, on) => {
    const h = await boot($, on);

    await briefed(h, $, {
      ...BRIEF,
      title: `${ESC}[5mAdd live session titles`,
      now: {
        state: "waiting",
        text: `Which ${ESC}]8;;http://x${BEL}fixes should I apply?`,
      },
    });
    const presence = JSON.parse(h.files[`${PRESENCE}/${SESSION}.json`] ?? "{}");

    expect(presence.name).toBe("Add live session");
    expect(presence.question).toBe("Which fixes should I apply?");
  });
});

describe("names zellij is given", () => {
  test("names the tab after a pinned title that starts with a dash", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);

    await runCommand($, "brief", "title -x fix");
    await h.clock.advance(SECOND);

    expect(h.zellij.tabName).toBe("-x fix ◆");
  });
});

describe("quitting", () => {
  test("tells the other sessions it ended before zellij is done giving the names back", async ($, on) => {
    const h = await boot($, on);
    await briefed(h, $);
    h.zellij.delayMs = 3 * SECOND;

    const ending = endSession($);
    await h.clock.settle();

    expect(
      JSON.parse(h.files[`${PRESENCE}/${SESSION}.json`] ?? "{}")
    ).toMatchObject({ isEnded: true });
    await h.clock.advance(10 * SECOND);
    await ending;
  });
});
