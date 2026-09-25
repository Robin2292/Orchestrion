// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../shared/contracts";
import { CompactModelPicker } from "./CompactModelPicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const efforts = (...values: string[]) => values.map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} detail` }));
const models = [
  {
    id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Reliable agentic model",
    providerId: "openai", providerDisplayName: "OpenAI", supportedReasoningEfforts: efforts("low", "medium", "high"),
    defaultReasoningEffort: "medium", serviceTiers: [{ id: "priority", name: "Priority", description: "Lower latency" }],
    defaultServiceTier: null, isDefault: true,
  },
  {
    id: "gpt-5.6-sol-900k", model: "gpt-5.6-sol-900k", displayName: "GPT-5.6 Sol 900K", description: "Extended context",
    providerId: "openai", providerDisplayName: "OpenAI", supportedReasoningEfforts: efforts("low", "medium", "high"),
    defaultReasoningEffort: "medium", serviceTiers: [{ id: "priority", name: "Priority", description: "Lower latency" }],
    defaultServiceTier: null, isDefault: false,
  },
  {
    id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: "Most capable",
    providerId: "openai", providerDisplayName: "OpenAI", supportedReasoningEfforts: efforts("none", "low", "medium", "high", "xhigh"),
    defaultReasoningEffort: "high", serviceTiers: [], defaultServiceTier: null, isDefault: false,
  },
  {
    id: "claude-opus", model: "claude-opus", displayName: "Claude Opus", description: "Anthropic model",
    providerId: "anthropic", providerDisplayName: "Anthropic", supportedReasoningEfforts: efforts("standard", "extended"),
    defaultReasoningEffort: "standard", serviceTiers: [], defaultServiceTier: null, isDefault: false,
  },
] satisfies ModelOption[];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(model = "gpt-5.6-sol", effort = "medium", onChange = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<CompactModelPicker
    open
    disabled={false}
    session={{ model, modelProvider: "openai", reasoningEffort: effort, serviceTier: null }}
    models={models}
    onOpenChange={() => undefined}
    onChange={onChange}
  />));
  return { container, onChange };
}

describe("CompactModelPicker", () => {
  it("renders the compact, model-specific controls without a visible reasoning label", async () => {
    const mounted = await mount("gpt-6-astra", "high");
    expect(mounted.container.textContent).toContain("GPT-6 AstraHigh");
    expect(mounted.container.textContent).not.toContain("Reasoning");
    expect([...mounted.container.querySelectorAll(".compact-effort-label")].map((node) => node.textContent))
      .toEqual(["None", "Low", "Medium", "High", "X-High"]);
    const slider = mounted.container.querySelector<HTMLInputElement>("[aria-label='Effort level']")!;
    expect(slider.max).toBe("4");
    expect(slider.value).toBe("3");
    expect(mounted.container.querySelector("[aria-label='Reset model settings']")).toBeNull();
    expect(mounted.container.querySelector("[role='tab'][aria-label='OpenAI'] .provider-logo")).not.toBeNull();
    expect(mounted.container.querySelector<HTMLButtonElement>("[aria-label='Connect provider']")?.disabled).toBe(true);
  });

  it("snaps effort changes and wires priority, context variants, provider filters, and search", async () => {
    const onChange = vi.fn();
    const mounted = await mount("gpt-5.6-sol", "medium", onChange);
    const slider = mounted.container.querySelector<HTMLInputElement>("[aria-label='Effort level']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "2");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(models[0], "high", null);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "0");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(models[0], "low", null);

    const priority = mounted.container.querySelector<HTMLButtonElement>("[aria-label='Priority service off']")!;
    await act(async () => priority.click());
    expect(onChange).toHaveBeenCalledWith(models[0], "medium", "priority");

    const extendedContext = [...mounted.container.querySelectorAll<HTMLButtonElement>(".compact-context-row button")]
      .find((button) => button.textContent === "900K")!;
    await act(async () => extendedContext.click());
    expect(onChange).toHaveBeenCalledWith(models[1], "medium", null);

    const anthropic = mounted.container.querySelector<HTMLButtonElement>("[role='tab'][aria-label='Anthropic']")!;
    await act(async () => anthropic.click());
    expect([...mounted.container.querySelectorAll(".compact-model-option strong")].map((node) => node.textContent)).toEqual(["Claude Opus"]);

    const search = mounted.container.querySelector<HTMLInputElement>("[aria-label='Search models']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "missing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mounted.container.textContent).toContain("No models found");
  });

  it("returns the slider to the applied effort when a settings update fails", async () => {
    const onChange = vi.fn(async () => { throw new Error("settings rejected"); });
    const mounted = await mount("gpt-5.6-sol", "medium", onChange);
    const slider = mounted.container.querySelector<HTMLInputElement>("[aria-label='Effort level']")!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "2");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith(models[0], "high", null);
    expect(slider.value).toBe("1");
    expect(mounted.container.querySelector(".compact-effort-label.current")?.textContent).toBe("Medium");
  });

  it("preserves reasoning across model changes and falls back only when unsupported", async () => {
    const onChange = vi.fn();
    const mounted = await mount("gpt-5.6-sol", "medium", onChange);
    const modelButton = (name: string) => [...mounted.container.querySelectorAll<HTMLButtonElement>(".compact-model-option")]
      .find((button) => button.querySelector("strong")?.textContent === name)!;

    await act(async () => modelButton("GPT-6 Astra").click());
    expect(onChange).toHaveBeenLastCalledWith(models[2], "medium", null);

    await act(async () => modelButton("Claude Opus").click());
    expect(onChange).toHaveBeenLastCalledWith(models[3], "standard", null);
  });
});
