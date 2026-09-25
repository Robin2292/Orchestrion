/** An internal lifetime fence, not an org/Tool permission grant. Renderer-owned
 * work receives its live document check; bootstrap/reconciliation/cleanup are
 * explicitly host-owned and cannot inherit a former document's cancellation. */
export type AssertRequestActive = () => void;
export const hostOwnedWork: AssertRequestActive = () => {};
