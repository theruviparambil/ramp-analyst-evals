# ramp-analyst-evals

An agentic finance analyst built on [Ramp's public agent-tool surface](https://docs.ramp.com/), plus the eval harness that proves it works.

The agent answers spend questions the way an analyst would: it reads the data
catalog, pulls the domain docs, writes read-only SQL against `analyst.spend_facts`,
and self-corrects when a query fails. The harness then grades each answer against
an exact ground truth — not just the final number, but the reasoning path that
produced it. The agent is the easy part. The harness is the point.

Everything runs against a local synthetic company by default, so the whole repo
is reproducible with no Ramp account and no network. `RAMP_MODE=live` swaps the
same tool calls onto Ramp's real MCP endpoint.

## Results (real run)

12 finance questions, graded live against the fixture. Model `gpt-5.1`, one
OpenAI key, `RAMP_MODE=fixture`.

| | |
|---|---|
| **REQUIRED-tier pass rate** | **92%** (11/12 questions — the agent's SLAs: right number, read-only, grounded in a real tool call) |
| **ADDITIONAL-tier pass rate** | **42%** (5/12 questions — advanced behavior: cite the SQL, catch the variant, flag the anomaly) |
| Cost | ≈ **$0.25** — 60 API calls, 151,821 prompt + 6,476 completion tokens |
| CI gate | REQUIRED ≥ 90% → **pass** |

```
q01_total_net_spend      required 4/4  PASS   additional 7/7
q02_top_vendor           required 5/5  PASS   additional 7/7
q03_spend_by_department  required 5/5  PASS   additional 8/8
q04_duplicate_charge     required 3/5  FAIL   additional 5/8   ← the harness earning its keep
q05_vendor_variant       required 4/4  PASS   additional 6/8
q06_out_of_policy        required 5/5  PASS   additional 7/8
q07_mom_spike            required 5/5  PASS   additional 8/9
q08_top_spender          required 5/5  PASS   additional 7/7
q09_software_total       required 4/4  PASS   additional 7/8
q10_refunds              required 5/5  PASS   additional 8/9
q11_open_bills           required 4/4  PASS   additional 8/9
q12_active_users         required 4/4  PASS   additional 4/4
```

The one required failure is real, and it's the most interesting line in the
table. Asked for duplicate charges, `gpt-5.1` grouped by *exact same date* and
concluded there were none — missing the planted Datadog double-charge three days
apart. A single "looks right" spot check would have passed it. The value checker
caught it because the fixture knows the true answer is `$8,400.00`.

Per-criterion, the invariants held perfectly and the headroom is honest:

```
[REQ] req.read_only              12/12  100%     the read-only guarantee never broke
[REQ] req.grounded               12/12  100%     every answer traced to a real tool result
[REQ] req.rationale              12/12  100%     every tool call carried a rationale
[REQ] req.value                  10/11   91%     one wrong number (q04)
[ADD] path.catalog_before_query  11/11  100%     always consulted the catalog first
[ADD] path.docs_before_query     11/11  100%     always read docs for referenced tables
[ADD] add.faithful                9/12   75%     the LLM judge, discriminating
[ADD] add.variants                0/1     0%     never named both Delta spellings out loud
[ADD] add.dates                   0/1     0%     didn't cite both duplicate dates
[ADD] add.refund_total            0/1     0%     reported net, not the refund line item
```

Reproduce the scoring machinery with no key in about 30 seconds:

```bash
npm install
npm test              # 60 tests, fully offline (scripted model + real DuckDB)
npm run ground-truth  # print the planted patterns and their exact values
```

To run the agent live, add one key and go:

```bash
cp .env.example .env         # one of OPENROUTER / OPENAI / ANTHROPIC
npm run demo                 # first 6 questions (cheap)
npm run eval                 # all 12 + the CI gate
npm run ask -- "How much did we spend with Delta in Q2?"
```

## One full transcript

`q02_top_vendor`, verbatim from `out/transcripts.md`. Note the handshake: the
agent reads the catalog and the domain docs *before* it writes SQL, because the
tool surface refuses the query otherwise — the same `docs_required` gate Ramp's
Core enforces.

```
Q: Which vendor did we spend the most with in Q2, and how much?

1. get_analyst_catalog
   rationale: "Determine available analyst tables to query total spend by vendor for Q2."

2. get_analyst_spend_facts_domain_docs
   rationale: "Understand grain, date, and merchant fields in spend_facts."

3. get_analyst_table_domain_docs  (analyst.merchant_dim)
   rationale: "Review merchant_dim to use normalized vendor names."

4. execute_analyst_query
   rationale: "Find the vendor with the highest net card spend in Q2 2026."
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
   In Q2, the largest vendor by net card spend was Google Ads, with total spend
   of $42,500.00. This comes from summing amount in analyst.spend_facts for
   transactions dated 2026-04-01 to 2026-06-30, joined to analyst.merchant_dim
   and grouped by normalized_merchant_name.
```

That answer clears every required criterion (correct value, read-only, grounded)
and every additional one (cited the query, formatted the money, took the clean
catalog → docs → SQL path).

## Why an eval, not a demo

You can get an agent to *look* right on a Tuesday. Proving it's right, and
staying right after the next prompt tweak, is a different job — and it's the one
that ships trust. Two ideas this repo leans on, in the shared vocabulary of the
teams that do this well:

**Grade the reasoning path, not just the answer.** A correct number can come from
a lucky guess, a stale cache, or a write that happened to not matter. So the
harness asserts on the trajectory: did the agent consult the catalog before
querying, did it read the docs for every table it referenced, did it stay
read-only, did it converge without thrashing. q02 above passes the *path*, not
only the destination.

**Two binary tiers (Hebbia's framing).** REQUIRED criteria are the SLAs — get the
value right, stay read-only, ground it in a real tool call. A required-only pass
is acceptable. ADDITIONAL criteria are headroom — cite the SQL, catch the vendor
variant, flag the policy breach, format money the Ramp way. The two rates are
reported separately, and only the REQUIRED tier gates the build. Binary pass/fail
(never a fuzzy 0.7) because binary is faster for judges to converge on and is
what a κ-validation pass expects.

Each question is graded three ways:

- **Deterministic checkers** — exact/tolerance value match against the fixture's
  independent oracle, Ramp money-format compliance, the read-only invariant,
  grounded-in-a-real-tool-call. No model in the loop, so the CI gate is
  deterministic.
- **Trajectory assertions** — catalog-before-query, docs-before-query, bounded
  retries, convergence.
- **A binary LLM judge** — answer faithfulness, provider-agnostic, ADDITIONAL-tier
  only. A judge is only trustworthy once measured; the Cohen's/Fleiss' κ
  validation pipeline for that lives in the methodology hub,
  [veriva-eval](https://github.com/theruviparambil/veriva-eval), and this repo
  marks where its output attaches.

## The fixture is the ground truth

One synthetic company, **Vela Robotics** — 15 users across 6 departments, **207**
card transactions over Q2 2026, plus vendors and AP bills. Generated from a fixed
seed (integer cents, no float drift), so every run sees identical data. Because we
own it, every question has an exact expected answer, computed by a TypeScript
oracle that is deliberately *independent* of the agent's DuckDB path. When a
checker says the two agree, that's two implementations agreeing.

Four patterns are planted so the analyst has something real to find:

| Pattern | What's planted | Exact ground truth |
|---|---|---|
| **(a) Duplicate charge** | Datadog billed twice, days apart | `$8,400.00` on 2026-05-12 **and** 2026-05-15 (and it must *not* flag the recurring monthly Datadog charge) |
| **(b) Vendor variant** | Same airline, two spellings | `Delta Air Lines` + `Delta Airlines` = **`$4,387.00`** combined |
| **(c) Out-of-policy** | A dinner over the meals cap | Nobu `$6,750.00`, flagged `OUT_OF_POLICY` (policy caps single meals at $500) |
| **(d) MoM spike** | One category jumps | Advertising `$12,500.00` (May) → `$50,000.00` (June), **4.0x**, driven by Google Ads |

Headline aggregates the agent is expected to reach: net Q2 spend **$188,925.60**
(gross $189,427.10 less $501.50 refunds), top vendor **Google Ads $42,500.00**,
top department **Engineering $92,005.81**, top spender **Priya Nair $85,112.86**,
open AP bills **$25,750.00**.

The fixture reproduces Ramp's real gotchas on purpose: transaction amounts come
back as formatted strings (`"$6,750.00"`), bill amounts as numbers;
`merchant_name` is un-normalized, so a naive `GROUP BY merchant_name` splits Delta
in two and under-reports it (q05 is exactly that trap).

## The golden set

12 questions. Four target the planted patterns directly; the rest cover totals,
group-bys, refunds, bills, and the user directory. Every REQUIRED criterion is
deterministic; ADDITIONAL mixes deterministic checks with the faithfulness judge.

| # | Question | Expected | Notable criteria |
|---|---|---|---|
| q01 | Total net card spend | `$188,925.60` | REQ value/read-only/grounded/rationale |
| q02 | Top vendor | Google Ads `$42,500.00` | REQ names vendor + amount · ADD path, cite |
| q03 | Spend by department | Engineering `$92,005.81` | ADD full six-department table |
| q04 | Duplicate charges | Datadog `$8,400.00`, 05-12 & 05-15 | REQ names Datadog + amount · ADD both dates |
| q05 | Total Delta spend | `$4,387.00` (both spellings) | REQ must sum variants · ADD names both spellings |
| q06 | Out-of-policy txns | Nobu `$6,750.00` | REQ merchant + amount · ADD cites $500 policy |
| q07 | Biggest MoM increase | Advertising, +`$37,500.00` (4.0x) | REQ category + figure · ADD quantifies, names driver |
| q08 | Top spender | Priya Nair `$85,112.86` | REQ names user + amount |
| q09 | SaaS/software total | `$35,598.00` | ADD names a top software vendor |
| q10 | Refunds, gross vs net | 2 refunds `$501.50`; net `$188,925.60` | REQ acknowledges refunds + net · ADD gross + refund line |
| q11 | Open bills owed | `$25,750.00` (2 bills) | REQ open total · ADD count, open-vs-paid |
| q12 | Active users + avg spend | 13 active; avg `$14,532.74` | REQ active count · ADD avg per active user |

## Architecture

One interface, two backends. The agent, the tool registry, and the eval never
know which is behind them.

```
question ─▶ agent loop ─▶ RampToolSurface ─┬─ fixture backend  (default)
           (LLMClient)   (8 read tools)     │    └─ in-process DuckDB + docs handshake
                                            └─ live backend     (RAMP_MODE=live)
                                                 └─ Ramp MCP over OAuth/PKCE (stub)
              │
              └─▶ Trajectory ─▶ eval: deterministic checkers + trajectory
                                      assertions + binary LLM judge ─▶ two-tier report + CI gate
```

- **Provider-agnostic, zero SDK.** The LLM client is `fetch` against OpenAI-compatible
  or Anthropic APIs, resolved from whichever key is present (`OPENROUTER` >
  `OPENAI` > `ANTHROPIC`). No vendor SDKs, mirroring veriva-eval.
- **Real SQL.** `execute_analyst_query` runs against an actual in-process DuckDB
  built from the fixture, so SQL errors are real and the self-correction loop has
  something authentic to fix.
- **Testable offline.** The agent loop is driven by a scripted LLM client
  (promptfoo's `_ScriptedClient` pattern) while the tool calls still hit the real
  backend and DuckDB. 60 tests, no network, no key.

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
    provider.ts           fetch-based tool-calling client (openai + anthropic)
    scripted.ts           offline test double
    agent.ts              the read-only, self-correcting loop
    system-prompt.ts      Ramp house conventions
  eval/
    golden.ts             the 12 questions + tier criteria
    checkers.ts           deterministic checkers
    trajectory.ts         reasoning-path assertions
    judge.ts              binary faithfulness judge
    rubric.ts             two-tier scorer + CI gate
    run.ts                orchestrator, cost capture, out/ artifacts
```

## Live mode — bring your own sandbox

`RAMP_MODE=live` routes the identical tool calls to Ramp's real MCP endpoint
instead of the fixture. The tool names and argument schemas already match, so no
other module changes. Wiring the auth needs Ramp sandbox credentials, so it ships
as a documented stub (`src/ramp/live-backend.ts`) with the contract spelled out:

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

The judge-validation half of this story — proving a grader is reliable with
inter-rater agreement (Cohen's / Fleiss' κ) instead of accuracy — lives in the
companion repo, **[veriva-eval](https://github.com/theruviparambil/veriva-eval)**.
This repo is the agent-and-harness end of the same discipline.

## License

MIT — see [LICENSE](LICENSE).
