import { describe, expect, it, vi } from "vitest";

import { aiExtension, aiRig, extProviderId, providerInfo } from "../../testUtils/aiFixtures";

describe("AiProviderService: when the AI panel exists", () => {
  it("is hidden with no provider at all — no panel, nothing to show", async () => {
    const rig = aiRig();
    await rig.providers.initialize();
    expect(rig.providers.panelVisible()).toBe(false);
    expect(rig.providers.usable()).toEqual([]);
    expect(rig.providers.selected()).toBeNull();
    // Reading the list is a local read: no request to any provider was made.
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(rig.ipc.aiProviderTest).not.toHaveBeenCalled();
  });

  it("appears when a provider is enabled, disappears when it is disabled and returns when it is enabled again", async () => {
    const rig = aiRig({ providers: [providerInfo()] });
    await rig.providers.initialize();
    expect(rig.providers.panelVisible()).toBe(true);
    await rig.providers.setEnabled("p1", false);
    expect(rig.providers.panelVisible()).toBe(false);
    expect(rig.providers.find("p1")?.unavailableReason).toBe("This provider is turned off.");
    await rig.providers.setEnabled("p1", true);
    expect(rig.providers.panelVisible()).toBe(true);
  });

  it("stays while another provider remains, and the selection moves to it", async () => {
    const rig = aiRig({ providers: [providerInfo(), providerInfo({ id: "p2", name: "Second" })] });
    await rig.providers.initialize();
    rig.providers.select("p1");
    expect(rig.providers.selected()?.id).toBe("p1");
    await rig.providers.setEnabled("p1", false);
    expect(rig.providers.panelVisible()).toBe(true);
    expect(rig.providers.selected()?.id).toBe("p2");
  });

  it("is hidden while AI is turned off in settings, whatever is configured", async () => {
    const rig = aiRig({ providers: [providerInfo()], settings: { "ai.enabled": false } });
    await rig.providers.initialize();
    expect(rig.providers.panelVisible()).toBe(false);
    rig.values["ai.enabled"] = true;
    await rig.settings.set("user", "ai.enabled", true);
    expect(rig.providers.panelVisible()).toBe(true);
  });

  it("notifies subscribers whenever availability changes", async () => {
    const rig = aiRig({ providers: [providerInfo()] });
    await rig.providers.initialize();
    const seen: boolean[] = [];
    rig.providers.subscribe(() => {
      seen.push(rig.providers.panelVisible());
    });
    await rig.providers.setEnabled("p1", false);
    await rig.providers.setEnabled("p1", true);
    expect(seen).toEqual([false, true]);
  });
});

describe("AiProviderService: providers contributed by extensions", () => {
  it("creates the provider when its extension is enabled, so the panel appears", async () => {
    const extension = aiExtension();
    const rig = aiRig({ extensions: [extension] });
    await rig.providers.initialize();
    const id = extProviderId(extension);
    expect(rig.providers.find(id)).toMatchObject({
      name: "Acme AI",
      source: extension.id,
      model: "acme-1",
      models: ["acme-1", "acme-2"],
      enabled: true,
      available: true,
    });
    expect(rig.providers.panelVisible()).toBe(true);
  });

  it("removes the provider — and the panel — at once when the extension is disabled, and restores them when it is enabled", async () => {
    const extension = aiExtension();
    const rig = aiRig({ extensions: [extension] });
    await rig.providers.initialize();
    expect(rig.providers.panelVisible()).toBe(true);

    rig.setExtensions([{ ...extension, enabled: false }]);
    expect(rig.providers.panelVisible()).toBe(false);
    expect(rig.providers.find(extProviderId(extension))?.unavailableReason).toBe(
      "The extension Sample AI Provider is disabled.",
    );

    rig.setExtensions([{ ...extension, enabled: true }]);
    expect(rig.providers.panelVisible()).toBe(true);
  });

  it("says the provider is gone when its extension is uninstalled, and never lists it as usable", async () => {
    const extension = aiExtension();
    const rig = aiRig({ extensions: [extension] });
    await rig.providers.initialize();
    rig.setExtensions([]);
    expect(rig.providers.panelVisible()).toBe(false);
    expect(rig.providers.find(extProviderId(extension))?.unavailableReason).toContain(
      "is not installed",
    );
  });

  it("marks a provider whose extension is uninstalled as removable, but not one whose extension is only disabled", async () => {
    const extension = aiExtension();
    const rig = aiRig({ extensions: [extension] });
    await rig.providers.initialize();
    const id = extProviderId(extension);
    expect(rig.providers.find(id)?.sourceMissing).toBe(false);
    rig.setExtensions([{ ...extension, enabled: false }]);
    expect(rig.providers.find(id)?.sourceMissing).toBe(false);
    rig.setExtensions([]);
    expect(rig.providers.find(id)?.sourceMissing).toBe(true);
    expect(await rig.providers.remove(id)).toBeNull();
    expect(rig.providers.find(id)).toBeUndefined();
  });

  it("keeps a user's own provider when an extension's provider goes away", async () => {
    const extension = aiExtension();
    const rig = aiRig({ providers: [providerInfo()], extensions: [extension] });
    await rig.providers.initialize();
    rig.setExtensions([{ ...extension, enabled: false }]);
    expect(rig.providers.panelVisible()).toBe(true);
    expect(rig.providers.usable().map((p) => p.id)).toEqual(["p1"]);
  });

  it("does not create a provider for a disabled extension and never creates one twice", async () => {
    const extension = aiExtension({ enabled: false });
    const rig = aiRig({ extensions: [extension] });
    await rig.providers.initialize();
    expect(rig.ipc.aiProviderSave).not.toHaveBeenCalled();
    rig.setExtensions([{ ...extension, enabled: true }]);
    await rig.providers.syncContributions();
    await rig.providers.syncContributions();
    expect(rig.ipc.aiProviderSave).toHaveBeenCalledTimes(1);
  });
});

describe("AiProviderService: configuration", () => {
  it("asks for a missing key or model before chat can start", async () => {
    const rig = aiRig({
      providers: [
        providerInfo({ id: "nokey", hasKey: false }),
        providerInfo({ id: "nomodel", model: "", models: [] }),
        providerInfo({ id: "local", needsKey: false, local: true, hasKey: false }),
      ],
    });
    await rig.providers.initialize();
    expect(rig.providers.configIssue(must(rig.providers.find("nokey")))).toContain(
      "Add an API key",
    );
    expect(rig.providers.configIssue(must(rig.providers.find("nomodel")))).toContain(
      "Choose a model",
    );
    expect(rig.providers.configIssue(must(rig.providers.find("local")))).toBeNull();
  });

  it("uses the default model when the default provider has none of its own", async () => {
    const rig = aiRig({
      providers: [providerInfo({ model: "", models: [] })],
      settings: { "ai.defaultProvider": "p1", "ai.defaultModel": "big-model" },
    });
    await rig.providers.initialize();
    const view = rig.providers.find("p1");
    expect(view && rig.providers.modelOf(view)).toBe("big-model");
  });

  it("adds a provider with its key sent once to the backend and never kept in the UI state", async () => {
    const rig = aiRig();
    await rig.providers.initialize();
    const result = await rig.providers.save(
      {
        name: "My OpenAI",
        kind: "openai-compatible",
        baseUrl: "",
        model: "gpt-x",
        enabled: true,
      },
      "sk-secret-value-123",
    );
    expect(result.ok).toBe(true);
    expect(rig.ipc.aiProviderSetKey).toHaveBeenCalledWith(
      expect.any(String),
      "sk-secret-value-123",
    );
    expect(rig.providers.find(result.ok ? result.provider.id : "")?.hasKey).toBe(true);
    expect(JSON.stringify(rig.providers.getState())).not.toContain("sk-secret-value-123");
    expect(JSON.stringify(rig.providers.all())).not.toContain("sk-secret-value-123");
    expect(rig.providers.panelVisible()).toBe(true);
  });

  it("reports a refused save and does not add the provider", async () => {
    const rig = aiRig({
      ipc: {
        aiProviderSave: vi.fn().mockRejectedValue(new Error("Only https endpoints are allowed.")),
      },
    });
    await rig.providers.initialize();
    const result = await rig.providers.save({
      name: "Bad",
      kind: "openai-compatible",
      baseUrl: "http://example.com",
      model: "",
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: "Error: Only https endpoints are allowed." });
    expect(rig.providers.all()).toEqual([]);
  });

  it("edits, clears the key, sets the model and deletes", async () => {
    const rig = aiRig({ providers: [providerInfo()] });
    await rig.providers.initialize();
    await rig.providers.clearKey("p1");
    expect(rig.providers.find("p1")?.hasKey).toBe(false);
    await rig.providers.setKey("p1", "  sk-new  ");
    expect(rig.ipc.aiProviderSetKey).toHaveBeenLastCalledWith("p1", "sk-new");
    await rig.providers.setModel("p1", "m2");
    expect(rig.providers.find("p1")?.model).toBe("m2");
    expect(await rig.providers.remove("p1")).toBeNull();
    expect(rig.providers.all()).toEqual([]);
    expect(rig.providers.panelVisible()).toBe(false);
  });

  it("makes a provider the default in the settings", async () => {
    const rig = aiRig({ providers: [providerInfo({ id: "a" }), providerInfo({ id: "b" })] });
    await rig.providers.initialize();
    await rig.providers.setDefault("b");
    expect(rig.settings.set).toHaveBeenCalledWith("user", "ai.defaultProvider", "b");
    expect(rig.providers.selected()?.id).toBe("b");
  });
});

describe("AiProviderService: connection test", () => {
  it("asks the provider once, on demand, and reports the models", async () => {
    const rig = aiRig({ providers: [providerInfo()] });
    await rig.providers.initialize();
    expect(rig.ipc.aiProviderTest).not.toHaveBeenCalled();
    const result = await rig.providers.test("p1");
    expect(result).toEqual({ status: "ok", message: "Connected. 2 models available." });
    expect(rig.ipc.aiProviderTest).toHaveBeenCalledTimes(1);
    expect(rig.providers.getState().tests.p1?.status).toBe("ok");
  });

  it("shows the failure message", async () => {
    const rig = aiRig({
      providers: [providerInfo()],
      ipc: {
        aiProviderTest: vi
          .fn()
          .mockRejectedValue("The provider rejected the API key or the request (HTTP 401)."),
      },
    });
    await rig.providers.initialize();
    const result = await rig.providers.test("p1");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("HTTP 401");
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("provider missing in the test");
  return value;
}
