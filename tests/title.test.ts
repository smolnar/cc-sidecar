import { describe, expect, test } from "claude-code/testing";

import {
  PRESENCE,
  SESSION,
  boot,
  endTurn,
  mountBand,
  nameSession,
  reply,
  runCommand,
  runTurn,
  shown,
  startTurn,
  switchConversation,
} from "./harness";
import type { Harness } from "./harness";

const SECOND = 1000;
/** How often the sidecar reads Claude Code's session registry. */
const LOOK = 10 * SECOND;

/** A dictated first prompt: its opening words name nothing. */
const FIRST_PROMPT =
  "Actually, improve the title because the titles of the chat seem to be all a little bit off.";
const TITLE = "Infer session titles with Haiku";
const TAB = "Haiku titles";
/** Claude Code's own generated title for the session. */
const CLAUDE_TITLE = "Improve chat titles";

/** What this session's presence file tells the other sessions. */
const presence = (h: Harness): { name?: string } =>
  JSON.parse(h.files[`${PRESENCE}/${SESSION}.json`] ?? "{}");

describe("the session's title, from the person's prompts", () => {
  test("names the session from the first prompt with Haiku while the turn still runs", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    h.replies.push(reply({ title: TITLE, tab: TAB }));

    await startTurn($, FIRST_PROMPT);
    await h.clock.advance(SECOND);

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.model).toBe("haiku");
    expect(h.asked[0]?.prompt).toContain(
      "the titles of the chat seem to be all a little bit off"
    );
    expect(await shown(band)).toContain(TITLE);
    expect(h.zellij.tabName).toBe(`${TAB} ◐`);
    expect(presence(h).name).toBe(TAB);
  });

  test("infers the title from every prompt the person sent, and none of Claude's replies", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    h.replies.push(
      reply({ title: TITLE, tab: TAB }),
      reply({
        title: "Hide the agent list under the prompt",
        tab: "Agent list",
      })
    );

    await runTurn($, {
      prompt: FIRST_PROMPT,
      answer: "The sidecar copies Claude Code's own title.",
    });
    await h.clock.advance(SECOND);
    await startTurn($, "Also hide the list of agents under the prompt.");
    await h.clock.advance(SECOND);
    const second = h.asked[1]?.prompt ?? "";

    expect(second).toContain("the titles of the chat seem to be all");
    expect(second).toContain("hide the list of agents under the prompt");
    expect(second).toContain(TITLE);
    expect(second).not.toContain("copies Claude Code's own title");
    expect(await shown(band)).toContain("Hide the agent list under the prompt");
  });

  test("hands Haiku's title to Claude Code at the next prompt", async ($, on) => {
    const h = await boot($, on);
    h.replies.push(reply({ title: TITLE, tab: TAB }));
    await runTurn($, { prompt: FIRST_PROMPT, answer: "Done." });
    await h.clock.advance(SECOND);
    nameSession(h, CLAUDE_TITLE);

    const handed = await $.classic.UserPromptSubmit({
      prompt: "next",
      session_title: CLAUDE_TITLE,
    });
    const taken = await $.classic.UserPromptSubmit({
      prompt: "again",
      session_title: TITLE,
    });

    expect(handed.sessionTitle).toBe(TITLE);
    expect(taken.sessionTitle).toBeUndefined();
  });

  test("keeps Haiku's title when Claude Code names the session itself", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    h.replies.push(reply({ title: TITLE, tab: TAB }));
    const turnId = await startTurn($, FIRST_PROMPT);
    await h.clock.advance(SECOND);

    nameSession(h, CLAUDE_TITLE);
    await h.clock.advance(LOOK);
    await endTurn($, turnId, { answer: "Done." });
    await h.clock.settle();

    expect(await shown(band)).toContain(TITLE);
    expect(await shown(band)).not.toContain(CLAUDE_TITLE);
    expect(h.zellij.tabName.startsWith(`${TAB} `)).toBe(true);
    expect(presence(h).name).toBe(TAB);
  });

  test("takes a /rename as the title over Haiku's, and asks Haiku no more", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    h.replies.push(reply({ title: TITLE, tab: TAB }));
    await runTurn($, { prompt: FIRST_PROMPT, answer: "Done." });
    await h.clock.advance(SECOND);

    await runCommand($, "rename", "sidecar titles");
    await h.clock.advance(LOOK);
    await startTurn($, "and fix the cache line too");
    await h.clock.advance(SECOND);

    expect(h.asked).toHaveLength(1);
    expect(await shown(band)).toContain("sidecar titles");
    expect(await shown(band)).not.toContain(TITLE);
  });

  test("keeps Claude Code's title when Haiku fails or answers with no title", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    nameSession(h, CLAUDE_TITLE);
    h.replies.push({ fail: "api-error" });
    await runTurn($, { prompt: FIRST_PROMPT, answer: "Done." });
    await h.clock.settle();
    expect(await shown(band)).toContain(CLAUDE_TITLE);

    h.replies.push("I would call it chat titles.");
    await runTurn($, { prompt: "and the tab names", answer: "Done." });
    await h.clock.settle();

    expect(h.asked).toHaveLength(2);
    expect(await shown(band)).toContain(CLAUDE_TITLE);
  });

  test("never shows a pasted block's raw text as the title while Haiku thinks", async ($, on) => {
    const h = await boot($, on);
    h.replies.push({
      text: reply({ title: "Fix the failing deploy", tab: "Deploy fix" }),
      afterMs: 5 * SECOND,
    });

    await startTurn(
      $,
      '<pasted_content id="p1">\nError: boom at deploy.rb:12\nbacktrace line\n</pasted_content>\nwhy does this fail?'
    );
    await h.clock.advance(SECOND);

    expect(presence(h).name).toBe("why does this");
    expect(h.zellij.paneName ?? "").not.toContain("pasted_content");
    expect(h.asked[0]?.prompt).toContain("Error: boom at deploy.rb:12");
    expect(h.asked[0]?.prompt).not.toContain("backtrace line");

    await h.clock.advance(5 * SECOND);
    expect(presence(h).name).toBe("Deploy fix");
  });

  test("lets a newer prompt's title win over an older one that answers late", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    h.replies.push(
      {
        text: reply({ title: "Chase the old goal", tab: "Old" }),
        afterMs: 30 * SECOND,
      },
      reply({ title: "Chase the new goal", tab: "New" })
    );

    const first = await startTurn($, FIRST_PROMPT);
    await endTurn($, first, { answer: "Done." });
    await startTurn($, "forget that, something else entirely");
    await h.clock.advance(31 * SECOND);

    expect(await shown(band)).toContain("Chase the new goal");
    expect(await shown(band)).not.toContain("Chase the old goal");
  });

  test("drops a title for the last conversation that lands after /clear", async ($, on) => {
    const h = await boot($, on);
    const band = await mountBand($);
    h.replies.push({
      text: reply({ title: "Name the old conversation", tab: "Old" }),
      afterMs: 5 * SECOND,
    });
    await startTurn($, FIRST_PROMPT);

    await switchConversation(h, $, "clear", "sess-2");
    await h.clock.advance(6 * SECOND);

    expect(h.store.has("brief:sess-2")).toBe(false);
    expect(await shown(band)).not.toContain("Name the old conversation");
  });

  test("asks Haiku nothing for a subagent's prompt, nor tells it one", async ($, on) => {
    const h = await boot($, on);

    await startTurn($, "Search the mod for the title logic", "agent-1");
    await h.clock.advance(SECOND);
    expect(h.asked).toHaveLength(0);

    await startTurn($, FIRST_PROMPT);
    await h.clock.advance(SECOND);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.prompt).not.toContain("Search the mod");
  });

  test("tells Haiku the first prompt and the latest ones, each cut short, however long the session", async ($, on) => {
    const h = await boot($, on);

    for (let i = 1; i <= 15; i++)
      await runTurn($, {
        prompt: `prompt number ${i} ${"words ".repeat(500)}`,
        answer: "Done.",
      });
    await h.clock.settle();
    const last = h.asked[h.asked.length - 1]?.prompt ?? "";

    expect(h.asked).toHaveLength(15);
    expect(last).toContain("prompt number 1 ");
    expect(last).toContain("prompt number 15 ");
    expect(last).not.toContain("prompt number 2 ");
    expect(last.length).toBeLessThan(8000);
  });
});
