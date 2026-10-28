import { describe, expect, test } from "claude-code/testing";

import { parseReply } from "../hooks/brief";
import type { Brief } from "../types";

const PREVIOUS: Brief = {
  title: "Replace zjstatus with a lean bar plugin",
  tab: "Lean bar plugin",
  story: "We traced the cost to zjstatus.",
  now: { state: "waiting", text: "approve the build step" },
  steps: [],
  plan: [],
  isPinned: false,
  isTitled: false,
  updatedAt: 0,
};

const json = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("parseReply", () => {
  test("reads a plain JSON reply", () => {
    const parsed = parseReply(
      json({
        title: "Fix the bar",
        story: "It works.",
        now: { state: "done", text: "shipped" },
        step: "tests pass",
      }),
      null
    );

    expect(parsed).toEqual({
      title: "Fix the bar",
      tab: "",
      story: "It works.",
      now: { state: "done", text: "shipped" },
      step: "tests pass",
      plan: [],
    });
  });

  test("reads JSON inside a code fence and prose", () => {
    const parsed = parseReply(
      "Sure:\n```json\n" +
        json({ title: "Fix the bar", story: "s" }) +
        "\n```\nDone.",
      null
    );

    expect(parsed?.title).toBe("Fix the bar");
  });

  test("returns null for text without a JSON object", () => {
    expect(parseReply("The session is about the bar.", PREVIOUS)).toBeNull();
    expect(parseReply('{"title": "Fix", "story": ', PREVIOUS)).toBeNull();
    expect(parseReply("[1, 2]", PREVIOUS)).toBeNull();
    expect(parseReply("", PREVIOUS)).toBeNull();
  });

  test("keeps the previous title and story when the reply leaves them out", () => {
    const parsed = parseReply(
      json({ title: "  ", now: { state: "done", text: "x" } }),
      PREVIOUS
    );

    expect(parsed?.title).toBe(PREVIOUS.title);
    expect(parsed?.story).toBe(PREVIOUS.story);
  });

  test("returns null when there is no title at all", () => {
    expect(parseReply(json({ story: "Only a story." }), null)).toBeNull();
  });

  test("cuts the title at 60 characters", () => {
    const sixty = "x".repeat(60);

    expect(parseReply(json({ title: sixty }), null)?.title).toBe(sixty);
    expect(parseReply(json({ title: sixty + "y" }), null)?.title).toBe(
      "x".repeat(59) + "…"
    );
  });

  test("cuts the story at 300 characters and folds its whitespace", () => {
    const parsed = parseReply(
      json({ title: "t", story: "line one\n\nline   two " + "z".repeat(400) }),
      null
    );

    expect(parsed?.story.startsWith("line one line two z")).toBe(true);
    expect([...(parsed?.story ?? "")]).toHaveLength(300);
    expect(parsed?.story.endsWith("…")).toBe(true);
  });

  test("treats an unknown or missing state as done", () => {
    expect(
      parseReply(
        json({ title: "t", now: { state: "blocked", text: "x" } }),
        null
      )?.now
    ).toEqual({
      state: "done",
      text: "x",
    });
    expect(parseReply(json({ title: "t" }), null)?.now).toEqual({
      state: "done",
      text: "",
    });
  });

  test("keeps a step only when it is non-empty text, cut at 60 characters", () => {
    expect(parseReply(json({ title: "t", step: null }), null)?.step).toBeNull();
    expect(parseReply(json({ title: "t", step: "  " }), null)?.step).toBeNull();
    expect(parseReply(json({ title: "t", step: 42 }), null)?.step).toBeNull();
    expect(
      parseReply(json({ title: "t", step: "s".repeat(70) }), null)?.step
    ).toBe("s".repeat(59) + "…");
  });
});
