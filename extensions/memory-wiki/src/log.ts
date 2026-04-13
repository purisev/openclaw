import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { resolveWikiPaths } from "./layout.js";

export type MemoryWikiLogEntry = {
  type: "init" | "ingest" | "compile" | "lint" | "query";
  timestamp: string;
  details?: Record<string, unknown>;
};

function renderHumanLogEntry(entry: MemoryWikiLogEntry): string {
  const summary =
    entry.type === "init"
      ? "vault initialized"
      : entry.type === "ingest"
        ? "source ingested"
        : entry.type === "compile"
          ? "wiki compiled"
          : entry.type === "lint"
            ? "wiki linted"
            : "query filed";
  const detailLines = Object.entries(entry.details ?? {})
    .map(([key, value]) => {
      if (value === undefined) {
        return null;
      }
      return `- ${key}: ${typeof value === "string" ? value : `\`${JSON.stringify(value)}\``}`;
    })
    .filter((line): line is string => Boolean(line));
  return [`## [${entry.timestamp}] ${entry.type} | ${summary}`, "", ...detailLines, ""].join("\n");
}

export async function appendMemoryWikiLog(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
  config?: ResolvedMemoryWikiConfig,
): Promise<void> {
  const layout = resolveWikiPaths({ layout: config?.layout ?? {} });
  const jsonLogPath = path.join(vaultRoot, layout.systemDir, "log.jsonl");
  await fs.mkdir(path.dirname(jsonLogPath), { recursive: true });
  await fs.appendFile(jsonLogPath, `${JSON.stringify(entry)}\n`, "utf8");

  const humanLogPath = path.join(vaultRoot, layout.log);
  await fs.mkdir(path.dirname(humanLogPath), { recursive: true });
  const header = "# Wiki Log\n\n";
  const existing = await fs.readFile(humanLogPath, "utf8").catch(() => header);
  const next = `${existing.trimEnd()}\n\n${renderHumanLogEntry(entry)}`.replace(/^\s*$/, header);
  await fs.writeFile(humanLogPath, `${next.trimEnd()}\n`, "utf8");
}
