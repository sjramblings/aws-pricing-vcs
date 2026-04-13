import type { Fetcher, PricingDocument } from "./types.ts";
import type { PricingClient } from "../lib/pricing-client.ts";
import { renderFrontmatter, renderTable, sanitiseSegment } from "../lib/markdown.ts";

interface BedrockAttrs {
  model?: string;
  modelId?: string;
  titleModelId?: string;
  titanModel?: string;
  provider?: string;
  usagetype?: string;
  operation?: string;
  regionCode?: string;
  location?: string;
  inferenceType?: string;
  servicecode?: string;
  servicename?: string;
  feature?: string;
  policyType?: string;
  featureType?: string;
}

interface RawProduct {
  product?: { attributes?: BedrockAttrs; productFamily?: string; sku?: string };
  terms?: {
    OnDemand?: Record<
      string,
      {
        priceDimensions?: Record<
          string,
          {
            unit?: string;
            pricePerUnit?: Record<string, string>;
            description?: string;
            endRange?: string;
            beginRange?: string;
          }
        >;
      }
    >;
  };
  publicationDate?: string;
  version?: string;
}

interface PriceRow {
  usageType: string;
  region: string;
  unit: string;
  priceUSD: number;
  description: string;
}

const PROVIDER_ALIASES: Record<string, string> = {
  "mistral-ai": "mistral",
  "moonshot-ai": "moonshot",
  "kimi-ai": "moonshot",
  "minimax-ai": "minimax",
  "z-ai": "zai",
};

function normaliseProvider(raw: string): string {
  // Collapse whitespace and punctuation to hyphens so "Mistral AI" and
  // "mistral-ai" map to the same alias key.
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return PROVIDER_ALIASES[key] ?? key;
}

function inferProviderFromModelName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) return "anthropic";
  if (lower.startsWith("nova") || lower.startsWith("titan")) return "amazon";
  if (lower.startsWith("llama")) return "meta";
  if (lower.startsWith("mistral") || lower.startsWith("mixtral")) return "mistral";
  if (lower.startsWith("command") || lower.startsWith("embed-")) return "cohere";
  if (lower.startsWith("jamba")) return "ai21";
  if (lower.startsWith("gemma")) return "google";
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("palmyra") || lower.startsWith("writer")) return "writer";
  return "unknown";
}

function extractModelKey(attrs: BedrockAttrs): { provider: string; model: string } | null {
  // Pricing API attribute schema varies across providers:
  //   - Older Anthropic/Claude 2/3 and Mistral: `provider` + `model`
  //   - Llama/Nova: `model` only (no `provider`)
  //   - Titan family: `titanModel` only
  // We accept all three shapes and infer provider from the model name when
  // it's missing. SKUs that are guardrails, knowledge bases, or custom model
  // units (no model at all) are correctly filtered out.
  //
  // Do NOT split model strings on ".", which mangles names like
  // "Claude 3.5", "Nova 2.0", and "Mixtral 8x7B v0.1".
  const modelRaw = (
    attrs.model ||
    attrs.titanModel ||
    attrs.titleModelId ||
    attrs.modelId ||
    ""
  ).trim();
  if (!modelRaw) return null;

  const providerRaw = (attrs.provider || "").trim();
  const provider = providerRaw
    ? normaliseProvider(providerRaw)
    : normaliseProvider(inferProviderFromModelName(modelRaw));

  return { provider, model: modelRaw };
}

function toNumber(priceMap: Record<string, string> | undefined): number {
  if (!priceMap) return 0;
  const usd = priceMap.USD ?? Object.values(priceMap)[0] ?? "0";
  const n = parseFloat(usd);
  return Number.isFinite(n) ? n : 0;
}

export const bedrockFetcher: Fetcher = {
  name: "bedrock",
  serviceCode: "AmazonBedrock",
  uriPrefix: "bedrock",

  async fetch(client: PricingClient): Promise<PricingDocument[]> {
    const groups = new Map<
      string,
      { provider: string; model: string; rows: PriceRow[]; publicationDate?: string }
    >();

    let totalSkus = 0;
    let skippedNoModel = 0;

    for await (const raw of client.getProducts("AmazonBedrock") as AsyncGenerator<RawProduct>) {
      totalSkus++;
      const attrs = raw.product?.attributes ?? {};
      const key = extractModelKey(attrs);
      if (!key) {
        skippedNoModel++;
        continue;
      }

      const groupKey = `${key.provider}/${key.model}`;
      let g = groups.get(groupKey);
      if (!g) {
        g = { provider: key.provider, model: key.model, rows: [], publicationDate: raw.publicationDate };
        groups.set(groupKey, g);
      }

      const terms = raw.terms?.OnDemand ?? {};
      for (const offer of Object.values(terms)) {
        for (const dim of Object.values(offer.priceDimensions ?? {})) {
          const price = toNumber(dim.pricePerUnit);
          if (price === 0 && !dim.description) continue;
          g.rows.push({
            usageType: attrs.usagetype || attrs.operation || "(unknown)",
            region: attrs.regionCode || attrs.location || "(global)",
            unit: dim.unit || "unit",
            priceUSD: price,
            description: (dim.description || "").replace(/\|/g, "/").slice(0, 120),
          });
        }
      }
    }

    console.error(
      `[bedrock] fetched ${totalSkus} SKUs, grouped into ${groups.size} models (skipped ${skippedNoModel} SKUs with no model attribute)`,
    );

    const docs: PricingDocument[] = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const g of groups.values()) {
      if (g.rows.length === 0) continue;

      // Nova 2.0 models produce hundreds of SKUs across ~20 regions; raw
      // output blows past 100KB. Collapse rows that share (usageType, unit,
      // price) into a single row listing the regions where that price applies.
      // This preserves all pricing information in a much smaller form.
      // Also strip the verbose description column — its contents duplicate
      // the other columns and add ~100 bytes per row of redundant text.
      // Normalise the region-prefixed usage type so rows for the same
      // dimension in different regions collapse. AWS uses prefixes like
      // "USE1-", "USW2-", "APS2-", "EUW1-" which are just the region code.
      const stripRegionPrefix = (ut: string): string =>
        ut.replace(/^[A-Z]{2,4}\d?-/, "");

      const collapsed = new Map<string, { usageType: string; unit: string; priceUSD: number; regions: Set<string> }>();
      for (const r of g.rows) {
        const normUsage = stripRegionPrefix(r.usageType);
        const key = `${normUsage}|${r.unit}|${r.priceUSD}`;
        let entry = collapsed.get(key);
        if (!entry) {
          entry = { usageType: normUsage, unit: r.unit, priceUSD: r.priceUSD, regions: new Set() };
          collapsed.set(key, entry);
        }
        entry.regions.add(r.region);
      }
      const collapsedRows = Array.from(collapsed.values())
        .map((c) => ({
          usageType: c.usageType,
          regions: Array.from(c.regions).sort().join(", "),
          unit: c.unit,
          priceUSD: c.priceUSD,
        }))
        .sort((a, b) => a.usageType.localeCompare(b.usageType));

      const regions = Array.from(new Set(g.rows.map((r) => r.region))).sort();
      const usageTypes = Array.from(new Set(g.rows.map((r) => r.usageType))).sort();

      const frontmatter = renderFrontmatter({
        service: "bedrock",
        provider: g.provider,
        model: g.model,
        model_id: `${g.provider}.${g.model}`,
        fetched: today,
        source: "AWS Pricing API (AmazonBedrock)",
        regions,
        usage_types: usageTypes,
        price_dimensions: g.rows.length,
      });

      const table = renderTable(
        ["Usage type", "Regions", "Unit", "Price USD"],
        collapsedRows.map((r) => [r.usageType, r.regions, r.unit, r.priceUSD]),
      );

      const title = `${g.provider}/${g.model} — Bedrock pricing`;
      const markdown =
        `${frontmatter}# ${title}\n\n` +
        `Pricing for Amazon Bedrock model **${g.provider}.${g.model}** as reported by the AWS Pricing API.\n\n` +
        `- Provider: \`${g.provider}\`\n` +
        `- Model: \`${g.model}\`\n` +
        `- Regions covered: ${regions.join(", ")}\n` +
        `- Usage types: ${usageTypes.join(", ")}\n` +
        `- Price dimensions: ${collapsedRows.length} (collapsed from ${g.rows.length} SKU rows)\n` +
        `- Fetched: ${today}\n\n` +
        `## Pricing dimensions\n\n${table}\n\n` +
        `## Notes\n\n` +
        `- Prices are on-demand only (no Provisioned Throughput, Savings Plans, or private offers).\n` +
        `- "Unit" reflects AWS Pricing API native units (e.g. 1K input tokens, per image).\n` +
        `- Prices in USD; convert to other currencies via published FX.\n` +
        `- Source: AWS Pricing API \`GetProducts(ServiceCode=AmazonBedrock)\`.\n`;

      const suffix = `${sanitiseSegment(g.provider)}/${sanitiseSegment(g.model)}`;
      docs.push({
        uriSuffix: suffix,
        filename: `${sanitiseSegment(g.model)}.md`,
        title,
        markdown,
        metadata: {
          service: "bedrock",
          category: "model",
          tags: [g.provider, g.model, "pricing", "bedrock"],
        },
      });
    }

    docs.sort((a, b) => a.uriSuffix.localeCompare(b.uriSuffix));
    return docs;
  },
};
