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
a range, not a single wobbling number. Agent `gpt-5.1` (OpenAI); judge **Claude
Sonnet 4.6 on AWS Bedrock — a genuinely different model family from the agent**;
`RAMP_MODE=fixture`.

| | |
|---|---|
| **REQUIRED tier** (the SLA) | **88% mean**, range **83–100%** over 5 runs |
| **ADDITIONAL tier** (headroom) | **47% mean**, range **33–58%** |
| Cost | agent **$1.19** (OpenAI, 198 calls) + judge **$0.13** (Bedrock, 60 calls) = **$1.32** |
| Offline tests (CI) | **87 passing**, keyless |
| Eval gate @ REQUIRED ≥ 0.9 | **fails at 88%** — on purpose (see below) |

Per-question, how often each tier fully passed across the 5 runs:

```
q01_total_net_spend      required 5/5   additional 5/5
q02_top_vendor           required 5/5   additional 2/5
q03_spend_by_department  required 5/5   additional 4/5
q04_duplicate_charge     required 3/5   additional 0/5   ← the hard one
q05_vendor_variant       required 5/5   additional 5/5
q06_out_of_policy        required 1/5   additional 0/5   ← the agent often gives up
q07_mom_spike            required 5/5   additional 0/5
q08_top_spender          required 5/5   additional 5/5
q09_software_total       required 5/5   additional 0/5
q10_refunds              required 4/5   additional 1/5
q11_open_bills           required 5/5   additional 4/5
q12_active_users         required 5/5   additional 2/5
```

**The eval gate fails, and that's the deliverable.** The harness is set to require
a 0.9 REQUIRED-tier pass rate; `gpt-5.1` lands at 0.88. It won't wave the agent
through, because the agent has two real misses:

- **q04 (duplicates)** — on several runs the model groups by *exact same date* and
  reports "no duplicates," missing the planted Datadog double-charge three days
  apart. This is the single most important test in the repo (see below).
- **q06 (out-of-policy)** — on 4 of 5 runs the model answers the policy question in
  the abstract and never queries `spend_facts.policy_status`, so it fails to name
  the Nobu charge. `req.grounded` catches the give-up (it dropped to 93%).

A green 100% would be the suspicious result. What held perfectly are the two
surface-enforced invariants: read-only 60/60 and rationale-on-every-call 60/60.

```
[REQ] (inv) req.read_only         60/60  100%   never called a write tool
[REQ] (inv) req.rationale         60/60  100%   every tool call had a rationale
[REQ] (obs) req.grounded          56/60   93%   4 give-ups without a query (q06)
[REQ] (obs) req.value             54/60   90%   the structured value check
[ADD] (obs) add.faithful          52/60   87%   the cross-family Claude judge, non-gating
[ADD] (obs) add.aggregated_in_sql 51/55   93%   aggregated in SQL, not a raw scan
[ADD] (obs) add.variants           5/5   100%   named both Delta spellings
[ADD] (obs) add.money_format      37/60   62%   terser JSON-first prose skips $ formatting
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
npm test              # 87 tests, fully offline (scripted model + real DuckDB)
npm run ground-truth  # print the planted patterns and their exact values
```

Run the agent live with one key:

```bash
cp .env.example .env             # one of OPENROUTER / OPENAI / ANTHROPIC
npm run demo                     # first 6 questions (cheap)
npm run eval -- --samples=5      # all 12, variance-controlled, + the eval gate
npm run ask -- "How much did we spend with Delta in Q2?"
```

## Three agents, head to head

Point the same 12 questions at three frontier agents and the harness
discriminates. Each is graded **cross-family** — no model grades its own family.
The two OpenAI agents share the *same* Bedrock Claude judge, so they're directly
comparable; the required tier is deterministic (structured-value equality against
the oracle), so the agent comparison is judge-independent regardless.

| | GPT-5.1 · Claude judge | GPT-5.5 · Claude judge | Claude Sonnet 4.6 · GPT-5.1 judge |
|---|---|---|---|
| REQUIRED tier | 88% (83–100%) — **fails** 0.9 | **92%** (92–92%) — **clears** | **100%** (100–100%) — **clears** |
| ADDITIONAL tier | 47% (33–58%) | **60%** (50–75%) | 42% (33–50%) |
| Agent cost (5×12) | $1.19 | $6.59 | $4.57 |
| Judge cost | $0.13 | $0.12 | $0.06 |

Required-tier pass frequency per question (passes out of 5 samples):

```
                         GPT-5.1   GPT-5.5   Claude 4.6
q01_total_net_spend        5/5       5/5        5/5
q02_top_vendor             5/5       5/5        5/5
q03_spend_by_department    5/5       5/5        5/5
q04_duplicate_charge       3/5       5/5        5/5     ← time-gapped duplicate
q05_vendor_variant         5/5       5/5        5/5
q06_out_of_policy          1/5       4/5        5/5     ← policy-query case
q07_mom_spike              5/5       5/5        5/5
q08_top_spender            5/5       5/5        5/5
q09_software_total         5/5       5/5        5/5
q10_refunds                4/5       1/5        5/5     ← gpt-5.5 regressed here
q11_open_bills             5/5       5/5        5/5
q12_active_users           5/5       5/5        5/5
```

**Was "Claude beats GPT-5.1" a real gap or a recency artifact? Mostly recency.**
GPT-5.5 — OpenAI's current frontier — clears the same 0.9 gate GPT-5.1 fails, and
closes almost all of the difference on the two anomaly questions: it catches the
time-gapped Datadog duplicate every time (q04, 3/5 → 5/5) and the out-of-policy
Nobu charge on 4 of 5 runs (q06, 1/5 → 4/5, citing the $500 cap). So the honest
reading is **newer beats older, and the harness tracks that across model
generations** — not "Claude beats OpenAI." Both current frontier models clear the
required tier; the older GPT-5.1 doesn't.

Two things that survive the recency control and are worth stating plainly. First,
Claude still has the cleanest required tier (100% vs 92%) — it's the only agent
that never misses q06. Second — and this is the harness catching something a
recency ladder would hide — **GPT-5.5 regressed on refunds** (q10, 4/5 → 1/5): it
mishandled the gross-vs-net-with-refunds question the older GPT-5.1 mostly got
right. Newer is not uniformly better, and per-model quirks show up regardless of
release date. GPT-5.5 does lead the softer ADDITIONAL tier (60%), mostly on money
formatting.

This is a snapshot on one fixture, not a league table — but it's reproducible, and
the point is the harness produces a real, per-question signal to compare on at all.
(Cost note: the agents price very differently — GPT-5.1 $1.25/$10, Claude $3/$15,
GPT-5.5 $5/$30 per 1M in/out — so the cost row reflects rate as much as token use.)

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

`q02_top_vendor`, from [`out/transcripts.md`](out/transcripts.md). Note the
handshake: the agent reads the catalog and domain docs *before* it writes SQL,
because the tool surface returns `docs_required` otherwise — the same prerequisite
Ramp's Core enforces.

```
Q: Which vendor did we spend the most with in Q2, and how much?

1. get_analyst_catalog
   "Understand which analyst.* tables are available before querying Q2 vendor spend."
2. get_analyst_spend_facts_domain_docs
   "Review spend_facts docs to know how to aggregate vendor spend for Q2."
3. get_analyst_table_domain_docs  (analyst.merchant_dim)
   "Need merchant_dim docs to group Q2 card spend by normalized vendor name."
4. execute_analyst_query
   "Compute Q2 (2026-04-01 to 2026-06-30) net card spend by normalized vendor
    and pick the top vendor by spend."
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
   The vendor you spent the most with in Q2 was Google Ads, with net card spend
   of $42,500.00 between 2026-04-01 and 2026-06-30 …
   ```json
   {"top_vendor": {"name": "Google Ads", "spend_usd": 42500}}
   ```
```

That answer clears every REQUIRED criterion (structured value, read-only,
grounded) and the reasoning-path checks. The ADDITIONAL tier is where the headroom
lives: even a clean answer like this doesn't land every advanced criterion on every
run (q02's additional tier passed 2 of 5).

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

**Infra failures aren't capability failures.** A slow reasoning model whose call
times out, or a transient 5xx, is retried; if it still fails it's flagged an infra
error and *excluded from the pass-rate*, not scored as a wrong answer. (The
per-request timeout is configurable — `AGENT_TIMEOUT_MS` — precisely because a fixed
timeout that marks slow models wrong is a fairness bug. This surfaced comparing
GPT-5.5: a 90s cap was aborting its reasoning calls and mis-scoring them.)

**A judge you don't over-trust — and can swap for a different family.** A model
grades exactly one criterion, `add.faithful`, on the non-gating ADDITIONAL tier.
Everything that gates — the entire REQUIRED tier — is deterministic: structured
value equality against the oracle, plus rule checks (read-only, grounded,
rationale). No model grades the pass/fail that matters, so judge bias can't reach
the gate by construction. On top of that, the judge itself is swappable: the repo
ships three judge transports — OpenAI, Anthropic, and **AWS Bedrock**
(the Converse API over a Bearer token, no SDK) — so the judge can be a genuinely
different family from the agent in one env var:
`JUDGE_TRANSPORT=bedrock JUDGE_MODEL=us.anthropic.claude-sonnet-4-6`. **The committed
run above is judged by Claude Sonnet 4.6 on Bedrock** grading a GPT-5.1 agent —
cross-family, not self-grading. As a sanity check, re-scoring the same answers with
a same-family `gpt-4.1` judge agreed with Claude 12/12 on `add.faithful`, and the
additional-tier mean came out the same 47% either way — so the soft-tier signal
isn't an artifact of one judge (and, gating aside, judge choice doesn't move it). The full judge-validation method — proving a grader with
inter-rater agreement (Cohen's / Fleiss' κ) instead of accuracy — lives in the
companion repo, [veriva-eval](https://github.com/theruviparambil/veriva-eval).

**Two gates, kept honest.** The 87 offline tests are the CI gate — they run keyless
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
    provider.ts           fetch tool-calling; agent + judge (openai/anthropic/bedrock),
                          (openai/anthropic/bedrock), usage capture
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
