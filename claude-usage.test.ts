import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownerOf, belongsToSession, priceFor, isPriced, extraPasses } from './claude-usage.ts';

/**
 * A transcript file's session is decided by the PATH, not the basename.
 *
 * A basename matcher (`sid.startsWith(filter)` against the file name) threw away
 * every agent-*.jsonl, because an agent's name does not start with the session
 * id. The failure is silent — an understated number looks like a normal counter —
 * and only a test on the matcher itself catches it: an end-to-end run prints a
 * plausible number either way.
 */

const SID = '7ed786b9-7ac7-46e6-bf64-f524281a347c';
const PROJ = '-Users-dev-myprojects-web-app';

test('main thread: <project>/<sid>.jsonl', () => {
  assert.deepEqual(ownerOf(`${PROJ}/${SID}.jsonl`), {
    project: PROJ,
    session: SID,
    main: true,
  });
});

test('a subagent lives under <sid>/subagents/ and belongs to its parent', () => {
  assert.deepEqual(ownerOf(`${PROJ}/${SID}/subagents/agent-af0919b54362a7355.jsonl`), {
    project: PROJ,
    session: SID,
    main: false,
  });
});

test('a workflow agent nests deeper and belongs to the same parent', () => {
  assert.deepEqual(
    ownerOf(`${PROJ}/${SID}/subagents/workflows/wf_9c44d138-26a/agent-a1d07487bbb7d7118.jsonl`),
    { project: PROJ, session: SID, main: false },
  );
});

test('main separates the main thread from agents — ctx counts only the former', () => {
  const main = ownerOf(`${PROJ}/${SID}.jsonl`);
  const sub = ownerOf(`${PROJ}/${SID}/subagents/agent-x.jsonl`);
  const wf = ownerOf(`${PROJ}/${SID}/subagents/workflows/wf_a/agent-y.jsonl`);
  assert.equal(main?.main, true);
  assert.equal(sub?.main, false);
  assert.equal(wf?.main, false);
});

test('another session sharing a prefix is not folded in', () => {
  // The ids differ only after the common prefix `7ed786b9-7ac7-46e6-bf64-`.
  const other = '7ed786b9-7ac7-46e6-bf64-000000000000';
  assert.equal(belongsToSession(`${PROJ}/${other}.jsonl`, SID), false);
  assert.equal(belongsToSession(`${PROJ}/${other}/subagents/agent-x.jsonl`, SID), false);
  // ...while the session's own files are, agent files included.
  assert.equal(belongsToSession(`${PROJ}/${SID}.jsonl`, SID), true);
  assert.equal(belongsToSession(`${PROJ}/${SID}/subagents/agent-x.jsonl`, SID), true);
});

test('with no filter, every file that has an owner belongs', () => {
  assert.equal(belongsToSession(`${PROJ}/${SID}/subagents/agent-x.jsonl`), true);
  assert.equal(belongsToSession('orphan.jsonl'), false);
});

test('non-transcripts and path fragments have no owner', () => {
  // .meta.json sits next to agent-*.jsonl; walk() does not return it, but the
  // matcher must still refuse to take anything without .jsonl for a main thread.
  assert.equal(ownerOf(`${PROJ}/${SID}.meta.json`), null);
  assert.equal(ownerOf(PROJ), null);
  assert.equal(ownerOf(''), null);
});

// --- pricing by model id ---------------------------------------------------
//
// Transcripts carry a dated id (`claude-haiku-4-5-20251001`); the table holds
// the family. Exact comparison missed, the record fell through to
// FALLBACK_PRICE and was counted at Opus rates: haiku came out five times too
// expensive. The failure is silent — the row looks like every other row.
//
// No assertion below is written in dollars: price lists get revised — on
// 2026-08-31 Sonnet 5's introductory price became permanent instead of the
// announced rise — and a golden number would turn such an edit into a red test.
// What is checked are the relations, which do not depend on the figures.

test('a dated id is priced by its family, not by the fallback', () => {
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), priceFor('claude-haiku-4-5'));
  assert.equal(isPriced('claude-haiku-4-5-20251001'), true);
  // Exactly the miss in question: haiku must not cost the same as Opus.
  assert.notDeepEqual(priceFor('claude-haiku-4-5-20251001'), priceFor('claude-opus-5'));
});

test('only the date suffix is normalised — a prefix match would be greedier and quieter', () => {
  // `claude-opus-5[1m]` (the 1M window) starts with a known key but costs more:
  // a greedy prefix match would price it at the ordinary rate SILENTLY. Better
  // that it admits to being unknown.
  assert.equal(isPriced('claude-opus-5[1m]'), false);
  // ...and conversely, the date is the only thing stripped: not `-2025`, not `-1001`.
  assert.equal(isPriced('claude-haiku-4-5-2025'), false);
  assert.equal(isPriced('claude-haiku-4-5-20251001-preview'), false);
});

test('an unknown model still gets a price, but stops calling itself known', () => {
  assert.equal(isPriced('claude-nonesuch-9'), false);
  assert.equal(isPriced('<synthetic>'), false);
  // There is still a price — counting it as zero would hide the spend entirely.
  assert.ok(priceFor('claude-nonesuch-9').input > 0);
});

// --- end-to-end run of the binary against a fake $HOME ----------------------
//
// The tool reads `<config dir>/projects` through `os.homedir()`, which on POSIX
// takes $HOME. So the entire input is substituted with one environment variable —
// the run is deterministic, without a single byte of live transcripts.
//
// The fixture's numbers are chosen so the cost can be worked out mentally, but no
// assertion is pinned to a dollar figure: PRICING gets revised, and a golden sum
// would turn a price update into a red test. What is checked is what does not
// depend on price — tokens, messages, the shape of the output — plus the JSON
// and the human table agreeing with each other.

const TOOL = fileURLToPath(new URL('./claude-usage.ts', import.meta.url));
const FIX_SID = '11111111-1111-4111-8111-111111111111';
const FIX_HOME = mkdtempSync(join(tmpdir(), 'claude-usage-fixture-'));
after(() => rmSync(FIX_HOME, { recursive: true, force: true }));

{
  const usage = (u: Record<string, number>) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { model: 'claude-opus-5', usage: u },
    }) + '\n';

  const homeProj = join(FIX_HOME, '.claude-home', 'projects', '-Users-dev-dotfiles');
  mkdirSync(join(homeProj, FIX_SID, 'subagents'), { recursive: true });
  // main thread: 1.34M tokens
  writeFileSync(
    join(homeProj, `${FIX_SID}.jsonl`),
    usage({
      input_tokens: 100_000,
      cache_creation_input_tokens: 200_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 40_000,
    }),
  );
  // a subagent of the same session: +0.12M, accumulating into the PARENT project's bucket
  writeFileSync(
    join(homeProj, FIX_SID, 'subagents', 'agent-aaa.jsonl'),
    usage({
      input_tokens: 0,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 0,
      output_tokens: 20_000,
    }),
  );
  // a second config directory, a second project: 5.85M
  const workProj = join(
    FIX_HOME, '.claude-work', 'projects', '-Users-dev-projects-api-service',
  );
  mkdirSync(workProj, { recursive: true });
  writeFileSync(
    join(workProj, '22222222-2222-4222-8222-222222222222.jsonl'),
    usage({
      input_tokens: 500_000,
      cache_creation_input_tokens: 250_000,
      cache_read_input_tokens: 5_000_000,
      output_tokens: 100_000,
    }),
  );
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', TOOL, ...args], {
    env: { ...process.env, HOME: FIX_HOME },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('--json prints a machine-readable total and nothing else', () => {
  const out = run(['24', '--json']);
  assert.equal(out.status, 0);
  const parsed = JSON.parse(out.stdout);
  assert.equal(typeof parsed.totalUsd, 'number');
  assert.equal(parsed.hours, 24);
  assert.ok(Array.isArray(parsed.rows));

  // No table, no headers, no ANSI, no progress lines: the consumer (a budget
  // gate) runs JSON.parse over the WHOLE of stdout.
  assert.equal(out.stdout.split('\n').filter((l) => l.length > 0).length, 1);
  assert.ok(!out.stdout.includes('\u001b['), 'stdout must carry no ANSI codes');
  assert.ok(out.stdout.endsWith('}\n'), 'exactly one object and a newline');
});

test('--json: rows cover both config dirs, agents attached to the parent project', () => {
  const parsed = JSON.parse(run(['24', '--json']).stdout);
  // The set of rows is compared in an order of our own: the real order is set by
  // cost, that is by price — pinning it here would break the test on a price edit.
  const byProject = parsed.rows
    .map((r: any) => [r.profile, r.project, r.messages, r.tokens])
    .sort((a: any, b: any) => (a[1] < b[1] ? -1 : 1));
  assert.deepEqual(byProject, [
    ['home', '-Users-dev-dotfiles', 2, 1_460_000],
    ['work', '-Users-dev-projects-api-service', 1, 5_850_000],
  ]);
  for (const r of parsed.rows) assert.equal(typeof r.usd, 'number');
  // ...and the output itself is sorted by descending cost, like the table.
  const usds = parsed.rows.map((r: any) => r.usd);
  assert.deepEqual(usds, [...usds].sort((a: number, b: number) => b - a));
});

test('--json works both AFTER a positional argument and before it', () => {
  // The trap: a flag placed after a positional is silently swallowed.
  const post = run(['24', '--json']);
  const pre = run(['--json', '24']);
  assert.equal(post.status, 0);
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, post.stdout);
  // ...and the hours are still read from the positional rather than pinned to the default
  assert.equal(JSON.parse(run(['--json', '1']).stdout).hours, 1);
  assert.equal(JSON.parse(run(['1', '--json']).stdout).hours, 1);
  assert.equal(JSON.parse(run(['--json']).stdout).hours, 24);
});

test('--json and the table report the same figure', () => {
  const parsed = JSON.parse(run(['24', '--json']).stdout);
  const table = run(['24']).stdout;
  const m = table.match(/TOTAL: (\d+) messages \| ([\d.]+)M tokens \| ~\$([\d.]+) /);
  assert.ok(m, `no TOTAL line in:\n${table}`);
  const sum = (f: (r: any) => number) => parsed.rows.reduce((a: number, r: any) => a + f(r), 0);
  assert.equal(sum((r) => r.messages), Number(m[1]));
  assert.equal((sum((r) => r.tokens) / 1_000_000).toFixed(2), m[2]);
  assert.equal(parsed.totalUsd.toFixed(2), m[3]);
  // totalUsd is the sum of UNROUNDED rows, so it differs from the sum of the
  // rounded ones by at most a cent per row.
  assert.ok(Math.abs(parsed.totalUsd - sum((r) => r.usd)) <= 0.01 * parsed.rows.length);
});

test('without --json the output stays a human table', () => {
  const out = run(['24']);
  assert.equal(out.status, 0);
  assert.throws(() => JSON.parse(out.stdout));
  assert.ok(out.stdout.includes('=== Spend over the last 24h (cache-write ×2) ==='));
  assert.ok(out.stdout.includes('TOTAL: 3 messages | 7.31M tokens |'));
  assert.ok(out.stdout.includes('Where the money goes (share of tokens → share of cost):'));
  assert.ok(out.stdout.includes('By model:'));
  // the status bar mode is untouched too: one line, `<tokens> ctx <N>k cache …`
  const bar = run(['--session', FIX_SID]);
  assert.match(bar.stdout, /^1\.46M ctx 1300k cache \d+ 3600\n$/);
});

// --- folding the records of one API call ------------------------------------
//
// The rule arrived here without a test: the main fixture writes one record per
// file, so it does not exercise the dedup path AT ALL. Found by mutation — a
// broken makeCallFolder left this file green. The rule is worth more than its
// implementation: it is what made the tool overstate by 2x for six weeks.

test('one API response spread over records counts as a single call', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-fold-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const proj = join(home, '.claude-home', 'projects', '-Users-dev-dotfiles');
  mkdirSync(proj, { recursive: true });

  // How Claude Code actually writes: one record per content block (thinking /
  // text / tool_use), each with a FULL copy of message.usage, and only output
  // growing across the group.
  const block = (out: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      requestId: 'req-single-call',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 100_000,
          output_tokens: out,
        },
      },
    }) + '\n';
  // The order is deliberately non-increasing: the fold takes the MAXIMUM over
  // the group rather than "the last record" — record order in the file is not
  // guaranteed.
  writeFileSync(
    join(proj, '66666666-6666-4666-8666-666666666666.jsonl'),
    block(100) + block(900) + block(400),
  );

  const j = JSON.parse(runIn(home, ['24', '--json']).stdout);
  assert.equal(j.rows.length, 1);
  // Three records, ONE call.
  assert.equal(j.rows[0].messages, 1);
  // Input counted once, output the group maximum: 1000+10000+100000+900.
  assert.equal(j.rows[0].tokens, 111_900);
});

test('distinct calls are not merged, even inside one file', () => {
  // The other side of it: the fold must cut on requestId, not on "similarity".
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-fold2-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const proj = join(home, '.claude-home', 'projects', '-Users-dev-dotfiles');
  mkdirSync(proj, { recursive: true });
  const one = (id: string | undefined) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      ...(id ? { requestId: id } : {}),
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0, cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1_000, output_tokens: 10,
        },
      },
    }) + '\n';
  // Two distinct calls plus a record with no key at all: the last counts as
  // unique — failing to fold a duplicate is cheaper than losing real spend.
  writeFileSync(
    join(proj, '77777777-7777-4777-8777-777777777777.jsonl'),
    one('a') + one('b') + one(undefined),
  );
  const j = JSON.parse(runIn(home, ['24', '--json']).stdout);
  assert.equal(j.rows[0].messages, 3);
  assert.equal(j.rows[0].tokens, 3 * 1_010);
});

test('the main fixture is fully priced — no stderr, no ⚠, no unpriced', () => {
  // A negative control for the tests below: while every model is known, none of
  // the three warning channels fires. Otherwise "a ⚠ appeared" proves nothing —
  // it might have been there all along.
  const out = run(['24']);
  assert.equal(out.stderr, '');
  assert.ok(!out.stdout.includes('⚠'));
  assert.deepEqual(JSON.parse(run(['24', '--json']).stdout).unpriced, []);
});

// --- a fallback price has to name itself ------------------------------------
//
// A separate $HOME on purpose: the main fixture pins `TOTAL: 3 messages` and
// `7.31M`, and mixing another model into it would break its own assertions.

function fixtureWith(model: string): string {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-price-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const proj = join(home, '.claude-home', 'projects', '-Users-dev-dotfiles');
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, '33333333-3333-4333-8333-333333333333.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        model,
        usage: {
          input_tokens: 100_000,
          cache_creation_input_tokens: 200_000,
          cache_read_input_tokens: 1_000_000,
          output_tokens: 40_000,
        },
      },
    }) + '\n',
  );
  return home;
}

function runIn(home: string, args: string[]) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', TOOL, ...args], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('dated haiku costs exactly what undated haiku costs, not what Opus costs', () => {
  // End-to-end check on identical tokens: these two figures can only diverge
  // through a miss on the price key.
  const dated = JSON.parse(runIn(fixtureWith('claude-haiku-4-5-20251001'), ['24', '--json']).stdout);
  const undated = JSON.parse(runIn(fixtureWith('claude-haiku-4-5'), ['24', '--json']).stdout);
  const opus = JSON.parse(runIn(fixtureWith('claude-opus-5'), ['24', '--json']).stdout);
  assert.equal(dated.totalUsd, undated.totalUsd);
  assert.ok(dated.totalUsd < opus.totalUsd, `haiku ${dated.totalUsd} should be cheaper than opus ${opus.totalUsd}`);
  assert.deepEqual(dated.unpriced, []);
});

test('an unknown model names itself in all three outputs', () => {
  const home = fixtureWith('claude-nonesuch-9');

  // 1. stderr — the only channel common to every mode: stdout carries either
  //    JSON or the status bar line.
  const table = runIn(home, ['24']);
  assert.match(table.stderr, /claude-nonesuch-9/);
  assert.match(table.stderr, /fallback/);
  // 2. ...and the mark stands in the table itself, next to the untrustworthy figure.
  assert.match(table.stdout, /claude-nonesuch-9\s+\$[\d.]+\s+⚠ fallback/);

  // 3. machine-readable — the gate sees that the figure is in question
  const json = runIn(home, ['24', '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.unpriced.length, 1);
  assert.equal(parsed.unpriced[0].model, 'claude-nonesuch-9');
  assert.ok(parsed.unpriced[0].usd > 0);
  // stdout stays exactly one object: the warning went to stderr
  assert.equal(json.stdout.split('\n').filter((l) => l.length > 0).length, 1);
  assert.match(json.stderr, /claude-nonesuch-9/);
});

test('<synthetic> stays quiet until it spends: warn about money, not about a key', () => {
  // A marker for a locally generated message with no API call behind it. In live
  // transcripts it always carries zero usage — 150 records in a week, zero
  // tokens — and complaining about it would train the reader to ignore noise.
  // But non-zero synthetic usage is the same silent ×5, so the warning turns
  // itself back on.
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-synth-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const proj = join(home, '.claude-home', 'projects', '-Users-dev-dotfiles');
  mkdirSync(proj, { recursive: true });
  const rec = (model: string, u: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model, usage: u } }) + '\n';
  writeFileSync(
    join(proj, '44444444-4444-4444-8444-444444444444.jsonl'),
    rec('claude-opus-5', { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }) +
      rec('<synthetic>', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
  );
  const quiet = runIn(home, ['24', '--json']);
  assert.deepEqual(JSON.parse(quiet.stdout).unpriced, []);
  assert.equal(quiet.stderr, '');

  // ...and with non-zero usage the same `<synthetic>` lands in the list at once
  const loud = runIn(fixtureWith('<synthetic>'), ['24', '--json']);
  assert.deepEqual(
    JSON.parse(loud.stdout).unpriced.map((u: any) => u.model),
    ['<synthetic>'],
  );
});

// --- extra sampling passes (usage.iterations) -------------------------------
//
// Top-level `usage` is the sum of `type: "message"` iterations and ONLY those.
// An advisor-model pass (and per the docs a compaction counts the same way) is
// not in it at all, though it is billed. Measured over 14 days: $281 of $6925 —
// 4.1% of the total — was invisible to the tool, and 75 of those 289 passes ran
// inside a sonnet thread, where the pass costs 2.5x the thread itself.
//
// No assertion below is written in dollars. The check has a different and
// stronger shape than a golden number: the fixture holds an ORDINARY opus-5 turn
// of exactly the same shape as the advisor pass, and the test demands they be
// EQUAL. That equality breaks on a model miss (counted as sonnet), on a lost
// pass, and on a doubled one — but survives any price revision.

type Tok = { input: number; cw: number; cr: number; out: number };

/** A usage object with a five-minute cache-write bucket, as in live records. */
const usageOfTok = (t: Tok, extra: Record<string, unknown> = {}) => ({
  input_tokens: t.input,
  cache_creation_input_tokens: t.cw,
  cache_read_input_tokens: t.cr,
  output_tokens: t.out,
  cache_creation: { ephemeral_5m_input_tokens: t.cw, ephemeral_1h_input_tokens: 0 },
  ...extra,
});

const assistantRec = (model: string, requestId: string, usage: Record<string, unknown>) => ({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  requestId,
  message: { model, usage },
});

/** The shape of an advisor pass: a large uncached input, its own sizeable output. */
const ADVISOR: Tok = { input: 70_000, cw: 0, cr: 0, out: 4_000 };
/** The shape of an ordinary thread turn: almost all input is a cache read. */
const THREAD: Tok = { input: 10, cw: 1_000, cr: 50_000, out: 300 };

const iterMsg = (t: Tok) => ({ type: 'message', ...usageOfTok(t) });
const iterAdvisor = (t: Tok, model = 'claude-opus-5') => ({
  type: 'advisor_message', model, ...usageOfTok(t),
});

function homeWith(files: { proj: string; sid: string; recs: object[] }[]): string {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-iter-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  for (const f of files) {
    const dir = join(home, '.claude-home', 'projects', f.proj);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${f.sid}.jsonl`), f.recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return home;
}

/** Dollars from a row of the "By model" table. The label is matched whole: */
/** `claude-opus-5` must not match `claude-opus-5 (advisor_message)`. */
function modelUsd(stdout: string, label: string): number {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = stdout.match(new RegExp('^\\s*' + esc + '\\s+\\$([0-9.]+)', 'm'));
  assert.ok(m, `no row "${label}" in the output:\n${stdout}`);
  return Number(m[1]);
}

const SID_A = '55555555-5555-4555-8555-555555555555';
const SID_B = '66666666-6666-4666-8666-666666666666';
const PROJ_A = '-Users-dev-dotfiles';
const PROJ_B = '-Users-dev-projects-api-service';

/** A sonnet thread with an advisor pass on opus + a reference opus turn of the same shape. */
function advisorFixture(threadRecs: object[]): string {
  return homeWith([
    { proj: PROJ_A, sid: SID_A, recs: threadRecs },
    { proj: PROJ_B, sid: SID_B, recs: [assistantRec('claude-opus-5', 'req-ref', usageOfTok(ADVISOR))] },
  ]);
}

test('an advisor pass is extracted with ITS OWN model, not the thread model', () => {
  const { extra, unknown } = extraPasses(
    usageOfTok(THREAD, { iterations: [iterMsg(THREAD), iterAdvisor(ADVISOR)] }),
    'claude-sonnet-5',
  );
  assert.equal(unknown, false);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].model, 'claude-opus-5', 'the pass has its own model, not the thread model');
  assert.equal(extra[0].kind, 'advisor_message');
  assert.equal(extra[0].input, ADVISOR.input);
  assert.equal(extra[0].output, ADVISOR.out);
});

test('a pass with no model of its own inherits the thread model rather than the fallback', () => {
  const { extra } = extraPasses(
    usageOfTok(THREAD, {
      iterations: [iterMsg(THREAD), { type: 'compaction', ...usageOfTok(ADVISOR) }],
    }),
    'claude-sonnet-5',
  );
  assert.equal(extra.length, 1);
  assert.equal(extra[0].model, 'claude-sonnet-5');
  assert.equal(extra[0].kind, 'compaction');
});

test('a single-iteration record yields no extra passes', () => {
  // 58 289 live records over 14 days — the top level matches iterations[0] byte
  // for byte, with zero exceptions. So "sum the iterations" adds nothing here.
  const { extra, unknown } = extraPasses(
    usageOfTok(THREAD, { iterations: [iterMsg(THREAD)] }),
    'claude-opus-5',
  );
  assert.deepEqual(extra, []);
  assert.equal(unknown, false);
});

test('a record with no iterations[] parses as before', () => {
  const { extra, unknown } = extraPasses(usageOfTok(THREAD), 'claude-opus-5');
  assert.deepEqual(extra, []);
  assert.equal(unknown, false);
});

test('an unreconciled top level is not parsed on a guess, it names itself', () => {
  // The live carrier is fallback_message: a different model answered than the one
  // requested, so "top == sum of message iterations" breaks by construction (2
  // records in 14 days). Guessing there is not allowed: part of the pass may
  // already be inside the top level.
  const { extra, unknown } = extraPasses(
    usageOfTok(THREAD, {
      iterations: [iterMsg({ input: 1, cw: 0, cr: 0, out: 1 }), iterAdvisor(ADVISOR)],
    }),
    'claude-opus-5',
  );
  assert.deepEqual(extra, [], 'nothing is taken from a shape we do not recognise');
  assert.equal(unknown, true, 'but we do not stay silent about it either');
});

test('an advisor pass costs what the SAME turn of its own model costs, not a thread turn', () => {
  const out = runIn(
    advisorFixture([
      assistantRec('claude-sonnet-5', 'req-a', usageOfTok(THREAD, {
        iterations: [iterMsg(THREAD), iterAdvisor(ADVISOR)],
      })),
    ]),
    ['24'],
  );
  const advisor = modelUsd(out.stdout, 'claude-opus-5 (advisor_message)');
  const reference = modelUsd(out.stdout, 'claude-opus-5');
  assert.ok(advisor > 0, 'the pass has to cost something at all');
  assert.equal(advisor, reference, 'the pass is priced as opus — like a reference opus turn of the same shape');
  // And it is a row of its own, not a term inside the thread's row: dissolved
  // into it, it would become invisible in exactly the way top-level usage hid it.
  assert.match(out.stdout, /claude-sonnet-5\s+\$/);
});

test('an extra pass is credited once, even when the call is spread over records', () => {
  // One API response is written as several records, each with a FULL copy of
  // usage. Taking the pass from every one of them would triple it — the same way
  // the tool once doubled the whole total.
  const grown: Tok = { ...THREAD, out: 900 };
  const out = runIn(
    advisorFixture([
      assistantRec('claude-sonnet-5', 'req-a', usageOfTok(THREAD, {
        iterations: [iterMsg(THREAD), iterAdvisor(ADVISOR)],
      })),
      assistantRec('claude-sonnet-5', 'req-a', usageOfTok(grown, {
        iterations: [iterMsg(grown), iterAdvisor(ADVISOR)],
      })),
    ]),
    ['24'],
  );
  assert.equal(
    modelUsd(out.stdout, 'claude-opus-5 (advisor_message)'),
    modelUsd(out.stdout, 'claude-opus-5'),
  );
});

test('a pass that appears after the call\'s first record is still credited', () => {
  // While the advisor has not finished, its iteration is not in the array yet.
  // Taking extras only from the call's first record would lose exactly these
  // passes — silently, because the remaining records fold as "output grew".
  const grown: Tok = { ...THREAD, out: 900 };
  const out = runIn(
    advisorFixture([
      assistantRec('claude-sonnet-5', 'req-a', usageOfTok(THREAD, {
        iterations: [iterMsg(THREAD)],
      })),
      assistantRec('claude-sonnet-5', 'req-a', usageOfTok(grown, {
        iterations: [iterMsg(grown), iterAdvisor(ADVISOR)],
      })),
    ]),
    ['24'],
  );
  assert.equal(
    modelUsd(out.stdout, 'claude-opus-5 (advisor_message)'),
    modelUsd(out.stdout, 'claude-opus-5'),
  );
});

test('an advisor pass does not pass itself off as a separate API call', () => {
  // The "msgs" counter counts calls, and a pass is part of a call, not a new one.
  const json = JSON.parse(
    runIn(
      advisorFixture([
        assistantRec('claude-sonnet-5', 'req-a', usageOfTok(THREAD, {
          iterations: [iterMsg(THREAD), iterAdvisor(ADVISOR)],
        })),
      ]),
      ['24', '--json'],
    ).stdout,
  );
  const thread = json.rows.find((r: any) => r.project === PROJ_A);
  assert.equal(thread.messages, 1, 'one call, though it contains two passes');
  assert.equal(json.unknownIterationShape, 0);
});

test('a record with an unrecognised iterations shape is counted out loud, not understated in silence', () => {
  const out = runIn(
    homeWith([
      {
        proj: PROJ_A,
        sid: SID_A,
        recs: [
          assistantRec('claude-opus-5', 'req-u', usageOfTok(THREAD, {
            iterations: [iterMsg({ input: 1, cw: 0, cr: 0, out: 1 }), iterAdvisor(ADVISOR)],
          })),
        ],
      },
    ]),
    ['24'],
  );
  assert.match(out.stderr, /iterations/, 'an unrecognised shape is reported on stderr');
  assert.doesNotMatch(out.stdout, /advisor_message/, 'and nothing from it is counted');
  const json = JSON.parse(runIn(
    homeWith([
      {
        proj: PROJ_A,
        sid: SID_A,
        recs: [
          assistantRec('claude-opus-5', 'req-u', usageOfTok(THREAD, {
            iterations: [iterMsg({ input: 1, cw: 0, cr: 0, out: 1 }), iterAdvisor(ADVISOR)],
          })),
        ],
      },
    ]),
    ['24', '--json'],
  ).stdout);
  assert.ok(json.unknownIterationShape > 0, 'and the gate sees it in JSON, not just a human');
});

// --- fast mode --------------------------------------------------------------
//
// `/fast` is the only premium reachable from here by a single keystroke, and it
// is a doubling. The signal is in the response (`usage.speed`), so a miss would
// not be "nothing to tell them apart by" but "there was, and we did not look".
// Over 14 days fast never occurred — these tests are the only thing keeping the
// branch alive.

test('fast takes the premium price only on models that support it', () => {
  assert.ok(
    priceFor('claude-opus-5', true).input > priceFor('claude-opus-5').input,
    'on Opus 5, fast costs more than standard',
  );
  assert.ok(priceFor('claude-opus-4-8', true).output > priceFor('claude-opus-4-8').output);
  // Opus 4.6 cannot do fast — it serves the request at the normal price; Sonnet
  // does not support it either.
  assert.deepEqual(priceFor('claude-opus-4-6', true), priceFor('claude-opus-4-6'));
  assert.deepEqual(priceFor('claude-sonnet-5', true), priceFor('claude-sonnet-5'));
  // The default is the ordinary price: no existing priceFor call changed behaviour.
  assert.deepEqual(priceFor('claude-opus-5'), priceFor('claude-opus-5', false));
});

test('fast on a dated id loses neither the premium nor the family', () => {
  assert.deepEqual(priceFor('claude-opus-5-20260101', true), priceFor('claude-opus-5', true));
  assert.equal(isPriced('claude-opus-5-20260101'), true);
});

test('a fast turn costs more than the same standard one and says so in the table', () => {
  const rec = (speed: string, sid: string) =>
    homeWith([{
      proj: PROJ_A,
      sid,
      recs: [assistantRec('claude-opus-5', 'req-f', usageOfTok(ADVISOR, { speed }))],
    }]);
  const fast = runIn(rec('fast', SID_A), ['24']);
  const std = runIn(rec('standard', SID_B), ['24']);
  assert.ok(
    modelUsd(fast.stdout, 'claude-opus-5 ⚡fast') > modelUsd(std.stdout, 'claude-opus-5'),
    'the same turn in fast mode must cost more',
  );
});
