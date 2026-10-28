# Sidecar for Claude Code

A sidebar for Claude Code. It docks a panel beside the transcript that shows what the session is doing and what it has done, so you can see where a long session stands without scrolling back.

<p align="center">
  <img src="docs/sidecar.png" alt="A Claude Code session adding gift cards to a small shop, with the transcript on the left and the panel on the right. The panel shows the title, Working for 2m 58s, a recap of the first turn, a plan with 7 of 8 tasks done, what Claude is doing now, two subagents running with what each is doing, six changed files with lines added and removed, the context window, output speed, the 5-hour and weekly limits, a docs session that needs you, and the footer with the folder, branch and Claude Code version." width="100%">
</p>

## What it shows

From the top:

- **Title and state**: the session's title, and whether Claude is working, waiting on you or done, with how long.
- **Recap**: a short story of the session and its last steps.
- **Plan**: Claude's task list, finished items folded into one line.
- **Now**: what Claude is doing or asking right now.
- **Agents**: the subagents running, what each is doing, its time and tokens.
- **Changed**: the files Claude changed that are in git, with lines added and removed as `git diff HEAD` counts them, recounted as each turn ends.
- **Context**: how full the context window is, what the session cost, the prompt cache's hit rate and when it goes cold.
- **Speed**: output tokens per second, with the recent average and peak.
- **Limits**: your subscription's usage windows and when they reset.
- **Needs you**: your other Claude Code sessions that wait on a question or a permission prompt.
- **Footer**: the folder, git branch and state, a worktree if the session runs in one, and the Claude Code version, model and effort.

Sections fold to one line when the terminal is short, and the ones with nothing to say stay hidden. The lists (plan, agents, changed files and sessions that need you) fill the rows the other sections leave free, and end in `… N more` where they would run into the next section.

### In a narrow terminal

In the fullscreen layout the panel opens by itself once the terminal is wide enough. Otherwise a short band above the prompt shows the title, the state and the brief, and `/brief panel` opens the panel.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install sidecar --marketplace smolnar/cc-sidecar
```

From a shell:

```
claude plugin install sidecar --marketplace smolnar/cc-sidecar
```

Answer `y` to add the marketplace, then pick a scope.

## Requirements

- Claude Code 2.1.300 or later.
- `git`, for the changed files and the footer.
- Optional: [zellij](https://zellij.dev). Inside zellij the sidecar names the pane and tab after the session, and tells other sessions when a finished one has not been looked at yet.

## Good to know

- **Plan** follows Claude's task tools (TodoWrite, or TaskCreate and TaskUpdate). If your sessions never show a plan, your Claude Code may have those tools turned off. Setting `CLAUDE_CODE_ENABLE_TODO_TOOLS` to `1` turns them on (checked on 2.1.311):

  ```json
  { "env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" } }
  ```

- **Changed** lists the files Claude writes with its file tools (Edit, MultiEdit, Write, NotebookEdit). A file it changes from a shell command, such as `cat >> file`, is left off the list. Files outside the session's folders, files `.gitignore` leaves out, and folders that are not in a repository are left off too.

## Settings

| Option | Default | What it does |
| --- | --- | --- |
| `panelBackground` | empty | A `#rrggbb` colour to paint the panel, such as `#22272e` on a dark terminal. Empty leaves the terminal's own background. |

Set it in `/config`, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "sidecar": { "options": { "panelBackground": "#22272e" } }
  }
}
```

The `themes/dock.json` theme pairs a light ANSI theme with a dark sidebar; pick `custom:sidecar:dock` in `/config` to use it. The screenshot uses it, with `panelBackground` set to `#22272e`.

## Commands

- `/brief`: print the brief.
- `/brief panel`: open the panel.
- `/brief title <text>`: pin a title; `/brief title` alone unpins it.
- `/brief refresh`: rebuild the brief from the whole conversation.

## What it reads, writes and sends

- **Model calls**, on your own Claude Code account: one small Haiku call per prompt to title the session, and one call on the session's model when you run `/brief refresh`.
- **Network**: once an hour it reads `https://downloads.claude.ai/claude-code-releases/latest`, the feed Claude Code's updater reads, to colour the footer's dot when a newer release is out.
- **Local files**: each session writes `~/.claude/sidecar/presence/<session id>.json` with its name, folder, state and pending question, so your other sessions can list it under Needs you. It reads Claude Code's own `~/.claude/sessions/` registry and runs `claude agents --json` for the same list, and removes presence files of sessions that ended.
- **git** runs only in the session's folder and folders added with `/add-dir`, with the repository's fsmonitor, external diff and textconv drivers turned off.

## Developing

Run the tests:

```
claude plugin test .
```

`tsconfig.json` builds on type files Claude Code writes into `.claude-plugin/types/` when it first loads the mod, so start a session with the mod loaded once (`claude --plugin-dir .`) before running `tsc -p .`.

## License

MIT
