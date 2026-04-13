# LLM validation prompts

A checklist of prompts for validating that AWS Bedrock pricing data ingested by this pipeline is actually **retrievable, grounded, and useful** when consumed by an LLM through VCS.

The pipeline ingests pricing at `viking://schema/aws-pricing/bedrock/<provider>/<model>/<model>.md`. Each document is summarised by VCS into L0 (~100 token abstract), L1 (~2K token overview), and L2 (full markdown in S3). A correctly configured LLM agent should follow a **scan → decide → load** retrieval pattern: search L0 abstracts, pick the most relevant hit(s), then load L1 or L2 only for the winners.

## How to run this suite

1. Run the ingestion end-to-end: `bun run src/cli.ts ingest --service bedrock`
2. Point your LLM agent at the same VCS instance (the one holding `viking://schema/aws-pricing/bedrock/`)
3. Feed each prompt below into the agent, one at a time, with a **fresh context** per prompt (so the agent is forced to use VCS rather than recall prior answers)
4. Check the response against the **Pass criteria** for each prompt
5. If a prompt fails, inspect the agent's tool-call trace: did it call `vcs find` first? Did it load the right URI at the right level?

All "expected" prices below are illustrative only — check them against the actual ingested L2 content before treating any test as failed. Prices change; this file is not a ground-truth price sheet.

---

## 1. Direct model lookup

### 1.1 — Named retrieval by model family

> **Prompt:** "What does Claude 3 Sonnet cost on Amazon Bedrock per 1,000 input tokens in us-east-1?"

**Expected agent behaviour:**
- Calls `vcs find "claude 3 sonnet bedrock pricing"` (or similar)
- Identifies the hit at `viking://schema/aws-pricing/bedrock/anthropic/claude-3-sonnet/`
- Loads L1 (or L2 if L1 summary lacks the region)
- Returns the numeric `input-tokens` price for `us-east-1`, in USD per 1K tokens

**Pass criteria:**
- Answer cites a specific USD price, not "it depends"
- Answer cites the URI or source as evidence
- Tool trace shows a VCS search, not a web search

**Common failures:**
- Agent hallucinates a price from training data (check: does the answer change between runs without ingestion?)
- Agent loads L2 unnecessarily (inefficient; L1 should suffice for single-price lookup)

---

### 1.2 — Named retrieval by provider

> **Prompt:** "List every Mistral model available on Bedrock and its input-token pricing in us-west-2."

**Expected agent behaviour:**
- Calls `vcs find "mistral bedrock models"` or scopes a scan to `viking://schema/aws-pricing/bedrock/mistral/`
- Loads L0 abstracts for each Mistral doc to build the list
- May need to load L1/L2 for the specific us-west-2 input-token rows

**Pass criteria:**
- Returns ≥ 3 Mistral models (Mistral 7B, Mistral Large, Mixtral 8x7B at minimum, plus newer variants if present)
- Each entry has a numeric price and the correct region
- Rows that don't have us-west-2 are explicitly flagged, not silently skipped

**Common failures:**
- Agent lists only one provider alias (e.g. misses docs under `mistral-ai` if normalisation regressed)
- Agent lists Mistral models that don't exist (hallucination from training data)

---

### 1.3 — Title family disambiguation

> **Prompt:** "I need pricing for the smallest Nova model. Which one is it, and what does it cost?"

**Expected agent behaviour:**
- Scans abstracts under `viking://schema/aws-pricing/bedrock/amazon/`
- Compares Nova Micro / Lite / Pro / Premier / Canvas / Reel / Sonic
- Identifies `Nova Micro` as the smallest text model

**Pass criteria:**
- Correctly identifies Nova Micro (not Lite or Pro)
- Returns input AND output token pricing, both quoted with region
- Mentions the difference between Nova Micro, Lite, and Pro is size/capability, not pricing structure

---

## 2. Cost modelling

### 2.1 — Scenario-based cost estimate

> **Prompt:** "I want to run Llama 3.3 70B on Bedrock in eu-west-1, processing 50M input tokens and 10M output tokens per month. What's the monthly cost?"

**Expected agent behaviour:**
- Retrieves `viking://schema/aws-pricing/bedrock/meta/llama-3.3-70b/`
- Extracts `llama-3.3-70b-input-tokens` price for eu-west-1
- Extracts `llama-3.3-70b-output-tokens` price for eu-west-1
- Arithmetic: `(50_000_000 / 1000) × input_price + (10_000_000 / 1000) × output_price`

**Pass criteria:**
- Shows the arithmetic step, not just a final number
- Returns a dollar figure with two-decimal precision
- States "on-demand, excluding cross-region inference and batch"

**Common failures:**
- Uses us-east-1 price instead of eu-west-1 (did not filter by region)
- Forgets to divide by 1000 (returns a price ~1000× too high)
- Silently falls back to a different model when eu-west-1 pricing is missing

---

### 2.2 — Comparative cost modelling

> **Prompt:** "For a chatbot that averages 500 input tokens and 300 output tokens per turn at 100K turns/month in us-east-1, compare the monthly Bedrock cost of Claude 3 Haiku vs Nova Lite vs Mistral 7B. Which is cheapest?"

**Expected agent behaviour:**
- Retrieves three model docs in parallel
- Builds a small cost table
- Shows the arithmetic for each row
- Declares a winner with the delta

**Pass criteria:**
- Table has one row per model, columns: input $, output $, monthly total
- The winner is declared with a concrete dollar delta
- Caveats: "prices exclude latency-optimised tiers and provisioned throughput"

---

### 2.3 — Sensitivity to region

> **Prompt:** "Does Claude 3 Sonnet cost the same in every region on Bedrock? If not, which region is cheapest and which is most expensive for input tokens?"

**Expected agent behaviour:**
- Loads L1 or L2 for `anthropic/claude-3-sonnet`
- Scans the `Regions` column for the `input-tokens` row(s)
- If the collapsed table shows a single row with multiple regions at the same price, answer: "prices are uniform across the listed regions"
- Otherwise list the min/max

**Pass criteria:**
- Correctly detects whether rows collapsed to one price or split across regions
- Identifies the actual cheapest/most-expensive region (not hallucinated)

---

## 3. Multi-model comparison and reasoning

### 3.1 — Provider agnostic "best value"

> **Prompt:** "On Bedrock in us-east-1, which provider's flagship model has the lowest output-token price? Include the price and model name."

**Expected agent behaviour:**
- Scans L0 abstracts across all `viking://schema/aws-pricing/bedrock/*` providers
- Filters to "flagship" models (agent judgement — e.g. Claude Opus / Claude 3 Sonnet, Llama 4, Nova Pro, Mistral Large)
- Loads L1 for each to get the us-east-1 output price

**Pass criteria:**
- Answer includes at least 4 providers in the comparison
- Declares a specific winner with a USD price
- Acknowledges that newer Anthropic flagships (Claude 3.5+, 4.x) are not in the Pricing API — see data gap below

---

### 3.2 — Unit normalisation

> **Prompt:** "Some Bedrock models charge per 1,000 tokens, others per image or per second of audio. Give me three examples, one of each unit type, and their prices."

**Expected agent behaviour:**
- Retrieves Nova Canvas (image), Nova Sonic (audio/second), and any text model (1K tokens)
- Quotes the exact `unit` field from the L1/L2 docs

**Pass criteria:**
- Three distinct units demonstrated
- Units match what the ingest pipeline actually writes (`1K tokens`, `image`, `seconds`, etc.)
- Prices are real numbers pulled from the docs

---

## 4. Data gap awareness

### 4.1 — Claude 4.x absence

> **Prompt:** "What does Claude Opus 4.6 cost on Bedrock?"

**Expected agent behaviour:**
- Searches VCS
- Finds no matching document
- Responds explicitly: "No Claude Opus 4.6 document exists in VCS under `viking://schema/aws-pricing/bedrock/`. This is a documented gap — newer Anthropic models (Claude 3.5+, 4.x) are not yet returned by the AWS Pricing API. See the `README.md` known-data-gaps section."

**Pass criteria:**
- Agent **does not** hallucinate a price
- Agent explicitly names the absence and the reason
- Agent points at the README or the pipeline's known-gaps section
- Bonus: suggests the public pricing page as an alternative source

**Common failures (highest severity):**
- Agent returns a made-up price — this is the single most dangerous failure mode and the reason this validation suite exists
- Agent returns Claude 3 Sonnet's price because it's the "closest match" without saying so

---

### 4.2 — Out-of-scope ask

> **Prompt:** "What's the Savings Plans discount for Claude 3 Sonnet on Bedrock?"

**Expected agent behaviour:**
- Searches VCS, finds only on-demand pricing dimensions
- Responds: "The ingested data only contains on-demand pricing. Savings Plans, Provisioned Throughput, Reserved capacity, and private offers are out of scope for this dataset — see README scope section."

**Pass criteria:**
- Agent does not invent a discount percentage
- Agent explicitly cites the scope boundary

---

## 5. Retrieval efficiency (scan → decide → load)

### 5.1 — Scan before load

> **Prompt:** "I just want a rough idea of what's the most expensive Bedrock model per output token, I don't need every region."

**Expected agent behaviour:**
- Uses `vcs find` to scan L0 abstracts (which contain a one-sentence summary)
- Based on abstracts, loads L1 (NOT L2) for the top 2-3 candidates only
- Returns the answer with a price

**Pass criteria:**
- Tool trace shows **at most** 3 L1 or L2 loads
- Tool trace does **not** load L2 for every model (the wasteful anti-pattern)
- Answer is directionally correct even without loading every doc

**Common failures:**
- Agent bulk-loads every doc under `bedrock/*` — signals the scan step was skipped
- Agent fails to answer because it could not find a definitive ranking — acceptable if it explains why

---

### 5.2 — Narrow scope

> **Prompt:** "Within `viking://schema/aws-pricing/bedrock/meta/` only, list every Llama model and its parameter size."

**Expected agent behaviour:**
- Scoped scan rather than unscoped `vcs find`
- Lists Llama 3, 3.1 (405B/70B/8B), 3.2 (1B/3B/11B/90B), 3.3, Llama 4 variants

**Pass criteria:**
- Lists only Meta/Llama models, no cross-provider leakage
- Parameter sizes match the model name in the doc
- Agent uses scope filtering, not a full scan followed by client-side filter

---

## 6. Smoke test (quick pre-flight)

Before running the full suite, run this 30-second sanity check:

```bash
# 1. Confirm docs were ingested
vcs find "bedrock pricing" --scope viking://schema/aws-pricing/bedrock/ | head

# 2. Confirm L2 is retrievable for a known-good model
vcs read viking://schema/aws-pricing/bedrock/anthropic/claude-3-sonnet/claude-3-sonnet.md --level 2

# 3. Confirm parent directory rollup was generated
vcs read viking://schema/aws-pricing/bedrock/ --level 1
```

If any of the three fail, the full prompt suite will also fail — fix ingestion before running the LLM validation.

---

## Scoring

| Category | Prompts | Weight | Notes |
|---|---|---|---|
| Direct lookup | 1.1, 1.2, 1.3 | 30% | Must work for the pipeline to be useful at all |
| Cost modelling | 2.1, 2.2, 2.3 | 25% | The primary use case — customer proposals |
| Multi-model comparison | 3.1, 3.2 | 15% | Tests retrieval breadth |
| Data gap awareness | 4.1, 4.2 | **25%** | **Highest severity — hallucination is the dealbreaker** |
| Retrieval efficiency | 5.1, 5.2 | 5% | Token-cost hygiene; lower severity |

A passing run is ≥ 80% overall AND **100% on category 4** (data gap awareness). A run that hallucinates a price for a missing model is a hard fail regardless of other scores.

## Regression tracking

Each time the ingestion pipeline changes (new fetcher, altered chunk strategy, new provider alias), re-run the full suite. Record failures in a date-stamped note — that's how you'll notice silent regressions from AWS Pricing API schema drift.
