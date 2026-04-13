import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface VcsCreds {
  apiUrl: string;
  apiKey: string;
}

export function loadVcsEnv(): VcsCreds {
  const fromProcess = {
    apiUrl: process.env.VCS_API_URL,
    apiKey: process.env.VCS_API_KEY,
  };
  if (fromProcess.apiUrl && fromProcess.apiKey) {
    return { apiUrl: fromProcess.apiUrl, apiKey: fromProcess.apiKey };
  }

  const candidates = [
    join(process.cwd(), ".env"),
    join(homedir(), ".claude", ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const env: Record<string, string> = {};
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    if (env.VCS_API_URL && env.VCS_API_KEY) {
      return { apiUrl: env.VCS_API_URL, apiKey: env.VCS_API_KEY };
    }
  }

  throw new Error(
    "VCS credentials not found. Set VCS_API_URL and VCS_API_KEY in env or .env",
  );
}

export interface IngestParams {
  content: string;
  uriPrefix: string;
  filename: string;
  instruction: string;
}

export interface IngestResult {
  ok: boolean;
  status: number;
  uri?: string;
  error?: string;
}

export class VcsClient {
  constructor(private creds: VcsCreds) {}

  async ingest(params: IngestParams): Promise<IngestResult> {
    const baseUrl = this.creds.apiUrl.endsWith("/")
      ? this.creds.apiUrl
      : this.creds.apiUrl + "/";
    const contentBase64 = Buffer.from(params.content).toString("base64");

    try {
      const resp = await fetch(`${baseUrl}resources`, {
        method: "POST",
        headers: {
          "x-api-key": this.creds.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content_base64: contentBase64,
          uri_prefix: params.uriPrefix,
          filename: params.filename,
          instruction: params.instruction,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const status = resp.status;
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, status, error: text.slice(0, 400) };
      }
      const body = (await resp.json().catch(() => ({}))) as { uri?: string };
      return { ok: true, status, uri: body.uri };
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
    }
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
