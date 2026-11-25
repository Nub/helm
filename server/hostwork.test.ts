import './testenv.ts';
// Clean host workspaces (hostwork.ts): the root and every path Helm deletes stay confined; the host settings are
// checked; the wrapper keeps the environment clean. The end-to-end run over SSH is server/checks/hostwork.check.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const hw = await import('./hostwork.ts');
const { hostFields } = await import('./hosts.ts');

test('a workspace root is a folder of its own, absolute or under ~, with plain characters', () => {
  for (const ok of ['~/.helm-work', '/srv/helm-work', '/home/user/work', '~/a/b']) assert.equal(hw.rootError(ok), null, ok);
  for (const bad of ['/', '~', '~/', '/tmp/../etc', 'relative/dir', '~/a b', "~/x';rm -rf ~;'", '/a/$(id)', '~/x~y', '']) assert.ok(hw.rootError(bad), bad);
});

test('only folders at least two levels under the root may be removed', () => {
  const root = '~/.helm-work';
  assert.equal(hw.confined(root, '~/.helm-work/game/build-1'), true);
  assert.equal(hw.confined(root, '~/.helm-work/game/build-1/src'), true);
  for (const bad of ['~/.helm-work', '~/.helm-work/game', '~/.helm-workx/game/b', '~/.helm-work/../x/y', '~/.helm-work/game/./b', '~/other/game/b', '/etc/passwd', '~/.helm-work/game/b;rm', '~/.helm-work/game/$HOME'])
    assert.equal(hw.confined(root, bad), false, bad);
  assert.equal(hw.confined('/', '/etc/x'), false, 'a bad root confines nothing');
});

test('host settings: PATH additions are folders, caches are variable names, the root is checked', () => {
  assert.ok('fields' in hostFields({ work_root: '~/.helm-work', work_env: '~/.cargo/bin\n/opt/x/bin', work_caches: 'CARGO_TARGET_DIR', work_setup: 'source /opt/env.sh' }, { id: 'h', name: 'h', is_local: 0 }));
  assert.ok('error' in hostFields({ work_root: '/' }, { id: 'h', name: 'h', is_local: 0 }));
  assert.ok('error' in hostFields({ work_env: 'bin; rm -rf ~' }, { id: 'h', name: 'h', is_local: 0 }));
  assert.ok('error' in hostFields({ work_caches: 'NOT A NAME' }, { id: 'h', name: 'h', is_local: 0 }));
});

test('the wrapper: env -i, no profile, the command on stdin, PATH and caches as declared', () => {
  const w = hw.wrapperScript({ work_root: '~/.helm-work', work_env: '~/.cargo/bin', work_caches: 'CARGO_TARGET_DIR' }, 'game');
  assert.match(w, /exec env -i HOME="\$WS\/home"/);
  assert.match(w, /bash --noprofile --norc -c/);
  assert.match(w, /CMD="\$\(cat\)"/);
  assert.match(w, /PATH="\$HOME\/\.cargo\/bin:\/run\/current-system\/sw\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"/);
  assert.match(w, /CARGO_TARGET_DIR="\$HOME\/\.helm-work\/cache\/game\/cargo_target_dir"/);
  assert.doesNotMatch(w, /bash -l|--login|\.profile|\.bashrc/);
});

test('copy-back refuses an archive with a link pointing out, and keeps nothing of it', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'helm-test-untar-'));
  const src = join(base, 'src');
  mkdirSync(join(src, 'out'), { recursive: true });
  writeFileSync(join(src, 'out', 'ok.txt'), 'fine');
  symlinkSync('/etc/passwd', join(src, 'out', 'escape'));
  execFileSync('tar', ['-cf', join(base, 'bad.tar'), '-C', src, 'out']);
  const dest = join(base, 'dest');
  mkdirSync(dest);
  assert.match((await hw.safeUntar(join(base, 'bad.tar'), dest))!, /out\/escape is a link/);
  assert.deepEqual(readdirSync(dest), [], 'nothing unpacked');
  // A plain archive unpacks.
  const good = join(base, 'good');
  mkdirSync(join(good, 'out'), { recursive: true });
  writeFileSync(join(good, 'out', 'a.txt'), 'a');
  execFileSync('tar', ['-cf', join(base, 'good.tar'), '-C', good, 'out']);
  const dest2 = join(base, 'dest2');
  mkdirSync(dest2);
  assert.equal(await hw.safeUntar(join(base, 'good.tar'), dest2), null);
  assert.ok(existsSync(join(dest2, 'out', 'a.txt')));
  // A name with .. is refused.
  execFileSync('tar', ['-cf', join(base, 'dots.tar'), '-C', good, '--transform', 's,^out,../out,', 'out']);
  const dest3 = join(base, 'dest3');
  mkdirSync(dest3);
  assert.match((await hw.safeUntar(join(base, 'dots.tar'), dest3))!, /outside the results/);
});

// Every bash script Helm sends a Linux or macOS host, for a slot with kept folders.
function bashScripts(platform: string) {
  const host = { platform, work_root: '~/.helm-work', work_env: '~/.cargo/bin', work_caches: 'CARGO_HOME', work_keep: 'CARGO_TARGET_DIR=target' };
  const keep = hw.keepFolders(host.work_keep);
  const wrapper = hw.wrapperScript(host, 'game', keep);
  const ws = '~/.helm-work/game/slot';
  const prep = (slot: boolean) => hw.bashPrep({ root: '~/.helm-work', pslug: 'game', ws, slot, wrapper, setup: 'export A=1', caches: ['~/.helm-work/cache/game/cargo_home'] });
  return { wrapper, all: [wrapper, prep(true), prep(false), hw.bashUnpack(ws, true, keep), hw.bashUnpack(ws, false), hw.bashRemove('~/.helm-work', ws), hw.bashStale('~/.helm-work'), hw.bashSizes([ws]), hw.bashPack(ws, ['out/a.txt'])] };
}

test('macOS: no NixOS folders, a locale macOS has; Linux keeps its own', () => {
  const mac = bashScripts('macos').wrapper;
  assert.doesNotMatch(mac, /run\/current-system/);
  assert.match(mac, /LANG=en_US\.UTF-8/);
  assert.match(mac, /PATH="\$HOME\/\.cargo\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
  assert.match(mac, /CARGO_TARGET_DIR="\$WS\/src\/target"/);
  const linux = bashScripts('linux').wrapper;
  assert.match(linux, /run\/current-system\/sw\/bin/);
  assert.match(linux, /LANG=C\.UTF-8/);
});

test('macOS: the scripts use nothing GNU-only, nothing newer than bash 3.2, and never source a login shell', async () => {
  const { execFileSync } = await import('node:child_process');
  // GNU-only tool flags (BSD find, tar, stat, sed, du, sort, xargs, date, touch, readlink differ) and bash 4+ syntax.
  const gnuOnly = [/-printf/, /--transform/, /\bstat -c/, /\bstat --/, /readlink -f/, /\brealpath\b/, /sed -i(?! '')/, /\bdu -b/, /sort -z/, /xargs -r/, /\bdate -d/, /touch -d/, /cp -T/, /--no-same-owner/, /tar [^\n]*--[a-z]/, /\bmapfile\b/, /\breadarray\b/, /declare -A/, /\$\{[A-Za-z_]+,,\}/, /\$\{[A-Za-z_]+\^\^\}/, /\|&/, /local -n/, /\bcoproc\b/, /\bshopt -s globstar/];
  const loginShell = [/bash -l\b/, /--login/, /\.profile/, /\.bashrc/, /\.zshrc/, /\.zprofile/, /zsh/];
  for (const s of bashScripts('macos').all) {
    for (const re of gnuOnly) assert.doesNotMatch(s, re, `GNU-only or bash 4: ${re}`);
    for (const re of loginShell) assert.doesNotMatch(s, re, `login shell: ${re}`);
    // tar always names its archive (-f -): BSD tar has no stdout default.
    for (const m of s.matchAll(/\btar\s+-[a-z]+(?:\s+-[a-z]+)*/g)) assert.match(m[0], /f/, m[0]);
    // Valid bash.
    execFileSync('bash', ['-n'], { input: s });
  }
});

test('PowerShell scripts: Windows PowerShell 5.1 syntax only; no path outside the root is ever handed to them', () => {
  const host = { platform: 'windows', work_root: '~/.helm-work', work_env: '~/.cargo/bin', work_caches: 'CARGO_HOME', work_keep: 'CARGO_TARGET_DIR=target' };
  const keep = hw.keepFolders(host.work_keep);
  const ws = '~/.helm-work/game/slot';
  const scripts = [
    hw.psWrapper(host, 'game', keep),
    hw.psPrep({ root: '~/.helm-work', pslug: 'game', ws, slot: true, wrapper: 'x', setup: 'y', caches: [] }),
    hw.psPrep({ root: '~/.helm-work', pslug: 'game', ws: '~/.helm-work/game/build-1', slot: false, wrapper: 'x', setup: 'y', caches: [] }),
    hw.psUnpack('~/.helm-work', ws, true, keep), hw.psUnpack('~/.helm-work', ws, false), hw.psRemove('~/.helm-work', ws), hw.psStale('~/.helm-work'), hw.psSizes([ws]), hw.psPack('~/.helm-work', ws, ['out/a.txt']),
  ];
  for (const s of scripts) {
    // PowerShell 7 only: ?? and ?. , pipeline chains (&& ||), ternaries, $IsWindows; and nothing that follows links when deleting.
    assert.doesNotMatch(s, /\?\?|\?\.|\$IsWindows|\$IsLinux|Remove-Item[^\n]*-Recurse/, s.slice(0, 80));
    for (const line of s.split('\n')) if (!/^\s*#/.test(line) && !/\[IO\.|Fail|Write-Output|"/.test(line)) assert.doesNotMatch(line, /\s(&&|\|\|)\s/, line);
  }
  // The script is sent encoded: no shell on the way parses it, and long ones go on stdin.
  const short = hw.remoteCommand(host, 'Write-Output 1', true);
  assert.match(short.command, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(short.command.split(' ').pop()!, 'base64').toString('utf16le'), 'Write-Output 1');
  const long = hw.remoteCommand(host, scripts[1], false);
  assert.equal(long.stdin, scripts[1]);
  assert.ok(long.command.length < 1000, 'within cmd.exe\'s 8191 characters');
  // Removal and the walk refuse at the link: InRoot fails on a reparse point; RemoveTree deletes links as themselves.
  assert.match(scripts[5], /InRoot \$RR 'game\/slot' \$false/);
  assert.match(scripts[0], /\$e\.Clear\(\)/);
});

test('kept build folders: plain paths inside the code, with an optional variable', () => {
  assert.deepEqual(hw.keepFolders('target\nCARGO_TARGET_DIR=target\nbuild/out'), [{ path: 'target', variable: null }, { path: 'target', variable: 'CARGO_TARGET_DIR' }, { path: 'build/out', variable: null }]);
  for (const bad of ['../x', '/abs', 'a/../b', '.git', '.helm/x', 'X=', '=x', 'a b', '~/x', 'x;rm']) assert.equal(hw.keepLineOk(bad), false, bad);
  assert.ok('error' in hostFields({ work_keep: '../escape' }, { id: 'h', name: 'h', is_local: 0 }));
  assert.ok('error' in hostFields({ platform: 'beos' }, { id: 'h', name: 'h', is_local: 0 }));
  assert.ok('fields' in hostFields({ platform: 'windows', work_keep: 'CARGO_TARGET_DIR=target' }, { id: 'h', name: 'h', is_local: 0 }));
});
