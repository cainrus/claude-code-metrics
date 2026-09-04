#!/usr/bin/env -S node --experimental-strip-types
//
// claude-usage.ts — Claude Code token spend, read out of the local transcripts.
//
// No router and no proxy are needed for this: Claude Code writes the full
// `usage` object into every transcript message (<config dir>/projects/**/*.jsonl).
// Read every config directory, weight by Anthropic's price list, and show what
// is actually burning the limit.
//
// The numbers are the API list-price EQUIVALENT, not a bill: on a Max/Pro
// subscription Anthropic meters the limit by its own formula. This is a ranking
// tool ("what costs more"), not billing.
//
//   claude-usage.ts [hours]            summary by project + model
//   claude-usage.ts [hours] --sessions broken down by session
//   claude-usage.ts --session <id>     one session (for a status bar)
//   claude-usage.ts --cache-ttl 5m     fallback cache-write multiplier for old
//                                      records with no usage.cache_creation
//                                      (default 1h = 2x)
//   claude-usage.ts [hours] --json     exactly one JSON object on stdout (for gates)
//
import { readdirSync, statSync, createReadStream, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Anthropic price list, $/1M tokens, checked against the docs on 2026-08-31.
// cacheRead = 0.1x input; cacheWrite = 1.25x (5-minute TTL) or 2x (1-hour TTL).
// The response names its own bucket (usage.cache_creation), so the multiplier
// comes from the data rather than from a default — see cacheWriteWeight().
//
// PROMPT SIZE DOES NOT AFFECT THE RATE. Models from 4.6 on serve the full 1M
// window at the standard price ("Long context pricing": a 900k request is
// billed at the same rate as a 9k one). It is stated here because the opposite
// is plausible enough to have already cost one investigation: over 14 days,
// 38 103 of 126 307 turns ran with a prompt above 200k, peaking at 976k, and the
// model id carries no window tier — but there is no point looking for that
// signal, because there is no premium behind it.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  // Sonnet 5: $2/$10 was announced as an introductory price until 2026-08-31 —
  // from that date it is the standard one; there is no rise to $3/$15 coming
  // (docs, note under the table).
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const FALLBACK_PRICE = { input: 5, output: 25 };

/**
 * Fast mode (`/fast`) is the ONLY premium reachable from here by a single
 * keystroke, and it is a doubling: Opus 5 / 4.8 run at $10/$50 instead of
 * $5/$25 across the whole window. The signal is in the response itself —
 * `usage.speed === 'fast'`.
 *
 * A table rather than a ×2 multiplier: matching a doubling is a property of
 * today's price list, not a rule. A separate table also answers "what about a
 * model that cannot do fast" by itself: Opus 4.7 errors on such a request and
 * Opus 4.6 serves it at the normal price — neither is listed here, and both
 * honestly fall through to PRICING.
 *
 * Measured on 2026-08-31 over 14 days: 110 205 turns with `speed: "standard"`,
 * zero with `fast`. So today this branch changes no number; it is here so that
 * the first turn taken with /fast on does not silently halve the report.
 */
const FAST_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 },
};

/**
 * Price for a model id as it appears in the transcript.
 *
 * A transcript carries a DATED id (`claude-haiku-4-5-20251001`) while the table
 * holds the family, so exact comparison missed and the record fell silently
 * through to FALLBACK_PRICE — that is, it was priced as Opus: haiku came out
 * FIVE TIMES too expensive ($5/$25 instead of $1/$5). The absolute sum is small,
 * which is why it did not stand out, but the decision to move mechanical work
 * onto a cheap model rests precisely on the "what would this have cost on
 * haiku" comparison — so the tool was systematically understating the gain from
 * moving it.
 *
 * The normalisation strips EXACTLY the date suffix (`-YYYYMMDD` at the end) —
 * Anthropic's own id convention — and not an arbitrary prefix. A greedy prefix
 * match would be worse than a miss: it would silently hand a family's price to
 * ANY id that happens to start with it. Anything that does not match falls
 * through to the fallback and says so — see the unpriced reporting below.
 *
 * `fast` is not a property of the model but a mode of the request
 * (`usage.speed`), so it is an argument rather than a separate table key: the
 * transcript id is identical for a fast turn and a normal one.
 */
export function priceFor(model: string, fast = false): { input: number; output: number } {
  const key = model in PRICING || model in FAST_PRICING ? model : model.replace(/-\d{8}$/, '');
  if (fast && FAST_PRICING[key]) return FAST_PRICING[key];
  return PRICING[model] ?? PRICING[key] ?? FALLBACK_PRICE;
}

/** Whether the model was found in the price list, or priced from the fallback. */
export function isPriced(model: string): boolean {
  return model in PRICING || model.replace(/-\d{8}$/, '') in PRICING;
}

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const valueOf = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const CACHE_WRITE_1H = 2;
const CACHE_WRITE_5M = 1.25;
// Fallback multiplier: applied only to records that did not name their bucket.
const cacheWriteMult = valueOf('--cache-ttl') === '5m' ? CACHE_WRITE_5M : CACHE_WRITE_1H;

const sessionFilter = valueOf('--session');
const bySessions = has('--sessions');
const hours = Number(argv.find((a) => /^\d+$/.test(a)) ?? 24);
const since = sessionFilter ? 0 : Date.now() - hours * 3600_000;

/**
 * How many input-prices this response's cache-write is worth.
 *
 * A flat ×2 lied: the hour bucket is not the only one. Around 19% of cache-write
 * goes to the five-minute bucket (×1.25), and in one config directory the share
 * reached 30–46%, which puts the actual blended multiplier near 1.86 rather than
 * 2. There is nothing to guess: the response names the bucket itself —
 * `usage.cache_creation` holds `ephemeral_1h_input_tokens` and
 * `ephemeral_5m_input_tokens` separately. Older records do not carry that field,
 * and for those the flat path remains (`--cache-ttl`).
 */
function cacheWriteWeight(u: any): number {
  const flat = (u.cache_creation_input_tokens ?? 0) * cacheWriteMult;
  const cc = u.cache_creation;
  if (!cc) return flat;
  const h1 = cc.ephemeral_1h_input_tokens ?? 0;
  const m5 = cc.ephemeral_5m_input_tokens ?? 0;
  // The field is present but both buckets are empty while
  // cache_creation_input_tokens is non-zero — inconsistent data; take the flat
  // path rather than a silent zero.
  if (h1 === 0 && m5 === 0) return flat;
  return h1 * CACHE_WRITE_1H + m5 * CACHE_WRITE_5M;
}

// Config directories are FIXED paths, never CLAUDE_CONFIG_DIR: a non-interactive
// caller (launchd, cron, an execFile from another tool) gets no shell profile,
// so the variable is unset and a raw binary reads an empty ~/.claude. Deriving
// the scan root from it would report a clean, believable, wrong $0.00.
//
// `default` is the stock install; the other two are the convention for running
// separate configurations out of one account. Scanning a directory that does
// not exist costs nothing, and omitting one silently halves the total.
const PROFILES = [
  { name: 'default', dir: join(homedir(), '.claude', 'projects') },
  { name: 'home', dir: join(homedir(), '.claude-home', 'projects') },
  { name: 'work', dir: join(homedir(), '.claude-work', 'projects') },
];

type Bucket = {
  profile: string;
  project: string;
  session: string;
  model: string;
  /** Empty for an ordinary turn. Otherwise the `usage.iterations[].type` of an extra pass. */
  kind: string;
  /** Premium mode (`/fast`): priced from FAST_PRICING. */
  fast: boolean;
  input: number;
  cacheWrite: number;
  /** cache-write already weighted by bucket: one unit is a token at the input price. */
  cacheWriteWeighted: number;
  cacheRead: number;
  output: number;
  /** API calls, NOT JSONL records: one response is written as several records. */
  msgs: number;
};

const zero = (o: Partial<Bucket>): Bucket => ({
  profile: '', project: '', session: '', model: '', kind: '', fast: false,
  input: 0, cacheWrite: 0, cacheWriteWeighted: 0, cacheRead: 0, output: 0, msgs: 0, ...o,
});

/** How a row names itself in the "By model" table. */
const modelLabel = (r: Pick<Bucket, 'model' | 'kind' | 'fast'>) =>
  r.model + (r.kind ? ` (${r.kind})` : '') + (r.fast ? ' ⚡fast' : '');

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Who a transcript file belongs to. `rel` is the path RELATIVE to the config
 * directory's `projects` root.
 *
 * On-disk layout (verified 2026-08-10):
 *
 *   <project>/<sid>.jsonl                        — the main thread
 *   <project>/<sid>/subagents/agent-<id>.jsonl   — subagents
 *   <project>/<sid>/subagents/workflows/wf_<id>/agent-<id>.jsonl — workflows
 *
 * Hence the rule: ownership comes from the PATH, not the basename. A basename
 * filter (`agent-af09….startsWith(sid) === false`) discarded every agent
 * wholesale — and a status bar in a session with parallel agents then
 * understated spend silently: in one measured session it showed 46.5M out of an
 * actual 125.9M.
 *
 * `main` separates the main thread because ctx is the size of the PARENT's
 * prompt. A subagent's context lives and dies inside its own call and is not
 * carried into the next step of the main thread, so it must not be substituted
 * into ctx.
 */
export function ownerOf(rel: string): { project: string; session: string; main: boolean } | null {
  const parts = rel.split('/');
  if (parts.length < 2) return null;
  const [project, second] = parts;
  if (parts.length === 2) {
    if (!second.endsWith('.jsonl')) return null;
    return { project, session: basename(second, '.jsonl'), main: true };
  }
  return { project, session: second, main: false };
}

/** A session's file, if its id starts with the filter (an empty filter means all). */
export function belongsToSession(rel: string, filter?: string): boolean {
  const owner = ownerOf(rel);
  if (!owner) return false;
  return !filter || owner.session.startsWith(filter);
}

/** An extra sampling pass inside one call — advisor, fallback, compaction. */
export type ExtraPass = {
  /** The pass has its own model: an advisor can be opus on top of a sonnet thread. */
  model: string;
  /** `usage.iterations[].type` — shown in the "By model" table as a tag. */
  kind: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  raw: any;
};

/** One transcript record carrying `message.usage`. */
export type UsageRec = {
  /** Date.parse(timestamp); NaN when there is no stamp. */
  ts: number;
  model: string;
  /** The API call's key. undefined means there is nothing to fold on, so it counts as unique. */
  requestId: string | undefined;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** `usage.speed === 'fast'` — premium price, see FAST_PRICING. */
  fast: boolean;
  /** Passes that are ABSENT from top-level usage entirely. Usually empty. */
  extra: ExtraPass[];
  /** iterations[] did not reconcile with top-level — extras were not extracted; say so out loud. */
  extraShapeUnknown: boolean;
  /** The raw usage: whoever weights cache-write needs the cache_creation buckets. */
  raw: any;
};

const ITER_FIELDS = [
  'input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'output_tokens',
] as const;

/**
 * Passes that are paid for but absent from top-level `usage`.
 *
 * `usage.iterations[]` holds the sampling passes inside ONE API call, and
 * top-level usage equals the sum of only those with `type === "message"`.
 * Everything else — an advisor model, a fallback, a compaction — is billed
 * separately ("Compaction requires an additional sampling step, which
 * contributes to rate limits and billing") and is missing from the top level
 * entirely. That is why such a pass can be ADDED without double counting.
 *
 * Measured on 2026-08-31 over 14 days: the invariant "top == sum of message
 * iterations" holds on 58 613 records out of 58 615, and on the 58 289
 * single-iteration ones the top level matches iterations[0] byte for byte, with
 * zero exceptions. The money that went unseen was $281 over two weeks (3.9% of
 * the total), of which $280.27 was advisor passes on opus-5 — and 75 of those
 * 289 calls ran inside a sonnet thread, where the pass costs 2.5x the thread
 * itself. Pricing them at the thread's model is the same understatement, only
 * quieter.
 *
 * Both exceptions were `fallback_message`, where a different model answered than
 * the one requested, so the equality cannot hold by construction. There we do
 * NOT guess: we return `unknown` and the caller prints it. Silently parsing a
 * shape you do not recognise is exactly the disease the unpriced reporting
 * exists for.
 */
export function extraPasses(u: any, model: string): { extra: ExtraPass[]; unknown: boolean } {
  const it = u?.iterations;
  if (!Array.isArray(it) || it.length === 0) return { extra: [], unknown: false };
  const kindOf = (x: any) => String(x?.type ?? 'message');
  const msgs = it.filter((x) => kindOf(x) === 'message');
  const holds = ITER_FIELDS.every(
    (f) => (u[f] ?? 0) === msgs.reduce((a: number, x: any) => a + (x?.[f] ?? 0), 0),
  );
  if (!holds) return { extra: [], unknown: true };
  return {
    extra: it
      .filter((x) => kindOf(x) !== 'message')
      .map((x) => ({
        model: String(x?.model ?? model),
        kind: kindOf(x),
        input: x?.input_tokens ?? 0,
        cacheWrite: x?.cache_creation_input_tokens ?? 0,
        cacheRead: x?.cache_read_input_tokens ?? 0,
        output: x?.output_tokens ?? 0,
        raw: x,
      })),
    unknown: false,
  };
}

/** Parse an already-decoded JSONL record. null means the record is not about spend. */
export function usageOf(rec: any): UsageRec | null {
  const u = rec?.message?.usage;
  if (!u) return null;
  const model = rec?.message?.model ?? 'unknown';
  const { extra, unknown } = extraPasses(u, model);
  return {
    ts: Date.parse(rec.timestamp ?? ''),
    model,
    requestId: rec.requestId ?? rec?.message?.id,
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    fast: u.speed === 'fast',
    extra,
    extraShapeUnknown: unknown,
    raw: u,
  };
}

/** The same from a raw line — for tools with no use for the rest of the JSON. */
export function parseUsageLine(line: string): UsageRec | null {
  if (!line.includes('"usage"')) return null;
  try {
    return usageOf(JSON.parse(line));
  } catch {
    return null;
  }
}

/** What to do with a record: a call seen for the first time, more output, or a duplicate. */
export type Fold<T> =
  | { kind: 'call'; into: T }
  | { kind: 'grew'; into: T; output: number }
  | { kind: 'same' };

/**
 * The fold over the records of one API call — shared by everything that counts
 * transcripts.
 *
 * It is lifted out of main() and exported NOT for tidiness: the fold rule is
 * exactly the place where this tool overstated by 2x for six weeks, and a second
 * copy of it in a neighbouring tool would drift from this one silently.
 *
 * `T` is whatever the caller accumulates into (a Bucket here, a session
 * elsewhere): the output increment has to land in the accumulator of the call's
 * FIRST record rather than the current one, which is why the folder remembers
 * the owner and not just a number.
 */
export function makeCallFolder<T>() {
  const seen = new Map<string, { into: T; output: number }>();
  return function fold(rec: UsageRec, into: T): Fold<T> {
    const key = rec.requestId;
    const prev = key ? seen.get(key) : undefined;
    if (prev) {
      // A repeat record of the same call: the input is already counted, so take
      // only the output increment — it is not final in the intermediate blocks.
      if (rec.output > prev.output) {
        const grew = rec.output - prev.output;
        prev.output = rec.output;
        return { kind: 'grew', into: prev.into, output: grew };
      }
      return { kind: 'same' };
    }
    // Neither requestId nor message.id — count the record as unique: failing to
    // fold a duplicate is cheaper than losing real spend.
    if (key) seen.set(key, { into, output: rec.output });
    return { kind: 'call', into };
  };
}

const rows = new Map<string, Bucket>();

// Folding the records of one API call.
//
// Claude Code spreads ONE model response over several assistant records — one
// per content block (thinking / text / tool_use) — and puts a FULL copy of
// message.usage into each, not a share of it. Summing over records therefore
// counts the same call two and three times: over one day, 5069 records with
// usage covered 2310 unique requestIds (×2.199), and the total came out 2.09x
// too high in tokens and 2.30x too high in money — $576 instead of $250.
//
// The data itself dictates the fold rule: within a group, input, cache_creation
// and cache_read are byte-identical and only output grows. So the input is taken
// ONCE per call, and output as the maximum over the group (record order in the
// file is not guaranteed, hence the maximum rather than "the last record").
//
// The dedup is global rather than per file: the difference between global and
// per-file was measured at 0.2%, and global is simpler and does not depend on
// how the transcript happens to be split across files.
//
// The rule itself lives in makeCallFolder() above — one copy for every tool.
const foldCall = makeCallFolder<Bucket>();

// How many extra passes of a call have already been credited — see extraPasses()
// and the place where they are put into a bucket.
const extrasCredited = new Map<string, number>();
// Records whose iterations[] did not reconcile with top-level: their extras were
// not parsed.
let unknownShape = 0;

// The prompt size of the last step is the whole context that will be re-read on
// the next one. The full prompt is input + cache_read + cache_write, not
// cache_read alone: the freshly added part is being written on this step, not
// read.
let lastContext = 0;

// After /compact the next usage-bearing turn does not appear immediately, and
// the last usage BEFORE it — the compaction call itself, which reads the whole
// old context rather than the new size — makes lastContext silently show the
// pre-compaction number. compact_boundary carries compactMetadata.postTokens but
// no message.usage.
// coldStart is the cost of a session's very first turn (system prompt + tools +
// instruction files, before any cache) — the same overhead that is re-read from
// scratch after every compaction. Calibrated on 31 real compactions
// (2026-08-13): coldStart + postTokens predicts the next real usage within 2–9%
// in most sessions (occasionally up to ~18% on outliers), against an 11% mean /
// 50% worst-case error for a cross-session constant.
let coldStart = 0;
let pendingCompactPostTokens = 0;

// Prompt cache age. What is emitted is not "alive/dead" but the MOMENT of the
// last request plus the TTL — the age is computed by the status line on every
// render. Otherwise the segment freezes during exactly the idle period it exists
// for: the line is redrawn on events, while the cache dies without any, so a
// cached verdict of "alive" would hang there for the whole idle stretch.
//
// The TTL is not guessed: the response names its bucket — usage.cache_creation
// keeps it in a separate field (`ephemeral_1h_input_tokens` /
// `ephemeral_5m_input_tokens`), so 1h versus 5m is visible in the data rather
// than inferred. A turn without cache-write names no bucket — then the previous
// one is kept.
let lastMainTs = 0;
let lastCacheTtlSec = 0;

async function main() {
  for (const prof of PROFILES) {
    for (const file of walk(prof.dir)) {
      const owner = ownerOf(file.slice(prof.dir.length + 1));
      if (!owner) continue;
      const { project, session: sid } = owner;
      if (sessionFilter && !sid.startsWith(sessionFilter)) continue;
      if (!sessionFilter && statSync(file).mtimeMs < since) continue;

      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = Date.parse(rec.timestamp ?? '');
        if (Number.isFinite(ts) && ts < since) continue;
        if (owner.main && rec.type === 'system' && rec.subtype === 'compact_boundary') {
          const post = rec.compactMetadata?.postTokens;
          if (typeof post === 'number') pendingCompactPostTokens = post;
          continue;
        }
        const usage = usageOf(rec);
        if (!usage) continue;
        const u = usage.raw;
        if (usage.extraShapeUnknown) unknownShape += 1;
        // Agent files go into the PARENT session's bucket: otherwise --sessions
        // opens a separate row per agent instead of a sum per session.
        const bucketFor = (model: string, kind: string, fast: boolean) => {
          const k = `${prof.name}|${project}|${sid}|${model}|${kind}|${fast ? 'fast' : ''}`;
          const b = rows.get(k)
            ?? zero({ profile: prof.name, project, session: sid, model, kind, fast });
          rows.set(k, b);
          return b;
        };
        const r = bucketFor(usage.model, '', usage.fast);
        const fold = foldCall(usage, r);
        if (fold.kind === 'grew') {
          fold.into.output += fold.output;
        } else if (fold.kind === 'call') {
          r.input += usage.input;
          r.cacheWrite += usage.cacheWrite;
          r.cacheWriteWeighted += cacheWriteWeight(u);
          r.cacheRead += usage.cacheRead;
          r.output += usage.output;
          r.msgs += 1;
        }
        // Extra passes do not necessarily arrive with the call's first record:
        // while the advisor has not finished, its iteration is not in the array
        // yet, and by the time it appears the record folds as 'grew' and nobody
        // would look at its extras. So they are credited by counter rather than
        // by first record: the array is ordered, so new passes are the tail.
        if (usage.extra.length > 0) {
          const ck = usage.requestId ?? `${sid}|${rec.uuid ?? ''}`;
          const credited = extrasCredited.get(ck) ?? 0;
          for (const x of usage.extra.slice(credited)) {
            const b = bucketFor(x.model, x.kind, usage.fast);
            b.input += x.input;
            b.cacheWrite += x.cacheWrite;
            b.cacheWriteWeighted += cacheWriteWeight(x.raw);
            b.cacheRead += x.cacheRead;
            b.output += x.output;
          }
          if (usage.extra.length > credited) extrasCredited.set(ck, usage.extra.length);
        }
        // The total accumulates over every file; ctx only over the main thread.
        if (owner.main) {
          const total =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          lastContext = total;
          // The RESPONSE time stands in for the moment of the request: the two
          // differ by the duration of the turn, and always in the direction of
          // "the cache is younger" — that is, towards silence rather than a
          // premature "cold".
          if (Number.isFinite(ts)) lastMainTs = ts;
          const cc = u.cache_creation;
          if (cc) {
            if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) lastCacheTtlSec = 3600;
            else if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) lastCacheTtlSec = 300;
          }
          if (coldStart === 0 && total > 0) coldStart = total;
          // A real turn after a compaction — the estimate is no longer needed.
          pendingCompactPostTokens = 0;
        }
      }
    }
  }

  const all = [...rows.values()];

  /** The weighted cost of a row, in list-price dollars. */
  function cost(r: Bucket): number {
    const p = priceFor(r.model, r.fast);
    return (
      (r.input * p.input +
        r.cacheWriteWeighted * p.input +
        r.cacheRead * p.input * 0.1 +
        r.output * p.output) /
      1_000_000
    );
  }
  const tokens = (r: Bucket) => r.input + r.cacheWrite + r.cacheRead + r.output;
  const fmtTok = (n: number) => (n / 1_000_000).toFixed(2) + 'M';
  const usd = (n: number) => '$' + n.toFixed(2);

  // Models whose price had to come from the fallback. A silent fallback is the
  // disease itself, not just a miss on one key: it hands Opus pricing to ANY
  // unknown model and prints the result as an ordinary table row.
  //
  // The "has tokens" threshold is deliberate, not cosmetic. `<synthetic>` marks
  // a locally generated message with no API call behind it and zero tokens: such
  // a row costs nothing at any price, so there is nothing to warn about. But the
  // moment a synthetic record carries non-zero usage it stops being free — and
  // that is the same silent ×5 the rule exists for, so the warning turns itself
  // back on.
  const unpriced = all
    .filter((r) => !isPriced(r.model) && tokens(r) > 0)
    .reduce((m, r) => m.set(r.model, (m.get(r.model) ?? 0) + cost(r)), new Map<string, number>());
  // Always on stderr: stdout carries either machine-readable JSON or the status
  // bar line, and prose cannot be mixed into either.
  for (const [m, v] of unpriced) {
    console.error(
      `claude-usage: no price for model ${m}, counted at the fallback ` +
        `$${FALLBACK_PRICE.input}/$${FALLBACK_PRICE.output} per 1M — ${usd(v)} of this row is in question`,
    );
  }
  // Same logic as the price fallback: name an unrecognised shape out loud rather
  // than parsing it on a guess. The only known carrier is fallback_message, where
  // a different model answered than the one requested (2 records in 14 days); if
  // this counter grows, a shape has appeared that extraPasses() was not written
  // for.
  if (unknownShape > 0) {
    console.error(
      `claude-usage: usage.iterations did not reconcile with top-level on ${unknownShape} records — ` +
        'the extra passes of those calls are not counted',
    );
  }

  // --- status bar mode: one session, one line ---
  //
  // No dollars: on an OAuth subscription the price in $ decides nothing and only
  // adds noise. Two quantities are shown, and the second is the actionable one:
  //   totals — how many tokens the session has burned (every re-read summed),
  //   ctx    — the current context size, which will be re-read on EVERY
  //            following step. A bloated ctx is visible immediately, before the
  //            bill is multiplied by the steps that remain.
  if (sessionFilter) {
    const t = all.reduce((a, r) => a + tokens(r), 0);
    if (!t) {
      console.log('');
      process.exit(0);
    }
    // The last compaction is not yet confirmed by a real turn — show the
    // estimate (coldStart + postTokens) marked with `~` instead of a silent
    // pre-compaction number. As soon as a real response arrives,
    // pendingCompactPostTokens resets and the exact lastContext returns.
    const estimating = pendingCompactPostTokens > 0 && coldStart > 0;
    const ctx = estimating ? pendingCompactPostTokens + coldStart : lastContext;
    const ctxStr = estimating ? `~${Math.round(ctx / 1000)}k` : `${Math.round(ctx / 1000)}k`;
    // The third field is raw numbers, not a verdict: `… cache <epoch_s> <ttl_s>`.
    // The tail is optional, and a status line that does not find it simply does
    // not draw the segment, so a cache written by an older version stays
    // readable.
    const cacheTail =
      lastMainTs > 0 ? ` cache ${Math.round(lastMainTs / 1000)} ${lastCacheTtlSec || 3600}` : '';
    console.log((ctx ? `${fmtTok(t)} ctx ${ctxStr}` : fmtTok(t)) + cacheTail);
    process.exit(0);
  }

  function aggregate(keyOf: (r: Bucket) => string) {
    const m = new Map<string, Bucket & { cost: number }>();
    for (const r of all) {
      const k = keyOf(r);
      const a = m.get(k) ?? { ...zero({ profile: r.profile, project: r.project, session: r.session }), cost: 0 };
      a.input += r.input; a.cacheWrite += r.cacheWrite; a.cacheRead += r.cacheRead;
      a.cacheWriteWeighted += r.cacheWriteWeighted;
      a.output += r.output; a.msgs += r.msgs; a.cost += cost(r);
      m.set(k, a);
    }
    return [...m.values()].sort((x, y) => y.cost - x.cost);
  }

  const label = bySessions ? 'session' : 'project';
  const sorted = bySessions
    ? aggregate((r) => `${r.profile}|${r.session}`)
    : aggregate((r) => `${r.profile}|${r.project}`);

  // --- machine-readable mode: EXACTLY one JSON object on stdout ---
  //
  // The consumer (a budget gate) runs JSON.parse over the WHOLE of stdout, so
  // this exit comes BEFORE the first table line: no header, no progress, no
  // ANSI. There is deliberately no separate cost counter on the consumer side —
  // it would drift from what a human sees, and drift silently.
  //
  // Flag position does not matter: `has()`/`argv.find()` look at the whole argv,
  // so `24 --json` and `--json 24` produce the same output. The "a flag after a
  // positional is silently swallowed" trap is closed here by a test rather than
  // by a convention about argument order.
  if (has('--json')) {
    // Round with the same operation as the table (`toFixed(2)`) so that
    // `totalUsd` matches its TOTAL line. Because of that, the sum of the rounded
    // `rows` can differ from `totalUsd` by a cent per row: the number to decide
    // on is `totalUsd`.
    const round2 = (n: number) => Number(n.toFixed(2));
    process.stdout.write(
      JSON.stringify({
        hours,
        totalUsd: round2(sorted.reduce((sum, r) => sum + r.cost, 0)),
        // Which part of totalUsd was priced from the fallback rather than the
        // real price list. An empty array is the normal state; a non-empty one
        // means the gate's number cannot be taken at face value. The field is
        // new but does not break the contract: the consumer reads `totalUsd` and
        // ignores extra keys.
        unpriced: [...unpriced].map(([model, u]) => ({ model, usd: round2(u) })),
        // Records with an unrecognised iterations[] shape: their extra passes are
        // not in totalUsd. Zero is the normal state; non-zero means "understated".
        unknownIterationShape: unknownShape,
        rows: sorted.map((r) => ({
          profile: r.profile,
          project: r.project,
          messages: r.msgs,
          tokens: tokens(r),
          usd: round2(r.cost),
        })),
      }) + '\n',
    );
    process.exit(0);
  }

  // The multiplier in the header is the ACTUAL one, blended across buckets,
  // rather than the default: with a live share of the five-minute bucket it
  // comes out around 1.83, and printing ×2 here would explain the table's
  // numbers with the wrong coefficient. With no cache-write (or on old records
  // without buckets) it coincides with the fallback multiplier.
  const totCacheWrite = all.reduce((a, r) => a + r.cacheWrite, 0);
  const effCacheWriteMult = totCacheWrite
    ? Number((all.reduce((a, r) => a + r.cacheWriteWeighted, 0) / totCacheWrite).toFixed(2))
    : cacheWriteMult;
  console.log(`\n=== Spend over the last ${hours}h (cache-write ×${effCacheWriteMult}) ===\n`);
  console.log(
    'conf'.padEnd(7), label.padEnd(bySessions ? 38 : 44),
    'msgs'.padStart(6), 'cacheW'.padStart(8), 'cacheR'.padStart(8),
    'output'.padStart(8), 'tokens'.padStart(8), '$list'.padStart(9),
  );
  for (const r of sorted.slice(0, 20)) {
    const name = bySessions ? r.session.slice(0, 36) : r.project.slice(0, 44);
    console.log(
      r.profile.padEnd(7), name.padEnd(bySessions ? 38 : 44),
      String(r.msgs).padStart(6),
      fmtTok(r.cacheWrite).padStart(8), fmtTok(r.cacheRead).padStart(8),
      fmtTok(r.output).padStart(8), fmtTok(tokens(r)).padStart(8),
      usd(r.cost).padStart(9),
    );
  }

  const totTok = all.reduce((a, r) => a + tokens(r), 0);
  const totCost = all.reduce((a, r) => a + cost(r), 0);
  const totMsgs = all.reduce((a, r) => a + r.msgs, 0);
  console.log(`\nTOTAL: ${totMsgs} messages | ${fmtTok(totTok)} tokens | ~${usd(totCost)} at API list price`);

  // Where the money is: each category's share of tokens against its share of cost.
  const cat = [
    { name: 'input', tok: all.reduce((a, r) => a + r.input, 0), mult: 1 },
    { name: 'cache-write', tok: totCacheWrite, mult: effCacheWriteMult },
    { name: 'cache-read', tok: all.reduce((a, r) => a + r.cacheRead, 0), mult: 0.1 },
    { name: 'output', tok: all.reduce((a, r) => a + r.output, 0), mult: 0 }, // counted separately
  ];
  const costByCat = (name: string) =>
    all.reduce((a, r) => {
      const p = priceFor(r.model, r.fast);
      if (name === 'input') return a + (r.input * p.input) / 1e6;
      if (name === 'cache-write') return a + (r.cacheWriteWeighted * p.input) / 1e6;
      if (name === 'cache-read') return a + (r.cacheRead * p.input * 0.1) / 1e6;
      return a + (r.output * p.output) / 1e6;
    }, 0);

  console.log('\nWhere the money goes (share of tokens → share of cost):');
  for (const c of cat) {
    const cc = costByCat(c.name);
    const tokPct = totTok ? ((c.tok / totTok) * 100).toFixed(1) : '0.0';
    const costPct = totCost ? ((cc / totCost) * 100).toFixed(1) : '0.0';
    console.log(`  ${c.name.padEnd(12)} ${fmtTok(c.tok).padStart(8)}  ${tokPct.padStart(5)}% of tokens → ${costPct.padStart(5)}% of cost  (${usd(cc)})`);
  }

  // The key is the row's LABEL, not the model id: an advisor pass on opus-5
  // inside a sonnet thread has to stand as its own row, or it dissolves into the
  // thread model's row and becomes invisible again — by the very mechanism that
  // hid it from top-level usage.
  const byModel = new Map<string, { usd: number; model: string }>();
  for (const r of all) {
    const k = modelLabel(r);
    const e = byModel.get(k) ?? { usd: 0, model: r.model };
    e.usd += cost(r);
    byModel.set(k, e);
  }
  console.log('\nBy model:');
  for (const [m, v] of [...byModel].sort((a, b) => b[1].usd - a[1].usd)) {
    // A row priced from the fallback is marked in the table itself: looking
    // exactly like its neighbours is what makes a price miss dangerous.
    const mark = unpriced.has(v.model) ? `  ⚠ fallback $${FALLBACK_PRICE.input}/$${FALLBACK_PRICE.output}` : '';
    console.log(`  ${m.padEnd(32)} ${usd(v.usd).padStart(9)}${mark}`);
  }
  console.log('\nAPI list-price equivalent, not a bill: on a subscription Anthropic meters the limit.\n');
  }

/**
 * Compare REAL PATHS: node hands back import.meta.url with symlinks already
 * resolved, while argv[1] is exactly what the caller typed. A direct comparison
 * turns an invocation through a symlink into a silent no-op.
 */
function isEntryPoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
