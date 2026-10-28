import type { EngineInterface } from "claude-code";

const TIMEOUT_MS = 3000;

/** A file's lines added and removed against the last commit; null counts where git can't say. */
export type LineCounts = { added: number | null; removed: number | null };

/**
 * What git says of a changed file: its counts; `off` where git keeps no such file (outside a
 * repository, or one .gitignore leaves out); `unknown` where git failed or ran past its timeout,
 * and so said nothing.
 */
export type Counted = LineCounts | "off" | "unknown";

/** What git answered: its exit code and output. */
type Ran = { exitCode: number; stdout: string };

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
 * Runs `git -C <dir> <args>` and answers its exit code and output, or null
 * when git is missing or runs past its timeout.
 *
 * A repository's own config can name commands git runs (fsmonitor, diff and
 * filter drivers): the fsmonitor is turned off here, the diff drivers by each
 * diff call, and the callers run git only in the session's own folders, which
 * the person trusted when Claude Code started there, so no filter of a folder
 * they never trusted runs.
 *
 * `--no-optional-locks` keeps `status` and `diff` from writing the index back,
 * so a commit the person runs meanwhile never finds its lock taken;
 * `--literal-pathspecs` reads a path as itself, so `v[12].md` never names `v1.md`.
 */
async function git(
  $: EngineInterface,
  dir: string,
  args: string[]
): Promise<Ran | null> {
  try {
    const ran = await $.process.run(
      [
        "git",
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-C",
        dir,
        ...args,
      ],
      { timeoutMs: TIMEOUT_MS }
    );
    return { exitCode: ran.exitCode, stdout: ran.stdout };
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

/** Whether .gitignore leaves the untracked `path` out; null when git said nothing. */
async function isIgnored(
  $: EngineInterface,
  dir: string,
  path: string
): Promise<boolean | null> {
  const ignored = await git($, dir, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    path,
  ]);
  return ignored === null || ignored.exitCode !== 0
    ? null
    : ignored.stdout.trim() !== "";
}

/** A new file's lines, every one of them added (`diff --no-index` exits 1 on a difference). */
async function countCreated(
  $: EngineInterface,
  dir: string,
  path: string
): Promise<Counted> {
  const created = await git($, dir, [
    "diff",
    ...PLAIN_DIFF,
    "--numstat",
    "--no-index",
    "--",
    "/dev/null",
    path,
  ]);
  if (created === null || ![0, 1].includes(created.exitCode)) return "unknown";
  return created.stdout.trim() === ""
    ? { added: null, removed: null }
    : parseNumstat(created.stdout);
}

/**
 * How many lines the absolute `path` gained and lost against the last commit,
 * as git counts them; a new untracked file counts all its lines as added, and
 * so does every file of a repository with no commit yet. `off` outside a
 * repository or for a file .gitignore leaves out (git sees no change to it);
 * `unknown` when git fails or runs past its timeout. Callers pass only paths
 * in the session's own folders (resolvePath, isInside).
 */
export async function countLines(
  $: EngineInterface,
  path: string
): Promise<Counted> {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const tracked = await git($, dir, [
    "diff",
    ...PLAIN_DIFF,
    "--numstat",
    "HEAD",
    "--",
    path,
  ]);
  if (tracked === null) return "unknown";
  if (tracked.exitCode === 0) {
    if (tracked.stdout.trim() !== "") return parseNumstat(tracked.stdout);
    const untracked = await git($, dir, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      path,
    ]);
    if (untracked === null || untracked.exitCode !== 0) return "unknown";
    if (untracked.stdout.trim() !== "") return countCreated($, dir, path);
    const ignored = await isIgnored($, dir, path);
    return ignored === null
      ? "unknown"
      : ignored
      ? "off"
      : { added: 0, removed: 0 };
  }

  // No diff against HEAD: outside a repository (128), or in one with no commit yet (1).
  const head = await git($, dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head === null || head.exitCode === 0) return "unknown";
  if (head.exitCode !== 1) return "off";
  const ignored = await isIgnored($, dir, path);
  return ignored === null
    ? "unknown"
    : ignored
    ? "off"
    : countCreated($, dir, path);
}

/**
 * What `git status --porcelain=v2 --branch` prints in `dir`; null outside a
 * repository; `unknown` when git fails or runs past its timeout.
 */
export async function repoStatus(
  $: EngineInterface,
  dir: string
): Promise<{ output: string } | null | "unknown"> {
  const ran = await git($, dir, ["status", "--porcelain=v2", "--branch"]);
  if (ran === null) return "unknown";
  return ran.exitCode === 0 ? { output: ran.stdout } : null;
}

/**
 * The linked worktree `dir` lies in: its root folder and the main repository's folder (the
 * one holding the shared .git). Null in a main checkout or outside a repository; `unknown`
 * when git fails or runs past its timeout.
 */
export async function worktreeOf(
  $: EngineInterface,
  dir: string
): Promise<{ root: string; main: string } | null | "unknown"> {
  const ran = await git($, dir, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (ran === null) return "unknown";
  if (ran.exitCode !== 0) return null;
  const [root, gitDir, commonDir] = ran.stdout.trim().split("\n");
  if (!root || !gitDir || !commonDir || gitDir === commonDir) return null;
  return {
    root,
    main: commonDir.endsWith("/.git")
      ? commonDir.slice(0, -"/.git".length)
      : commonDir,
  };
}
