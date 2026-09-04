# claude-code-metrics

Two read-only tools that answer **"what did this cost"** and **"what is slow"** for
Claude Code — by reading the transcripts it already writes to disk.

No proxy in front of the API. No wrapper around the CLI. No instrumentation to
install and keep in sync. Claude Code writes a complete `usage` object into every
transcript message, and one attachment per hook call carrying its command,
duration and timeout. Everything below is arithmetic over files that already
exist.

| tool | question | source |
|---|---|---|
| `claude-usage.ts` | where the tokens and the money went | `message.usage` in `<config dir>/projects/**/*.jsonl` |
| `hook-timings.ts` | which hook **command** is slow | hook attachments in the same transcripts |

---

## Why this exists rather than a dashboard

The interesting failures in agent tooling are not "the number is missing". They
are **a number that is present, plausible, and wrong** — and every one of the
three below survived for weeks precisely because nothing looked broken.

**One response is written as several records.** Claude Code splits a single model
response across one assistant record per content block (thinking / text /
tool_use) and puts a *full copy* of `message.usage` into each, not a share of it.
Summing records therefore counts one API call two or three times. Measured over a
single day: 5069 records with usage covered 2310 unique `requestId`s — a ×2.199
inflation, which came out as **$576 instead of $250**. The fold rule is dictated
by the data: within a group `input`, `cache_creation` and `cache_read` are
byte-identical and only `output` grows, so input is counted once per call and
output is taken as the maximum over the group (record order in the file is not
guaranteed).

**Model ids are dated; price tables are not.** A transcript carries
`claude-haiku-4-5-20251001`, the price table holds `claude-haiku-4-5`. Exact
comparison missed and the record fell silently through to the Opus-priced
fallback: **haiku billed at five times its rate**. The absolute error was small,
which is why it went unnoticed — but the entire case for moving mechanical work
onto a cheap model rests on the "what would this have cost on haiku" comparison,
so the tool was systematically understating the reason to do it. The fix
normalises *exactly* the `-YYYYMMDD` suffix; a greedy prefix match would have
been worse than the miss, because it would hand a family's price to any id that
merely starts with it.

**Some passes you pay for are absent from `usage` entirely.** `usage.iterations[]`
holds the sampling passes inside one API call, and top-level `usage` is the sum of
only those with `type: "message"`. An advisor pass, a fallback, a compaction is
billed separately and does not appear at the top level at all. Over 14 days that
was **$281 unseen (3.9% of the total)**, of which $280.27 was advisor passes on
opus-5 — and 75 of those 289 calls ran inside a sonnet thread, where the pass
costs 2.5× the thread it runs in. Pricing them at the thread's model is the same
understatement, only quieter.

And one finding that is worth as much as the three above, because it stopped a
line of work rather than starting one: **prompt size does not affect the rate.**
Models from 4.6 on serve the full 1M window at the standard price. Over 14 days,
38 103 of 126 307 turns ran with a prompt above 200k, peaking at 976k — and there
is no premium behind any of it. The comment saying so lives in the pricing table,
where the next person to assume otherwise will read it.

---

## `claude-usage.ts`

```
claude-usage.ts [hours]              summary by project + model      (default 24)
claude-usage.ts [hours] --sessions   broken down by session
claude-usage.ts --session <id>       one session, one line (for a status bar)
claude-usage.ts [hours] --json       exactly one JSON object on stdout
claude-usage.ts --cache-ttl 5m       fallback cache-write multiplier for old
                                     records that predate usage.cache_creation
```

```
=== Spend over the last 24h (cache-write ×1.86) ===

conf    project                                        msgs   cacheW   cacheR   output   tokens     $list
default -Users-dev-projects-api-service                  412   18.40M  241.02M    1.21M  261.99M    $71.34
default -Users-dev-dotfiles                              128    5.02M   66.71M    0.44M   72.44M    $19.88

TOTAL: 540 messages | 334.43M tokens | ~$91.22 at API list price

Where the money goes (share of tokens → share of cost):
  input           0.26M    0.1% of tokens →   0.1% of cost  ($0.13)
  cache-write    23.42M    7.0% of tokens →  47.7% of cost  ($43.55)
  cache-read    308.10M   92.1% of tokens →  33.8% of cost  ($30.81)
  output          1.65M    0.5% of tokens →  18.4% of cost  ($16.73)

By model:
  claude-opus-5                          $84.19
  claude-opus-5 (advisor_message)         $5.42
  claude-haiku-4-5                        $1.61
```

*(Output shape is real; the rows above are illustrative. The measurements quoted
in this README are not — every figure in it came from live transcripts.)*

The **"where the money goes"** block is the point of the tool. Token share and
cost share are different distributions, and only the second one is actionable:
cache-read can be 92% of the tokens and a third of the bill, while cache-write is
7% of the tokens and nearly half of it.

Three things the output refuses to do quietly:

- a model missing from the price table is priced from the fallback, **and says
  so** — on stderr, in the table row (`⚠ fallback $5/$25`), and in the JSON
  (`unpriced: [...]`). A silent fallback is the disease itself, not just a miss on
  one key;
- an `iterations[]` shape that does not reconcile with the top level is
  **reported and not parsed** (`unknownIterationShape`), rather than guessed at;
- the cache-write multiplier printed in the header is the *actual blended* one,
  computed from the buckets the responses name themselves — not the ×2 default. A
  flat ×2 was wrong by ~7%, because roughly a fifth of cache-write goes to the
  five-minute bucket at ×1.25.

### Numbers are a list-price equivalent, not a bill

On a Max/Pro subscription Anthropic meters the limit by its own formula, and none
of these dollars are charged to anyone. This is a **ranking** tool — "what costs
more, and by how much" — and it is useful precisely because ranking is what
decisions need. Treat the absolute figure as a unit of comparison.

---

## `hook-timings.ts`

```
hook-timings.ts [--event NAME]... [--profile default|home|work|all]
                [--since SPEC] [--top N] [--json]
```

The whole design is one decision: **group by the full command, not by
`hookName`.** `hookName` names the *event* (`SessionStart`), which every step of
the chain shares, so percentiles over it average N different populations together.
One permanently-slow step out of eight moves the shared median by about an eighth
of its weight — invisible until it starts hitting the timeout.

Measured: `SessionStart` read as **median 351 ms / p90 2589 / 11 timeouts**, which
says "a rare outlier — cache it". The per-command cut showed a single culprit at
**median 2359 ms — slow always**, with the other seven steps (101–469 ms) dragging
the shared median down. The real diagnosis was that one step was reading 10 777
files, and no amount of percentile work on the event would have found it.

```
hook timings — profile all, SessionStart, since 7d
1284 transcripts seen, 96 read, 812 hook calls after dedup (37 duplicate lines dropped)

BY COMMAND (sorted by p90)
  n   med   p90   p99   max  to  command
---  ----  ----  ----  ----  --  -------------------------------------------
101  2359  3110  3402  3488   4  ~/.claude/hooks/scan-recent-dirs.ts
101   469   712   889   902   ·  ~/.claude/hooks/prime-cache.ts
101   101   140   188   201   ·  ~/.claude/hooks/session-meta.ts
ms; `to` = calls killed by their timeout. Grouped by the full command, not by hookName.
```

Two more things it refuses to do:

- **an empty window is not a clean bill of health.** With nothing matching, the
  report prints `NOTHING TO REPORT — that is an absence of data`, and points at
  `--since` / `--event` / `--profile`, instead of rendering an empty table that
  reads as "healthy";
- **duplicate lines are deduped by `uuid`.** The same call appears in more than
  one transcript when a session is resumed. Deduping on
  `timestamp + durationMs` — the obvious key — is lossy in the other direction:
  it collapsed 586 genuinely distinct calls that merely shared a millisecond and a
  duration. `uuid` and `toolUseID + command` agree exactly (40 050 each).

Timeouts are reported **with their dates**, grouped by day: whether they cluster
in a few days or spread evenly is what separates a regression from a standing
cost.

---

## Running it

Node **22 or newer**, and nothing else — no dependencies, no build step, no
bundler. The `.ts` files run directly under Node's type stripping:

```sh
git clone https://github.com/cainrus/claude-code-metrics.git
cd claude-code-metrics

node --experimental-strip-types claude-usage.ts 24
node --experimental-strip-types hook-timings.ts --event SessionStart --since 7d
```

Both files carry a shebang, so `chmod +x` and a symlink onto your `PATH` work too.

### Which directories are read

Config directories are **fixed paths**, deliberately never `CLAUDE_CONFIG_DIR`:

| `--profile` | directory |
|---|---|
| `default` | `~/.claude` |
| `home` | `~/.claude-home` |
| `work` | `~/.claude-work` |
| `all` (default) | all three |

A stock install only has the first; the other two are the convention for keeping
separate configurations under one account. Scanning a directory that does not
exist costs nothing, and omitting one silently halves the data — which is the
reason for the fixed list. Reading `CLAUDE_CONFIG_DIR` instead would be worse than
useless: a non-interactive caller (launchd, cron, an `execFile` from another tool)
gets no shell profile, so the variable is unset, and the tool would confidently
report `$0.00` and zero hook calls.

### Tests

```sh
npm test    # or: node --test --experimental-strip-types claude-usage.test.ts hook-timings.test.ts
```

52 tests, no network, no fixtures from a real machine: every end-to-end case
builds a transcript tree in a temporary `$HOME`. Note what the assertions
deliberately avoid — **no test is pinned to a dollar figure.** Price lists get
revised (Sonnet 5's introductory price became permanent on 2026-08-31 instead of
the announced rise), and a golden number would turn a price update into a red
test. What is asserted are relations that survive any revision: that a dated
haiku id costs exactly what an undated one costs, that an advisor pass costs what
the same turn of the same model costs, that a fast turn costs more than an
identical standard one.

## License

MIT — see [LICENSE](./LICENSE).
