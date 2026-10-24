import { describe, expect, it } from "vitest";
import { agentOptions, DEFAULT_AGENT_OPTIONS } from "./agentOptions";

describe("reasoning and output limits", () => {
  it("delegates default output and reasoning budgets to the server", () => {
    const options = agentOptions(null);
    expect(options.reasoningBudgetTokens).toBe(0);
    expect(options.maxOutputTokens).toBe(0);
    expect(options).toEqual(DEFAULT_AGENT_OPTIONS);
  });

  it("keeps existing users' explicit output settings", () => {
    const settings = agentOptions({ maxOutputTokens: 16384 });
    expect(settings.maxOutputTokens).toBe(16384);
    expect(settings.reasoningBudgetTokens).toBe(0);
  });

  it("accepts zero to delegate reasoning to the server", () => {
    expect(
      agentOptions({ reasoningBudgetTokens: 0 }).reasoningBudgetTokens,
    ).toBe(0);
  });

  it("bounds invalid or huge client values before sending to Rust", () => {
    expect(
      agentOptions({ reasoningBudgetTokens: 1e9 }).reasoningBudgetTokens,
    ).toBe(1e9);
    expect(
      agentOptions({ reasoningBudgetTokens: -5 }).reasoningBudgetTokens,
    ).toBe(0);
    expect(
      agentOptions({ reasoningBudgetTokens: Number.NaN }).reasoningBudgetTokens,
    ).toBe(0);
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

it("accepts large model token windows without the old desktop ceilings", () => {
  expect(
    agentOptions({
      contextTokens: 1_000_000,
      maxOutputTokens: 200_000,
      reasoningBudgetTokens: 100_000,
    }),
  ).toMatchObject({
    contextTokens: 1_000_000,
    maxOutputTokens: 200_000,
    reasoningBudgetTokens: 100_000,
  });
});
