"use client";

import { useEffect } from "react";

interface UnsavedNavigationGuardOptions {
  isDirty: boolean;
  onNavigationAttempt?: (href: string) => void;
}

/**
 * One navigation boundary for unsaved client state.
 *
 * Browser exits use beforeunload. Same-origin links are intercepted before
 * Next.js can unmount the current route and are handed back to the owning page
 * so it can present its existing confirmation UI.
 */
export function useUnsavedNavigationGuard({
  isDirty,
  onNavigationAttempt,
}: UnsavedNavigationGuardOptions) {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    if (!isDirty || !onNavigationAttempt) return;
    const handler = (event: MouseEvent) => {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const next = `${destination.pathname}${destination.search}${destination.hash}`;
      if (next === current) return;

      event.preventDefault();
      event.stopPropagation();
      onNavigationAttempt(next);
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [isDirty, onNavigationAttempt]);
}
