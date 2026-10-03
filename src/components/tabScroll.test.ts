import { describe, expect, it } from "vitest";

import { overflows, revealScrollLeft, wheelDistance } from "./tabScroll";

const wheel = (deltaX: number, deltaY: number, deltaMode = 0, shiftKey = false) => ({ deltaX, deltaY, deltaMode, shiftKey });

describe("tab row wheel distance", () => {
  it("turns a vertical wheel into sideways movement, with or without Shift", () => {
    expect(wheelDistance(wheel(0, 120), 500)).toBe(120);
    expect(wheelDistance(wheel(0, -120), 500)).toBe(-120);
    expect(wheelDistance(wheel(0, 120, 0, true), 500)).toBe(120);
  });

  it("uses a trackpad's sideways swipe as it is", () => {
    expect(wheelDistance(wheel(-40, 3), 500)).toBe(-40);
    expect(wheelDistance(wheel(25, -2), 500)).toBe(25);
  });

  it("converts line and page units to pixels", () => {
    expect(wheelDistance(wheel(0, 3, 1), 500)).toBe(48);
    expect(wheelDistance(wheel(0, 1, 2), 500)).toBe(500);
    expect(wheelDistance(wheel(0, 0), 500)).toBe(0);
  });
});

describe("revealing a tab", () => {
  // Row 300px wide, scrolled to 200: tabs from 200 to 500 are visible.
  it("leaves a fully visible tab alone", () => {
    expect(revealScrollLeft(200, 300, 250, 100)).toBeNull();
    expect(revealScrollLeft(200, 300, 200, 300)).toBeNull();
  });

  it("scrolls left to a tab cut off (or hidden) on the left", () => {
    expect(revealScrollLeft(200, 300, 150, 100)).toBe(150);
    expect(revealScrollLeft(200, 300, 0, 100)).toBe(0);
  });

  it("scrolls right just enough for a tab cut off (or hidden) on the right", () => {
    expect(revealScrollLeft(200, 300, 450, 100)).toBe(250);
    expect(revealScrollLeft(0, 300, 1100, 120)).toBe(920);
  });

  it("aligns a tab wider than the row to its start", () => {
    expect(revealScrollLeft(0, 100, 400, 150)).toBe(400);
  });
});

describe("overflow", () => {
  it("is only when the tabs are wider than the row", () => {
    expect(overflows(1200, 400)).toBe(true);
    expect(overflows(400, 400)).toBe(false);
    expect(overflows(400.5, 400)).toBe(false);
  });
});
