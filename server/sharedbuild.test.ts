import { SCRATCH } from './testenv.ts';
// One Rust build folder for all work trees (sharedbuild.ts): set for a Rust project with the setting on, next to its
// work trees; nothing for other projects or with the setting off; agents are told where binaries go.
// `node --test server/sharedbuild.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const sb = await import('./sharedbuild.ts');
const { setSetting } = await import('./settings.ts');
const { hostsPromptSection } = await import('./hosts.ts');

function project(name: string, rust: boolean) {
  const path = join(SCRATCH, 'src', name);
  mkdirSync(path, { recursive: true });
  if (rust) writeFileSync(join(path, 'Cargo.toml'), '[package]\nname = "x"\n');
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, structure, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, name, path, '{"root":"director","roles":[]}', db.now(), db.now());
  return db.get('SELECT * FROM projects WHERE id = ?', id)!;
}

test('a Rust project: one CARGO_TARGET_DIR next to its work trees, made on first use; agents are told', () => {
  const p = project('game', true);
  assert.deepEqual(sb.sharedBuildEnv(p), {}, 'off unless the project turns it on');
  setSetting(p.id, 'shared_target', true);
  const env = sb.sharedBuildEnv(p);
  assert.equal(env.CARGO_TARGET_DIR, join(SCRATCH, 'src', 'game-wt', '.target'));
  assert.ok(existsSync(env.CARGO_TARGET_DIR));
  assert.match(hostsPromptSection(p.id), /^# Builds\nRust builds in every work tree .*CARGO_TARGET_DIR is set/);
  setSetting(p.id, 'shared_target', false);
  assert.deepEqual(sb.sharedBuildEnv(p), {});
  assert.equal(hostsPromptSection(p.id), '');
});

test('not a Rust project: nothing set, nothing said', () => {
  const p = project('site', false);
  setSetting(p.id, 'shared_target', true);
  assert.deepEqual(sb.sharedBuildEnv(p), {});
  assert.equal(hostsPromptSection(p.id), '');
});
