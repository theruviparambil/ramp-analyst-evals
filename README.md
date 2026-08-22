# ramp-analyst-evals

![Tests](https://img.shields.io/badge/tests-255-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Golden set](https://img.shields.io/badge/golden%20set-22%20questions-blue)
![Offline](https://img.shields.io/badge/test%20suite-runs%20offline-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

An agentic finance analyst built on Ramp's public agent-tool surface, plus the eval harness that proves, or disproves, that it works.

The agent answers spend questions the way an analyst would: it reads the data
catalog, pulls the domain docs, writes read-only SQL against `analyst.spend_facts`,
and self-corrects when a query fails. The harness then grades each answer against
an exact ground truth: the number, the reasoning path, and a structured payload
it can check mechanically. The agent is the easy part. The harness is the point.

The tool schemas mirror Ramp's **public** agent-tool spec
([`demo-api.ramp.com/v1/public/agent-tools/spec`](https://demo-api.ramp.com/v1/public/agent-tools/spec/),
also bundled in their open-source [ramp-cli](https://github.com/ramp-public/ramp-cli)); the fixture
data and analyst tables are entirely synthetic. Everything runs against a local synthetic company by
default, so the repo is reproducible with no Ramp account and no network. `RAMP_MODE=live` is a
documented stub (see below) for pointing the same tool calls at Ramp's real MCP endpoint.

> **Disclaimer.** Independent project. Not affiliated with, authorized, or endorsed by Ramp.
> "Ramp" is a trademark of its owner, used here nominatively to describe the public agent-tool
> surface this project is built on. No proprietary Ramp data or code is included: the schemas are
> reproduced from Ramp's public spec, and all data is synthetic.

## Quickstart (no API key)

```bash
npm install
npm test              # 255 tests, fully offline (scripted model + real DuckDB)
npm run ground-truth  # print the planted patterns and their exact values
```

Every grading rule, every planted trap, and the oracle that defines the right
answers are exercised without a key or a network call.

**Start here:** [the result](#the-result)
· [the trap that earned its keep](#the-trap-that-earned-its-keep)
· [what this eval cannot tell you](#what-this-eval-cannot-tell-you)
· [the golden set](#the-golden-set)
· [reproduce it](#reproduce-the-run)
· [architecture](#architecture)

---

## The result

Two frontier agents, 22 questions, **3 samples each**, each graded by a
cross-family judge. Both receipts carry the same `gradingHash`, so this compares
models rather than rubric versions.

| | gpt-5.6-terra | claude-sonnet-5 |
| --- | --- | --- |
| REQUIRED tier | **95.5%** (95.5 / 95.5 / 95.5) | **97.0%** (100 / 95.5 / 95.5) |
| ADDITIONAL tier | **40.9%** (31.8 / 45.5 / 45.5) | **34.8%** (36.4 / 36.4 / 31.8) |
| judged by | claude-sonnet-5 | gpt-5.6-terra |
| cost | $2.29 | $5.15 |

**That is not a ranking.** A 1.5-point REQUIRED gap is one question across three
samples. What the run shows is that the two models fail in *different shapes*:

| question | gpt-5.6-terra | claude-sonnet-5 |
| --- | --- | --- |
| q09 software total | **0/3** | 3/3 |
| q19 vendor reconciliation | 3/3 | **2/3** |
| q20 travel definition | 3/3 | **2/3** |
| the other 19 | 3/3 | 3/3 |

Terra has a **deterministic blind spot**: q09 fails every single time. Sonnet 5
has none, but is **less consistent**, dropping questions it usually gets right.
One sample would have called that a ranking. Three show it is a difference in
kind.

## The trap that earned its keep

Q2 holds one $18,000 charge to a merchant missing from `merchant_dim`. The
domain docs tell an agent to join that table and group by
`normalized_merchant_name` for canonical vendor totals, and that inner join
silently drops the row: no error, no empty result, just a total short by $18,000
that still looks completely plausible.

**Following the documentation is what produces the wrong answer.**

The sharpest evidence is one model across two questions:

```
q19  "does total spend reconcile to the sum by vendor?"     3/3 PASS
     -> finds the $18,000 gap, names the orphaned record

q09  "how much did we spend on software?"                   0/3 FAIL
     -> "grouped using canonical vendor names from merchant_dim"
     -> reports $44,198.00 against a true $62,198.00
```

Same model, same data, same $18,000. It locates the orphan when asked to look,
and loses it silently when it is not. That is not a knowledge gap. It is the
absence of a reason to check, and it is what a demo cannot surface.

The trap lives in the **fixture**, not in a question, which is why it caught
q09: a question written before the trap existed.

A second data-level trap works the same way. An employee transferred department
mid-quarter, so `user_dim` (current department) and `spend_facts` (department at
time of charge) disagree. Attributing spend through the wrong one reports Sales
at $36,623.79 against a true $14,981.38, off by 144%.

## What this eval cannot tell you

All of it recomputable from the committed receipts in `out/`.

**The REQUIRED tier is near its ceiling.** 19 of 22 questions are 3/3 for both
models, so the comparison rests on **three** discriminating questions, not 22.
An earlier version of this suite had every frontier model at 100%, which is why
the harder set exists; the ceiling has moved, not gone.

**n=3.** Enough to separate "fails every time" from "fails sometimes", which is
the distinction the result rests on. Not enough to rank two models 1.5 points
apart, and this README does not.

**One fixture, one company, one quarter.** 220 synthetic transactions with
planted anomalies. Nothing here establishes how these models behave on real
spend data at real scale.

**The models ran under different reasoning defaults.** Terra reasons by default;
Claude's extended thinking is off unless requested. Both ran at their API
defaults, which is what a developer gets out of the box, but it is not a
controlled comparison of reasoning budgets.

**The ADDITIONAL tier is an AND** over every criterion for a question, so one
failing check zeroes that question's additional score regardless of the rest.
Read it as a strict conjunction, not partial credit.

**What the numbers do support:** on one synthetic fixture, two 2026 frontier
agents stay read-only, follow the docs handshake, and get 95 to 97% of
structured values right, while both are vulnerable to a data-quality defect the
documented method walks them into. That is the claim.

## The test that matters: structured grading

Substring grading is a coinflip. The planted duplicate is a Datadog charge of
`$8,400.00`, but `$8,400.00` is *also* Datadog's legitimate monthly bill. So this
confidently-wrong answer would pass a naive "does it say Datadog and $8,400" check:

> "No duplicate charges. The Datadog $8,400.00 charge is the normal recurring
> monthly bill."

To close that, every question asks the agent to emit a machine-readable JSON block
next to its prose, and `req.value` grades that block for set / vector / scalar
**structured matching** against the independent oracle.

> **What "matching" actually means, precisely.** Money is compared with
> `max(2 cents, 0.05% of expected)`, so q01's $188,925.60 admits anything within
> ±$94.46 and q12's average uses a 1% band (±$145). Names are compared with a
> *bidirectional substring* after normalization, so `{"name": "a"}` satisfies a
> check whose expected value is `"Google Ads"`. Item lists are recall-only:
> `req.value` on q04 asks whether the real duplicate is present, not whether
> anything false was flagged alongside it, and the dates are graded on the
> non-gating ADDITIONAL tier. Two outside reviewers built answers that are
> clearly wrong and clear REQUIRED anyway, including a q04 answer whose prose
> denies a duplicate exists while its JSON names the legitimate April and June
> recurring charges. Calling this "equality" was an overstatement and the word
> has been removed. Tightening the graders would invalidate the committed
> receipts above, so that is a deliberate next step rather than a silent edit.

The answer above carries
`{"duplicates": []}`, which fails set-containment against the planted pair, so it
now fails REQUIRED, as it should. There's a regression test pinning exactly this
(`src/eval/golden.test.ts`). This is what makes the oracle load-bearing instead of
decorative.

## The golden set

22 questions in two groups.

**q01-q12** cover totals, group-bys, refunds, bills and the user directory, four
of them targeting planted anomalies. Near-saturated for 2026 frontier models,
and kept as the regression floor.

**q13-q22** test judgment rather than SQL. Each is built so a competent model
reaches a defensible *wrong* answer by doing the obvious thing:

| | the trap |
| --- | --- |
| q13 typical purchase | mean $1,098.21 vs median $52.71, a 21x gap. Leading with the mean is correct arithmetic and useless advice. |
| q14 refund scope | 3 refunds exist, one outside the quarter. Catches the period filter applied everywhere, or nowhere. |
| q15 program reach | Meals and Travel **tie** at 4 departments. Naming one of two tied answers fails. |
| q16 Q2 cash out | $25,750 of OPEN bills are commitments, not outflow. |
| q17 over budget | **Unanswerable.** No budget column exists anywhere. Passed only by declining, and naming nothing. |
| q18 inactive spenders | Answerable, and the answer is the **empty set**. Shares q17's schema so neither is given away by shape. |
| q19 reconciliation | The documented join drops $18,000. |
| q20 travel | Two defensible readings $6,750 apart. Graded on internal consistency, not one blessed number. |
| q21 false premise | "Marketing's spend dropped in June" is untrue. It quadrupled. |
| q22 concentration | Four dependent steps, and it inherits the department-transfer trap. |

REQUIRED correctness is a structured-value check against the oracle. ADDITIONAL
mixes deterministic checks with a binary faithfulness judge.

## Reproduce the run

```bash
cp .env.example .env
npm run eval -- --samples=3 --tag=my-run --out=out/my-run
```

Every run writes a `summary.json` carrying `harness.gradingHash`: a digest of
the nine files that decide pass or fail, the fixture and its oracle included.
**Two runs are comparable only if that hash matches.** The runner refuses to
overwrite a receipt written under a different model, tag, or question count.

## The fixture is the ground truth

One synthetic company, **Vela Robotics**: 15 users across 6 departments, **207**
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
    ground-truth.ts       the independent oracle: every expected answer
  ramp/
    analyst-db.ts         in-process DuckDB: analyst.* tables, read-only SQL
    docs.ts               catalog + domain docs (the semantic source of truth)
    tools.ts              agent-tool registry, read/write classification
    fixture-backend.ts    schema-faithful tool surface + docs_required handshake
    live-backend.ts       Ramp MCP seam (documented stub)
  agent/
    provider.ts           fetch tool-calling; agent + judge
                          (openai/anthropic/bedrock), usage capture
    scripted.ts           offline test double
    agent.ts / system-prompt.ts   the read-only, self-correcting loop
  eval/
    golden.ts             the 22 questions + tier criteria
    structured.ts         structured-answer matching vs the oracle
    checkers.ts           deterministic checkers
    trajectory.ts         reasoning-path + efficiency discriminators
    judge.ts              binary faithfulness judge
    rubric.ts             two-tier scorer + eval gate
    run.ts                orchestrator, sampling, cost capture, out/ artifacts
out/                      committed receipts from the run above
```

## Live mode: bring your own sandbox

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

The judge-validation half of this discipline, proving a grader is reliable with
inter-rater agreement (Cohen's / Fleiss' κ) instead of accuracy, lives in the
companion repo, **[veriva-eval](https://github.com/theruviparambil/veriva-eval)**.
This repo is the agent-and-harness end of the same story.

## License

MIT. See [LICENSE](LICENSE).
