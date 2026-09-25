import { createContext, useContext, type ReactNode } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";

const DesktopApiContext = createContext<OrchestrionDesktopApi | undefined>(undefined);

export function DesktopApiProvider({
  api,
  children,
}: {
  api?: OrchestrionDesktopApi;
  children: ReactNode;
}) {
  const bridge = api ?? (typeof window !== "undefined" ? window.orchestrion : undefined);
  return <DesktopApiContext.Provider value={bridge}>{children}</DesktopApiContext.Provider>;
}

export function useDesktopApi(): OrchestrionDesktopApi | undefined {
  const api = useContext(DesktopApiContext);
  return api ?? (typeof window !== "undefined" ? window.orchestrion : undefined);
}
