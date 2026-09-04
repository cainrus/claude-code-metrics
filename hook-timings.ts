#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
//
// hook-timings.ts — cut Claude Code hook timings by COMMAND, read straight out
// of the session transcripts. Answers "why are the hooks slow" with a per-step
// table instead of a per-event one.
//
// Why per-command and not per-hookName: `hookName` is the name of the EVENT
// (`SessionStart:startup`), shared by every step in the chain. Percentiles over
// a chain average N populations, and one permanently-slow step out of eight
// moves the median by ~1/8 of its weight — invisible until it hits the timeout.
// Measured: on 19.08.2026 SessionStart read as median 351ms / p90 2589 / 11
// timeouts, i.e. "a rare outlier, cache it". The per-command cut showed a
// single culprit, top-cwds.ts, at median 2359ms — slow ALWAYS, with the other
// seven steps (101–469ms) dragging the shared median down. The real diagnosis
// was "this step reads 10 777 files".
//
// Data source: <profile>/projects/**/*.jsonl. Every hook call is one line, an
// `attachment` of type hook_success / hook_cancelled / hook_non_blocking_error
// carrying command, durationMs, timedOut, timeoutMs, exitCode.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Profile roots come from CONSTANTS, never from CLAUDE_CONFIG_DIR.
 *
 * A non-interactive caller (launchd, cron, an execFile from another tool) gets
 * no shell profile, so the env var is unset and a raw binary reads an empty
 * ~/.claude. Deriving the scan root from it would make this tool report "0
 * hook calls" — a clean, believable, wrong answer. `--profile` selects among
 * fixed paths instead, and defaults to scanning all of them.
 *
 * `default` is the stock install. The other two are the convention for running
 * separate configurations out of one account (`CLAUDE_CONFIG_DIR` pointed at
 * `~/.claude-home` or `~/.claude-work`); they are listed because scanning a
 * directory that does not exist costs nothing, while missing one silently
 * halves the data.
 */
export const PROFILE_DIRS: Record<'default' | 'home' | 'work', string> = {
  default: '.claude',
  home: '.claude-home',
  work: '.claude-work',
}

export type ProfileName = keyof typeof PROFILE_DIRS

/** `all` means every entry of PROFILE_DIRS, not "every directory on disk". */
export type ProfileSelector = ProfileName | 'all'

export function profileRoots(which: ProfileSelector, home = homedir()): Array<{ profile: ProfileName; root: string }> {
  const names: ProfileName[] = which === 'all' ? (Object.keys(PROFILE_DIRS) as ProfileName[]) : [which]
  return names.map((profile) => ({ profile, root: join(home, PROFILE_DIRS[profile], 'projects') }))
}

// ---------------------------------------------------------------------------
// --since
// ---------------------------------------------------------------------------

/**
 * `30d`, `12h`, `90m` — relative to now; `2026-08-01` / `2026-08-21T02:00` —
 * absolute. Returns epoch ms, or null for "no lower bound".
 */
export function parseSince(spec: string | undefined, now = Date.now()): number | null {
  if (spec === undefined || spec === '') return null
  const rel = /^(\d+(?:\.\d+)?)([mhdw])$/.exec(spec.trim())
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2] as 'm' | 'h' | 'd' | 'w']
    return now - Number(rel[1]) * unit
  }
  const abs = Date.parse(spec)
  if (Number.isNaN(abs)) throw new Error(`--since: expected 30d / 12h / 2026-08-01, got ${JSON.stringify(spec)}`)
  return abs
}

// ---------------------------------------------------------------------------
// Command labels
// ---------------------------------------------------------------------------

/** Path prefixes worth collapsing, longest-first so the specific ones win. */
const PREFIX_RULES: Array<[RegExp, string]> = [
  [/\$HOME\/dotfiles\/claude\/bin\//g, '~bin/'],
  [/\$\{CLAUDE_PLUGIN_ROOT\}\//g, '~plug/'],
  [/\$CLAUDE_PLUGIN_ROOT\//g, '~plug/'],
  [/\$\{?CLAUDE_PROJECT_DIR\}?\//g, '~proj/'],
  [/\$HOME\//g, '~/'],
]

/** Shell tails that say nothing about which step this is. */
const TAIL_RULES: RegExp[] = [
  /\s*2>&1\s*\|.*$/,
  /\s*\|\|\s*true\s*$/,
  /\s*\d?>\s*\/dev\/null(\s*2>&1)?\s*$/,
  /\s*2>\s*\/dev\/null\s*$/,
]

/**
 * A display label. Grouping ALWAYS keys on the full command — shortening is
 * cosmetic, and collapsing two distinct commands into one row would recreate
 * the exact averaging bug this tool exists to expose. `assignLabels` guards it.
 */
export function shortenCommand(command: string, home = homedir()): string {
  let s = command.replaceAll(home + '/', '~/')
  for (const [re, to] of PREFIX_RULES) s = s.replace(re, to)
  // Applied repeatedly: `… 2>&1 | grep -v '^  ok' || true` needs both rules.
  for (let pass = 0; pass < TAIL_RULES.length; pass++) {
    for (const re of TAIL_RULES) s = s.replace(re, '')
  }
  s = s.replaceAll('"', '').trim()
  return s === '' ? command.trim() : s
}

/**
 * Full command -> unique label. Two commands that shorten to the same string
 * get `#2`, `#3` … appended rather than being silently merged; `collisions`
 * names them so the report can say so out loud.
 */
export function assignLabels(commands: string[], home = homedir()): { labels: Map<string, string>; collisions: string[] } {
  const byShort = new Map<string, string[]>()
  for (const c of commands) {
    const short = shortenCommand(c, home)
    const bucket = byShort.get(short)
    if (bucket) bucket.push(c)
    else byShort.set(short, [c])
  }
  const labels = new Map<string, string>()
  const collisions: string[] = []
  for (const [short, group] of byShort) {
    if (group.length === 1) {
      labels.set(group[0], short)
      continue
    }
    collisions.push(short)
    group.sort()
    group.forEach((full, i) => labels.set(full, i === 0 ? short : `${short} #${i + 1}`))
  }
  return { labels, collisions }
}

export function truncate(s: string, width: number): string {
  return s.length <= width ? s : s.slice(0, width - 1) + '…'
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over an ascending array — the same method throughout,
 * median included, so p50 and p90 are never computed two different ways.
 */
export function quantile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

// ---------------------------------------------------------------------------
// Reading transcripts
// ---------------------------------------------------------------------------

export type Outcome = 'ok' | 'timeout' | 'error'

export type Invocation = {
  /** Per-line uuid: unique per call and preserved when a transcript is forked. */
  uuid: string
  ts: number
  iso: string
  event: string
  hookName: string
  /** One firing of the whole chain: every step of it shares this toolUseID. */
  firing: string
  command: string
  ms: number
  outcome: Outcome
  timeoutMs?: number
  exitCode?: number
  profile: ProfileName
}

const HOOK_MARKER = '"hook_'

/**
 * One transcript line -> one invocation, or null.
 *
 * Only attachments that carry BOTH command and durationMs count: the same
 * chain also emits hook_additional_context / hook_system_message lines, which
 * have neither and are not calls.
 */
export function parseHookLine(line: string, profile: ProfileName): Invocation | null {
  if (!line.includes(HOOK_MARKER)) return null
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  const a = row?.attachment
  if (!a || typeof a.type !== 'string' || !a.type.startsWith('hook_')) return null
  if (typeof a.command !== 'string' || typeof a.durationMs !== 'number') return null
  const ts = Date.parse(row.timestamp ?? '')
  return {
    uuid: typeof row.uuid === 'string' ? row.uuid : `${a.toolUseID}|${a.command}`,
    ts: Number.isNaN(ts) ? 0 : ts,
    iso: typeof row.timestamp === 'string' ? row.timestamp : '',
    event: typeof a.hookEvent === 'string' ? a.hookEvent : '(unknown)',
    hookName: typeof a.hookName === 'string' ? a.hookName : '',
    firing: typeof a.toolUseID === 'string' ? a.toolUseID : row.uuid,
    command: a.command,
    ms: a.durationMs,
    outcome: a.timedOut === true ? 'timeout' : a.type === 'hook_non_blocking_error' ? 'error' : 'ok',
    timeoutMs: typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined,
    exitCode: typeof a.exitCode === 'number' ? a.exitCode : undefined,
    profile,
  }
}

export function listTranscripts(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}

/** mtime skew allowance before a file is skipped as older than the window. */
const MTIME_MARGIN_MS = 3_600_000

export type Scan = {
  invocations: Invocation[]
  filesSeen: number
  filesRead: number
  duplicates: number
  missingRoots: string[]
}

/**
 * Collect every hook call in the selected profiles, deduplicated.
 *
 * Dedup is by line uuid. It matters: one call lands in SEVERAL transcripts when
 * a session is resumed or forked (72 of 40 122 on 21.08.2026). The earlier
 * ad-hoc analysis keyed on timestamp+durationMs, which is LOSSY in the other
 * direction — it collapsed 586 genuinely distinct calls that merely shared a
 * millisecond and a duration. uuid and toolUseID+command agree exactly (40 050
 * each), so uuid is used and the pair is the fallback when a line has no uuid.
 */
export function scan(opts: {
  which: ProfileSelector
  since: number | null
  events: string[] | null
  home?: string
}): Scan {
  const home = opts.home ?? homedir()
  const seen = new Set<string>()
  const invocations: Invocation[] = []
  let filesSeen = 0
  let filesRead = 0
  let duplicates = 0
  const missingRoots: string[] = []

  for (const { profile, root } of profileRoots(opts.which, home)) {
    const files = listTranscripts(root)
    // An absent config directory is the normal case once more than one profile
    // name is known: on a stock install two of the three never existed. Only a
    // directory that IS there and holds nothing is worth a note, because that
    // is the shape of "you selected the wrong profile".
    if (files.length === 0 && existsSync(root)) missingRoots.push(root)
    for (const file of files) {
      filesSeen++
      // A transcript is only appended to, so nothing inside it is newer than
      // its mtime: an old file cannot hold a call inside a recent window.
      if (opts.since !== null) {
        try {
          if (statSync(file).mtimeMs < opts.since - MTIME_MARGIN_MS) continue
        } catch {
          continue
        }
      }
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!text.includes(HOOK_MARKER)) continue
      filesRead++
      for (const line of text.split('\n')) {
        const inv = parseHookLine(line, profile)
        if (inv === null) continue
        if (opts.since !== null && inv.ts < opts.since) continue
        if (opts.events !== null && !opts.events.includes(inv.event)) continue
        if (seen.has(inv.uuid)) {
          duplicates++
          continue
        }
        seen.add(inv.uuid)
        invocations.push(inv)
      }
    }
  }
  invocations.sort((a, b) => a.ts - b.ts)
  return { invocations, filesSeen, filesRead, duplicates, missingRoots }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type CommandStat = {
  command: string
  label: string
  events: string[]
  n: number
  median: number
  p90: number
  p99: number
  max: number
  timeouts: number
  errors: number
}

export function byCommand(invocations: readonly Invocation[], home = homedir()): CommandStat[] {
  const groups = new Map<string, Invocation[]>()
  for (const inv of invocations) {
    const g = groups.get(inv.command)
    if (g) g.push(inv)
    else groups.set(inv.command, [inv])
  }
  const { labels } = assignLabels([...groups.keys()], home)
  const stats: CommandStat[] = []
  for (const [command, calls] of groups) {
    const durations = calls.map((c) => c.ms).sort((a, b) => a - b)
    stats.push({
      command,
      label: labels.get(command) ?? command,
      events: [...new Set(calls.map((c) => c.event))].sort(),
      n: calls.length,
      median: quantile(durations, 0.5),
      p90: quantile(durations, 0.9),
      p99: quantile(durations, 0.99),
      max: durations[durations.length - 1],
      timeouts: calls.filter((c) => c.outcome === 'timeout').length,
      errors: calls.filter((c) => c.outcome === 'error').length,
    })
  }
  // p90 desc — the column that separates "slow always" from "slow sometimes"
  // better than a median does, which is the whole point of the cut.
  stats.sort((a, b) => b.p90 - a.p90 || b.median - a.median)
  return stats
}

// ---------------------------------------------------------------------------
// Warmth: duration vs the gap since the previous firing of the same event
// ---------------------------------------------------------------------------

export const WARMTH_BUCKETS: Array<{ name: string; maxGapMs: number }> = [
  { name: '<1m', maxGapMs: 60_000 },
  { name: '1m–10m', maxGapMs: 600_000 },
  { name: '10m–1h', maxGapMs: 3_600_000 },
  { name: '>1h', maxGapMs: Number.POSITIVE_INFINITY },
]

export type WarmthRow = {
  bucket: string
  firings: number
  chainMedian: number
  chainP90: number
  callMedian: number
  callP90: number
}

/**
 * Separates "the page cache was cold" from "this costs that much every time".
 *
 * The gap is measured between FIRINGS of the chain (all steps of one firing
 * share a toolUseID), not between individual calls — steps inside one firing
 * are milliseconds apart and would all land in `<1m` regardless.
 */
export function warmth(invocations: readonly Invocation[], event: string): WarmthRow[] {
  const firings = new Map<string, Invocation[]>()
  for (const inv of invocations) {
    if (inv.event !== event) continue
    const f = firings.get(inv.firing)
    if (f) f.push(inv)
    else firings.set(inv.firing, [inv])
  }
  const ordered = [...firings.values()]
    .map((calls) => ({ ts: Math.min(...calls.map((c) => c.ts)), calls }))
    .sort((a, b) => a.ts - b.ts)

  const buckets = new Map<string, { chains: number[]; calls: number[] }>()
  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].ts - ordered[i - 1].ts
    const name = WARMTH_BUCKETS.find((b) => gap < b.maxGapMs)!.name
    const b = buckets.get(name) ?? { chains: [], calls: [] }
    b.chains.push(ordered[i].calls.reduce((s, c) => s + c.ms, 0))
    for (const c of ordered[i].calls) b.calls.push(c.ms)
    buckets.set(name, b)
  }
  const rows: WarmthRow[] = []
  for (const { name } of WARMTH_BUCKETS) {
    const b = buckets.get(name)
    if (!b || b.chains.length === 0) continue
    const chains = b.chains.sort((x, y) => x - y)
    const calls = b.calls.sort((x, y) => x - y)
    rows.push({
      bucket: name,
      firings: chains.length,
      chainMedian: quantile(chains, 0.5),
      chainP90: quantile(chains, 0.9),
      callMedian: quantile(calls, 0.5),
      callP90: quantile(calls, 0.9),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ms(n: number): string {
  return Number.isNaN(n) ? '-' : String(Math.round(n))
}

function table(headers: string[], rows: string[][], alignRight: boolean[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (alignRight[i] ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i]))).join('  ').trimEnd()
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

const LABEL_WIDTH = 62

export function renderReport(sc: Scan, opts: { since: number | null; sinceSpec?: string; which: string; events: string[] | null; top: number; home?: string }): string {
  const home = opts.home ?? homedir()
  const out: string[] = []
  const window = opts.sinceSpec ? `since ${opts.sinceSpec}` : 'all time'
  const evLabel = opts.events === null ? 'all events' : opts.events.join(', ')
  out.push(`hook timings — profile ${opts.which}, ${evLabel}, ${window}`)
  out.push(
    `${sc.filesSeen} transcripts seen, ${sc.filesRead} read, ` +
      `${sc.invocations.length} hook calls after dedup (${sc.duplicates} duplicate lines dropped)`,
  )
  for (const root of sc.missingRoots) out.push(`note: ${root} holds no transcripts`)

  // An empty window means "there was nothing to read", which is not the same
  // claim as "the hooks are healthy". Say which one it is, in words.
  if (sc.invocations.length === 0) {
    out.push('')
    out.push('NOTHING TO REPORT — no hook calls matched this window.')
    out.push('That is an absence of data, not a clean bill of health: widen --since,')
    out.push('drop --event, or check --profile (default/home/work/all) before concluding anything.')
    return out.join('\n')
  }

  const stats = byCommand(sc.invocations, home)
  const { collisions } = assignLabels([...new Set(sc.invocations.map((i) => i.command))], home)

  out.push('')
  out.push('BY COMMAND (sorted by p90)')
  out.push(
    table(
      ['n', 'med', 'p90', 'p99', 'max', 'to', 'command'],
      stats.map((s) => [
        String(s.n),
        ms(s.median),
        ms(s.p90),
        ms(s.p99),
        ms(s.max),
        s.timeouts === 0 ? '·' : String(s.timeouts),
        truncate(s.label, LABEL_WIDTH),
      ]),
      [true, true, true, true, true, true, false],
    ),
  )
  out.push('ms; `to` = calls killed by their timeout. Grouped by the full command, not by hookName.')
  const errs = stats.reduce((s, x) => s + x.errors, 0)
  if (errs > 0) out.push(`${errs} call(s) returned a non-blocking error — separate from the timeouts above.`)
  if (collisions.length > 0) {
    out.push(`labels disambiguated with #N (distinct commands, same short form): ${collisions.join(', ')}`)
  }

  // Timeouts, with their timestamps: whether they cluster in a few days or
  // spread evenly is what tells a regression apart from a standing cost.
  const timeouts = sc.invocations.filter((i) => i.outcome === 'timeout')
  out.push('')
  out.push(`TIMEOUTS (${timeouts.length})`)
  if (timeouts.length === 0) {
    out.push('none in this window.')
  } else {
    const perDay = new Map<string, number>()
    for (const t of timeouts) perDay.set(t.iso.slice(0, 10), (perDay.get(t.iso.slice(0, 10)) ?? 0) + 1)
    out.push(
      'by day: ' +
        [...perDay.entries()]
          .sort()
          .map(([d, n]) => `${d} ×${n}`)
          .join(', '),
    )
    const shown = timeouts.slice(-opts.top)
    if (timeouts.length > shown.length) out.push(`(showing the ${shown.length} most recent of ${timeouts.length}; raise --top for the rest)`)
    out.push(
      table(
        ['when', 'ms', 'limit', 'event', 'command'],
        shown.map((t) => [
          t.iso.replace('T', ' ').slice(0, 19),
          ms(t.ms),
          t.timeoutMs === undefined ? '-' : ms(t.timeoutMs),
          t.event,
          truncate(shortenCommand(t.command, home), LABEL_WIDTH),
        ]),
        [false, true, true, false, false],
      ),
    )
  }

  const slowest = sc.invocations
    .filter((i) => i.outcome !== 'timeout')
    .sort((a, b) => b.ms - a.ms)
    .slice(0, opts.top)
  out.push('')
  out.push(`SLOWEST CALLS THAT DID NOT TIME OUT (top ${slowest.length})`)
  out.push(
    table(
      ['when', 'ms', 'event', 'command'],
      slowest.map((s) => [
        s.iso.replace('T', ' ').slice(0, 19),
        ms(s.ms),
        s.event,
        truncate(shortenCommand(s.command, home), LABEL_WIDTH),
      ]),
      [false, true, false, false],
    ),
  )

  // Warmth is per event: a chain total only means something within one chain.
  for (const event of [...new Set(sc.invocations.map((i) => i.event))].sort()) {
    const rows = warmth(sc.invocations, event)
    if (rows.length === 0) continue
    out.push('')
    out.push(`WARMTH — ${event}: duration vs the pause since the previous firing`)
    out.push(
      table(
        ['gap', 'firings', 'chain med', 'chain p90', 'call med', 'call p90'],
        rows.map((r) => [r.bucket, String(r.firings), ms(r.chainMedian), ms(r.chainP90), ms(r.callMedian), ms(r.callP90)]),
        [false, true, true, true, true, true],
      ),
    )
    out.push('chain = all steps of one firing summed. A cold/warm gap that stays wide is page cache;')
    out.push('a chain that is slow even in the warmest row has no headroom anywhere.')
  }

  return out.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `hook-timings.ts — cut Claude Code hook timings by COMMAND

  hook-timings.ts [--event NAME]... [--profile default|home|work|all] [--since SPEC] [--top N] [--json]

  --event NAME      SessionStart | UserPromptSubmit | PreToolUse | Stop | ...
                    repeatable; default: every event
  --profile WHICH   default (~/.claude) | home (~/.claude-home) |
                    work (~/.claude-work) | all   (default: all — read from
                    fixed paths, never from CLAUDE_CONFIG_DIR, which a
                    non-interactive caller does not have)
  --since SPEC      30d | 12h | 90m | 2026-08-01   (default: all history)
  --top N           rows in the timeout / slowest lists (default 10)
  --json            emit the whole cut as JSON instead of the report

Reads <profile>/projects/**/*.jsonl. Groups by the full command, because
hookName is the name of the EVENT and is shared by every step of the chain —
percentiles over the chain hide a permanently-slow step. See the header comment.

  hook-timings.ts --event SessionStart --since 7d
  hook-timings.ts --event PreToolUse --profile work --since 24h --top 20
`

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // strict:true so an unrecognised flag stops the run instead of being dropped
  // and having the tool report a window nobody asked for. The throw is caught
  // only to trade a stack trace for the usage text.
  let values: {
    event?: string[]
    profile?: string
    since?: string
    top?: string
    json?: boolean
    help?: boolean
  }
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        event: { type: 'string', multiple: true },
        profile: { type: 'string', default: 'all' },
        since: { type: 'string' },
        top: { type: 'string', default: '10' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  if (values.help) {
    process.stdout.write(USAGE)
    return
  }

  const which = values.profile as string
  if (which !== 'default' && which !== 'home' && which !== 'work' && which !== 'all') {
    process.stderr.write(`--profile: expected default | home | work | all, got ${JSON.stringify(which)}\n`)
    process.exitCode = 2
    return
  }
  const top = Number(values.top)
  if (!Number.isInteger(top) || top < 1) {
    process.stderr.write(`--top: expected a positive integer, got ${JSON.stringify(values.top)}\n`)
    process.exitCode = 2
    return
  }

  let since: number | null
  try {
    since = parseSince(values.since)
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exitCode = 2
    return
  }

  const events = values.event && values.event.length > 0 ? (values.event as string[]) : null
  const sc = scan({ which, since, events })

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          window: { since: since === null ? null : new Date(since).toISOString(), spec: values.since ?? null },
          profile: which,
          events,
          filesSeen: sc.filesSeen,
          filesRead: sc.filesRead,
          calls: sc.invocations.length,
          duplicatesDropped: sc.duplicates,
          byCommand: byCommand(sc.invocations),
          timeouts: sc.invocations
            .filter((i) => i.outcome === 'timeout')
            .map((i) => ({ ts: i.iso, ms: i.ms, timeoutMs: i.timeoutMs, event: i.event, command: i.command, profile: i.profile })),
          slowest: sc.invocations
            .filter((i) => i.outcome !== 'timeout')
            .sort((a, b) => b.ms - a.ms)
            .slice(0, top)
            .map((i) => ({ ts: i.iso, ms: i.ms, event: i.event, command: i.command, profile: i.profile })),
          warmth: Object.fromEntries(
            [...new Set(sc.invocations.map((i) => i.event))].sort().map((e) => [e, warmth(sc.invocations, e)]),
          ),
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  process.stdout.write(renderReport(sc, { since, sinceSpec: values.since, which, events, top }) + '\n')
}

/**
 * Compare REALPATHS: node resolves symlinks in import.meta.url, argv[1] keeps
 * the path as typed. A direct comparison turns a symlinked invocation into a
 * silent no-op that exits 0.
 */
function isEntryPoint(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) await main()
