import type { ContextWindowUsage } from "./contracts";

type JsonObject = Record<string, unknown>;

export interface ContextWindowPresentation {
  available: boolean;
  usedLabel: string;
  totalLabel: string;
  percentageLabel: string;
  percentage: number | null;
  visualPercentage: number;
  tone: "default" | "warning" | "overflow" | "unavailable";
}

/** Parse the stable app-server `thread/tokenUsage/updated` payload. */
export function contextWindowUsageFromNotification(params: unknown): ContextWindowUsage | null {
  const envelope = object(params);
  const turnId = nonEmptyString(envelope.turnId);
  if (!turnId || !("tokenUsage" in envelope)) return null;

  const tokenUsage = object(envelope.tokenUsage);
  const last = object(tokenUsage.last);
  return {
    turnId,
    usedTokens: nonNegativeInteger(last.totalTokens),
    contextWindowTokens: positiveInteger(tokenUsage.modelContextWindow),
  };
}

export function presentContextWindowUsage(usage: ContextWindowUsage | null | undefined): ContextWindowPresentation {
  const used = usage?.usedTokens ?? null;
  const total = usage?.contextWindowTokens ?? null;
  if (used === null || total === null) {
    return {
      available: false,
      usedLabel: used === null ? "Unavailable" : formatTokenCount(used),
      totalLabel: total === null ? "Unavailable" : formatTokenCount(total),
      percentageLabel: "Unavailable",
      percentage: null,
      visualPercentage: 0,
      tone: "unavailable",
    };
  }

  const percentage = (used / total) * 100;
  return {
    available: true,
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(total),
    percentageLabel: formatPercentage(percentage),
    percentage,
    visualPercentage: Math.min(Math.max(percentage, 0), 100),
    tone: percentage > 100 ? "overflow" : percentage >= 80 ? "warning" : "default",
  };
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return compactNumber(value, 1_000_000, "M");
  if (value >= 1_000) return compactNumber(value, 1_000, "k");
  return Math.round(value).toLocaleString("en-US");
}

function compactNumber(value: number, divisor: number, suffix: string): string {
  const scaled = value / divisor;
  const digits = scaled >= 100 || Number.isInteger(scaled) ? 0 : 1;
  return `${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
}

function formatPercentage(value: number): string {
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
