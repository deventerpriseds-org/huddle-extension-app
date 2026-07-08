// Central model catalog for the Huddle router. Single source of truth so the
// Settings dropdown, defaults, and priority-tier gating stay consistent.

export type RouterBackend = "openai" | "lovable";

export interface CatalogModel {
  /** Value stored in config + sent to the provider. */
  id: string;
  /** Human label in the dropdown. */
  label: string;
  /** Group used to render <optgroup>-style sections. */
  group: string;
  /** True → "Fast mode" toggle can request the priority tier. */
  supportsPriority: boolean;
}

export const ROUTER_MODELS: Record<RouterBackend, CatalogModel[]> = {
  openai: [
    { id: "gpt-5.5", label: "GPT-5.5 (default)", group: "GPT-5.5", supportsPriority: true },
    { id: "gpt-5.4", label: "GPT-5.4", group: "GPT-5.4", supportsPriority: true },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini", group: "GPT-5.4", supportsPriority: true },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano", group: "GPT-5.4", supportsPriority: false },
    { id: "gpt-5.2", label: "GPT-5.2", group: "GPT-5", supportsPriority: true },
    { id: "gpt-5", label: "GPT-5", group: "GPT-5", supportsPriority: true },
    { id: "gpt-5-mini", label: "GPT-5 mini", group: "GPT-5", supportsPriority: true },
    { id: "gpt-5-nano", label: "GPT-5 nano", group: "GPT-5", supportsPriority: false },
  ],
  lovable: [
    { id: "openai/gpt-5.5", label: "OpenAI GPT-5.5 (default)", group: "OpenAI via Lovable", supportsPriority: true },
    { id: "openai/gpt-5.4", label: "OpenAI GPT-5.4", group: "OpenAI via Lovable", supportsPriority: true },
    { id: "openai/gpt-5.4-mini", label: "OpenAI GPT-5.4 mini", group: "OpenAI via Lovable", supportsPriority: true },
    { id: "openai/gpt-5-mini", label: "OpenAI GPT-5 mini", group: "OpenAI via Lovable", supportsPriority: true },
    { id: "openai/gpt-5-nano", label: "OpenAI GPT-5 nano", group: "OpenAI via Lovable", supportsPriority: false },
    { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google via Lovable", supportsPriority: false },
    { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", group: "Google via Lovable", supportsPriority: false },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", group: "Google via Lovable", supportsPriority: false },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", group: "Google via Lovable", supportsPriority: false },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", group: "Google via Lovable", supportsPriority: false },
  ],
};

export const DEFAULT_ROUTER_MODEL: Record<RouterBackend, string> = {
  openai: "gpt-5.5",
  lovable: "openai/gpt-5.5",
};

export const CATALOG_VERSION = "2026-07-08";

export function getModel(backend: RouterBackend, id: string): CatalogModel | undefined {
  return ROUTER_MODELS[backend].find((m) => m.id === id);
}

export function supportsPriority(backend: RouterBackend, id: string): boolean {
  return !!getModel(backend, id)?.supportsPriority;
}
