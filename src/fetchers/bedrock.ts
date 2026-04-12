import type { Fetcher, PricingDocument } from "./types.ts";
import type { PricingClient } from "../lib/pricing-client.ts";
import { renderFrontmatter, renderTable, sanitiseSegment } from "../lib/markdown.ts";

interface BedrockAttrs {
  model?: string;
  modelId?: string;
  titleModelId?: string;
  provider?: string;
  usagetype?: string;
  operation?: string;
  regionCode?: string;
  location?: string;
  inferenceType?: string;
  servicecode?: string;
  servicename?: string;
  feature?: string;
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

function extractModelKey(attrs: BedrockAttrs): { provider: string; model: string } | null {
  const raw = attrs.model || attrs.titleModelId || attrs.modelId || "";
  if (!raw) return null;

  let provider = (attrs.provider || "").toLowerCase();
  let model = raw;

  if (raw.includes(".")) {
    const [p, ...rest] = raw.split(".");
    if (!provider) provider = p.toLowerCase();
    model = rest.join(".");
  }

  if (!provider) {
    const lower = model.toLowerCase();
    if (lower.includes("claude")) provider = "anthropic";
    else if (lower.includes("nova") || lower.includes("titan")) provider = "amazon";
    else if (lower.includes("llama")) provider = "meta";
    else if (lower.includes("mistral") || lower.includes("mixtral")) provider = "mistral";
    else if (lower.includes("command")) provider = "cohere";
    else if (lower.includes("jamba")) provider = "ai21";
    else provider = "unknown";
  }

  return { provider, model };
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

      g.rows.sort((a, b) => {
        const r = a.region.localeCompare(b.region);
        return r !== 0 ? r : a.usageType.localeCompare(b.usageType);
      });

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
        ["Usage type", "Region", "Unit", "Price USD", "Description"],
        g.rows.map((r) => [r.usageType, r.region, r.unit, r.priceUSD, r.description]),
      );

      const title = `${g.provider}/${g.model} — Bedrock pricing`;
      const markdown =
        `${frontmatter}# ${title}\n\n` +
        `Pricing for Amazon Bedrock model **${g.provider}.${g.model}** as reported by the AWS Pricing API.\n\n` +
        `- Provider: \`${g.provider}\`\n` +
        `- Model: \`${g.model}\`\n` +
        `- Regions covered: ${regions.join(", ")}\n` +
        `- Usage types: ${usageTypes.join(", ")}\n` +
        `- Price dimensions: ${g.rows.length}\n` +
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
