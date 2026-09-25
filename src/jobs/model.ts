import { z } from "zod";
import type { RuntimeOwner } from "../shared/local-contracts";

export const SyntheticJobSchema = z.object({
  mode: z.enum(["success", "retry", "unknown"]),
  maxAttempts: z.number().int().min(1).max(5).default(3),
}).strict();
export type SyntheticJob = z.infer<typeof SyntheticJobSchema>;
export type JobStatus = "queued" | "claimed" | "effect" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface Claim { id: string; epoch: number; owner: RuntimeOwner; mode: SyntheticJob["mode"]; attempts: number }
export const LEASE_MS = 5_000;
export const retryDelay = (attempt: number): number => Math.min(30_000, 1_000 * 2 ** (attempt - 1));
export function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 60_000)
    throw new Error("JOB_CLOCK_INVALID");
  return value;
}
