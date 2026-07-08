// Store factory. Today: only Azure Postgres. Later: add Lovable Cloud
// implementation and switch based on agent config.

import { azurePgStore } from "./azure-pg.server";
import type { RagStore } from "./types";

export type StoreKind = "azure" | "lovable" | "none";

export function getStore(kind: StoreKind): RagStore | null {
  if (kind === "azure") return azurePgStore;
  // "lovable" not yet implemented; falls back to no retrieval.
  return null;
}
