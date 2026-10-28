import type {
  Brief,
  BriefState,
  FileChange,
  Live,
  PlanItem,
  PlanStatus,
  Turn,
  Work,
} from "../types";
import { NOW_MAX, STATE_LABEL, cut, tabName } from "./brief";
import { ownWords } from "./title";

/** Every file the session changed is kept, so the panel can say how many more there are. */
export const FILES_KEPT = 200;

/** The record read back from the store; one saved before 0.3 kept file names alone. */
export function asWork(value: unknown): Work | null {
  if (typeof value !== "object" || value === null) return null;
  const saved = value as { todos?: unknown; files?: unknown };
  if (!Array.isArray(saved.files)) return null;
  const files = saved.files.flatMap((file: unknown): FileChange[] => {
    if (typeof file === "string")
      return [{ path: file, name: file, added: null, removed: null }];
    if (typeof file !== "object" || file === null) return [];
    const change = file as Partial<FileChange>;
    if (typeof change.path !== "string" || typeof change.name !== "string")
      return [];
    return [
      {
        path: change.path,
        name: change.name,
        added: change.added ?? null,
        removed: change.removed ?? null,
      },
    ];
  });
  return {
    todos: Array.isArray(saved.todos) ? (saved.todos as PlanItem[]) : null,
    files,
  };
}
export const PROVISIONAL_MAX = 40;

/** What the session shows as "now": a state and its words. */
export type Showing = { state: BriefState; text: string };

/** The plan as drawn: a todo list of the session's, or the summary's guess at one. */
export type PlanView = {
  source: "todos" | "summary";
  items: PlanItem[];
  done: number;
};

export const GLYPH: Record<BriefState, string> = {
  working: "◐",
  waiting: "◆",
  done: "✓",
};

const textOf = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const fileName = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;

/** Tools that change the plan or the record, not what Claude is visibly doing. */
const QUIET = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "ToolSearch",
]);

/**
 * One tool call in words, as the "now" line says it: `Reading config.kdl`,
 * a Bash command's own description, `Agent: <task>`. Null for a tool that
 * says nothing about what Claude is doing.
 */
export function describeActivity(
  tool: string,
  input: object
): Omit<Live, "at"> | null {
  if (QUIET.has(tool)) return null;
  const fields = input as Record<string, unknown>;
  const path = textOf(fields.file_path) || textOf(fields.notebook_path);
  const said = (text: string) => ({
    text: cut(text, NOW_MAX),
    isWaiting: false,
  });
  switch (tool) {
    case "Read":
      return said(`Reading ${fileName(path)}`);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return said(`Editing ${fileName(path)}`);
    case "Write":
      return said(`Writing ${fileName(path)}`);
    case "Bash":
      return said(
        textOf(fields.description) || `Running ${textOf(fields.command)}`
      );
    case "Grep":
      return said(`Searching for ${textOf(fields.pattern)}`);
    case "Glob":
      return said(`Finding ${textOf(fields.pattern)}`);
    case "WebSearch":
      return said(`Searching the web for ${textOf(fields.query)}`);
    case "WebFetch":
      return said(
        `Reading ${
          textOf(fields.url)
            .replace(/^https?:\/\//, "")
            .split("/")[0] ?? ""
        }`
      );
    case "Agent":
    case "Task":
      return said(
        `Agent: ${textOf(fields.description) || "working on a subtask"}`
      );
    case "AskUserQuestion":
      return { text: "Waiting on your answer", isWaiting: true };
    case "Skill":
      return said(`Using the ${textOf(fields.skill)} skill`);
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp !== null) return said(`Using ${mcp[2]} (${mcp[1]})`);
  return said(tool);
}

/**
 * The sentence of a model step that says what Claude does next: the last
 * sentence of its text, with no closing stop. Null when the step said nothing.
 */
export function progressSentence(answer: string): string | null {
  const folded = answer.replace(/\s+/g, " ").trim();
  if (folded === "") return null;
  const sentences = folded
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence !== "");
  const last = (sentences[sentences.length - 1] ?? folded)
    .replace(/[.:!]+$/, "")
    .trim();
  return last === "" ? null : cut(last, NOW_MAX);
}

const STATUS_OF_TODO: Record<string, PlanStatus> = {
  completed: "done",
  in_progress: "doing",
  pending: "next",
};

/**
 * The record after one tool call: the todo list as TodoWrite, TaskCreate and
 * TaskUpdate left it, and the files Edit and Write changed, newest first.
 */
export function applyTool(
  work: Work,
  tool: string,
  input: object,
  result: unknown
): Work {
  const fields = input as Record<string, unknown>;
  switch (tool) {
    case "TodoWrite": {
      const todos = Array.isArray(fields.todos)
        ? (fields.todos as Record<string, unknown>[])
        : [];
      return {
        ...work,
        todos: todos.flatMap((todo, i) => {
          const status = STATUS_OF_TODO[textOf(todo.status)];
          const text = textOf(todo.content);
          return status === undefined || text === ""
            ? []
            : [{ id: `todo-${i + 1}`, text, status }];
        }),
      };
    }
    case "TaskCreate": {
      const task = (result as { task?: { id?: unknown } } | null)?.task;
      const id = textOf(task?.id);
      const text = textOf(fields.subject);
      if (id === "" || text === "") return work;
      return {
        ...work,
        todos: [...(work.todos ?? []), { id, text, status: "next" }],
      };
    }
    case "TaskUpdate": {
      const id = textOf(fields.taskId);
      const todos = work.todos ?? [];
      if (fields.status === "deleted")
        return { ...work, todos: todos.filter((todo) => todo.id !== id) };
      const status = STATUS_OF_TODO[textOf(fields.status)];
      const text = textOf(fields.subject);
      return {
        ...work,
        todos: todos.map((todo) =>
          todo.id !== id
            ? todo
            : {
                ...todo,
                ...(status === undefined ? {} : { status }),
                ...(text === "" ? {} : { text }),
              }
        ),
      };
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = textOf(fields.file_path) || textOf(fields.notebook_path);
      if (path === "") return work;
      const before = work.files.find((file) => file.path === path);
      const changed = before ?? {
        path,
        name: fileName(path),
        added: null,
        removed: null,
      };
      return {
        ...work,
        files: [
          changed,
          ...work.files.filter((file) => file.path !== path),
        ].slice(0, FILES_KEPT),
      };
    }
    default:
      return work;
  }
}

/** The plan to draw: the session's own todo list once it has one, else the summary's plan. */
export function planView(work: Work, brief: Brief | null): PlanView | null {
  const items = work.todos ?? brief?.plan ?? [];
  if (work.todos === null && items.length === 0) return null;
  return {
    source: work.todos === null ? "summary" : "todos",
    items,
    done: items.filter((item) => item.status === "done").length,
  };
}

/** What the session is doing: the live line while a turn runs, the summary's state after. */
export function showing(
  brief: Brief | null,
  turn: Turn | null,
  live: Live | null
): Showing {
  if (turn !== null)
    return {
      state: live?.isWaiting === true ? "waiting" : "working",
      text: live?.text ?? "Working",
    };
  return brief?.now ?? { state: "done", text: "" };
}

/** "now" in words, as the frame title and the panel say it. */
export function nowText(now: Showing, isTurnRunning: boolean): string {
  if (isTurnRunning || now.state === "working")
    return `${GLYPH[now.state]} ${now.text || STATE_LABEL.working}`;
  const label = STATE_LABEL[now.state];
  return `${GLYPH[now.state]} ${
    now.text === "" ? label : `${label}: ${now.text}`
  }`;
}

/** The session's title: the brief's, or the first prompt's opening words, pasted text left out, until there is a brief. */
export function titleOf(
  brief: Brief | null,
  firstPrompt: string
): string | null {
  if (brief !== null) return brief.title;
  const provisional = cut(ownWords(firstPrompt), PROVISIONAL_MAX);
  return provisional === "" ? null : provisional;
}

/** The zellij pane's frame title: `✻ title · ◐ now`. */
export const frameTitle = (
  title: string,
  now: Showing,
  isTurnRunning: boolean
): string => `✻ ${title} · ${nowText(now, isTurnRunning)}`;

/** The zellij tab's name: the short title and the state's mark. */
export function tabLabel(
  brief: Brief | null,
  title: string,
  now: Showing
): string {
  const name =
    brief !== null && brief.tab !== "" && !brief.isPinned
      ? brief.tab
      : tabName(title);
  return `${name} ${GLYPH[now.state]}`;
}
