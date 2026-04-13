import type { PricingClient } from "../lib/pricing-client.ts";

export interface PricingDocument {
  uriSuffix: string;
  filename: string;
  title: string;
  markdown: string;
  metadata: {
    service: string;
    category: string;
    tags: string[];
  };
}

export interface Fetcher {
  name: string;
  serviceCode: string;
  uriPrefix: string;
  fetch(client: PricingClient): Promise<PricingDocument[]>;
}
