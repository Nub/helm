#!/usr/bin/env node
// Time finding code for one project, as JSON for dashboard tiles (update_tile data shapes): this week's share of
// agents' active time with last week's as its trend, and the last eight weeks as a chart. Same measure as the Helm
// page (server/findingcode.ts). Opens the database read-only.
//   node scripts/finding-code.ts <path to helm.db> <project id>
import { DatabaseSync } from 'node:sqlite';
import { findingCode, weeklyShares } from '../server/findingcode.ts';

const [dbPath, projectId] = process.argv.slice(2);
if (!dbPath || !projectId) {
  console.error('usage: finding-code.ts <helm.db> <project id>');
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as Record<string, any>[];
const now = Date.now();
const weeks = weeklyShares(q, projectId, now, 8);
const week = findingCode(q, projectId, now - 7 * 86_400_000, now).all;
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
console.log(
  JSON.stringify(
    {
      number: { value: week.timeShare ?? 0, unit: '%', better: 'lower', target: 15, label: `of agent time finding code this week · ${weeks[weeks.length - 2]?.share.timeShare ?? '–'}% last week${week.tokenShare != null ? ` · ${week.tokenShare}% of all tokens` : ''}` },
      chart: { type: 'line', unit: '%', labels: weeks.map((w) => day.format(w.to)), series: [{ name: 'Time finding code', values: weeks.map((w) => w.share.timeShare ?? 0) }] },
    },
    null,
    1,
  ),
);
