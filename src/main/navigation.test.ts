import { describe, expect, it } from "vitest";
import {
  createNavigationGuard,
  isLoopbackRendererUrl,
  prototypeSearch,
  withPrototypeSearch,
} from "./navigation";

describe("renderer navigation policy", () => {
  it("accepts only HTTP loopback URLs as development renderer targets", () => {
    expect(isLoopbackRendererUrl("http://localhost:5173/")).toBe(true);
    expect(isLoopbackRendererUrl("https://127.0.0.1:5173/")).toBe(true);
    expect(isLoopbackRendererUrl("http://[::1]:5173/")).toBe(true);
    expect(isLoopbackRendererUrl("file:///tmp/renderer.html")).toBe(false);
    expect(isLoopbackRendererUrl("https://example.com/phishing")).toBe(false);
  });

  it("allows navigation only to the exact normalized renderer URL", () => {
    const production = createNavigationGuard("file:///Applications/Orchestrion/renderer/index.html");
    expect(production("file:///Applications/Orchestrion/renderer/index.html#session")).toBe(true);
    expect(production("file:///tmp/renderer.html")).toBe(false);

    const development = createNavigationGuard("http://localhost:5173/app?mode=dev");
    expect(development("http://localhost:5173/app?mode=dev#thread")).toBe(true);
    expect(development("http://localhost:5174/app?mode=dev")).toBe(false);
    expect(development("http://localhost:5173/other?mode=dev")).toBe(false);
    expect(development("http://localhost:5173/app?mode=other")).toBe(false);
  });
});

describe("update prototype search injection", () => {
  it("maps UPDATE_PROTOTYPE env to the renderer query flag", () => {
    expect(prototypeSearch({})).toBe("");
    expect(prototypeSearch({ UPDATE_PROTOTYPE: "" })).toBe("");
    expect(prototypeSearch({ UPDATE_PROTOTYPE: "1" })).toBe("?update-prototype");
    expect(prototypeSearch({ UPDATE_PROTOTYPE: "error" })).toBe("?update-prototype=error");
    expect(prototypeSearch({ UPDATE_PROTOTYPE: "anything-else" })).toBe("?update-prototype");
  });

  it("appends the prototype flag without dropping existing query or hash behavior", () => {
    expect(withPrototypeSearch("http://localhost:5173/", "")).toBe("http://localhost:5173/");
    expect(withPrototypeSearch("http://localhost:5173/", "?update-prototype")).toBe(
      "http://localhost:5173/?update-prototype",
    );
    expect(withPrototypeSearch("file:///tmp/renderer/index.html", "?update-prototype=error")).toBe(
      "file:///tmp/renderer/index.html?update-prototype=error",
    );
    expect(withPrototypeSearch("http://localhost:5173/app?mode=dev", "?update-prototype")).toBe(
      "http://localhost:5173/app?mode=dev&update-prototype",
    );
  });

  it("keeps navigation and handshake URLs aligned after hash route changes", () => {
    const expected = withPrototypeSearch("http://localhost:5173/", prototypeSearch({ UPDATE_PROTOTYPE: "1" }));
    const guard = createNavigationGuard(expected);
    expect(guard("http://localhost:5173/?update-prototype")).toBe(true);
    expect(guard("http://localhost:5173/?update-prototype#/session/abc")).toBe(true);
    expect(guard("http://localhost:5173/#/session/abc")).toBe(false);
    expect(guard("http://localhost:5173/?update-prototype=error")).toBe(false);

    const errorExpected = withPrototypeSearch(
      "file:///tmp/renderer/index.html",
      prototypeSearch({ UPDATE_PROTOTYPE: "error" }),
    );
    const errorGuard = createNavigationGuard(errorExpected);
    expect(errorGuard("file:///tmp/renderer/index.html?update-prototype=error")).toBe(true);
    expect(errorGuard("file:///tmp/renderer/index.html?update-prototype")).toBe(false);
    expect(errorGuard("file:///tmp/renderer/index.html")).toBe(false);
  });
});
