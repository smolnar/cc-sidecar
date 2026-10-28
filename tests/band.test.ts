import { describe, expect, test } from "claude-code/testing";

import {
  MINUTE,
  SESSION,
  START,
  bandProps,
  boot,
  mountBand,
  nameSession,
  reply,
  runCommand,
  runTurn,
  shown,
  startTurn,
  useTools,
} from "./harness";

const SECOND = 1000;
/** How often the sidecar reads Claude Code's session registry. */
const LOOK = 10 * SECOND;

/** Claude Code's own title for the session, as its registry entry names it. */
const TITLE = "Replace zjstatus with a lean bar plugin";

const FIRST_TURN = {
  prompt: "why does the status bar burn a whole core?",
  answer:
    "The status bar burned 55-100% of a core. We traced it to zjstatus and rebuilt the bar in Rust. Shall I add the build step to ./install?",
  tools: 2,
};

describe("after a turn", () => {
  test("shows Claude Code's title, the reply's opening as the story and its question as waiting, with no model call but the prompt's title", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);

    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    const text = await shown(band);
    expect(text).toContain(TITLE);
    expect(text).toContain(
      "The status bar burned 55-100% of a core. We traced it to zjstatus and rebuilt the bar in Rust."
    );
    expect(text).toContain("Waiting on you");
    expect(text).toContain("Shall I add the build step to ./install?");
    // The one Haiku call names the session from the prompt (down here, so Claude Code's title stays).
    expect(h.asked.map((call) => call.model)).toEqual(["haiku"]);
    expect(h.forked).toHaveLength(0);
  });

  test("says done when the reply asks nothing, and rewrites the story each turn", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    await runTurn($, {
      prompt: "yes, add it",
      answer: "Added the build step to ./install. The bar is installed.",
    });
    await h.clock.settle();

    const text = await shown(band);
    expect(text).toContain(TITLE);
    expect(text).toContain("Added the build step to ./install.");
    expect(text).not.toContain("We traced it");
    expect(text).toContain("Done");
    expect(text).toContain("The bar is installed");
  });

  test("follows Claude Code when it renames the session", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    nameSession(h, "Fix fish completions for zellij");
    await h.clock.advance(LOOK);

    const text = await shown(band);
    expect(text).toContain("Fix fish completions for zellij");
    expect(text).not.toContain("Replace zjstatus");
  });

  test("uses the first prompt as the title until Claude Code names the session", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);

    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    expect(await shown(band)).toContain(FIRST_TURN.prompt);

    nameSession(h, TITLE);
    await h.clock.advance(LOOK);
    expect(await shown(band)).toContain(TITLE);
  });

  test("reads a markdown reply as plain text", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);

    await runTurn($, {
      prompt: "what changed?",
      answer: [
        "## Summary",
        "",
        "- Traced the **CPU burn** to `zjstatus`",
        "- Rebuilt the bar in [Rust](https://rust-lang.org)",
        "",
        "```rust",
        "fn main() {}",
        "```",
        "",
        "Shall I add the build step?",
      ].join("\n"),
    });
    await h.clock.settle();

    const text = await shown(band);
    expect(text).toContain(
      "Traced the CPU burn to zjstatus. Rebuilt the bar in Rust."
    );
    expect(text).toContain("Shall I add the build step?");
    expect(text).not.toMatch(/##|\*\*|`|https:|fn main/);
  });

  test("cuts a title longer than 60 characters", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    const long =
      "Replace zjstatus with a lean bar plugin and measure every widget it draws";
    nameSession(h, long);

    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    const text = await shown(band);
    expect(text).toContain(long.slice(0, 59).trimEnd() + "…");
    expect(text).not.toContain(long);
  });

  test("says when the brief was last updated", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);

    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    expect(await shown(band)).toContain("updated just now");

    await h.clock.advance(2 * MINUTE);
    expect(await shown(band)).toContain("updated 2m ago");
  });

  test("makes no brief for a turn that ended on an API error", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);

    await runTurn($, { ...FIRST_TURN, reason: "error" });
    await h.clock.settle();

    expect(await shown(band)).toBe("");
  });

  test("makes no brief for a turn with no prompt, reply or tools", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);

    await runTurn($, { reason: "aborted" });
    await h.clock.settle();

    expect(await shown(band)).toBe("");
  });

  test("asks no model in the middle of a long turn", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    await startTurn($, "a long one");
    await h.clock.advance(SECOND);
    // One Haiku call per prompt names the session; none comes after it.
    const titled = h.asked.length;
    await useTools($, 3);
    await h.clock.advance(10 * MINUTE);

    expect(titled).toBe(2);
    expect(h.asked).toHaveLength(titled);
    expect(h.forked).toHaveLength(0);
  });
});

describe("while a turn runs", () => {
  test("counts the tool calls of the running turn", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    const band = await mountBand($);

    await startTurn($, "yes, add it");
    await band.redraw(bandProps({ isWorking: true }));
    await useTools($, 1);
    expect(await shown(band)).toContain("Working · 1 tool call");

    await useTools($, 1);
    const text = await shown(band);
    expect(text).toContain("Working · 2 tool calls");
    expect(text).toContain(TITLE);
    expect(text).not.toContain("Waiting on you");
  });

  test("leaves the brief and the working line alone when a subagent's turn ends", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    const band = await mountBand($);

    await startTurn($, "research the zellij pipe API");
    await band.redraw(bandProps({ isWorking: true }));
    await useTools($, 1);
    await runTurn($, {
      prompt: "find the pipe docs",
      answer: "Found them.",
      agentId: "agent-1",
    });
    await h.clock.settle();

    const text = await shown(band);
    expect(text).toContain("Working · 1 tool call");
    expect(text).not.toContain("Found them");
  });
});

describe("coming back", () => {
  test("shows a recap after ten idle minutes and drops it when a turn starts", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);

    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    await h.clock.advance(9 * MINUTE);
    expect(await shown(band)).not.toContain("you were away");

    await h.clock.advance(1 * MINUTE);
    const recap = await shown(band);
    expect(recap).toContain("you were away 10m");
    expect(recap).toContain("We traced it to zjstatus");
    expect(recap).toContain("Waiting on you");

    await startTurn($, "ok, where were we?");
    await band.redraw(bandProps({ isWorking: true }));
    const working = await shown(band);
    expect(working).not.toContain("you were away");
    expect(working).toContain("Working");
  });

  test("shows the brief saved for this session when it starts again", async ($, on) => {
    const saved = {
      title: "Keep focus when a window closes",
      story:
        "Closing a window lost focus. We patched the fork and added a regression test.",
      now: { state: "done", text: "merged into the fork branch" },
      steps: [{ at: START - 3 * MINUTE, text: "regression test passes" }],
      isPinned: false,
      updatedAt: START - 3 * MINUTE,
    };
    await boot($, on, { [`brief:${SESSION}`]: saved });
    const band = await mountBand($);

    const text = await shown(band);
    expect(text).toContain("Keep focus when a window closes");
    expect(text).toContain("We patched the fork");
    expect(text).toContain("Done");
  });
});

describe("the band", () => {
  test("draws nothing before the first brief", async ($, on) => {
    await boot($, on);
    const band = await mountBand($);

    expect(await band.find({ key: "engine" })).toBeDefined();
    expect(await shown(band)).toBe("");
  });

  test("steps aside while a survey holds the band", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    const band = await mountBand($, { hasSurvey: true });

    expect(await band.find({ key: "engine" })).toBeDefined();
    expect(await shown(band)).not.toContain("Replace zjstatus");
  });
});

describe("/brief", () => {
  test("prints the whole brief and keeps only the last eight steps", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    for (let i = 1; i <= 9; i++) {
      h.forkReplies.push(
        reply({
          title: TITLE,
          story: "We traced it to zjstatus and rebuilt the bar in Rust.",
          now: {
            state: "waiting",
            text: "approve the build step in ./install",
          },
          step: `milestone ${i}`,
        })
      );
      await runCommand($, "brief", "refresh");
    }

    const printed = await runCommand($, "brief");

    expect(printed.text).toContain(TITLE);
    expect(printed.text).toContain("We traced it to zjstatus");
    expect(printed.text).toContain(
      "Waiting on you: approve the build step in ./install"
    );
    expect(printed.text?.match(/milestone \d/g)).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9].map((i) => `milestone ${i}`)
    );
  });

  test("says there is no brief before the first reply", async ($, on) => {
    await boot($, on);

    const printed = await runCommand($, "brief");

    expect(printed.text).toContain("No brief yet");
  });

  test("pins a title that Claude Code's later titles leave alone", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    const pinned = await runCommand($, "brief", "title Lean zellij status bar");
    expect(pinned.text).toContain("Lean zellij status bar");
    expect(await shown(band)).toContain("Lean zellij status bar");

    nameSession(h, "Something else entirely");
    await runTurn($, { prompt: "next", answer: "ok" });
    await h.clock.advance(LOOK);
    const text = await shown(band);
    expect(text).toContain("Lean zellij status bar");
    expect(text).not.toContain("Something else entirely");
  });

  test("unpins the title when given no text, and Claude Code's comes back", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    await runCommand($, "brief", "title Lean zellij status bar");

    const unpinned = await runCommand($, "brief", "title");
    nameSession(h, "Ship the bar plugin");
    await h.clock.advance(LOOK);

    expect(unpinned.text).toContain("no longer pinned");
    expect(await shown(band)).toContain("Ship the bar plugin");
  });

  test("pins a title before the first reply", async ($, on) => {
    await boot($, on);
    const band = await mountBand($);

    await runCommand($, "brief", "title Lean zellij status bar");

    expect(await shown(band)).toContain("Lean zellij status bar");
  });

  test("refresh rebuilds the brief from the whole conversation with one model call", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();
    h.forkReplies.push(
      reply({
        title: TITLE,
        story: "Rebuilt from the full transcript.",
        now: { state: "done", text: "bar is installed" },
        step: null,
      })
    );

    const titled = h.asked.length;
    const refreshed = await runCommand($, "brief", "refresh");

    expect(h.forked).toHaveLength(1);
    expect(h.asked).toHaveLength(titled);
    expect(refreshed.text).toContain("Rebuilt the brief");
    expect(await shown(band)).toContain("Rebuilt from the full transcript.");
  });

  test("refresh before the first reply says there is nothing to summarize", async ($, on) => {
    const h = await boot($, on);
    h.forkReplies.push({ fail: "nothing-to-fork" });

    const refreshed = await runCommand($, "brief", "refresh");

    expect(refreshed.text).toContain("Nothing to summarize yet");
  });
});

describe("session title", () => {
  test("leaves Claude Code's own title alone, and gives it a pinned one", async ($, on) => {
    const h = await boot($, on);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    const unpinned = await $.classic.UserPromptSubmit({
      prompt: "next",
      session_title: TITLE,
    });
    await runCommand($, "brief", "title Lean zellij status bar");
    const pinned = await $.classic.UserPromptSubmit({
      prompt: "again",
      session_title: TITLE,
    });

    expect(unpinned.sessionTitle).toBeUndefined();
    expect(pinned.sessionTitle).toBe("Lean zellij status bar");
  });

  test("takes the name /rename gives as the title", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, TITLE);
    await runTurn($, FIRST_TURN);
    await h.clock.settle();

    const renamed = await runCommand($, "rename", "zellij bar");
    await h.clock.advance(LOOK);

    expect(renamed.text).toBe("Renamed the session.");
    expect(await shown(band)).toContain("zellij bar");
    expect(await shown(band)).not.toContain("Replace zjstatus");
  });
});
