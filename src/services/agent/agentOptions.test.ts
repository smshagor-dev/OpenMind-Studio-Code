import { describe, expect, it } from "vitest";
import { agentOptions, DEFAULT_AGENT_OPTIONS } from "./agentOptions";

describe("reasoning and output limits", () => {
  it("uses a bounded default reasoning budget and shorter output limit", () => {
    const options = agentOptions(null);
    expect(options.reasoningBudgetTokens).toBe(1024);
    expect(options.maxOutputTokens).toBe(4096);
    expect(options).toEqual(DEFAULT_AGENT_OPTIONS);
  });

  it("keeps existing users' explicit output settings", () => {
    const settings = agentOptions({ maxOutputTokens: 16384 });
    expect(settings.maxOutputTokens).toBe(16384);
    expect(settings.reasoningBudgetTokens).toBe(1024);
  });

  it("accepts zero to request no reasoning", () => {
    expect(agentOptions({ reasoningBudgetTokens: 0 }).reasoningBudgetTokens)
      .toBe(0);
  });

  it("bounds invalid or huge client values before sending to Rust", () => {
    expect(agentOptions({ reasoningBudgetTokens: 1e9 }).reasoningBudgetTokens)
      .toBe(8192);
    expect(agentOptions({ reasoningBudgetTokens: -5 }).reasoningBudgetTokens)
      .toBe(0);
    expect(agentOptions({ reasoningBudgetTokens: Number.NaN }).reasoningBudgetTokens)
      .toBe(1024);
  });

  it("hiding thinking changes display only, not the generation budget", () => {
    const options = agentOptions({
      reasoningBudgetTokens: 512,
      showReasoning: false,
    });
    expect(options.showReasoning).toBe(false);
    expect(options.reasoningBudgetTokens).toBe(512);
  });
});
