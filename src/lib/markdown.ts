export function renderFrontmatter(fields: Record<string, string | number | string[]>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((s) => JSON.stringify(s)).join(", ")}]`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

export function renderTable(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c)).join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

export function sanitiseSegment(segment: string): string {
  let s = segment.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  s = s.replace(/^[^a-z0-9]+/, "");
  s = s.replace(/-+/g, "-");
  return s || "unnamed";
}
