export function isLoopbackRendererUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:")
      && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function createNavigationGuard(expectedRendererUrl: string): (candidate: string) => boolean {
  const expected = normalizedRendererUrl(expectedRendererUrl);
  if (!expected) throw new Error("Expected renderer URL is invalid");
  return (candidate) => normalizedRendererUrl(candidate) === expected;
}

export function prototypeSearch(env: { UPDATE_PROTOTYPE?: string } = process.env): string {
  const value = env.UPDATE_PROTOTYPE;
  if (value === undefined || value === "") return "";
  if (value === "error") return "?update-prototype=error";
  return "?update-prototype";
}

export function withPrototypeSearch(baseUrl: string, search: string): string {
  if (!search) return baseUrl;
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return baseUrl;
  const hashIndex = baseUrl.indexOf("#");
  const withoutHash = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : baseUrl.slice(hashIndex);
  const joined = withoutHash.includes("?")
    ? `${withoutHash}&${query}`
    : `${withoutHash}?${query}`;
  return `${joined}${hash}`;
}

function normalizedRendererUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
