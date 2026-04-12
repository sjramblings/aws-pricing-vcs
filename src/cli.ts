#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { PricingClient } from "./lib/pricing-client.ts";
import { VcsClient, loadVcsEnv, sleep } from "./lib/vcs-client.ts";
import { getFetcher, listFetchers } from "./fetchers/registry.ts";

const VCS_BASE_URI = "viking://schema/aws-pricing/";
const INGEST_INSTRUCTION =
  "This is an AWS service pricing document. Extract: model/resource identifier, pricing dimensions (input/output/cache/storage/compute), supported regions, unit of measurement, and effective/fetched date. Preserve exact numeric prices for cost modelling.";
const MAX_FILE_BYTES = 100_000;
const RATE_LIMIT_MS = 500;

const program = new Command();
program
  .name("aws-pricing-vcs")
  .description("Fetch AWS pricing data and ingest it into Viking Context Service")
  .version("0.1.0");

program
  .command("list-services")
  .description("List registered pricing fetchers")
  .action(() => {
    const fetchers = listFetchers();
    if (fetchers.length === 0) {
      console.log("(no fetchers registered)");
      return;
    }
    console.log("Registered fetchers:");
    for (const f of fetchers) {
      console.log(`  ${f.name.padEnd(16)} service=${f.serviceCode} uri=${VCS_BASE_URI}${f.uriPrefix}/`);
    }
  });

program
  .command("ingest")
  .description("Fetch pricing for a service and ingest into VCS")
  .requiredOption("-s, --service <name>", "Service fetcher name (e.g. bedrock)")
  .option("--dry-run", "Generate docs but do not POST to VCS; write to data/dry-run/", false)
  .option("--region <region>", "AWS region for the Pricing API", process.env.AWS_REGION || "us-east-1")
  .action(async (opts: { service: string; dryRun: boolean; region: string }) => {
    const fetcher = getFetcher(opts.service);
    console.error(`[cli] service=${fetcher.name} serviceCode=${fetcher.serviceCode} dryRun=${opts.dryRun}`);

    const pricing = new PricingClient(opts.region);
    const docs = await fetcher.fetch(pricing);

    console.error(`[cli] generated ${docs.length} documents`);
    if (docs.length === 0) {
      console.error("[cli] nothing to ingest");
      process.exit(1);
    }

    let oversize = 0;
    for (const d of docs) {
      const size = Buffer.byteLength(d.markdown, "utf-8");
      if (size > MAX_FILE_BYTES) {
        oversize++;
        console.error(`[warn] ${d.uriSuffix} is ${size} bytes (>${MAX_FILE_BYTES})`);
      }
    }
    if (oversize > 0) {
      console.error(`[cli] ${oversize} document(s) exceed VCS 100KB ceiling — they will still be sent but may be rejected`);
    }

    if (opts.dryRun) {
      const outDir = join(process.cwd(), "data", "dry-run", fetcher.name);
      mkdirSync(outDir, { recursive: true });
      for (const d of docs) {
        const safePath = join(outDir, d.uriSuffix.replace(/\//g, "__") + ".md");
        writeFileSync(safePath, d.markdown, "utf-8");
      }
      console.error(`[cli] dry-run: wrote ${docs.length} files to ${outDir}`);
      console.log(docs[0]?.markdown || "");
      return;
    }

    const creds = loadVcsEnv();
    const vcs = new VcsClient(creds);

    let ok = 0;
    let fail = 0;
    for (const d of docs) {
      const uriPrefix = `${VCS_BASE_URI}${fetcher.uriPrefix}/${d.uriSuffix}/`;
      const result = await vcs.ingest({
        content: d.markdown,
        uriPrefix,
        filename: d.filename,
        instruction: INGEST_INSTRUCTION,
      });
      if (result.ok) {
        ok++;
        console.error(`[ok]   ${uriPrefix}${d.filename}${result.uri ? ` → ${result.uri}` : ""}`);
      } else {
        fail++;
        console.error(`[fail] ${uriPrefix}${d.filename} status=${result.status} ${result.error || ""}`);
      }
      await sleep(RATE_LIMIT_MS);
    }

    console.error(`[cli] done: ${ok} ok, ${fail} fail, ${docs.length} total`);
    process.exit(fail === 0 ? 0 : 2);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`[error] ${(e as Error).message}`);
  process.exit(1);
});
