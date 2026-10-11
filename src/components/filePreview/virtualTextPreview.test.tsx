import { act, cleanup, render } from "@testing-library/react";
import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VirtualTextPreview } from "./VirtualTextPreview";

// The editor widget itself isn't under test: only what the preview writes into the shared model.
vi.mock("../../editor/MonacoHost", () => ({ MonacoHost: () => null }));

afterEach(cleanup);

const modelOf = (uri: string) => monaco.editor.getModel(monaco.Uri.parse(uri));

describe("a remote document's editor model", () => {
  it("never takes the snapshot back once it followed the live document (a disconnect keeps everyone's edits)", () => {
    const uri = "omcollab://room-a/file-1";
    const view = render(<VirtualTextPreview uri={uri} text="snapshot" language="plaintext" live />);
    // Collaborators' edits arrive through the CRDT binding.
    act(() => modelOf(uri)?.setValue("snapshot + everyone's edits"));
    // The room becomes unreachable: the document is no longer live and its tab still carries the old snapshot.
    view.rerender(<VirtualTextPreview uri={uri} text="snapshot" language="plaintext" live={false} />);
    expect(modelOf(uri)?.getValue()).toBe("snapshot + everyone's edits");
    // A second view of it (another tab, a remount) doesn't bring the snapshot back either.
    const other = render(<VirtualTextPreview uri={uri} text="snapshot" language="plaintext" live={false} />);
    expect(modelOf(uri)?.getValue()).toBe("snapshot + everyone's edits");
    other.unmount();
    view.unmount();
  });

  it("follows a newer snapshot while it has never been live", () => {
    const uri = "omcollab://room-a/file-2";
    const view = render(<VirtualTextPreview uri={uri} text="v1" language="plaintext" />);
    view.rerender(<VirtualTextPreview uri={uri} text="v2" language="plaintext" />);
    expect(modelOf(uri)?.getValue()).toBe("v2");
    view.unmount();
  });
});
