import { describe, expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

import {
  CONFIG,
  HOME,
  IN_ZELLIJ,
  MINUTE,
  boot,
  briefWith,
  colorOf,
  mountBand,
  mountPanel,
  nameSession,
  otherSession,
  reply,
  runCommand,
  runTurn,
  shown,
} from "./harness";
import type { BriefFields, Harness } from "./harness";

const SECOND = 1000;
/** How often the sidecar looks at the other sessions, and asks claude agents which still run. */
const POLL = 10 * SECOND;
const AGENTS_POLL = 30 * SECOND;

/** A second configuration folder, run with `CLAUDE_CONFIG_DIR`. */
const WORK = `${HOME}/.claude-work`;
const IN_WORK = { ...IN_ZELLIJ, CLAUDE_CONFIG_DIR: WORK };

/** The colours a profile gets when the profiles file names none, in the order the profiles are listed. */
const FIRST_COLOUR = "#4b91ff";
const SECOND_COLOUR = "#e0823d";

const PROFILES = {
  personal: { name: "Personal", path: "~/.claude" },
  work: { name: "Work", path: "~/.claude-work" },
};

/** Where the person keeps the profiles every session reads. */
const PROFILES_FILE = `${HOME}/.config/cc-sidecar/profiles.json`;

/** Writes the profiles file, as the person does, at `path`. */
function setProfiles(
  h: Harness,
  profiles: unknown = PROFILES,
  path = PROFILES_FILE
) {
  h.files[path] = JSON.stringify({ profiles });
}

const BRIEF: BriefFields = {
  title: "Fuse gauges with near-limit bars",
  story: "Combining the gauges layout with block bars.",
  now: { state: "done", text: "" },
  step: null,
  plan: [],
};

const briefed = (h: Harness, $: Engine) =>
  briefWith(h, $, BRIEF, "fuse the sidebar");

const panelLines = async ($: Engine): Promise<string[]> => {
  const panel = await mountPanel($, { bodyColumns: 51 });
  const lines = (await shown(panel)).split("\n");
  await panel.unmount();
  return lines;
};

/** The lines of one section: from its heading to the next blank line. */
function section(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.trim() === "");
  return lines.slice(start, end < 0 ? undefined : end);
}

const needsRows = async ($: Engine) =>
  section(await panelLines($), "NEEDS YOU");

/** The colour the panel draws the first text holding `needle` in. */
async function colourOf(
  $: Engine,
  needle: string
): Promise<string | undefined> {
  const panel = await mountPanel($, { bodyColumns: 51 });
  const colour = colorOf(await panel.drawn(), needle);
  await panel.unmount();
  return colour;
}

describe("sessions of other profiles that need you", () => {
  test("lists a waiting session of another profile under that profile's name, in its colour", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it on staging?",
      since: h.clock.now(),
      tabPosition: 3,
      configDir: WORK,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const rows = await needsRows($);

    expect(rows[0]).toMatch(/1 of 2 sessions$/);
    expect(rows[1]).toMatch(/^◆ Billing migration +Work · tab 4 · 0m$/);
    expect(rows[2]).toBe("Run it on staging?");
    expect(await colourOf($, "Work")).toBe(SECOND_COLOUR);
  });

  test("lists a waiting session of the default profile in a session run with CLAUDE_CONFIG_DIR", async ($, on) => {
    const h = await boot($, on, {}, IN_WORK);
    setProfiles(h);
    otherSession(h, {
      id: "p",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
      configDir: CONFIG,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const rows = await needsRows($);

    expect(rows[1]).toMatch(/^◆ Bookshelf plans +Personal · tab 2 · 0m$/);
    expect(rows[2]).toBe("Order the shelves?");
  });

  test("reads the profiles file under XDG_CONFIG_HOME when it is set", async ($, on) => {
    const h = await boot($, on, {}, { ...IN_ZELLIJ, XDG_CONFIG_HOME: "/xdg" });
    setProfiles(h, PROFILES, "/xdg/cc-sidecar/profiles.json");
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);

    expect((await needsRows($))[1]).toMatch(/^◆ Billing migration +Work · /);
  });

  test("lists only its own folder's sessions while the profiles file is no JSON", async ($, on) => {
    const h = await boot($, on);
    h.files[PROFILES_FILE] = "{ profiles: personal }";
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    otherSession(h, {
      id: "p",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order?",
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const rows = (await needsRows($)).join("\n");

    expect(rows).toContain("Bookshelf plans");
    expect(rows).not.toContain("Billing migration");
    expect(await panelLines($)).toContain("~/.dotfiles:main");
  });

  test("labels no session of its own profile, and counts its own profile once", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    otherSession(h, {
      id: "p",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
    });
    await briefed(h, $);

    await h.clock.advance(POLL);
    const rows = await needsRows($);

    expect(rows[0]).toMatch(/1 of 2 sessions$/);
    expect(rows[1]).toMatch(/^◆ Bookshelf plans +tab 2 · 0m$/);
  });

  test("counts the other profile's open sessions, background ones too", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    otherSession(h, {
      id: "w2",
      name: "Docs",
      state: "working",
      configDir: WORK,
    });
    h.background.push({
      id: "bg",
      sessionId: "w3",
      cwd: `${HOME}/projects/ops`,
      name: "Nightly report",
      startedAt: h.clock.now(),
      state: "running",
      configDir: WORK,
    });
    await briefed(h, $);

    await h.clock.advance(AGENTS_POLL);
    const rows = await needsRows($);

    expect(rows[0]).toMatch(/1 of 4 sessions$/);
  });

  test("hides a session of another profile that crashed, and keeps the live ones", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    otherSession(h, {
      id: "crashed",
      name: "Gone for good",
      state: "waiting",
      question: "Anyone?",
      configDir: WORK,
    });
    h.gone.add("crashed");
    await briefed(h, $);

    await h.clock.advance(AGENTS_POLL);
    const rows = (await needsRows($)).join("\n");

    expect(rows).toContain("Billing migration");
    expect(rows).not.toContain("Gone for good");
  });

  test("still lists another profile's sessions while its claude agents fails", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    h.agentsDownIn.add(WORK);
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    await briefed(h, $);

    await h.clock.advance(AGENTS_POLL);

    expect((await needsRows($)).join("\n")).toContain("Billing migration");
  });

  test("removes stale presence files of its own profile only", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    otherSession(h, { id: "mine", name: "Old", state: "done", isEnded: true });
    otherSession(h, {
      id: "theirs",
      name: "Old too",
      state: "done",
      isEnded: true,
      configDir: WORK,
    });
    await briefed(h, $);

    await h.clock.advance(POLL);

    const paths = Object.keys(h.files);
    expect(paths).not.toContain(`${CONFIG}/sidecar/presence/mine.json`);
    expect(paths).toContain(`${WORK}/sidecar/presence/theirs.json`);
  });

  test("tells no model call what another profile's sessions are doing", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it on staging?",
      configDir: WORK,
    });
    await h.clock.advance(POLL);

    h.replies.push(reply({ title: "Fuse the gauges", tab: "gauges" }));
    await runTurn($, { prompt: "fuse the gauges", answer: "Done." });
    await h.clock.settle();
    h.forkReplies.push(reply({ ...BRIEF }));
    await runCommand($, "brief", "refresh");
    await h.clock.settle();

    expect(h.asked.length + h.forked.length).toBeGreaterThan(1);
    const sent = JSON.stringify([h.asked, h.forked]);
    expect(sent).not.toContain("Billing migration");
    expect(sent).not.toContain("Run it on staging?");
  });
});

describe("the session's own profile", () => {
  test("names its profile in the footer, in the profile's colour", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    await briefed(h, $);

    expect(await panelLines($)).toContain("Personal · ~/.dotfiles:main");
    expect(await colourOf($, "Personal")).toBe(FIRST_COLOUR);
  });

  test("takes ~/.claude for its profile while CLAUDE_CONFIG_DIR is not set", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h);
    await briefed(h, $);
    await h.clock.advance(MINUTE);

    expect(Object.keys(h.files)).toContain(
      `${CONFIG}/sidecar/presence/${h.sessionId}.json`
    );
    expect(await panelLines($)).toContain("Personal · ~/.dotfiles:main");
  });

  test("names a session run with CLAUDE_CONFIG_DIR after that folder's profile, a trailing slash or not", async ($, on) => {
    const h = await boot(
      $,
      on,
      {},
      { ...IN_ZELLIJ, CLAUDE_CONFIG_DIR: `${WORK}/` }
    );
    setProfiles(h);
    await briefed(h, $);
    await h.clock.advance(MINUTE);

    expect(await panelLines($)).toContain("Work · ~/.dotfiles:main");
    expect(Object.keys(h.files)).toContain(
      `${WORK}/sidecar/presence/${h.sessionId}.json`
    );
  });

  test("shows a profile's id when the profiles file gives it no name", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h, { personal: { path: "~/.claude" } });
    await briefed(h, $);

    expect(await panelLines($)).toContain("personal · ~/.dotfiles:main");
  });

  test("paints a profile the colour the profiles file names, and the default for one that is no colour", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h, {
      personal: { ...PROFILES.personal, color: "#22aa88" },
      work: { ...PROFILES.work, color: "teal" },
    });
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    await briefed(h, $);
    await h.clock.advance(POLL);

    expect(await colourOf($, "Personal")).toBe("#22aa88");
    expect(await colourOf($, "Work")).toBe(SECOND_COLOUR);
  });

  test("ignores profiles it cannot read: no path, a relative path, no object", async ($, on) => {
    const h = await boot($, on);
    setProfiles(h, {
      bare: "~/.claude-work",
      nameless: { name: "Work" },
      relative: { name: "Work", path: "claude-work" },
      personal: { path: "~/.claude" },
    });
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
      configDir: WORK,
    });
    await briefed(h, $);
    await h.clock.advance(POLL);

    expect(await needsRows($)).toEqual([]);
    expect(await panelLines($)).toContain("personal · ~/.dotfiles:main");
  });

  test("takes Claude Code's title in a session run with CLAUDE_CONFIG_DIR", async ($, on) => {
    const h = await boot($, on, {}, IN_WORK);
    const band = await mountBand($);
    nameSession(h, "Sidecar titles");
    h.replies.push({ fail: "api-error" });
    await runTurn($, { prompt: "fuse the gauges", answer: "Done." });
    await h.clock.settle();

    expect(await shown(band)).toContain("Sidecar titles");
  });
});

describe("without profiles", () => {
  test("lists only the sessions of its own configuration folder", async ($, on) => {
    const h = await boot($, on, {}, IN_WORK);
    otherSession(h, {
      id: "p",
      name: "Bookshelf plans",
      state: "waiting",
      question: "Order the shelves?",
      configDir: CONFIG,
    });
    otherSession(h, {
      id: "w",
      name: "Billing migration",
      state: "waiting",
      question: "Run it?",
    });
    await briefed(h, $);
    await h.clock.advance(MINUTE);

    const lines = await panelLines($);
    const rows = section(lines, "NEEDS YOU").join("\n");
    expect(rows).toContain("Billing migration");
    expect(rows).not.toContain("Bookshelf plans");
    expect(lines).toContain("~/.dotfiles:main");
    expect(Object.keys(h.files)).toContain(
      `${WORK}/sidecar/presence/${h.sessionId}.json`
    );
    expect(Object.keys(h.files)).not.toContain(
      `${CONFIG}/sidecar/presence/${h.sessionId}.json`
    );
  });
});
