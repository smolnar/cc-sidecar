import type { EngineInterface } from "claude-code";

const TIMEOUT_MS = 3000;

/** A file's lines added and removed against the last commit; null counts where git can't say. */
export type LineCounts = { added: number | null; removed: number | null };

/**
 * `path` made absolute against `cwd`, its `.` and `..` folded away; null when
 * it climbs above `/`. Spelled out, so `<cwd>/../x` is not taken for inside.
 */
export function resolvePath(path: string, cwd: string): string | null {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split(
    "/"
  )) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return `/${parts.join("/")}`;
}

/** Whether the absolute `path` is one of `roots` or lies in one. */
export const isInside = (path: string, roots: readonly string[]): boolean =>
  roots.some(
    (root) =>
      path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
  );

/**
 * Runs `git -C <dir> <args>` and answers its output, or null when git is
 * missing, fails, or the directory is in no repository. `exitCodes` lists the
 * codes that still mean an answer (`diff --no-index` exits 1 on a difference).
 *
 * A repository's own config can name commands git runs (fsmonitor, diff and
 * filter drivers): the fsmonitor is turned off here, the diff drivers by each
 * diff call, and the callers run git only in the session's own folders, which
 * the person trusted when Claude Code started there, so no filter of a folder
 * they never trusted runs.
 */
async function git(
  $: EngineInterface,
  dir: string,
  args: string[],
  exitCodes: readonly number[] = [0]
): Promise<string | null> {
  try {
    const ran = await $.process.run(
      ["git", "-c", "core.fsmonitor=false", "-C", dir, ...args],
      { timeoutMs: TIMEOUT_MS }
    );
    return exitCodes.includes(ran.exitCode) ? ran.stdout : null;
  } catch {
    return null;
  }
}

/** The first line of `git diff --numstat`: `12\t3\tpath`, or `-\t-\tpath` for a binary file. */
function parseNumstat(stdout: string): LineCounts {
  const [added, removed] = (stdout.split("\n")[0] ?? "").split("\t");
  const count = (field: string | undefined): number | null =>
    field !== undefined && /^\d+$/.test(field) ? Number(field) : null;
  return { added: count(added), removed: count(removed) };
}

/** The diff flags that keep a repository's external diff and textconv drivers from running. */
const PLAIN_DIFF = ["--no-ext-diff", "--no-textconv"];

/**
 * How many lines the absolute `path` gained and lost against the last commit,
 * as git counts them; a new untracked file counts all its lines as added.
 * Null outside a repository, for a file .gitignore leaves out (git sees no
 * change to it), or when git fails. Callers pass only paths in the session's
 * own folders (resolvePath, isInside).
 */
export async function countLines(
  $: EngineInterface,
  path: string
): Promise<LineCounts | null> {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const tracked = await git($, dir, [
    "diff",
    ...PLAIN_DIFF,
    "--numstat",
    "HEAD",
    "--",
    path,
  ]);
  if (tracked === null) return null;
  if (tracked.trim() !== "") return parseNumstat(tracked);

  const untracked = await git($, dir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    path,
  ]);
  if (untracked === null) return null;
  if (untracked.trim() === "") {
    const ignored = await git($, dir, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      path,
    ]);
    return ignored === null || ignored.trim() !== ""
      ? null
      : { added: 0, removed: 0 };
  }
  const created = await git(
    $,
    dir,
    ["diff", ...PLAIN_DIFF, "--numstat", "--no-index", "--", "/dev/null", path],
    [0, 1]
  );
  return created === null || created.trim() === ""
    ? { added: null, removed: null }
    : parseNumstat(created);
}

/** What `git status --porcelain=v2 --branch` prints in `dir`, or null outside a repository. */
export async function repoStatus(
  $: EngineInterface,
  dir: string
): Promise<string | null> {
  return git($, dir, ["status", "--porcelain=v2", "--branch"]);
}

/**
 * The linked worktree `dir` lies in: its root folder and the main repository's folder (the
 * one holding the shared .git). Null in a main checkout, outside a repository, or when git fails.
 */
export async function worktreeOf(
  $: EngineInterface,
  dir: string
): Promise<{ root: string; main: string } | null> {
  const out = await git($, dir, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (out === null) return null;
  const [root, gitDir, commonDir] = out.trim().split("\n");
  if (!root || !gitDir || !commonDir || gitDir === commonDir) return null;
  return {
    root,
    main: commonDir.endsWith("/.git")
      ? commonDir.slice(0, -"/.git".length)
      : commonDir,
  };
}
