import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { CatalogAgentItem, LocalAssignmentUiValue } from "../shared/assignment-ui-contracts";

const PAGE_SIZE = 100;
const MAX_ITEMS = 10_000;
type CatalogPage = Extract<LocalAssignmentUiValue, { kind: "catalog.page" }>;
type CatalogDetail = Extract<LocalAssignmentUiValue, { kind: "catalog.detail" }>;

function samePin(a: CatalogPage["expected"], b: CatalogPage["expected"]): boolean {
  return a.revision === b.revision && a.hash === b.hash;
}

export async function readAgentCatalog(api: OrchestrionDesktopApi): Promise<{
  expected: CatalogPage["expected"];
  items: CatalogAgentItem[];
}> {
  let expected: CatalogPage["expected"] | null = null;
  let total: number | null = null;
  const items: CatalogAgentItem[] = [];
  for (let offset = 0; offset <= MAX_ITEMS; offset += PAGE_SIZE) {
    const page = await api.localAssignments.request({ operation: "catalog.list", limit: PAGE_SIZE, offset });
    if (page.kind !== "catalog.page" || (expected && !samePin(expected, page.expected)) ||
        (total !== null && total !== page.total)) throw new Error("REVISION_CONFLICT");
    expected = page.expected;
    total = page.total;
    if (page.total > MAX_ITEMS || items.length + page.items.length > page.total) throw new Error("SERVICE_UNAVAILABLE");
    items.push(...page.items);
    if (items.length === page.total) break;
    if (page.items.length !== PAGE_SIZE) throw new Error("REVISION_CONFLICT");
  }
  if (!expected || items.length !== total || new Set(items.map((item) => item.identity.id)).size !== items.length)
    throw new Error("REVISION_CONFLICT");
  return { expected, items };
}

export async function readAgentCatalogDetail(api: OrchestrionDesktopApi, agentId: string): Promise<CatalogDetail> {
  let first: CatalogDetail | null = null;
  const versions: CatalogDetail["versions"] = [];
  for (let offset = 0; offset <= MAX_ITEMS; offset += PAGE_SIZE) {
    const page = await api.localAssignments.request({ operation: "catalog.detail", agentId, limit: PAGE_SIZE, offset });
    if (page.kind !== "catalog.detail" || (first && (!samePin(first.expected, page.expected)
        || first.totalVersions !== page.totalVersions || first.item.latestVersionId !== page.item.latestVersionId)))
      throw new Error("REVISION_CONFLICT");
    first ??= page;
    if (page.totalVersions > MAX_ITEMS || versions.length + page.versions.length > page.totalVersions)
      throw new Error("SERVICE_UNAVAILABLE");
    versions.push(...page.versions);
    if (versions.length === page.totalVersions) break;
    if (page.versions.length !== PAGE_SIZE) throw new Error("REVISION_CONFLICT");
  }
  if (!first || versions.length !== first.totalVersions ||
      new Set(versions.map((version) => version.id)).size !== versions.length) throw new Error("REVISION_CONFLICT");
  return { ...first, versions };
}
