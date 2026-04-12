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
    do {
      const resp: GetProductsCommandOutput = await this.client.send(
        new GetProductsCommand({
          ServiceCode: serviceCode,
          Filters: filters,
          NextToken: nextToken,
          MaxResults: 100,
        }),
      );
      for (const raw of resp.PriceList ?? []) {
        const parsed =
          typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
        yield parsed;
      }
      nextToken = resp.NextToken;
    } while (nextToken);
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
