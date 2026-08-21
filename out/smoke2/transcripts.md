### What was Vela Robotics' total net card spend in Q2 2026 (April 1 – June 30), after refunds?

**1. `get_analyst_catalog`**: _I need to identify the available curated analyst tables before querying total card spend for the specified Q2 2026 period._
```json
{
  "analyst_tables": [
    {
      "qualified_name": "analyst.spend_facts",
      "schema_name": "analyst",
      "table_name": "spend_facts",
      "availability": "queryable",
      "column_count": 12,
      "row_count": 217,
      "source_tables": [
        "core.card_transactions",
        "core.spend_events"
      ],
      "starter_queries": [
        "SELECT spend_facts.transaction_date, spend_facts.amount FROM analyst.spend_facts ORDER BY spend_facts.transaction_date DESC LIMIT 20",
        "SELECT spend_facts.spend_program, COUNT(*) AS n FROM analyst.spend_facts GROUP BY spend_facts.spend_program"
      ]
    },
    {
      "qualified_name": "analyst.user_dim",
      "schema_name": "analyst",
      "table_name": "user_dim",
      "availability": "queryable",
      "column_count": 10,
      "row_count": 15,
      "source_tables": [
        "core.users"
      ],
      "starter_que
… (truncated)
```

**2. `get_analyst_spend_facts_domain_docs`**: _I need the spend_facts grain, date, amount, and spend-program semantics to calculate net card spend including refunds for April 1 through June 30, 2026._
```json
{
  "qualified_name": "analyst.spend_facts",
  "artifact_status": "fresh",
  "table_availability": "queryable",
  "columns": [
    {
      "column_name": "spend_event_uuid",
      "description": "Stable UUID for the card spend event. Use this (not spend_event_id) when filtering or joining on a specific event."
    },
    {
      "column_name": "spend_event_id",
      "description": "Integer surrogate id. Never compare this to a UUID string literal."
    },
    {
      "column_name": "transaction_date",
      "description": "DATE the transaction settled. Compare with DATE 'YYYY-MM-DD' literals."
    },
    {
      "column_name": "amount",
      "description": "Signed DECIMAL in whole dollars (USD). Positive = spend, negative = refund/credit. Sum directly for net spend; filter amount > 0 for gross."
    },
    {
      "column_name": "currency",
      "description": "ISO currency code. All 
… (truncated)
```

**3. `execute_analyst_query`**: _I need to sum signed card-spend amounts during Q2 2026 to obtain net spend after refunds, with gross and refund components as validation._
```sql
SELECT SUM(sf.amount) AS net_spend_usd, SUM(CASE WHEN sf.amount > 0 THEN sf.amount ELSE 0 END) AS gross_spend_usd, SUM(CASE WHEN sf.amount < 0 THEN sf.amount ELSE 0 END) AS refunds_usd FROM analyst.spend_facts AS sf WHERE sf.transaction_date >= DATE '2026-04-01' AND sf.transaction_date <= DATE '2026-06-30'
```
```json
{
  "status": "success",
  "execution_mode": "materialized",
  "columns": [
    {
      "key": "net_spend_usd",
      "label": "net_spend_usd",
      "format": "money"
    },
    {
      "key": "gross_spend_usd",
      "label": "gross_spend_usd",
      "format": "money"
    },
    {
      "key": "refunds_usd",
      "label": "refunds_usd",
      "format": "text"
    }
  ],
  "rows": [
    {
      "net_spend_usd": 188925.6,
      "gross_spend_usd": 189427.1,
      "refunds_usd": -501.5
    }
  ],
  "row_count": 1,
  "total_row_count": 1,
  "truncated": false,
  "referenced_tables": [
    "analyst.spend_facts"
  ],
  "message": null,
  "external_agent_messages": []
}
```

**Answer:**

Vela Robotics’ total **net card spend in Q2 2026 was $188,925.60**. This reflects $189,427.10 in charges less $501.50 in refunds, based on settled card transactions dated April 1 through June 30. (Source: `analyst.spend_facts` aggregate query.)

```json
{"net_spend_usd": 188925.6}
```

---

### Which vendor did we spend the most with in Q2, and how much?

**1. `get_analyst_catalog`**: _I need to identify the available analyst tables before querying Q2 spend by vendor._
```json
{
  "analyst_tables": [
    {
      "qualified_name": "analyst.spend_facts",
      "schema_name": "analyst",
      "table_name": "spend_facts",
      "availability": "queryable",
      "column_count": 12,
      "row_count": 217,
      "source_tables": [
        "core.card_transactions",
        "core.spend_events"
      ],
      "starter_queries": [
        "SELECT spend_facts.transaction_date, spend_facts.amount FROM analyst.spend_facts ORDER BY spend_facts.transaction_date DESC LIMIT 20",
        "SELECT spend_facts.spend_program, COUNT(*) AS n FROM analyst.spend_facts GROUP BY spend_facts.spend_program"
      ]
    },
    {
      "qualified_name": "analyst.user_dim",
      "schema_name": "analyst",
      "table_name": "user_dim",
      "availability": "queryable",
      "column_count": 10,
      "row_count": 15,
      "source_tables": [
        "core.users"
      ],
      "starter_que
… (truncated)
```

**2. `get_analyst_spend_facts_domain_docs`**: _I need the spend fact grain, date and amount semantics to calculate Q2 vendor spend correctly._
```json
{
  "qualified_name": "analyst.spend_facts",
  "artifact_status": "fresh",
  "table_availability": "queryable",
  "columns": [
    {
      "column_name": "spend_event_uuid",
      "description": "Stable UUID for the card spend event. Use this (not spend_event_id) when filtering or joining on a specific event."
    },
    {
      "column_name": "spend_event_id",
      "description": "Integer surrogate id. Never compare this to a UUID string literal."
    },
    {
      "column_name": "transaction_date",
      "description": "DATE the transaction settled. Compare with DATE 'YYYY-MM-DD' literals."
    },
    {
      "column_name": "amount",
      "description": "Signed DECIMAL in whole dollars (USD). Positive = spend, negative = refund/credit. Sum directly for net spend; filter amount > 0 for gross."
    },
    {
      "column_name": "currency",
      "description": "ISO currency code. All 
… (truncated)
```

**3. `get_analyst_table_domain_docs`**: _I need the canonical merchant fields and join key to group Q2 spend by vendor rather than unnormalized merchant names._
```json
{
  "qualified_name": "analyst.merchant_dim",
  "artifact_status": "fresh",
  "table_availability": "queryable",
  "columns": [
    {
      "column_name": "merchant_uuid",
      "description": "Stable merchant UUID. Join target for spend_facts.merchant_uuid."
    },
    {
      "column_name": "merchant_name",
      "description": "Raw merchant name as captured (may be a variant spelling)."
    },
    {
      "column_name": "normalized_merchant_name",
      "description": "Canonical vendor name. Multiple raw merchant_name spellings map to one normalized_merchant_name. GROUP BY this for true per-vendor totals."
    },
    {
      "column_name": "merchant_category",
      "description": "Merchant category label."
    }
  ],
  "sections": [
    {
      "title": "Grain",
      "content": "One row per raw merchant record. Several rows can share a normalized_merchant_name when the same vendor w
… (truncated)
```

**4. `get_analyst_table_domain_docs`**: _I need to determine whether Q2 vendor spend should include AP bills and how their vendor and payment dates are represented before calculating an all-spend vendor total._
```json
{
  "qualified_name": "analyst.ap_bill_facts",
  "artifact_status": "fresh",
  "table_availability": "queryable",
  "columns": [
    {
      "column_name": "bill_uuid",
      "description": "Stable bill UUID."
    },
    {
      "column_name": "payee_uuid",
      "description": "Vendor/payee UUID."
    },
    {
      "column_name": "payee_name",
      "description": "Vendor/payee name."
    },
    {
      "column_name": "amount",
      "description": "Bill amount, DECIMAL dollars (USD). Positive."
    },
    {
      "column_name": "currency",
      "description": "ISO currency code."
    },
    {
      "column_name": "invoice_number",
      "description": "Vendor invoice number."
    },
    {
      "column_name": "payment_status",
      "description": "'PAID' or 'OPEN'. OPEN = an unpaid commitment."
    },
    {
      "column_name": "issue_date",
      "description": "DATE the bill was i
… (truncated)
```

**5. `execute_analyst_query`**: _I need the top canonical vendor by net settled card spend during Q2 2026, combining raw merchant-name variants through merchant_dim._
```sql
SELECT md.normalized_merchant_name AS vendor_name, SUM(sf.amount) AS net_spend_usd
FROM analyst.spend_facts AS sf
JOIN analyst.merchant_dim AS md ON sf.merchant_uuid = md.merchant_uuid
WHERE sf.transaction_date >= DATE '2026-04-01'
  AND sf.transaction_date < DATE '2026-07-01'
GROUP BY md.normalized_merchant_name
ORDER BY net_spend_usd DESC
LIMIT 1
```
```json
{
  "status": "success",
  "execution_mode": "materialized",
  "columns": [
    {
      "key": "vendor_name",
      "label": "vendor_name",
      "format": "text"
    },
    {
      "key": "net_spend_usd",
      "label": "net_spend_usd",
      "format": "money"
    }
  ],
  "rows": [
    {
      "vendor_name": "Google Ads",
      "net_spend_usd": 42500
    }
  ],
  "row_count": 1,
  "total_row_count": 1,
  "truncated": false,
  "referenced_tables": [
    "analyst.spend_facts",
    "analyst.merchant_dim"
  ],
  "message": null,
  "external_agent_messages": []
}
```

**Answer:**

Google Ads was the top vendor in Q2 2026, with **$42,500.00** in net settled card spend. This groups merchant-name variants using the canonical merchant dimension; AP bills are separate and not included.

```json
{"top_vendor": {"name": "Google Ads", "spend_usd": 42500}}
```
