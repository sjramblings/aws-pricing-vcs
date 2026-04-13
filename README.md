# aws-pricing-vcs

Fetch AWS service pricing from the AWS Pricing API and ingest it into **Viking Context Service (VCS)** as searchable L0/L1/L2 context so LLMs can build accurate cost models on demand.

Bedrock is the first supported service; the pipeline is built around a pluggable `Fetcher` interface so any service with public Pricing API data can be added with a single new file.

## Why VCS?

VCS stores each document at three levels — L0 abstract (~100 tokens), L1 overview (~2K tokens), L2 full content in S3. Semantic retrieval scans L0 abstracts first, then loads L1/L2 only for the winners. This gives an LLM the whole AWS pricing catalogue at a fraction of the token cost of pasting raw CSV.

## Install

```bash
bun install
cp .env.example .env  # fill in VCS_API_URL, VCS_API_KEY, AWS_REGION
```

AWS credentials are resolved via the default provider chain (env vars, `~/.aws/credentials`, or IMDS). The Pricing API is only available in `us-east-1` and `ap-south-1`.

## Usage

```bash
# list registered fetchers
bun run src/cli.ts list-services

# dry-run: write generated markdown to data/dry-run/bedrock/ and print the first doc
bun run src/cli.ts ingest --service bedrock --dry-run

# real ingest into VCS
bun run src/cli.ts ingest --service bedrock
```

Each Bedrock model lands at `viking://schema/aws-pricing/bedrock/<provider>/<model>/<model>.md`. Re-running overwrites the latest; there is no snapshot history.

## Retrieving the data from VCS

```bash
vcs find "claude opus bedrock pricing eu-west-1"
vcs read viking://schema/aws-pricing/bedrock/anthropic/claude-opus-4-6/claude-opus-4-6.md --level 2
```

## Adding a new service

1. Create `src/fetchers/<service>.ts` implementing the `Fetcher` interface from `src/fetchers/types.ts`.
2. Register it in `src/fetchers/registry.ts`.
3. Run `bun run src/cli.ts ingest --service <service> --dry-run` and inspect `data/dry-run/<service>/`.

A fetcher receives a `PricingClient` (wrapping `@aws-sdk/client-pricing` with pagination) and returns an array of `PricingDocument` objects — each becomes one VCS entry. Aim for 5–30KB per document; VCS rejects files over 100KB.

## Architecture

```
src/
├── cli.ts                     # commander entry point
├── lib/
│   ├── pricing-client.ts      # AWS Pricing API wrapper + pagination
│   ├── vcs-client.ts          # POST /resources + credential loader
│   └── markdown.ts            # frontmatter + table rendering
└── fetchers/
    ├── types.ts               # Fetcher + PricingDocument interfaces
    ├── registry.ts            # name → Fetcher map
    └── bedrock.ts             # AmazonBedrock → one doc per model
```

## Known data gaps

The AWS Pricing API does not expose every Bedrock model. Observed gaps as of 2026-04-13:

- **Newer Anthropic Claude models** (Claude 3.5 Sonnet, Claude 4, Sonnet 4.6, Opus 4.6, Haiku 4.5) are **not** returned by `GetProducts(ServiceCode=AmazonBedrock)`. Only Claude 2.x, Claude 3 Sonnet, Claude 3 Haiku, and Claude Instant appear. Use the published pricing page or the model-card API for newer Claude prices until AWS adds them.
- **Guardrails, Knowledge Bases, and Custom Model Units** (~577 SKUs) are skipped because they are not per-model inference pricing. Add a separate fetcher if they become relevant.
- **Oversized docs**: Nova 2.0 Omni and Nova 2.0 Pro currently generate ~120–130KB markdown documents (~20–30% over the informal 100KB guideline) due to their broad cross-region × usage-type matrix. VCS may still accept them; the CLI warns but does not block.

## Scope

**In:** on-demand public pricing via the Pricing API, overwrite-latest ingestion, CLI only.

**Out:** Reserved Instances, Savings Plans, Spot, private offers, historical snapshots, scheduled runs, non-Bedrock fetchers (yet).
