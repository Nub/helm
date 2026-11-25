/**
 * Live host stats for the Hosts page (hosts.ts health check): CPU use and load, memory, disk of the Helm root (or home)
 * volume, and per GPU its use and memory. One collector per platform, run in the health check's one SSH round (the
 * local host runs the same Unix script). Every value a host cannot give is null, shown as "—": a missing tool is never
 * an error. Pure parsers here so tests run them on sample outputs.
 */

export type Used = { used: number; total: number };
export type Gpu = { util: number | null; mem: Used | null };
export type HostStats = { cpu: number | null; load: string; cpus: number | null; mem: Used | null; disk: Used | null; gpus: Gpu[] };

const EMPTY: HostStats = { cpu: null, load: '', cpus: null, mem: null, disk: null, gpus: [] };

/** A path for the shell, single-quoted (a leading ~/ becomes $HOME). */
function shPath(p: string): string {
  const raw = p.trim() || '~';
  if (raw === '~') return '"$HOME"';
  if (raw.startsWith('~/')) return `"$HOME"/'${raw.slice(2).replace(/'/g, `'\\''`)}'`;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

const GPU_QUERY = 'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits';

/**
 * Linux and macOS, read by `sh -s` from stdin (so the login shell, fish or zsh, never parses it). Sections start with
 * "@name"; each tool's failure only leaves its section empty.
 */
export function unixScript(root: string): string {
  const r = shPath(root);
  return [
    `R=${r}; [ -d "$R" ] || R="$HOME"`,
    'if [ "$(uname)" = Darwin ]; then',
    '  echo @load; sysctl -n vm.loadavg 2>/dev/null',
    '  echo @cpus; sysctl -n hw.ncpu 2>/dev/null',
    "  echo @topcpu; top -l 2 -n 0 -s 1 2>/dev/null | grep 'CPU usage' | tail -1",
    '  echo @memsize; sysctl -n hw.memsize 2>/dev/null',
    '  echo @vmstat; vm_stat 2>/dev/null',
    'else',
    '  echo @load; cat /proc/loadavg 2>/dev/null',
    '  echo @cpus; nproc 2>/dev/null',
    '  echo @stat; head -1 /proc/stat 2>/dev/null; sleep 0.5; head -1 /proc/stat 2>/dev/null',
    "  echo @meminfo; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null",
    'fi',
    'echo @disk; df -Pk "$R" 2>/dev/null | tail -1',
    `echo @gpu; command -v nvidia-smi >/dev/null 2>&1 && ${GPU_QUERY} 2>/dev/null`,
    'true',
  ].join('\n');
}

/** Windows: one PowerShell call (CIM counters), sent as -EncodedCommand so no shell quoting is involved. */
export function windowsScript(root: string): string {
  const drive = /^[A-Za-z]:/.test(root.trim()) ? root.trim().slice(0, 2).toUpperCase() : '$env:SystemDrive';
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '"@cpu"; (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    '"@cpus"; [Environment]::ProcessorCount',
    '$os = Get-CimInstance Win32_OperatingSystem',
    '"@mem"; "$($os.TotalVisibleMemorySize) $($os.FreePhysicalMemory)"',
    drive.startsWith('$') ? '$drv = $env:SystemDrive' : `$drv = '${drive}'`,
    '$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$drv\'"',
    '"@disk"; "$($d.Size) $($d.FreeSpace)"',
    `"@gpu"; if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { ${GPU_QUERY} }`,
  ].join('; ');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
}

/** The output split into its "@name" sections. */
function sections(out: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur = '';
  for (const raw of out.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const head = /^@(\w+)$/.exec(line);
    if (head) {
      cur = head[1];
      map.set(cur, []);
    } else if (cur && line) map.get(cur)!.push(line);
  }
  return map;
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? '').trim());
  return Number.isFinite(n) && String(s ?? '').trim() !== '' ? n : null;
};
const pct = (n: number | null) => (n == null ? null : Math.max(0, Math.min(100, Math.round(n))));
const used = (u: number | null, t: number | null): Used | null => (u != null && t != null && t > 0 ? { used: Math.max(0, u), total: t } : null);

/** nvidia-smi CSV lines "util, used MiB, total MiB" (no units). */
function parseGpus(lines: string[] | undefined): Gpu[] {
  return (lines ?? [])
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((p) => p.length >= 3 && p.some((x) => /^\d/.test(x)))
    .map(([u, m, t]) => ({ util: pct(num(u)), mem: used(num(m) == null ? null : num(m)! * 1048576, num(t) == null ? null : num(t)! * 1048576) }));
}

/** `df -Pk` data line: filesystem, 1K-blocks, used, available, capacity, mount. */
function parseDf(lines: string[] | undefined): Used | null {
  const p = (lines ?? []).at(-1)?.split(/\s+/);
  if (!p || p.length < 4) return null;
  const total = num(p[1]);
  const usedK = num(p[2]);
  const avail = num(p[3]);
  // used + available, like df's own percentage (reserved blocks are not the user's).
  return total == null || usedK == null ? null : used(usedK * 1024, ((avail != null ? usedK + avail : total) || total) * 1024);
}

/** CPU busy % between two /proc/stat "cpu" lines. */
function procStatCpu(lines: string[] | undefined): number | null {
  const rows = (lines ?? []).filter((l) => /^cpu\s/.test(l)).map((l) => l.split(/\s+/).slice(1).map(Number));
  if (rows.length < 2 || rows.some((r) => r.length < 4 || r.some((n) => !Number.isFinite(n)))) return null;
  const [a, b] = rows;
  const idle = (r: number[]) => r[3] + (r[4] ?? 0);
  const total = (r: number[]) => r.reduce((s, n) => s + n, 0);
  const dt = total(b) - total(a);
  return dt > 0 ? pct(((dt - (idle(b) - idle(a))) / dt) * 100) : null;
}

export function parseUnixStats(out: string): HostStats {
  const s = sections(out);
  const loadLine = s.get('load')?.[0] ?? '';
  const lm = loadLine.replace(/[{}]/g, '').trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const load = lm ? `${lm[1]} ${lm[2]} ${lm[3]}` : '';
  const cpus = num(s.get('cpus')?.[0]);
  let cpu: number | null = procStatCpu(s.get('stat'));
  let mem: Used | null = null;
  if (s.has('meminfo')) {
    const kb = (k: string) => num(s.get('meminfo')!.find((l) => l.startsWith(`${k}:`))?.match(/(\d+)/)?.[1]);
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    mem = total != null && avail != null ? used((total - avail) * 1024, total * 1024) : null;
  }
  if (s.has('topcpu')) {
    // "CPU usage: 7.14% user, 10.71% sys, 82.14% idle"
    const idle = num(s.get('topcpu')?.[0]?.match(/([\d.]+)%\s*idle/)?.[1]);
    cpu = idle == null ? null : pct(100 - idle);
  }
  if (s.has('memsize')) {
    const total = num(s.get('memsize')?.[0]);
    const vm = s.get('vmstat') ?? [];
    const page = num(vm[0]?.match(/page size of (\d+) bytes/)?.[1]) ?? 4096;
    const pages = (k: string) => num(vm.find((l) => l.startsWith(k))?.match(/:\s*(\d+)/)?.[1]);
    // In use: what Activity Monitor calls App memory + wired + compressed (active + wired + compressor-occupied pages).
    const parts = [pages('Pages active'), pages('Pages wired down'), pages('Pages occupied by compressor')];
    mem = total != null && parts.every((p) => p != null) ? used((parts as number[]).reduce((a, b) => a + b, 0) * page, total) : null;
  }
  return { ...EMPTY, cpu, load, cpus, mem, disk: parseDf(s.get('disk')), gpus: parseGpus(s.get('gpu')) };
}

export function parseWindowsStats(out: string): HostStats {
  const s = sections(out);
  const memP = (s.get('mem')?.[0] ?? '').split(/\s+/).map((x) => num(x));
  const diskP = (s.get('disk')?.[0] ?? '').split(/\s+/).map((x) => num(x));
  const mem = memP.length >= 2 && memP[0] != null && memP[1] != null ? used((memP[0] - memP[1]) * 1024, memP[0] * 1024) : null;
  const disk = diskP.length >= 2 && diskP[0] != null && diskP[1] != null ? used(diskP[0] - diskP[1], diskP[0]) : null;
  return { ...EMPTY, cpu: pct(num(s.get('cpu')?.[0])), cpus: num(s.get('cpus')?.[0]), mem, disk, gpus: parseGpus(s.get('gpu')) };
}
