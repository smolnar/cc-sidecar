import type { Brief } from "../types";
import { TAB_MAX, TITLE_MAX, cut, tabName } from "./brief";

/** The model that names the session: a cheap, fast one, called once per prompt. */
export const TITLE_MODEL = "haiku";
/** The prompts Haiku hears: the first one, and the newest up to this many in all. */
export const PROMPTS_KEPT = 9;
/** How much of one prompt Haiku hears. */
const PROMPT_MAX = 500;
/** How much of a pasted block's first line it hears. */
const PASTE_MAX = 120;

/** A block the person pasted into a prompt, up to its closing tag or the prompt's end. */
const PASTED =
  /<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content[^>]*>|$)/g;

/** A prompt's own words, its pasted blocks left out: the title until Haiku answers. */
export const ownWords = (prompt: string): string =>
  cut(prompt.replace(PASTED, " "), Number.MAX_SAFE_INTEGER);

/** A prompt as Haiku hears it: each pasted block by its first line, the whole cut short. */
export function promptForTitle(prompt: string): string {
  const heard = prompt.replace(PASTED, (_, pasted: string) => {
    const first = pasted.trim().split("\n")[0] ?? "";
    return ` [pasted: ${cut(first, PASTE_MAX)}] `;
  });
  return cut(heard, PROMPT_MAX);
}

/** The prompts kept once `next` is said: the first one, then the newest. */
export function keptPrompts(
  prompts: readonly string[],
  next: string
): string[] {
  const all = [...prompts, next];
  return all.length <= PROMPTS_KEPT
    ? all
    : [all[0] ?? next, ...all.slice(-(PROMPTS_KEPT - 1))];
}

/** What Haiku is asked: the person's prompts, oldest first, and the title it gave last. */
export function titlePrompt(
  prompts: readonly string[],
  current: string | null
): string {
  return [
    'Name this Claude Code session for a sidebar and a terminal tab, from the messages its user sent in it, oldest first. The messages are often dictated: look past filler such as "Actually," or "All right, so". [pasted: …] marks text the user pasted, by its first line. Use no tools.',
    "",
    current === null
      ? "The session has no title yet."
      : `Current title: ${JSON.stringify(
          current
        )}. Keep it unless the user's goal has clearly changed.`,
    "",
    "<messages>",
    ...prompts.map((prompt, i) => `${i + 1}. ${prompt}`),
    "</messages>",
    "",
    'Reply with one JSON object and nothing else: {"title": string, "tab": string}',
    `- title: the session's goal in at most ${TITLE_MAX} characters, starting with a verb, like "Replace zjstatus with a lean bar plugin".`,
    `- tab: the title as a short name for a terminal tab, at most ${TAB_MAX} characters, like "Lean bar plugin".`,
  ].join("\n");
}

/** Haiku's answer: the first JSON object in it, with a title; null when it gave none. */
export function parseTitle(
  text: string
): { title: string; tab: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const fields = data as Record<string, unknown>;
  const title =
    typeof fields.title === "string" ? cut(fields.title, TITLE_MAX) : "";
  if (title === "") return null;
  const tab = typeof fields.tab === "string" ? cut(fields.tab, TAB_MAX) : "";
  return { title, tab: tab === "" ? tabName(title) : tab };
}

/** The brief with Haiku's title, or a new one holding only that title. */
export function titledBrief(
  previous: Brief | null,
  title: string,
  tab: string,
  at: number
): Brief {
  if (previous !== null) return { ...previous, title, tab, isTitled: true };
  return {
    title,
    tab,
    story: "",
    now: { state: "done", text: "" },
    steps: [],
    plan: [],
    isPinned: false,
    isTitled: true,
    updatedAt: at,
  };
}
