import type { Scope } from "./policy/p0-canonical";
import type { ToolDefinition, ToolPolicyMetadata } from "./tool-registry-contracts";

/** Read-only policy metadata projection. It is configuration evidence only and
 * never grants invocation authority. */
export interface ToolPolicySource {
  metadata(definition: ToolDefinition, scope: Scope): ToolPolicyMetadata | null;
}
