/**
 * The dashboards part of every agent's system prompt (structure.ts), when the project has dashboards on: every agent
 * keeps the tiles its task affected current and never others; managers build dashboards from the user's words and
 * check each finished task's scope (dashboards.ts, tilescope.ts, dashtools.ts).
 */
export function dashboardsSection(manager: boolean, root: boolean): string {
  const lines = [
    `# Dashboards`,
    `The project's dashboards ([[page:dashboards]]) are pages of tiles (numbers, charts, tables, images, galleries, text, pages) that agents keep current. Each tile records what it depends on (repository globs, Spec entries, tags), its recipe (the exact command, folder, host and duration that produce its data) and what its data was built from. list_dashboards shows them. Helm never runs a recipe: agents do.`,
    `- When you finish a task, complete_task names the tiles your task's changes may have affected (Helm matches the files you changed against each tile's dependencies). For each one, refresh it by its recipe and send the result with update_tile, or declare it unaffected with the reason (update_tile unaffected). If it cannot be refreshed where you are (it needs another machine), use leave_stale with why; if the refresh fails, failed with the error. Expensive tiles are not yours: they go Stale for the director.`,
    `- Never refresh a tile your task did not affect, unless your manager asked you to: an unasked refresh costs time and is shown to the director.`,
    `- Dashboard rules (set_tile refuses what breaks them): every tile is in a section (one per scene or area, at most 8 tiles, then a sub-section); titles at most 40 characters, captions one line, details in info; images of one viewpoint are one compare tile (2 to 8 labelled images, a reference if there is one), never separate image tiles, flip animations or viewer pages; the numbers that score them are a scores tile with the same row labels; a page tile (free HTML) states page_reason; name series once in the dashboard's key.`,
    `- Building a tile (your task is a dashboard's, or the director opened the dashboard to your task): set_tile with kind, section, title, depends_on and recipe, then its first data with update_tile. Write the recipe so another agent repeats it exactly: the commands, the folder, the host, how long it takes, and how the output becomes the tile's data. Keep the dependencies as narrow as what really changes the tile (one level's folder for that level's picture), so a task that changes one input refreshes one tile. A gallery (different views) is image tiles sharing a group, one per picture. Where a tile names Helm items (a task in a table row or chart label, a Spec entry in a caption or text), write each as [[id]], so the dashboard links it with the item's title.`,
  ];
  if (manager) {
    lines.push(
      `- The user describes a dashboard in words (New dashboard on the Dashboards page, or in conversation) and you deliver it: ${root ? 'create it with set_dashboard (a title, and their words as the description) unless Helm already did, ' : ''}design the sections and tiles by the rules (dashboard_lint checks them), ask the user only what you cannot decide (which levels, which angles), let its builder write the recipes and first data (Helm starts one on the dashboard's task; set_dashboard allow_tasks opens it to another task), check the result against the user's words, and mark it ready with set_dashboard. Changes the user asks for (add, change, drop) arrive in the dashboard's task thread: adjust the tiles the same way.`,
      `- When a task affected tiles, check the scope before or after its builder finishes: review_dashboard_scope shows what Helm computed and what the agent did about each tile (refreshed, unaffected with the reason, left stale). Accept it, send the agent back for a tile it should have refreshed (also one Helm missed), and correct a tile's dependencies when the list was too wide or too narrow, so the next list is right. Closing with tiles unanswered leaves them Stale and is only a warning, since some refreshes need another machine.`,
      `- Expensive tiles (long profiling runs) are refreshed only when you ask: you are told when a task leaves one Stale; batch them when it is worth it. When the user asks for a refresh, Helm makes a Routine task for a fresh builder to run the recipes; you do not run them. To refresh expensive tiles yourself, schedule such a task (create_task with the tile ids and recipes in its description).`,
    );
  }
  return lines.join('\n');
}
