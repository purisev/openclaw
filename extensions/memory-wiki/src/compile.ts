import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  assessClaimFreshness,
  assessPageFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  collectWikiClaimHealth,
  isClaimContestedStatus,
  normalizeClaimStatus,
  WIKI_AGING_DAYS,
  type WikiClaimContradictionCluster,
  type WikiClaimHealth,
  type WikiFreshness,
  type WikiFreshnessLevel,
  type WikiPageContradictionCluster,
} from "./claim-health.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { resolveWikiPaths } from "./layout.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  formatWikiLink,
  parseWikiMarkdown,
  renderWikiMarkdown,
  toWikiPageSummary,
  type WikiClaim,
  type WikiPageKind,
  type WikiPageSummary,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

function getCompilePageGroups(
  config: ResolvedMemoryWikiConfig,
): Array<{ kind: WikiPageKind; dir: string; heading: string }> {
  const layout = resolveWikiPaths(config);
  return [
    { kind: "source", dir: layout.sourcesDir, heading: "Sources" },
    { kind: "entity", dir: layout.entitiesDir, heading: "Entities" },
    { kind: "concept", dir: layout.conceptsDir, heading: "Concepts" },
    { kind: "query", dir: layout.queriesDir, heading: "Queries" },
    { kind: "synthesis", dir: layout.synthesesDir, heading: "Syntheses" },
    { kind: "report", dir: layout.reportsDir, heading: "Reports" },
  ];
}

type DashboardPageDefinition = {
  id: string;
  title: string;
  relativePath: (config: ResolvedMemoryWikiConfig) => string;
  buildBody: (params: {
    config: ResolvedMemoryWikiConfig;
    pages: WikiPageSummary[];
    now: Date;
  }) => string;
};

const DASHBOARD_PAGES: DashboardPageDefinition[] = [
  {
    id: "report.open-questions",
    title: "Open Questions",
    relativePath: (config) => `${resolveWikiPaths(config).reportsDir}/open-questions.md`,
    buildBody: ({ config, pages }) => {
      const matches = pages.filter((page) => page.questions.length > 0);
      if (matches.length === 0) {
        return "- No open questions right now.";
      }
      return [
        `- Pages with open questions: ${matches.length}`,
        "",
        ...matches.map(
          (page) =>
            `- ${formatWikiLink({
              renderMode: config.vault.renderMode,
              relativePath: page.relativePath,
              title: page.title,
            })}: ${page.questions.join(" | ")}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.contradictions",
    title: "Contradictions",
    relativePath: (config) => `${resolveWikiPaths(config).reportsDir}/contradictions.md`,
    buildBody: ({ config, pages, now }) => {
      const pageClusters = buildPageContradictionClusters(pages);
      const claimClusters = buildClaimContradictionClusters({ pages, now });
      if (pageClusters.length === 0 && claimClusters.length === 0) {
        return "- No contradictions flagged right now.";
      }
      const lines = [
        `- Contradiction note clusters: ${pageClusters.length}`,
        `- Competing claim clusters: ${claimClusters.length}`,
      ];
      if (pageClusters.length > 0) {
        lines.push("", "### Page Notes");
        for (const cluster of pageClusters) {
          lines.push(formatPageContradictionClusterLine(config, cluster));
        }
      }
      if (claimClusters.length > 0) {
        lines.push("", "### Claim Clusters");
        for (const cluster of claimClusters) {
          lines.push(formatClaimContradictionClusterLine(config, cluster));
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.low-confidence",
    title: "Low Confidence",
    relativePath: (config) => `${resolveWikiPaths(config).reportsDir}/low-confidence.md`,
    buildBody: ({ config, pages, now }) => {
      const pageMatches = pages
        .filter((page) => typeof page.confidence === "number" && page.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      const claimMatches = collectWikiClaimHealth(pages, now)
        .filter((claim) => typeof claim.confidence === "number" && claim.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      if (pageMatches.length === 0 && claimMatches.length === 0) {
        return "- No low-confidence pages or claims right now.";
      }
      const lines = [
        `- Low-confidence pages: ${pageMatches.length}`,
        `- Low-confidence claims: ${claimMatches.length}`,
      ];
      if (pageMatches.length > 0) {
        lines.push("", "### Pages");
        for (const page of pageMatches) {
          lines.push(
            `- ${formatPageLink(config, page)}: confidence ${(page.confidence ?? 0).toFixed(2)}`,
          );
        }
      }
      if (claimMatches.length > 0) {
        lines.push("", "### Claims");
        for (const claim of claimMatches) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.claim-health",
    title: "Claim Health",
    relativePath: (config) => `${resolveWikiPaths(config).reportsDir}/claim-health.md`,
    buildBody: ({ config, pages, now }) => {
      const claimHealth = collectWikiClaimHealth(pages, now);
      const missingEvidence = claimHealth.filter((claim) => claim.missingEvidence);
      const contestedClaims = claimHealth.filter((claim) => isClaimHealthContested(claim));
      const staleClaims = claimHealth.filter(
        (claim) => claim.freshness.level === "stale" || claim.freshness.level === "unknown",
      );
      if (
        missingEvidence.length === 0 &&
        contestedClaims.length === 0 &&
        staleClaims.length === 0
      ) {
        return "- No claim health issues right now.";
      }
      const lines = [
        `- Claims missing evidence: ${missingEvidence.length}`,
        `- Contested claims: ${contestedClaims.length}`,
        `- Stale or unknown claims: ${staleClaims.length}`,
      ];
      if (missingEvidence.length > 0) {
        lines.push("", "### Missing Evidence");
        for (const claim of missingEvidence) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      if (contestedClaims.length > 0) {
        lines.push("", "### Contested Claims");
        for (const claim of contestedClaims) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      if (staleClaims.length > 0) {
        lines.push("", "### Stale Claims");
        for (const claim of staleClaims) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.stale-pages",
    title: "Stale Pages",
    relativePath: (config) => `${resolveWikiPaths(config).reportsDir}/stale-pages.md`,
    buildBody: ({ config, pages, now }) => {
      const matches = pages
        .filter((page) => page.kind !== "report" && page.kind !== "query")
        .flatMap((page) => {
          const freshness = assessPageFreshness(page, now);
          if (freshness.level === "fresh") {
            return [];
          }
          return [{ page, freshness }];
        })
        .toSorted((left, right) => left.page.title.localeCompare(right.page.title));
      if (matches.length === 0) {
        return `- No aging or stale pages older than ${WIKI_AGING_DAYS} days.`;
      }
      return [
        `- Stale pages: ${matches.length}`,
        "",
        ...matches.map(
          ({ page, freshness }) =>
            `- ${formatPageLink(config, page)}: ${formatFreshnessLabel(freshness)}`,
        ),
      ].join("\n");
    },
  },
];

export type CompileMemoryWikiResult = {
  vaultRoot: string;
  pageCounts: Record<WikiPageKind, number>;
  pages: WikiPageSummary[];
  claimCount: number;
  updatedFiles: string[];
};

export type RefreshMemoryWikiIndexesResult = {
  refreshed: boolean;
  reason: "auto-compile-disabled" | "no-import-changes" | "missing-indexes" | "import-changed";
  compile?: CompileMemoryWikiResult;
};

async function collectMarkdownFiles(rootDir: string, relativeDir: string): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(relativeDir, entry.name))
    .filter((relativePath) => path.basename(relativePath) !== "index.md")
    .toSorted((left, right) => left.localeCompare(right));
}

async function readPageSummaries(
  rootDir: string,
  config: ResolvedMemoryWikiConfig,
): Promise<WikiPageSummary[]> {
  const filePaths = (
    await Promise.all(
      getCompilePageGroups(config).map((group) => collectMarkdownFiles(rootDir, group.dir)),
    )
  ).flat();

  const pages = await Promise.all(
    filePaths.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      return toWikiPageSummary({ absolutePath, relativePath, raw });
    }),
  );

  return pages
    .flatMap((page) => (page ? [page] : []))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

function buildPageCounts(pages: WikiPageSummary[]): Record<WikiPageKind, number> {
  return {
    entity: pages.filter((page) => page.kind === "entity").length,
    concept: pages.filter((page) => page.kind === "concept").length,
    source: pages.filter((page) => page.kind === "source").length,
    query: pages.filter((page) => page.kind === "query").length,
    synthesis: pages.filter((page) => page.kind === "synthesis").length,
    report: pages.filter((page) => page.kind === "report").length,
  };
}

function formatPageLink(config: ResolvedMemoryWikiConfig, page: WikiPageSummary): string {
  return formatWikiLink({
    renderMode: config.vault.renderMode,
    relativePath: page.relativePath,
    title: page.title,
  });
}

function formatFreshnessLabel(freshness: WikiFreshness): string {
  switch (freshness.level) {
    case "fresh":
      return `fresh (${freshness.lastTouchedAt ?? "recent"})`;
    case "aging":
      return `aging (${freshness.lastTouchedAt ?? "unknown"})`;
    case "stale":
      return `stale (${freshness.lastTouchedAt ?? "unknown"})`;
    case "unknown":
      return freshness.reason;
  }
  throw new Error("Unsupported wiki freshness level");
}

function formatClaimIdentity(claim: WikiClaimHealth): string {
  return claim.claimId ? `\`${claim.claimId}\`: ${claim.text}` : claim.text;
}

function isClaimHealthContested(claim: WikiClaimHealth): boolean {
  return isClaimContestedStatus(claim.status);
}

function formatClaimHealthLine(config: ResolvedMemoryWikiConfig, claim: WikiClaimHealth): string {
  const details = [
    `status ${claim.status}`,
    typeof claim.confidence === "number" ? `confidence ${claim.confidence.toFixed(2)}` : null,
    claim.missingEvidence ? "missing evidence" : `${claim.evidenceCount} evidence`,
    formatFreshnessLabel(claim.freshness),
  ].filter(Boolean);
  return `${formatWikiLink({
    renderMode: config.vault.renderMode,
    relativePath: claim.pagePath,
    title: claim.pageTitle,
  })}: ${formatClaimIdentity(claim)} (${details.join(", ")})`;
}

function formatPageContradictionClusterLine(
  config: ResolvedMemoryWikiConfig,
  cluster: WikiPageContradictionCluster,
): string {
  const pageRefs = cluster.entries.map((entry) =>
    formatWikiLink({
      renderMode: config.vault.renderMode,
      relativePath: entry.pagePath,
      title: entry.pageTitle,
    }),
  );
  return `- ${cluster.label}: ${pageRefs.join(" | ")}`;
}

function formatClaimContradictionClusterLine(
  config: ResolvedMemoryWikiConfig,
  cluster: WikiClaimContradictionCluster,
): string {
  const entries = cluster.entries.map(
    (entry) =>
      `${formatWikiLink({
        renderMode: config.vault.renderMode,
        relativePath: entry.pagePath,
        title: entry.pageTitle,
      })} -> ${formatClaimIdentity(entry)} (${entry.status}, ${formatFreshnessLabel(entry.freshness)})`,
  );
  return `- \`${cluster.label}\`: ${entries.join(" | ")}`;
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, ""),
  );
}

function uniquePages(pages: WikiPageSummary[]): WikiPageSummary[] {
  const seen = new Set<string>();
  const unique: WikiPageSummary[] = [];
  for (const page of pages) {
    const key = page.id ?? page.relativePath;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(page);
  }
  return unique;
}

function buildPageLookupKeys(page: WikiPageSummary): Set<string> {
  const keys = new Set<string>();
  keys.add(normalizeComparableTarget(page.relativePath));
  keys.add(normalizeComparableTarget(page.relativePath.replace(/\.md$/i, "")));
  keys.add(normalizeComparableTarget(page.title));
  if (page.id) {
    keys.add(normalizeComparableTarget(page.id));
  }
  return keys;
}

function renderWikiPageLinks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
}): string {
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

function buildRelatedBlockBody(params: {
  config: ResolvedMemoryWikiConfig;
  page: WikiPageSummary;
  allPages: WikiPageSummary[];
}): string {
  const candidatePages = params.allPages.filter((candidate) => candidate.kind !== "report");
  const pagesById = new Map(
    candidatePages.flatMap((candidate) =>
      candidate.id ? [[candidate.id, candidate] as const] : [],
    ),
  );
  const sourcePages = uniquePages(
    params.page.sourceIds.flatMap((sourceId) => {
      const page = pagesById.get(sourceId);
      return page ? [page] : [];
    }),
  );
  const backlinkKeys = buildPageLookupKeys(params.page);
  const backlinks = uniquePages(
    candidatePages.filter((candidate) => {
      if (candidate.relativePath === params.page.relativePath) {
        return false;
      }
      if (candidate.sourceIds.includes(params.page.id ?? "")) {
        return true;
      }
      return candidate.linkTargets.some((target) =>
        backlinkKeys.has(normalizeComparableTarget(target)),
      );
    }),
  );
  const relatedPages = uniquePages(
    candidatePages.filter((candidate) => {
      if (candidate.relativePath === params.page.relativePath) {
        return false;
      }
      if (sourcePages.some((sourcePage) => sourcePage.relativePath === candidate.relativePath)) {
        return false;
      }
      if (backlinks.some((backlink) => backlink.relativePath === candidate.relativePath)) {
        return false;
      }
      if (params.page.sourceIds.length === 0 || candidate.sourceIds.length === 0) {
        return false;
      }
      return params.page.sourceIds.some((sourceId) => candidate.sourceIds.includes(sourceId));
    }),
  );

  const sections: string[] = [];
  if (sourcePages.length > 0) {
    sections.push(
      "### Sources",
      renderWikiPageLinks({ config: params.config, pages: sourcePages }),
    );
  }
  if (backlinks.length > 0) {
    sections.push(
      "### Referenced By",
      renderWikiPageLinks({ config: params.config, pages: backlinks }),
    );
  }
  if (relatedPages.length > 0) {
    sections.push(
      "### Related Pages",
      renderWikiPageLinks({ config: params.config, pages: relatedPages }),
    );
  }
  if (sections.length === 0) {
    return "- No related pages yet.";
  }
  return sections.join("\n\n");
}

async function refreshPageRelatedBlocks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
}): Promise<string[]> {
  if (!params.config.render.createBacklinks) {
    return [];
  }
  const updatedFiles: string[] = [];
  for (const page of params.pages) {
    if (page.kind === "report") {
      continue;
    }
    const original = await fs.readFile(page.absolutePath, "utf8");
    const updated = withTrailingNewline(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Related",
        startMarker: WIKI_RELATED_START_MARKER,
        endMarker: WIKI_RELATED_END_MARKER,
        body: buildRelatedBlockBody({
          config: params.config,
          page,
          allPages: params.pages,
        }),
      }),
    );
    if (updated === original) {
      continue;
    }
    await fs.writeFile(page.absolutePath, updated, "utf8");
    updatedFiles.push(page.absolutePath);
  }
  return updatedFiles;
}

function renderSectionList(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  emptyText: string;
}): string {
  if (params.pages.length === 0) {
    return `- ${params.emptyText}`;
  }
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

async function writeManagedMarkdownFile(params: {
  filePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): Promise<boolean> {
  const original = await fs.readFile(params.filePath, "utf8").catch(() => `# ${params.title}\n`);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: params.startMarker,
    endMarker: params.endMarker,
    body: params.body,
  });
  const rendered = withTrailingNewline(updated);
  if (rendered === original) {
    return false;
  }
  await fs.writeFile(params.filePath, rendered, "utf8");
  return true;
}

async function writeDashboardPage(params: {
  config: ResolvedMemoryWikiConfig;
  rootDir: string;
  definition: DashboardPageDefinition;
  pages: WikiPageSummary[];
  now: Date;
}): Promise<boolean> {
  const relativePath = params.definition.relativePath(params.config);
  const filePath = path.join(params.rootDir, relativePath);
  const original = await fs.readFile(filePath, "utf8").catch(() =>
    renderWikiMarkdown({
      frontmatter: {
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status: "active",
      },
      body: `# ${params.definition.title}\n`,
    }),
  );
  const parsed = parseWikiMarkdown(original);
  const originalBody =
    parsed.body.trim().length > 0 ? parsed.body : `# ${params.definition.title}\n`;
  const updatedBody = replaceManagedMarkdownBlock({
    original: originalBody,
    heading: "## Generated",
    startMarker: `<!-- openclaw:wiki:${path.basename(relativePath, ".md")}:start -->`,
    endMarker: `<!-- openclaw:wiki:${path.basename(relativePath, ".md")}:end -->`,
    body: params.definition.buildBody({
      config: params.config,
      pages: params.pages,
      now: params.now,
    }),
  });
  const preservedUpdatedAt =
    typeof parsed.frontmatter.updatedAt === "string" && parsed.frontmatter.updatedAt.trim()
      ? parsed.frontmatter.updatedAt
      : params.now.toISOString();
  const stableRendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: {
        ...parsed.frontmatter,
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status:
          typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
            ? parsed.frontmatter.status
            : "active",
        updatedAt: preservedUpdatedAt,
      },
      body: updatedBody,
    }),
  );
  if (stableRendered === original) {
    return false;
  }
  const rendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: {
        ...parsed.frontmatter,
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status:
          typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
            ? parsed.frontmatter.status
            : "active",
        updatedAt: params.now.toISOString(),
      },
      body: updatedBody,
    }),
  );
  await fs.writeFile(filePath, rendered, "utf8");
  return true;
}

async function refreshDashboardPages(params: {
  config: ResolvedMemoryWikiConfig;
  rootDir: string;
  pages: WikiPageSummary[];
}): Promise<string[]> {
  if (!params.config.render.createDashboards) {
    return [];
  }
  const now = new Date();
  const updatedFiles: string[] = [];
  for (const definition of DASHBOARD_PAGES) {
    if (
      await writeDashboardPage({
        config: params.config,
        rootDir: params.rootDir,
        definition,
        pages: params.pages,
        now,
      })
    ) {
      updatedFiles.push(path.join(params.rootDir, definition.relativePath(params.config)));
    }
  }
  return updatedFiles;
}

function buildRootIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  counts: Record<WikiPageKind, number>;
}): string {
  const claimCount = params.pages.reduce((total, page) => total + page.claims.length, 0);
  const lines = [
    `- Render mode: \`${params.config.vault.renderMode}\``,
    `- Total pages: ${params.pages.length}`,
    `- Claims: ${claimCount}`,
    `- Sources: ${params.counts.source}`,
    `- Entities: ${params.counts.entity}`,
    `- Concepts: ${params.counts.concept}`,
    `- Syntheses: ${params.counts.synthesis}`,
    `- Reports: ${params.counts.report}`,
  ];

  for (const group of getCompilePageGroups(params.config)) {
    lines.push("", `### ${group.heading}`);
    lines.push(
      renderSectionList({
        config: params.config,
        pages: params.pages.filter((page) => page.kind === group.kind),
        emptyText: `No ${normalizeLowercaseStringOrEmpty(group.heading)} yet.`,
      }),
    );
  }

  return lines.join("\n");
}

function buildDirectoryIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  group: { kind: WikiPageKind; dir: string; heading: string };
}): string {
  return renderSectionList({
    config: params.config,
    pages: params.pages.filter((page) => page.kind === params.group.kind),
    emptyText: `No ${normalizeLowercaseStringOrEmpty(params.group.heading)} yet.`,
  });
}

type AgentDigestClaim = {
  id?: string;
  text: string;
  status: string;
  confidence?: number;
  evidenceCount: number;
  missingEvidence: boolean;
  evidence: WikiClaim["evidence"];
  freshnessLevel: WikiFreshnessLevel;
  lastTouchedAt?: string;
};

type AgentDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageKind;
  path: string;
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  confidence?: number;
  freshnessLevel: WikiFreshnessLevel;
  lastTouchedAt?: string;
  claimCount: number;
  topClaims: AgentDigestClaim[];
};

type AgentDigestClaimHealthSummary = {
  freshness: Record<WikiFreshnessLevel, number>;
  contested: number;
  lowConfidence: number;
  missingEvidence: number;
};

type AgentDigestContradictionCluster = {
  key: string;
  label: string;
  kind: "claim-id" | "page-note";
  entryCount: number;
  paths: string[];
};

type AgentDigest = {
  pageCounts: Record<WikiPageKind, number>;
  claimCount: number;
  claimHealth: AgentDigestClaimHealthSummary;
  contradictionClusters: AgentDigestContradictionCluster[];
  pages: AgentDigestPage[];
};

function createFreshnessSummary(): Record<WikiFreshnessLevel, number> {
  return {
    fresh: 0,
    aging: 0,
    stale: 0,
    unknown: 0,
  };
}

function rankFreshnessLevel(level: WikiFreshnessLevel): number {
  switch (level) {
    case "fresh":
      return 3;
    case "aging":
      return 2;
    case "stale":
      return 1;
    case "unknown":
      return 0;
  }
  throw new Error("Unsupported wiki freshness level");
}

function sortClaims(page: WikiPageSummary): WikiClaim[] {
  return [...page.claims].toSorted((left, right) => {
    const leftConfidence = left.confidence ?? -1;
    const rightConfidence = right.confidence ?? -1;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftFreshness = rankFreshnessLevel(assessClaimFreshness({ page, claim: left }).level);
    const rightFreshness = rankFreshnessLevel(assessClaimFreshness({ page, claim: right }).level);
    if (leftFreshness !== rightFreshness) {
      return rightFreshness - leftFreshness;
    }
    return left.text.localeCompare(right.text);
  });
}

function buildAgentDigestClaimHealthSummary(
  pages: WikiPageSummary[],
): AgentDigestClaimHealthSummary {
  const freshness = createFreshnessSummary();
  let contested = 0;
  let lowConfidence = 0;
  let missingEvidence = 0;

  for (const claim of collectWikiClaimHealth(pages)) {
    freshness[claim.freshness.level] += 1;
    if (isClaimHealthContested(claim)) {
      contested += 1;
    }
    if (typeof claim.confidence === "number" && claim.confidence < 0.5) {
      lowConfidence += 1;
    }
    if (claim.missingEvidence) {
      missingEvidence += 1;
    }
  }

  return {
    freshness,
    contested,
    lowConfidence,
    missingEvidence,
  };
}

function buildAgentDigestContradictionClusters(
  pages: WikiPageSummary[],
): AgentDigestContradictionCluster[] {
  const pageClusters = buildPageContradictionClusters(pages).map((cluster) => ({
    key: cluster.key,
    label: cluster.label,
    kind: "page-note" as const,
    entryCount: cluster.entries.length,
    paths: [...new Set(cluster.entries.map((entry) => entry.pagePath))].toSorted(),
  }));
  const claimClusters = buildClaimContradictionClusters({ pages }).map((cluster) => ({
    key: cluster.key,
    label: cluster.label,
    kind: "claim-id" as const,
    entryCount: cluster.entries.length,
    paths: [...new Set(cluster.entries.map((entry) => entry.pagePath))].toSorted(),
  }));
  return [...pageClusters, ...claimClusters].toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function buildAgentDigest(params: {
  pages: WikiPageSummary[];
  pageCounts: Record<WikiPageKind, number>;
}): AgentDigest {
  const pages = [...params.pages]
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((page) => {
      const pageFreshness = assessPageFreshness(page);
      return {
        ...(page.id ? { id: page.id } : {}),
        title: page.title,
        kind: page.kind,
        path: page.relativePath,
        sourceIds: [...page.sourceIds],
        questions: [...page.questions],
        contradictions: [...page.contradictions],
        ...(typeof page.confidence === "number" ? { confidence: page.confidence } : {}),
        freshnessLevel: pageFreshness.level,
        ...(pageFreshness.lastTouchedAt ? { lastTouchedAt: pageFreshness.lastTouchedAt } : {}),
        claimCount: page.claims.length,
        topClaims: sortClaims(page)
          .slice(0, 5)
          .map((claim) => {
            const freshness = assessClaimFreshness({ page, claim });
            return {
              ...(claim.id ? { id: claim.id } : {}),
              text: claim.text,
              status: normalizeClaimStatus(claim.status),
              ...(typeof claim.confidence === "number" ? { confidence: claim.confidence } : {}),
              evidenceCount: claim.evidence.length,
              missingEvidence: claim.evidence.length === 0,
              evidence: [...claim.evidence],
              freshnessLevel: freshness.level,
              ...(freshness.lastTouchedAt ? { lastTouchedAt: freshness.lastTouchedAt } : {}),
            };
          }),
      };
    });
  return {
    pageCounts: params.pageCounts,
    claimCount: params.pages.reduce((total, page) => total + page.claims.length, 0),
    claimHealth: buildAgentDigestClaimHealthSummary(params.pages),
    contradictionClusters: buildAgentDigestContradictionClusters(params.pages),
    pages,
  };
}

function buildClaimsDigestLines(params: { pages: WikiPageSummary[] }): string[] {
  return params.pages
    .flatMap((page) =>
      sortClaims(page).map((claim) => {
        const freshness = assessClaimFreshness({ page, claim });
        return JSON.stringify({
          ...(claim.id ? { id: claim.id } : {}),
          pageId: page.id,
          pageTitle: page.title,
          pageKind: page.kind,
          pagePath: page.relativePath,
          text: claim.text,
          status: normalizeClaimStatus(claim.status),
          confidence: claim.confidence,
          sourceIds: page.sourceIds,
          evidenceCount: claim.evidence.length,
          missingEvidence: claim.evidence.length === 0,
          evidence: claim.evidence,
          freshnessLevel: freshness.level,
          lastTouchedAt: freshness.lastTouchedAt,
        });
      }),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

function tokenizeSearchText(value: string): string[] {
  return normalizeLowercaseStringOrEmpty(value)
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

type LocalSearchDocRecord = {
  path: string;
  title: string;
  kind: WikiPageSummary["kind"];
  id?: string;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  updatedAt?: string;
  contentHash: string;
  preview: string;
  fieldLengths: {
    title: number;
    path: number;
    id: number;
    sourceIds: number;
    questions: number;
    contradictions: number;
    claims: number;
    body: number;
  };
};

type LocalSearchIndex = {
  version: 2;
  generatedAt: string;
  stats: {
    docCount: number;
    avgFieldLengths: LocalSearchDocRecord["fieldLengths"];
  };
  docs: Record<string, LocalSearchDocRecord>;
  terms: Record<
    string,
    {
      df: number;
      postings: Record<string, Partial<Record<keyof LocalSearchDocRecord["fieldLengths"], number>>>;
    }
  >;
};

function updateFieldTermCounts(
  target: Map<string, Partial<Record<keyof LocalSearchDocRecord["fieldLengths"], number>>>,
  field: keyof LocalSearchDocRecord["fieldLengths"],
  value: string,
): number {
  const tokens = tokenizeSearchText(value);
  for (const token of tokens) {
    const current = target.get(token) ?? {};
    current[field] = (current[field] ?? 0) + 1;
    target.set(token, current);
  }
  return tokens.length;
}

async function sha1Text(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha1").update(value).digest("hex");
}

function createEmptyFieldLengths(): LocalSearchDocRecord["fieldLengths"] {
  return {
    title: 0,
    path: 0,
    id: 0,
    sourceIds: 0,
    questions: 0,
    contradictions: 0,
    claims: 0,
    body: 0,
  };
}

function sortPostingMap(
  postings: Record<string, Partial<Record<keyof LocalSearchDocRecord["fieldLengths"], number>>>,
): Record<string, Partial<Record<keyof LocalSearchDocRecord["fieldLengths"], number>>> {
  return Object.fromEntries(
    Object.entries(postings).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

async function buildLocalSearchIndex(params: {
  rootDir: string;
  pages: WikiPageSummary[];
  existing?: LocalSearchIndex | null;
}): Promise<LocalSearchIndex> {
  const previousDocs = params.existing?.docs ?? {};
  const previousTerms = params.existing?.terms ?? {};
  const nextDocs: Record<string, LocalSearchDocRecord> = {};
  const changedDocPaths = new Set<string>();
  const deletedDocPaths = new Set(
    Object.keys(previousDocs).filter(
      (docPath) => !params.pages.some((page) => page.relativePath === docPath),
    ),
  );

  const freshDocTerms = new Map<
    string,
    Map<string, Partial<Record<keyof LocalSearchDocRecord["fieldLengths"], number>>>
  >();

  for (const page of params.pages) {
    const raw = await fs.readFile(path.join(params.rootDir, page.relativePath), "utf8");
    const contentHash = await sha1Text(raw);
    const previousDoc = previousDocs[page.relativePath];

    if (previousDoc && previousDoc.contentHash === contentHash) {
      nextDocs[page.relativePath] = {
        ...previousDoc,
        title: page.title,
        kind: page.kind,
        ...(page.id ? { id: page.id } : {}),
        ...(page.sourceType ? { sourceType: page.sourceType } : {}),
        ...(page.provenanceMode ? { provenanceMode: page.provenanceMode } : {}),
        ...(page.sourcePath ? { sourcePath: page.sourcePath } : {}),
        ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
      };
      continue;
    }

    changedDocPaths.add(page.relativePath);
    const parsed = parseWikiMarkdown(raw);
    const fieldCounts = new Map<
      string,
      Partial<Record<keyof LocalSearchDocRecord["fieldLengths"], number>>
    >();
    const fieldLengths = {
      title: updateFieldTermCounts(fieldCounts, "title", page.title),
      path: updateFieldTermCounts(fieldCounts, "path", page.relativePath),
      id: updateFieldTermCounts(fieldCounts, "id", page.id ?? ""),
      sourceIds: updateFieldTermCounts(fieldCounts, "sourceIds", page.sourceIds.join(" ")),
      questions: updateFieldTermCounts(fieldCounts, "questions", page.questions.join(" ")),
      contradictions: updateFieldTermCounts(
        fieldCounts,
        "contradictions",
        page.contradictions.join(" "),
      ),
      claims: updateFieldTermCounts(
        fieldCounts,
        "claims",
        page.claims
          .flatMap((claim) => [claim.text, claim.id ?? ""])
          .filter(Boolean)
          .join(" "),
      ),
      body: updateFieldTermCounts(fieldCounts, "body", parsed.body),
    };
    nextDocs[page.relativePath] = {
      path: page.relativePath,
      title: page.title,
      kind: page.kind,
      ...(page.id ? { id: page.id } : {}),
      ...(page.sourceType ? { sourceType: page.sourceType } : {}),
      ...(page.provenanceMode ? { provenanceMode: page.provenanceMode } : {}),
      ...(page.sourcePath ? { sourcePath: page.sourcePath } : {}),
      ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
      contentHash,
      preview:
        parsed.body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "",
      fieldLengths,
    };
    freshDocTerms.set(page.relativePath, fieldCounts);
  }

  const nextTerms: LocalSearchIndex["terms"] = {};
  for (const [term, entry] of Object.entries(previousTerms)) {
    const nextPostings = Object.fromEntries(
      Object.entries(entry.postings).filter(
        ([docPath]) => !changedDocPaths.has(docPath) && !deletedDocPaths.has(docPath),
      ),
    );
    const df = Object.keys(nextPostings).length;
    if (df > 0) {
      nextTerms[term] = {
        df,
        postings: sortPostingMap(nextPostings),
      };
    }
  }

  for (const [docPath, tokenMap] of freshDocTerms.entries()) {
    for (const [term, fieldFreqs] of tokenMap.entries()) {
      const current = nextTerms[term] ?? { df: 0, postings: {} };
      current.postings[docPath] = fieldFreqs;
      current.df = Object.keys(current.postings).length;
      nextTerms[term] = current;
    }
  }

  const sortedTerms = Object.fromEntries(
    Object.entries(nextTerms)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([term, entry]) => [
        term,
        {
          df: Object.keys(entry.postings).length,
          postings: sortPostingMap(entry.postings),
        },
      ]),
  ) as LocalSearchIndex["terms"];

  const docValues = Object.values(nextDocs).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const avgFieldLengths = createEmptyFieldLengths();
  for (const doc of docValues) {
    for (const key of Object.keys(avgFieldLengths) as Array<keyof typeof avgFieldLengths>) {
      avgFieldLengths[key] += doc.fieldLengths[key];
    }
  }
  if (docValues.length > 0) {
    for (const key of Object.keys(avgFieldLengths) as Array<keyof typeof avgFieldLengths>) {
      avgFieldLengths[key] = Number((avgFieldLengths[key] / docValues.length).toFixed(3));
    }
  }

  const sortedDocs = Object.fromEntries(
    docValues.map((doc) => [doc.path, doc]),
  ) as LocalSearchIndex["docs"];
  const docsUnchanged = params.existing
    ? JSON.stringify(params.existing.docs) === JSON.stringify(sortedDocs)
    : false;
  const termsUnchanged = params.existing
    ? JSON.stringify(params.existing.terms) === JSON.stringify(sortedTerms)
    : false;
  const statsUnchanged =
    params.existing &&
    JSON.stringify(params.existing.stats) ===
      JSON.stringify({
        docCount: docValues.length,
        avgFieldLengths,
      });

  return {
    version: 2,
    generatedAt:
      params.existing && docsUnchanged && termsUnchanged && statsUnchanged
        ? params.existing.generatedAt
        : new Date().toISOString(),
    stats: {
      docCount: docValues.length,
      avgFieldLengths,
    },
    docs: sortedDocs,
    terms: sortedTerms,
  };
}

async function writeAgentDigestArtifacts(params: {
  rootDir: string;
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  pageCounts: Record<WikiPageKind, number>;
}): Promise<string[]> {
  const updatedFiles: string[] = [];
  const layout = resolveWikiPaths(params.config);
  const agentDigestPath = path.join(params.rootDir, layout.systemCacheDir, "agent-digest.json");
  const claimsDigestPath = path.join(params.rootDir, layout.systemCacheDir, "claims.jsonl");
  const localSearchIndexPath = path.join(
    params.rootDir,
    layout.systemCacheDir,
    "local-search-index.json",
  );
  const agentDigest = `${JSON.stringify(
    buildAgentDigest({
      pages: params.pages,
      pageCounts: params.pageCounts,
    }),
    null,
    2,
  )}\n`;
  const claimsDigest = withTrailingNewline(
    buildClaimsDigestLines({ pages: params.pages }).join("\n"),
  );
  const existingLocalSearchIndex = await fs
    .readFile(localSearchIndexPath, "utf8")
    .then((raw) => JSON.parse(raw) as LocalSearchIndex)
    .catch(() => null);
  const localSearchIndex = `${JSON.stringify(
    await buildLocalSearchIndex({
      rootDir: params.rootDir,
      pages: params.pages,
      existing: existingLocalSearchIndex,
    }),
    null,
    2,
  )}\n`;

  for (const [filePath, content] of [
    [agentDigestPath, agentDigest],
    [claimsDigestPath, claimsDigest],
    [localSearchIndexPath, localSearchIndex],
  ] as const) {
    const existing = await fs.readFile(filePath, "utf8").catch(() => "");
    if (existing === content) {
      continue;
    }
    await fs.writeFile(filePath, content, "utf8");
    updatedFiles.push(filePath);
  }
  return updatedFiles;
}

export async function compileMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
): Promise<CompileMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  const rootDir = config.vault.path;
  let pages = await readPageSummaries(rootDir, config);
  const updatedFiles = await refreshPageRelatedBlocks({ config, pages });
  if (updatedFiles.length > 0) {
    pages = await readPageSummaries(rootDir, config);
  }
  const dashboardUpdatedFiles = await refreshDashboardPages({ config, rootDir, pages });
  updatedFiles.push(...dashboardUpdatedFiles);
  if (dashboardUpdatedFiles.length > 0) {
    pages = await readPageSummaries(rootDir, config);
  }
  const counts = buildPageCounts(pages);
  const digestUpdatedFiles = await writeAgentDigestArtifacts({
    rootDir,
    config,
    pages,
    pageCounts: counts,
  });
  updatedFiles.push(...digestUpdatedFiles);

  const rootIndexPath = path.join(rootDir, config.layout.rootIndex);
  if (
    await writeManagedMarkdownFile({
      filePath: rootIndexPath,
      title: "Wiki Index",
      startMarker: "<!-- openclaw:wiki:index:start -->",
      endMarker: "<!-- openclaw:wiki:index:end -->",
      body: buildRootIndexBody({ config, pages, counts }),
    })
  ) {
    updatedFiles.push(rootIndexPath);
  }

  for (const group of getCompilePageGroups(config)) {
    const filePath = path.join(rootDir, group.dir, "index.md");
    if (
      await writeManagedMarkdownFile({
        filePath,
        title: group.heading,
        startMarker: `<!-- openclaw:wiki:${group.dir}:index:start -->`,
        endMarker: `<!-- openclaw:wiki:${group.dir}:index:end -->`,
        body: buildDirectoryIndexBody({ config, pages, group }),
      })
    ) {
      updatedFiles.push(filePath);
    }
  }

  if (updatedFiles.length > 0) {
    await appendMemoryWikiLog(
      rootDir,
      {
        type: "compile",
        timestamp: new Date().toISOString(),
        details: {
          pageCounts: counts,
          updatedFiles: updatedFiles.map((filePath) => path.relative(rootDir, filePath)),
        },
      },
      config,
    );
  }

  return {
    vaultRoot: rootDir,
    pageCounts: counts,
    pages,
    claimCount: pages.reduce((total, page) => total + page.claims.length, 0),
    updatedFiles,
  };
}

async function hasMissingWikiIndexes(
  rootDir: string,
  config: ResolvedMemoryWikiConfig,
): Promise<boolean> {
  const required = [
    path.join(rootDir, config.layout.rootIndex),
    ...getCompilePageGroups(config).map((group) => path.join(rootDir, group.dir, "index.md")),
  ];
  for (const filePath of required) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return true;
    }
  }
  return false;
}

export async function refreshMemoryWikiIndexesAfterImport(params: {
  config: ResolvedMemoryWikiConfig;
  syncResult: { importedCount: number; updatedCount: number; removedCount: number };
}): Promise<RefreshMemoryWikiIndexesResult> {
  await initializeMemoryWikiVault(params.config);
  if (!params.config.ingest.autoCompile) {
    return {
      refreshed: false,
      reason: "auto-compile-disabled",
    };
  }
  const importChanged =
    params.syncResult.importedCount > 0 ||
    params.syncResult.updatedCount > 0 ||
    params.syncResult.removedCount > 0;
  const missingIndexes = await hasMissingWikiIndexes(params.config.vault.path, params.config);
  if (!importChanged && !missingIndexes) {
    return {
      refreshed: false,
      reason: "no-import-changes",
    };
  }
  const compile = await compileMemoryWikiVault(params.config);
  return {
    refreshed: true,
    reason: missingIndexes && !importChanged ? "missing-indexes" : "import-changed",
    compile,
  };
}
