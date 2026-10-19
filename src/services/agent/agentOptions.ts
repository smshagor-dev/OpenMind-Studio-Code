/** Persisted task settings. Runtime limits are validated again by Rust. */
export interface AgentOptions {
  effort: "low" | "medium" | "high";
  useGpu: boolean;
  searchEndpoint: string;
  visionEndpoint: string;
  imageEndpoint: string;
  contextTokens: number;
  maxOutputTokens: number;
  reasoningBudgetTokens: number;
  maxSteps: number;
  maxContinuations: number;
  temperature: number;
  commandTimeoutSeconds: number;
  autoContinue: boolean;
  autoRunQueue: boolean;
  showReasoning: boolean;
  autoScroll: boolean;
  /** One command line run after a turn changed files (empty = none). */
  afterEditCommand: string;
}

export const DEFAULT_AGENT_OPTIONS: Readonly<AgentOptions> = {
  effort: "medium",
  useGpu: true,
  searchEndpoint: "",
  visionEndpoint: "",
  imageEndpoint: "",
  contextTokens: 0,
  maxOutputTokens: 4096,
  reasoningBudgetTokens: 1024,
  maxSteps: 128,
  maxContinuations: 8,
  temperature: 0.6,
  commandTimeoutSeconds: 120,
  autoContinue: true,
  autoRunQueue: true,
  showReasoning: true,
  autoScroll: true,
  afterEditCommand: "",
};

export function agentOptions(value: unknown): AgentOptions {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const number = (
    key: keyof AgentOptions,
    low: number,
    high: number,
    integer = true,
  ): number => {
    const v = source[key];
    const fallback = DEFAULT_AGENT_OPTIONS[key];
    const n =
      typeof v === "number" && Number.isFinite(v)
        ? Math.max(low, Math.min(high, v))
        : Number(fallback);
    return integer ? Math.round(n) : n;
  };
  const bool = (key: keyof AgentOptions): boolean =>
    typeof source[key] === "boolean"
      ? source[key]
      : Boolean(DEFAULT_AGENT_OPTIONS[key]);
  const endpoint = (
    key: "searchEndpoint" | "visionEndpoint" | "imageEndpoint",
  ): string =>
    typeof source[key] === "string" ? source[key].trim().slice(0, 2048) : "";
  return {
    effort:
      source.effort === "low" || source.effort === "high"
        ? source.effort
        : "medium",
    useGpu: bool("useGpu"),
    searchEndpoint: endpoint("searchEndpoint"),
    visionEndpoint: endpoint("visionEndpoint"),
    imageEndpoint: endpoint("imageEndpoint"),
    contextTokens: number("contextTokens", 0, 131072),
    maxOutputTokens: number("maxOutputTokens", 1024, 32768),
    reasoningBudgetTokens: number("reasoningBudgetTokens", 0, 8192),
    maxSteps: number("maxSteps", 8, 512),
    maxContinuations: number("maxContinuations", 0, 16),
    temperature: number("temperature", 0, 1, false),
    commandTimeoutSeconds: number("commandTimeoutSeconds", 10, 600),
    autoContinue: bool("autoContinue"),
    autoRunQueue: bool("autoRunQueue"),
    showReasoning: bool("showReasoning"),
    autoScroll: bool("autoScroll"),
    afterEditCommand:
      typeof source.afterEditCommand === "string" && !/[\u0000-\u001f]/.test(source.afterEditCommand)
        ? source.afterEditCommand.trim().slice(0, 2000)
        : "",
  };
}
