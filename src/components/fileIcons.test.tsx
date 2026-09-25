import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileTypeIcon } from "./fileIcons";
import { iconUrl } from "./fileIconUrls";
import { fileIconName, usedIconNames } from "./fileIconSpec";

describe("file type icons", () => {
  it("picks the language's icon by file name, .d.ts and extension", () => {
    expect(fileIconName("app.py")).toBe("python");
    expect(fileIconName("Main.JAVA")).toBe("java");
    expect(fileIconName("index.tsx")).toBe("react_ts");
    expect(fileIconName("types.d.ts")).toBe("typescript-def");
    expect(fileIconName("package.json")).toBe("nodejs");
    expect(fileIconName("Dockerfile")).toBe("docker");
    expect(fileIconName("notes")).toBe("file");
    expect(fileIconName("strange.qqq")).toBe("file");
  });

  it("bundles an SVG for every icon the tables name", () => {
    const missing = usedIconNames().filter((name) => iconUrl(name) === undefined);
    expect(missing).toEqual([]);
  });

  it("draws an image, not a letter", () => {
    const { container } = render(<FileTypeIcon name="hello.py" />);
    const img = container.querySelector("img.file-icon");
    expect(img?.getAttribute("src")).toBe(iconUrl("python"));
    expect(container.querySelector("text")).toBeNull();
  });
});
