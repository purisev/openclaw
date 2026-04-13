import path from "node:path";

export const MEMORY_WIKI_LAYOUT_STYLES = ["default", "karpathy-style"] as const;
export const MEMORY_WIKI_INBOX_MODES = ["file", "directory"] as const;

export type MemoryWikiLayoutStyle = (typeof MEMORY_WIKI_LAYOUT_STYLES)[number];
export type MemoryWikiInboxMode = (typeof MEMORY_WIKI_INBOX_MODES)[number];

export type MemoryWikiLayoutConfig = {
  style?: MemoryWikiLayoutStyle;
  rootIndex?: string;
  overview?: string;
  log?: string;
  inbox?: string;
  inboxMode?: MemoryWikiInboxMode;
  entitiesDir?: string;
  conceptsDir?: string;
  sourcesDir?: string;
  queriesDir?: string;
  synthesesDir?: string;
  reportsDir?: string;
  attachmentsDir?: string;
  viewsDir?: string;
  systemDir?: string;
};

export type ResolvedMemoryWikiLayout = {
  style: MemoryWikiLayoutStyle;
  rootIndex: string;
  overview: string;
  log: string;
  inbox: string;
  inboxMode: MemoryWikiInboxMode;
  entitiesDir: string;
  conceptsDir: string;
  sourcesDir: string;
  queriesDir: string;
  synthesesDir: string;
  reportsDir: string;
  attachmentsDir: string;
  viewsDir: string;
  systemDir: string;
  systemLocksDir: string;
  systemCacheDir: string;
};

function normalizeRelative(input: string | undefined, fallback: string): string {
  const value = (input ?? fallback)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  return value.replace(/^\/+/, "").replace(/\/+$/, "") || fallback;
}

function resolveLayoutDefaults(style: MemoryWikiLayoutStyle) {
  if (style === "karpathy-style") {
    return {
      rootIndex: "wiki/index.md",
      overview: "wiki/overview.md",
      log: "wiki/log.md",
      inbox: "raw/inbox",
      inboxMode: "directory" as const,
      entitiesDir: "wiki/entities",
      conceptsDir: "wiki/concepts",
      sourcesDir: "wiki/sources",
      queriesDir: "wiki/queries",
      synthesesDir: "wiki/syntheses",
      reportsDir: "wiki/reports",
      attachmentsDir: "raw/assets",
      viewsDir: "wiki/views",
      systemDir: ".openclaw-wiki",
    };
  }

  return {
    rootIndex: "index.md",
    overview: "WIKI.md",
    log: "log.md",
    inbox: "inbox.md",
    inboxMode: "file" as const,
    entitiesDir: "entities",
    conceptsDir: "concepts",
    sourcesDir: "sources",
    queriesDir: "queries",
    synthesesDir: "syntheses",
    reportsDir: "reports",
    attachmentsDir: "_attachments",
    viewsDir: "_views",
    systemDir: ".openclaw-wiki",
  };
}

export function resolveWikiPaths(config: {
  layout: MemoryWikiLayoutConfig;
}): ResolvedMemoryWikiLayout {
  const style = config.layout.style ?? "default";
  const defaults = resolveLayoutDefaults(style);
  const systemDir = normalizeRelative(config.layout.systemDir, defaults.systemDir);
  const inboxMode = config.layout.inboxMode ?? defaults.inboxMode;
  return {
    style,
    rootIndex: normalizeRelative(config.layout.rootIndex, defaults.rootIndex),
    overview: normalizeRelative(config.layout.overview, defaults.overview),
    log: normalizeRelative(config.layout.log, defaults.log),
    inbox: normalizeRelative(config.layout.inbox, defaults.inbox),
    inboxMode,
    entitiesDir: normalizeRelative(config.layout.entitiesDir, defaults.entitiesDir),
    conceptsDir: normalizeRelative(config.layout.conceptsDir, defaults.conceptsDir),
    sourcesDir: normalizeRelative(config.layout.sourcesDir, defaults.sourcesDir),
    queriesDir: normalizeRelative(config.layout.queriesDir, defaults.queriesDir),
    synthesesDir: normalizeRelative(config.layout.synthesesDir, defaults.synthesesDir),
    reportsDir: normalizeRelative(config.layout.reportsDir, defaults.reportsDir),
    attachmentsDir: normalizeRelative(config.layout.attachmentsDir, defaults.attachmentsDir),
    viewsDir: normalizeRelative(config.layout.viewsDir, defaults.viewsDir),
    systemDir,
    systemLocksDir: path.posix.join(systemDir, "locks"),
    systemCacheDir: path.posix.join(systemDir, "cache"),
  };
}
