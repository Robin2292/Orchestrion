/** Shared host contract for signed token verification, persistence and refresh.
 * Persisted absolute deadlines still govern use; this cap never extends them. */
export const CODEX_MAX_TOKEN_LIFETIME_SECONDS = 14 * 24 * 60 * 60;
