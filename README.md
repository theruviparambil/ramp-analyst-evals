# ramp-analyst-evals

An agentic finance analyst built on [Ramp's public agent-tool surface](https://docs.ramp.com/), plus the eval harness that proves — or disproves — that it works.

The agent answers spend questions the way an analyst would: it reads the data
catalog, pulls the domain docs, writes read-only SQL against `analyst.spend_facts`,
and self-corrects when a query fails. The harness then grades each answer against
an exact ground truth — the number, the reasoning path, and a structured payload
it can check for equality. The agent is the easy part. The harness is the point.

Everything runs against a local synthetic company by default, so the repo is
reproducible with no Ramp account and no network. `RAMP_MODE=live` swaps the same
tool calls onto Ramp's real MCP endpoint.

## Results (real run)

12 questions, run **5 times each** so the model-dependent tier reports a mean and
a range, not a single wobbling number. Agent `gpt-5.1`, judge `gpt-4.1`, one
OpenAI key, `RAMP_MODE=fixture`.

| | |
|---|---|
| **REQUIRED tier** (the SLA) | **85% mean**, range **75–92%** over 5 runs |
| **ADDITIONAL tier** (headroom) | **47% mean**, range **33–58%** |
| Cost | ≈ **$1.20** — 271 API calls, 707,855 prompt + 31,856 completion tokens |
| Offline tests (CI) | **76 passing**, keyless |
| Eval gate @ REQUIRED ≥ 0.9 | **fails at 85%** — on purpose (see below) |

Per-question, how often each tier fully passed across the 5 runs:

```
q01_total_net_spend      required 5/5   additional 5/5
q02_top_vendor           required 5/5   additional 1/5
q03_spend_by_department  required 5/5   additional 4/5
q04_duplicate_charge     required 2/5   additional 0/5   ← the hard one
q05_vendor_variant       required 5/5   additional 4/5
q06_out_of_policy        required 1/5   additional 0/5   ← the agent often gives up
q07_mom_spike            required 5/5   additional 0/5
q08_top_spender          required 5/5   additional 5/5
q09_software_total       required 5/5   additional 0/5
q10_refunds              required 3/5   additional 2/5
q11_open_bills           required 5/5   additional 4/5
q12_active_users         required 5/5   additional 3/5
```

**The eval gate fails, and that's the deliverable.** The harness is set to require
a 0.9 REQUIRED-tier pass rate; `gpt-5.1` lands at 0.85. It won't wave the agent
through, because the agent has two real misses:

- **q04 (duplicates)** — the model groups by *exact same date* and reports "no
  duplicates," missing the planted Datadog double-charge three days apart. This is
  the single most important test in the repo (see below).
- **q06 (out-of-policy)** — on 4 of 5 runs the model answers the policy question in
  the abstract and never queries `spend_facts.policy_status`, so it fails to name
  the Nobu charge. `req.grounded` catches the give-up (it dropped to 93%).

A green 100% would be the suspicious result. What held perfectly are the two
surface-enforced invariants: read-only 60/60 and rationale-on-every-call 60/60.

```
[REQ] (inv) req.read_only         60/60  100%   never called a write tool
[REQ] (inv) req.rationale         60/60  100%   every tool call had a rationale
[REQ] (obs) req.grounded          56/60   93%   4 give-ups without a query (q06)
[REQ] (obs) req.value             51/60   85%   the structured value check
[ADD] (obs) add.aggregated_in_sql 51/55   93%   aggregated in SQL, not a raw scan
[ADD] (obs) add.variants           5/5   100%   named both Delta spellings
[ADD] (obs) add.money_format      34/60   57%   terser JSON-first prose skips $ formatting
[ADD] (obs) add.policy_cited       0/5     0%   stopped citing the $500 cap in prose
```

`(inv)` marks **surface-enforced invariants** — checks that cannot fail while the
tool surface behaves: write tools are never handed to the agent, and the surface
rejects any call missing a rationale. They're guarantees of the harness, not
evidence about the model. Everything else is `(obs)` — observed behavior that
genuinely depends on what the agent chose to do, including grounding and the
catalog/docs path checks, which fail when the agent answers without ever landing
a query. Labeling them apart keeps the report from dressing one up as the other. The additional tier dropped from an earlier build because
asking the agent for a machine-checkable JSON block made its prose terser — a real
tradeoff, and exactly the kind of thing you want measured rather than guessed.

Reproduce the whole scoring machinery with no key in ~30 seconds:

```bash
npm install
npm test              # 76 tests, fully offline (scripted model + real DuckDB)
npm run ground-truth  # print the planted patterns and their exact values
```

Run the agent live with one key:

```bash
cp .env.example .env             # one of OPENROUTER / OPENAI / ANTHROPIC
npm run demo                     # first 6 questions (cheap)
npm run eval -- --samples=5      # all 12, variance-controlled, + the eval gate
npm run ask -- "How much did we spend with Delta in Q2?"
```

## The test that matters: structured grading

Substring grading is a coinflip. The planted duplicate is a Datadog charge of
`$8,400.00` — but `$8,400.00` is *also* Datadog's legitimate monthly bill. So this
confidently-wrong answer would pass a naive "does it say Datadog and $8,400" check:

> "No duplicate charges. The Datadog $8,400.00 charge is the normal recurring
> monthly bill."

To close that, every question asks the agent to emit a machine-readable JSON block
next to its prose, and `req.value` grades that block for set / vector / scalar
**equality** against the independent oracle. The answer above carries
`{"duplicates": []}`, which fails set-containment against the planted pair — so it
now fails REQUIRED, as it should. There's a regression test pinning exactly this
(`src/eval/golden.test.ts`). This is what makes the oracle load-bearing instead of
decorative.

## One full transcript

`q02_top_vendor`, verbatim from [`out/transcripts.md`](out/transcripts.md). Note
the handshake: the agent reads the catalog and domain docs *before* it writes SQL,
because the tool surface returns `docs_required` otherwise — the same prerequisite
Ramp's Core enforces.

```
Q: Which vendor did we spend the most with in Q2, and how much?

1. get_analyst_catalog
   "Identify available analyst tables to compute top vendor spend for Q2."
2. get_analyst_spend_facts_domain_docs
   "Understand spend_facts grain, date, and merchant fields."
3. get_analyst_table_domain_docs  (analyst.merchant_dim)
   "Review merchant_dim to use normalized vendor names."
4. execute_analyst_query
   "Compute the top vendor by net card spend in Q2, grouping by normalized
    vendor name to combine spelling variants."
   SQL:
     SELECT md.normalized_merchant_name AS vendor, SUM(sf.amount) AS net_spend
     FROM analyst.spend_facts sf
     JOIN analyst.merchant_dim md ON sf.merchant_uuid = md.merchant_uuid
     WHERE sf.transaction_date >= DATE '2026-04-01'
       AND sf.transaction_date <= DATE '2026-06-30'
     GROUP BY md.normalized_merchant_name
     ORDER BY net_spend DESC LIMIT 1
   → { "vendor": "Google Ads", "net_spend": 42500.00 }

Answer:
   We spent the most with Google Ads in Q2, with net card spend of $42,500 …
   ```json
   {"top_vendor": {"name": "Google Ads", "spend_usd": 42500}}
   ```
```

That answer clears every REQUIRED criterion (structured value, read-only,
grounded) and the reasoning-path checks. It misses one ADDITIONAL criterion —
`$42,500` in prose isn't Ramp-formatted `$42,500.00` — which is why q02's additional
tier is only 1/5. Headroom, measured.

## Why an eval, not a demo

You can get an agent to *look* right on a Tuesday. Proving it's right, and staying
right after the next prompt tweak, is a different job. A few ideas this repo leans
on, in the shared vocabulary of the teams that do this well:

**Grade the reasoning path, not just the answer.** A correct number can come from a
lucky guess or a write that happened to not matter. So the harness asserts on the
trajectory: did the agent consult the catalog before querying, did it read docs for
every table it referenced, did it aggregate in SQL instead of scanning raw
transactions, did it avoid redundant re-fetches. The last two are genuine
discriminators — a lazy agent fails them even with the right number.

**Two binary tiers (Hebbia's framing).** REQUIRED = the SLA (right value, read-only,
grounded). ADDITIONAL = headroom (cite the SQL, catch the variant, flag the anomaly,
format money the Ramp way). Reported separately; only REQUIRED gates. Binary
pass/fail, never a fuzzy 0.7, because binary converges faster for judges and is what
a κ-validation pass expects.

**Invariant vs observed.** Some checks can't fail while the surface behaves. Calling
those "the model did well" is misleading, so they're tagged and reported apart from
real observed behavior.

**Variance control.** The model-dependent tier is run N times and reported as a mean
with a range (`--samples=5`). A single number that swings ±8 points between runs
isn't a measurement.

**A judge you don't over-trust.** Answer faithfulness is scored by a *separate* model
(`JUDGE_MODEL`, default a different model than the agent) on the non-gating
ADDITIONAL tier only. The committed run used a same-provider judge (`gpt-4.1`
grading `gpt-5.1`) — a known self-preference limitation, which is exactly why that
tier never gates. `JUDGE_API_KEY=<another vendor>` runs a true cross-family judge in
one env var. The full judge-validation method — proving a grader with inter-rater
agreement (Cohen's / Fleiss' κ) instead of accuracy — lives in the companion repo,
[veriva-eval](https://github.com/theruviparambil/veriva-eval).

**Two gates, kept honest.** The 76 offline tests are the CI gate — they run keyless
on every push ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The *eval*
gate is the `process.exit` in `npm run eval`; it needs a key because it has to
generate real trajectories, so it runs on demand, not in CI.

## The fixture is the ground truth

One synthetic company, **Vela Robotics** — 15 users across 6 departments, **207**
card transactions over Q2 2026, plus vendors and AP bills. Generated from a fixed
seed (integer cents, no float drift), so every run sees identical data. Because we
own it, every question has an exact expected answer, computed by a TypeScript
oracle that is deliberately *independent* of the agent's DuckDB path. When a checker
says the two agree, that's two implementations agreeing.

Four patterns are planted so the analyst has something real to find:

| Pattern | What's planted | Exact ground truth |
|---|---|---|
| **(a) Duplicate charge** | Datadog billed twice, days apart | `$8,400.00` on 2026-05-12 **and** 2026-05-15 (must *not* flag the recurring monthly charge) |
| **(b) Vendor variant** | Same airline, two spellings | `Delta Air Lines` + `Delta Airlines` = **`$4,387.00`** combined |
| **(c) Out-of-policy** | A dinner over the meals cap | Nobu `$6,750.00`, flagged `OUT_OF_POLICY` ($500 single-meal cap) |
| **(d) MoM spike** | One category jumps | Advertising `$12,500.00` (May) → `$50,000.00` (June), **4.0x**, driven by Google Ads |

Headline aggregates the agent should reach: net Q2 spend **$188,925.60** (gross
$189,427.10 less $501.50 refunds), top vendor **Google Ads $42,500.00**, top
department **Engineering $92,005.81**, top spender **Priya Nair $85,112.86**, open
AP bills **$25,750.00**, 13 active users.

The fixture reproduces Ramp's real gotchas on purpose: transaction amounts are
formatted strings (`"$6,750.00"`), bill amounts are numbers; `merchant_name` is
un-normalized, so a naive `GROUP BY merchant_name` splits Delta and under-reports it
(q05 is exactly that trap).

## The golden set

12 questions. Four target the planted patterns; the rest cover totals, group-bys,
refunds, bills, and the user directory. REQUIRED correctness is a structured-value
check against the oracle; ADDITIONAL mixes deterministic checks with the
faithfulness judge.

| # | Question | Expected | Structured `req.value` · notable ADDITIONAL |
|---|---|---|---|
| q01 | Total net card spend | `$188,925.60` | scalar `net_spend_usd` |
| q02 | Top vendor | Google Ads `$42,500.00` | `{name, spend}` · cite, format |
| q03 | Spend by department | Engineering `$92,005.81` | top `{name, spend}` · full 6-dept vector |
| q04 | Duplicate charges | Datadog `$8,400.00`, 05-12 & 05-15 | set contains Datadog · exact set, both dates |
| q05 | Total Delta spend | `$4,387.00` (both spellings) | scalar `combined` · names both variants |
| q06 | Out-of-policy txns | Nobu `$6,750.00` | set contains Nobu · exact set, cites $500 |
| q07 | Biggest MoM increase | Advertising, June `$50,000.00` | `spike.category` + `to_usd` · increase, driver |
| q08 | Top spender | Priya Nair `$85,112.86` | `{name, spend}` |
| q09 | SaaS/software total | `$35,598.00` | scalar · names a top vendor |
| q10 | Refunds, gross vs net | net `$188,925.60`, 2 refunds | `net_usd` + `refund_count` · gross, refund total |
| q11 | Open bills owed | `$25,750.00` (2 bills) | scalar · count, open-vs-paid |
| q12 | Active users + avg spend | 13 active; avg `$14,532.74` | `active_users` · avg per active user |

## Architecture

One interface, two backends. The agent, the tool registry, and the eval never know
which is behind them.

```
question ─▶ agent loop ─▶ RampToolSurface ─┬─ fixture backend  (default)
           (LLMClient)   (8 read tools)     │    └─ in-process DuckDB + docs handshake
                                            └─ live backend     (RAMP_MODE=live)
                                                 └─ Ramp MCP over OAuth/PKCE (stub)
              │
              └─▶ Trajectory ─▶ eval: structured/deterministic checks + trajectory
                                      assertions + binary judge ─▶ two-tier report + eval gate
```

- **Provider-agnostic, zero SDK.** The LLM client is `fetch` against OpenAI-compatible
  or Anthropic APIs, resolved from whichever key is present. No vendor SDKs.
- **Real SQL.** `execute_analyst_query` runs against an in-process DuckDB built from
  the fixture, so SQL errors are real and self-correction has something to fix.
- **Testable offline.** The agent loop is driven by a scripted LLM client (promptfoo's
  `_ScriptedClient` pattern) while tool calls still hit the real backend and DuckDB.

```
src/
  money.ts                cents-based money + Ramp formatting
  fixture/
    data.ts               the synthetic company (deterministic, seeded)
    ground-truth.ts       the independent oracle — every expected answer
  ramp/
    analyst-db.ts         in-process DuckDB: analyst.* tables, read-only SQL
    docs.ts               catalog + domain docs (the semantic source of truth)
    tools.ts              agent-tool registry, read/write classification
    fixture-backend.ts    schema-faithful tool surface + docs_required handshake
    live-backend.ts       Ramp MCP seam (documented stub)
  agent/
    provider.ts           fetch tool-calling (agent + separate judge), usage capture
    scripted.ts           offline test double
    agent.ts / system-prompt.ts   the read-only, self-correcting loop
  eval/
    golden.ts             the 12 questions + tier criteria
    structured.ts         structured-answer equality vs the oracle
    checkers.ts           deterministic checkers
    trajectory.ts         reasoning-path + efficiency discriminators
    judge.ts              binary faithfulness judge
    rubric.ts             two-tier scorer + eval gate
    run.ts                orchestrator, sampling, cost capture, out/ artifacts
out/                      committed receipts from the run above
```

## Live mode — bring your own sandbox

`RAMP_MODE=live` routes the identical tool calls to Ramp's real MCP endpoint. The
tool names and argument schemas already match, so no other module changes. Wiring
the auth needs Ramp sandbox credentials, so it ships as a documented stub
(`src/ramp/live-backend.ts`):

```bash
RAMP_MODE=live
RAMP_MCP_URL=https://demo-mcp.ramp.com/mcp   # streamable-HTTP MCP
RAMP_CLIENT_ID=…                              # OAuth 2.0 + PKCE
RAMP_CLIENT_SECRET=…
```

The integration shape (streamable-HTTP MCP, OAuth/PKCE token exchange, JSON-RPC
`tools/call`) is documented at the top of `live-backend.ts`. The seam is the
deliverable; the credentials are yours.

## Methodology hub

The judge-validation half of this discipline — proving a grader is reliable with
inter-rater agreement (Cohen's / Fleiss' κ) instead of accuracy — lives in the
companion repo, **[veriva-eval](https://github.com/theruviparambil/veriva-eval)**.
This repo is the agent-and-harness end of the same story.

## License

MIT — see [LICENSE](LICENSE).
