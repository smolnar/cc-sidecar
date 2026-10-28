import type { EngineInterface } from "claude-code";

const TIMEOUT_MS = 3000;

/** The tab a pane sits in, as `zellij action list-panes` reports it, and its position from 0. */
export type Tab = { id: number; name: string; position: number | null };

/**
 * Runs `zellij action <args>` and answers its output, or null when zellij is
 * missing, fails, or takes too long: the brief never depends on zellij.
 */
async function action(
  $: EngineInterface,
  args: string[]
): Promise<string | null> {
  try {
    const ran = await $.process.run(["zellij", "action", ...args], {
      timeoutMs: TIMEOUT_MS,
    });
    return ran.exitCode === 0 ? ran.stdout : null;
  } catch {
    return null;
  }
}

/** Sets the pane's frame title; true once zellij took it. `--` keeps a name starting with `-` a name. */
export async function renamePane(
  $: EngineInterface,
  paneId: string,
  name: string
): Promise<boolean> {
  return (
    (await action($, [
      "rename-pane",
      "-p",
      `terminal_${paneId}`,
      "--",
      name,
    ])) !== null
  );
}

/** Takes the pane's name away, so its frame shows the program's own title again. */
export async function unnamePane(
  $: EngineInterface,
  paneId: string
): Promise<boolean> {
  return (
    (await action($, ["undo-rename-pane", "-p", `terminal_${paneId}`])) !== null
  );
}

/** Sets a tab's name by its stable id; true once zellij took it. `--` keeps a name starting with `-` a name. */
export async function renameTab(
  $: EngineInterface,
  tabId: number,
  name: string
): Promise<boolean> {
  return (
    (await action($, ["rename-tab-by-id", String(tabId), "--", name])) !== null
  );
}

/** The id of the tab on screen, as `current-tab-info` names it; null when zellij can't say. */
export async function activeTabId($: EngineInterface): Promise<number | null> {
  const info = await action($, ["current-tab-info", "-j"]);
  if (info === null) return null;
  try {
    const parsed = JSON.parse(info) as { tab_id?: unknown };
    return typeof parsed.tab_id === "number" ? parsed.tab_id : null;
  } catch {
    return null;
  }
}

/** The tab holding the terminal pane `paneId`, or null when zellij can't say. */
export async function tabOf(
  $: EngineInterface,
  paneId: string
): Promise<Tab | null> {
  const listed = await action($, ["list-panes", "-j", "-t"]);
  if (listed === null) return null;
  let panes: unknown;
  try {
    panes = JSON.parse(listed);
  } catch {
    return null;
  }
  if (!Array.isArray(panes)) return null;
  const pane = (panes as Record<string, unknown>[]).find(
    (one) => one.is_plugin === false && String(one.id) === paneId
  );
  if (pane === undefined || typeof pane.tab_id !== "number") return null;
  return {
    id: pane.tab_id,
    name: typeof pane.tab_name === "string" ? pane.tab_name : "",
    position: typeof pane.tab_position === "number" ? pane.tab_position : null,
  };
}
