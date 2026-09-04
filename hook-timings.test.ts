import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assignLabels,
  byCommand,
  parseHookLine,
  parseSince,
  profileRoots,
  quantile,
  renderReport,
  scan,
  shortenCommand,
  warmth,
} from './hook-timings.ts'

const HOME = '/Users/x'

// ---------------------------------------------------------------------------
// --since
// ---------------------------------------------------------------------------

test('--since takes relative and absolute forms', () => {
  const now = Date.parse('2026-08-21T12:00:00Z')
  assert.equal(parseSince(undefined, now), null, 'no flag means no lower bound')
  assert.equal(parseSince('90m', now), Date.parse('2026-08-21T10:30:00Z'))
  assert.equal(parseSince('12h', now), Date.parse('2026-08-21T00:00:00Z'))
  assert.equal(parseSince('30d', now), Date.parse('2026-07-22T12:00:00Z'))
  assert.equal(parseSince('2w', now), Date.parse('2026-08-07T12:00:00Z'))
  assert.equal(parseSince('2026-08-01', now), Date.parse('2026-08-01'))
})

test('--since rejects garbage instead of silently scanning all of history', () => {
  // A window that quietly widens to "everything" is the failure mode that
  // makes a post-fix measurement show the pre-fix numbers.
  assert.throws(() => parseSince('yesterday'), /--since/)
  assert.throws(() => parseSince('30'), /--since/)
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('a label collapses the known prefixes and drops the shell tail', () => {
  assert.equal(shortenCommand('$HOME/dotfiles/claude/bin/top-cwds.ts', HOME), '~bin/top-cwds.ts')
  assert.equal(
    shortenCommand("$HOME/dotfiles/claude/bin/sync-settings.ts --check 2>&1 | grep -v '^  ok' || true", HOME),
    '~bin/sync-settings.ts --check',
  )
  assert.equal(shortenCommand('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh', HOME), '~plug/hooks/session-start.sh')
  assert.equal(
    shortenCommand('node "${CLAUDE_PLUGIN_ROOT}/hooks/inject-claude-md.mjs"', HOME),
    'node ~plug/hooks/inject-claude-md.mjs',
  )
  assert.equal(
    shortenCommand('node "$CLAUDE_PROJECT_DIR/.claude/hooks/default_branch_check.mjs"', HOME),
    'node ~proj/.claude/hooks/default_branch_check.mjs',
  )
  assert.equal(shortenCommand('$HOME/dotfiles/claude/bin/link-shared-memory.sh >/dev/null', HOME), '~bin/link-shared-memory.sh')
  assert.equal(shortenCommand('/Users/x/.claude-home/scripts/prime-cache.py', HOME), '~/.claude-home/scripts/prime-cache.py')
})

test('shortening never empties a label', () => {
  // `|| true` alone is a whole command in principle; a blank row would be
  // unreadable, so the raw text stands in.
  assert.equal(shortenCommand('|| true', HOME), '|| true')
})

test('two commands that shorten alike stay two rows', () => {
  // The invariant the whole tool rests on. Merging them would recreate exactly
  // the averaging bug that per-command grouping exists to expose.
  const a = "$HOME/dotfiles/claude/bin/sync-mcp.ts --check 2>&1 | grep -v '^  ok' || true"
  const b = "python3 $HOME/dotfiles/claude/bin/sync-mcp.ts --check 2>&1 | grep -v '^  ok' || true"
  const c = '$HOME/dotfiles/claude/bin/sync-mcp.ts --check >/dev/null'
  const { labels, collisions } = assignLabels([a, b, c], HOME)
  assert.equal(labels.get(b), 'python3 ~bin/sync-mcp.ts --check', 'a different binary is a different label already')
  assert.notEqual(labels.get(a), labels.get(c), 'same short form, so they must be disambiguated')
  assert.equal(new Set([labels.get(a), labels.get(b), labels.get(c)]).size, 3)
  assert.deepEqual(collisions, ['~bin/sync-mcp.ts --check'], 'the report has to be able to say which ones were split')
})

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

test('percentiles are nearest-rank, and p50 uses the same method as p90', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(quantile(xs, 0.5), 5)
  assert.equal(quantile(xs, 0.9), 9)
  assert.equal(quantile(xs, 0.99), 10)
  assert.equal(quantile([42], 0.9), 42, 'a single sample is its own p90')
  assert.ok(Number.isNaN(quantile([], 0.5)))
})

// ---------------------------------------------------------------------------
// Parsing a transcript line
// ---------------------------------------------------------------------------

function line(attachment: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'attachment',
    uuid: 'u-1',
    timestamp: '2026-08-19T09:00:00.000Z',
    attachment,
    ...extra,
  })
}

test('a hook call is read out of the attachment, whatever its outcome', () => {
  const ok = parseHookLine(
    line({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', toolUseID: 't1', command: 'x.ts', durationMs: 120, exitCode: 0 }),
    'home',
  )
  assert.equal(ok?.ms, 120)
  assert.equal(ok?.outcome, 'ok')
  assert.equal(ok?.event, 'SessionStart')
  assert.equal(ok?.firing, 't1')

  const killed = parseHookLine(
    line({ type: 'hook_cancelled', hookEvent: 'SessionStart', toolUseID: 't1', command: 'slow.ts', durationMs: 5105, timedOut: true, timeoutMs: 5000 }),
    'home',
  )
  assert.equal(killed?.outcome, 'timeout')
  assert.equal(killed?.timeoutMs, 5000)

  const failed = parseHookLine(
    line({ type: 'hook_non_blocking_error', hookEvent: 'PreToolUse', toolUseID: 't2', command: 'bad.ts', durationMs: 12, exitCode: 1 }),
    'home',
  )
  assert.equal(failed?.outcome, 'error')
})

test('attachments that are not calls are skipped', () => {
  // The same chain emits these; counting them would inflate n with zero-cost rows.
  assert.equal(parseHookLine(line({ type: 'hook_additional_context', hookEvent: 'SessionStart', content: ['...'] }), 'home'), null)
  assert.equal(parseHookLine(line({ type: 'hook_system_message', hookEvent: 'SessionStart', content: 'hi' }), 'home'), null)
  assert.equal(parseHookLine(line({ type: 'text', text: 'hello' }), 'home'), null)
  assert.equal(parseHookLine('not json at all', 'home'), null)
  assert.equal(parseHookLine('{"attachment":{"type":"hook_success","command":"x"}}', 'home'), null, 'no durationMs means no measurement')
})

test('a line with no uuid falls back to toolUseID+command', () => {
  const inv = parseHookLine(
    JSON.stringify({ timestamp: '2026-08-19T09:00:00.000Z', attachment: { type: 'hook_success', hookEvent: 'SessionStart', toolUseID: 't9', command: 'x.ts', durationMs: 3 } }),
    'home',
  )
  assert.equal(inv?.uuid, 't9|x.ts')
})

// ---------------------------------------------------------------------------
// The cut itself
// ---------------------------------------------------------------------------

function inv(command: string, ms: number, over: Partial<ReturnType<typeof parseHookLine> & object> = {}) {
  return {
    uuid: `${command}-${ms}-${Math.round(ms * 7)}`,
    ts: Date.parse('2026-08-19T09:00:00Z'),
    iso: '2026-08-19T09:00:00.000Z',
    event: 'SessionStart',
    hookName: 'SessionStart:startup',
    firing: 'f1',
    command,
    ms,
    outcome: 'ok' as const,
    profile: 'home' as const,
    ...over,
  }
}

test('one permanently-slow step is not hidden by the seven healthy ones', () => {
  // The finding, reduced to a fixture: eight steps under ONE hookName. The
  // chain-wide median reads healthy; the per-command cut names the culprit.
  const calls = []
  for (let i = 0; i < 20; i++) {
    calls.push(inv('$HOME/dotfiles/claude/bin/top-cwds.ts', 2300 + i, { uuid: `slow-${i}` }))
    for (const step of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']) {
      calls.push(inv(step, 100 + i, { uuid: `${step}-${i}` }))
    }
  }
  const all = calls.map((c) => c.ms).sort((x, y) => x - y)
  assert.ok(quantile(all, 0.5) < 200, 'the chain-wide median looks healthy, which is the trap')

  const stats = byCommand(calls, HOME)
  assert.equal(stats.length, 8, 'eight commands, not one hookName')
  assert.equal(stats[0].label, '~bin/top-cwds.ts', 'sorted by p90, the slow step comes first')
  assert.ok(stats[0].median > 2000, `the culprit keeps its own median, got ${stats[0].median}`)
  assert.ok(stats[1].median < 200)
})

test('timeouts and errors are counted per command, not per event', () => {
  const stats = byCommand(
    [
      inv('slow.ts', 5105, { uuid: 'a', outcome: 'timeout' as const }),
      inv('slow.ts', 5040, { uuid: 'b', outcome: 'timeout' as const }),
      inv('slow.ts', 900, { uuid: 'c' }),
      inv('fine.ts', 90, { uuid: 'd' }),
      inv('fine.ts', 91, { uuid: 'e', outcome: 'error' as const }),
    ],
    HOME,
  )
  const slow = stats.find((s) => s.label === 'slow.ts')!
  const fine = stats.find((s) => s.label === 'fine.ts')!
  assert.equal(slow.timeouts, 2)
  assert.equal(slow.n, 3)
  assert.equal(fine.timeouts, 0)
  assert.equal(fine.errors, 1)
})

// ---------------------------------------------------------------------------
// Warmth
// ---------------------------------------------------------------------------

test('warmth buckets on the gap between FIRINGS, not between steps', () => {
  // Steps inside one firing are milliseconds apart; bucketing per call would
  // drop every one of them into `<1m` and measure nothing.
  const t0 = Date.parse('2026-08-19T09:00:00Z')
  const at = (firing: string, offsetMs: number, ms: number, i: number) =>
    inv('step.ts', ms, { uuid: `${firing}-${i}`, firing, ts: t0 + offsetMs })

  const calls = [
    at('f1', 0, 500, 1),
    at('f1', 5, 500, 2),
    at('f2', 30_000, 400, 1), // 30s later -> warm
    at('f2', 30_005, 400, 2),
    at('f3', 30_000 + 7_200_000, 3000, 1), // 2h later -> cold
    at('f3', 30_005 + 7_200_000, 3000, 2),
  ]
  const rows = warmth(calls, 'SessionStart')
  const warm = rows.find((r) => r.bucket === '<1m')!
  const cold = rows.find((r) => r.bucket === '>1h')!
  assert.equal(warm.firings, 1)
  assert.equal(warm.chainMedian, 800, 'two 400ms steps in one firing sum to the chain cost')
  assert.equal(warm.callMedian, 400)
  assert.equal(cold.chainMedian, 6000)
  assert.equal(rows.find((r) => r.bucket === '1m–10m'), undefined, 'empty buckets are not printed')
})

test('warmth only looks at the event it was asked for', () => {
  const t0 = Date.parse('2026-08-19T09:00:00Z')
  const calls = [
    inv('a.ts', 100, { uuid: '1', firing: 'f1', ts: t0, event: 'SessionStart' }),
    inv('b.ts', 900, { uuid: '2', firing: 'f2', ts: t0 + 1000, event: 'PreToolUse' }),
    inv('a.ts', 200, { uuid: '3', firing: 'f3', ts: t0 + 2000, event: 'SessionStart' }),
  ]
  const rows = warmth(calls, 'SessionStart')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chainMedian, 200, 'the PreToolUse firing in between is not a SessionStart chain')
})

// ---------------------------------------------------------------------------
// Scanning real transcript trees
// ---------------------------------------------------------------------------

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'hook-timings-'))
  const write = (profile: string, project: string, file: string, rows: string[]) => {
    const dir = join(home, profile, 'projects', project)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), rows.join('\n') + '\n')
  }
  const call = (uuid: string, iso: string, event: string, firing: string, command: string, ms: number, extra = {}) =>
    JSON.stringify({
      type: 'attachment',
      uuid,
      timestamp: iso,
      attachment: { type: 'hook_success', hookName: `${event}:startup`, hookEvent: event, toolUseID: firing, command, durationMs: ms, exitCode: 0, ...extra },
    })

  write('.claude-home', '-Users-x-dotfiles', 'sess-a.jsonl', [
    call('u1', '2026-08-19T09:00:00.000Z', 'SessionStart', 'f1', '$HOME/dotfiles/claude/bin/top-cwds.ts', 2400),
    call('u2', '2026-08-19T09:00:00.100Z', 'SessionStart', 'f1', '$HOME/dotfiles/claude/bin/finding.ts digest', 300),
    '',
    'garbage that is not json',
    JSON.stringify({ type: 'attachment', uuid: 'u3', timestamp: '2026-08-19T09:00:01.000Z', attachment: { type: 'hook_additional_context', hookEvent: 'SessionStart', content: ['x'] } }),
  ])
  // The SAME two calls again: a resumed session copies the lines verbatim,
  // uuid included. Without dedup, top-cwds would report n=2 for one run.
  write('.claude-home', '-Users-x-dotfiles', 'sess-a-resumed.jsonl', [
    call('u1', '2026-08-19T09:00:00.000Z', 'SessionStart', 'f1', '$HOME/dotfiles/claude/bin/top-cwds.ts', 2400),
    call('u2', '2026-08-19T09:00:00.100Z', 'SessionStart', 'f1', '$HOME/dotfiles/claude/bin/finding.ts digest', 300),
    call('u4', '2026-08-21T10:00:00.000Z', 'PreToolUse', 'f2', '$HOME/dotfiles/claude/bin/env-watch.ts', 40),
  ])
  write('.claude-work', '-Users-x-projects-api-service', 'sess-b.jsonl', [
    call('u5', '2026-08-20T09:00:00.000Z', 'SessionStart', 'f3', '$HOME/dotfiles/claude/bin/top-cwds.ts', 5105, {
      type: 'hook_cancelled',
      timedOut: true,
      timeoutMs: 5000,
    }),
  ])
  return home
}

test('the same call in two transcripts is counted once', () => {
  const home = fixture()
  const sc = scan({ which: 'all', since: null, events: null, home })
  assert.equal(sc.duplicates, 2, 'both copied lines are recognised as copies')
  assert.equal(sc.invocations.length, 4)
  const top = byCommand(sc.invocations, HOME).find((s) => s.label === '~bin/top-cwds.ts')!
  assert.equal(top.n, 2, 'one home run + one work run, not three')
  assert.equal(top.timeouts, 1)
})

test('--profile selects among fixed paths and never reads CLAUDE_CONFIG_DIR', () => {
  const home = fixture()
  assert.deepEqual(
    profileRoots('all', home).map((p) => p.profile),
    ['default', 'home', 'work'],
  )
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = '/nonexistent/.claude'
  try {
    // A non-interactive caller has no CLAUDE_CONFIG_DIR at all; deriving the
    // root from it would report "0 hook calls" — clean, believable, wrong.
    assert.equal(scan({ which: 'home', since: null, events: null, home }).invocations.length, 3)
    assert.equal(scan({ which: 'work', since: null, events: null, home }).invocations.length, 1)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
})

test('--event and --since narrow the population', () => {
  const home = fixture()
  const ss = scan({ which: 'all', since: null, events: ['SessionStart'], home })
  assert.equal(ss.invocations.length, 3)
  assert.ok(ss.invocations.every((i) => i.event === 'SessionStart'))

  const recent = scan({ which: 'all', since: Date.parse('2026-08-20T00:00:00Z'), events: null, home })
  assert.deepEqual(
    recent.invocations.map((i) => i.uuid).sort(),
    ['u4', 'u5'],
    'the 19.08 calls are outside the window',
  )
})

test('an empty window says so in words instead of printing a clean table', () => {
  const home = fixture()
  const sc = scan({ which: 'all', since: Date.parse('2027-01-01T00:00:00Z'), events: null, home })
  assert.equal(sc.invocations.length, 0)
  const report = renderReport(sc, { since: Date.parse('2027-01-01T00:00:00Z'), sinceSpec: '2027-01-01', which: 'all', events: null, top: 10, home: HOME })
  assert.match(report, /NOTHING TO REPORT/)
  assert.match(report, /absence of data, not a clean bill of health/)
})

test('the report names the culprit and its timeouts', () => {
  const home = fixture()
  const sc = scan({ which: 'all', since: null, events: ['SessionStart'], home })
  const report = renderReport(sc, { since: null, which: 'all', events: ['SessionStart'], top: 10, home: HOME })
  assert.match(report, /BY COMMAND \(sorted by p90\)/)
  assert.match(report, /~bin\/top-cwds\.ts/)
  assert.match(report, /TIMEOUTS \(1\)/)
  assert.match(report, /2026-08-20/, 'a timeout is listed with its timestamp')
  assert.match(report, /SLOWEST CALLS THAT DID NOT TIME OUT/)
})
