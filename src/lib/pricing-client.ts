import {
  PricingClient as AwsPricingClient,
  GetProductsCommand,
  type Filter,
  type GetProductsCommandOutput,
} from "@aws-sdk/client-pricing";

export class PricingClient {
  private client: AwsPricingClient;

  constructor(region: string = process.env.AWS_REGION || "us-east-1") {
    this.client = new AwsPricingClient({ region });
  }

  async *getProducts(
    serviceCode: string,
    filters: Filter[] = [],
  ): AsyncGenerator<Record<string, unknown>> {
    let nextToken: string | undefined = undefined;
    let pageCount = 0;
    let yieldedTotal = 0;
    let parseFailed = 0;
    do {
      const resp: GetProductsCommandOutput = await this.client.send(
        new GetProductsCommand({
          ServiceCode: serviceCode,
          Filters: filters,
          NextToken: nextToken,
          MaxResults: 100,
        }),
      );
      pageCount++;
      for (const raw of resp.PriceList ?? []) {
        if (raw == null) continue;
        // AWS SDK returns PriceList items as either primitive strings or
        // String wrapper objects (typeof "object", constructor String).
        // `.toString()` returns the JSON primitive for both cases; regular
        // plain objects would return "[object Object]" which JSON.parse rejects.
        const text =
          typeof raw === "string" ? raw : (raw as { toString(): string }).toString();
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          yieldedTotal++;
          yield parsed;
        } catch {
          parseFailed++;
          continue;
        }
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    console.error(
      `[pricing-client] ${serviceCode}: ${pageCount} pages, ${yieldedTotal} products yielded, ${parseFailed} parse failures`,
    );
  }

  async getAllProducts(
    serviceCode: string,
    filters: Filter[] = [],
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for await (const p of this.getProducts(serviceCode, filters)) {
      out.push(p);
    }
    return out;
  }
}
