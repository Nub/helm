#!/usr/bin/env node
// A small scratch git repository for trying dashboards (server/dashboards.ts): a "game" with three levels, a chart
// input and a profiling input, and two recipes: scripts/chart.mjs prints a bar chart's JSON, scripts/render.mjs LEVEL
// renders that level's picture to out/LEVEL.svg from its scene file. The fake director's DASHBOARD scenario
// (fake-claude.mjs) builds a dashboard on it; DASHWORK <level|readme|profile> changes one input in a worker task.
//
//   node dash-repo.mjs DIR     creates DIR as that repository (refuses an existing non-empty folder)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILES = {
  'README.md': '# Scratch game\n\nA tiny repository for trying Helm dashboards.\n',
  'levels/forest/scene.txt': 'sky=#9fd3ff ground=#2f7d32 trees=9\n',
  'levels/cave/scene.txt': 'sky=#1b1b2f ground=#5d4037 trees=0\n',
  'levels/desert/scene.txt': 'sky=#ffd59e ground=#e0b25b trees=2\n',
  'chart/draw-calls.json': JSON.stringify({ forest: 812, cave: 1204, desert: 640 }, null, 2) + '\n',
  'profile/settings.txt': 'quality=high shadows=on\n',
  'scripts/chart.mjs': `// Prints the draw-call chart as Helm chart JSON.
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(new URL('../chart/draw-calls.json', import.meta.url)));
console.log(JSON.stringify({ type: 'bar', labels: Object.keys(d), series: [{ name: 'Draw calls', values: Object.values(d) }] }));
`,
  'scripts/render.mjs': `// Renders one level's picture from its scene file: node scripts/render.mjs LEVEL -> out/LEVEL.svg
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const lv = process.argv[2];
const scene = Object.fromEntries(readFileSync(new URL(\`../levels/\${lv}/scene.txt\`, import.meta.url), 'utf8').trim().split(/\\s+/).map((kv) => kv.split('=')));
const trees = Array.from({ length: Number(scene.trees ?? 0) }, (_, i) => \`<polygon points="\${60 + i * 60},300 \${85 + i * 60},230 \${110 + i * 60},300" fill="#1b5e20"/>\`).join('');
const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="\${scene.sky}"/><circle cx="540" cy="80" r="40" fill="#fff8e1" opacity="0.9"/><rect y="300" width="640" height="100" fill="\${scene.ground}"/>\${trees}<text x="20" y="40" font-family="sans-serif" font-size="28" fill="#111">\${lv}</text></svg>\`;
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
writeFileSync(new URL(\`../out/\${lv}.svg\`, import.meta.url), svg);
console.log(\`out/\${lv}.svg\`);
`,
  '.gitignore': 'out/\n',
};

export function makeGameRepo(dir) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`);
  for (const [f, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', '-c', 'init.defaultBranch=main', '-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'Scratch game');
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node dash-repo.mjs DIR');
    process.exit(2);
  }
  console.log(makeGameRepo(dir));
}
