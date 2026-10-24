import { describe, expect, it, vi } from "vitest";
import { readAttachment } from "./agentAttachments";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
function file(text: string, name = "code.ts"): File {
  const value = new File([text], name, { type: "text/plain" });
  Object.defineProperty(value, "arrayBuffer", {
    value: () => Promise.resolve(new TextEncoder().encode(text).buffer),
  });
  return value;
}
describe("readAttachment", () => {
  it("reads UTF-8 source without interpreting instructions", async () => {
    expect(
      await readAttachment(file("const greeting = 'বাংলা';")),
    ).toMatchObject({
      name: "code.ts",
      text: "const greeting = 'বাংলা';",
    });
  });
  it("rejects empty and binary files", async () => {
    await expect(readAttachment(file(""))).rejects.toThrow("1 byte");
    await expect(readAttachment(file("binary\0payload"))).rejects.toThrow(
      "binary",
    );
  });
});

it("retains UTF-8 text beyond the old 100 KB attachment limit", async () => {
  const text = "বাংলা source\n".repeat(40_000);
  expect((await readAttachment(file(text))).text).toBe(text);
});
