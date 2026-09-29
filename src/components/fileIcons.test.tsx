import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileTypeIcon } from "./fileIcons";
import { iconUrl } from "./fileIconUrls";
import { fileIconName, folderIconName, usedFolderIconNames, usedIconNames } from "./fileIconSpec";
import { FolderTypeIcon } from "./fileIcons";
import {
  DEFAULT_ICON_THEME,
  followIconTheme,
  iconThemeById,
  ICON_THEMES,
  setActiveIconTheme,
} from "./iconThemes";

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

describe("the spec's file types", () => {
  it.each([
    ["app.js", "javascript"],
    ["a.ts", "typescript"],
    ["App.tsx", "react_ts"],
    ["b.jsx", "react"],
    ["index.html", "html"],
    ["s.css", "css"],
    ["s.scss", "sass"],
    ["data.json", "json"],
    ["ci.yml", "yaml"],
    ["Cargo.toml", "rust"],
    ["a.xml", "xml"],
    ["m.py", "python"],
    ["index.php", "php"],
    ["artisan", "laravel"],
    ["welcome.blade.php", "laravel"],
    ["main.rs", "rust"],
    ["main.go", "go"],
    ["A.java", "java"],
    ["a.c", "c"],
    ["a.cpp", "cpp"],
    ["a.cs", "csharp"],
    ["README.md", "readme"],
    ["notes.md", "markdown"],
    ["Dockerfile", "docker"],
    ["Dockerfile.dev", "docker"],
    ["docker-compose.override.yml", "docker"],
    ["q.sql", "database"],
    ["schema.prisma", "prisma"],
    ["q.graphql", "graphql"],
    ["main.dart", "dart"],
    ["pubspec.yaml", "dart"],
    ["build.gradle", "gradle"],
    ["AndroidManifest.xml", "android"],
    ["tauri.conf.json", "tauri"],
    [".gitignore", "git"],
    [".env", "tune"],
    [".env.production", "tune"],
  ])("%s -> %s", (file, icon) => {
    expect(fileIconName(file)).toBe(icon);
  });
});

describe("folder icons", () => {
  it.each([
    ["src", "folder-src"],
    ["test", "folder-test"],
    ["tests", "folder-test"],
    ["node_modules", "folder-node"],
    [".git", "folder-git"],
    ["dist", "folder-dist"],
    ["build", "folder-dist"],
    ["target", "folder-target"],
    ["public", "folder-public"],
    ["assets", "folder-resource"],
    ["routes", "folder-routes"],
    ["controllers", "folder-controller"],
    ["components", "folder-components"],
    ["pages", "folder-views"],
    ["My Folder", "folder-base"],
  ])("%s -> %s and its open twin", (name, icon) => {
    expect(folderIconName(name, false)).toBe(icon);
    expect(folderIconName(name, true)).toBe(`${icon}-open`);
  });

  it("every folder icon the table can return is bundled (no broken image)", () => {
    expect(usedFolderIconNames().filter((name) => iconUrl(name) === undefined)).toEqual([]);
  });
});

describe("icon themes", () => {
  it("an unknown theme id falls back to the default, and every built-in theme is listed once", () => {
    expect(iconThemeById("no-such-theme").id).toBe(DEFAULT_ICON_THEME);
    expect(iconThemeById("extension:acme.pack/icons").id).toBe("extension:acme.pack/icons");
    expect(new Set(ICON_THEMES.map((theme) => theme.id)).size).toBe(ICON_THEMES.length);
  });

  it("the theme decides file and folder icons and follows the setting (so the choice persists with it)", () => {
    let value = "material-files";
    const handlers: (() => void)[] = [];
    followIconTheme({
      string: () => value,
      onChange: (_ids, handler) => {
        handlers.push(handler);
        return () => undefined;
      },
    });
    const files = render(
      <>
        <FileTypeIcon name="a.py" />
        <FolderTypeIcon name="src" open={false} />
      </>,
    );
    expect(files.container.querySelectorAll("img")).toHaveLength(1);
    expect(files.container.querySelector("img")?.getAttribute("src")).toBe(iconUrl("python"));
    files.unmount();

    value = "material";
    handlers.forEach((handler) => {
      handler();
    });
    const both = render(
      <>
        <FileTypeIcon name="a.py" />
        <FolderTypeIcon name="src" open={true} />
      </>,
    );
    const sources = [...both.container.querySelectorAll("img")].map((img) =>
      img.getAttribute("src"),
    );
    expect(sources).toEqual([iconUrl("python"), iconUrl("folder-src-open")]);
    both.unmount();

    value = "minimal";
    handlers.forEach((handler) => {
      handler();
    });
    const minimal = render(
      <>
        <FileTypeIcon name="a.py" />
        <FolderTypeIcon name="src" open={false} />
      </>,
    );
    expect(
      [...minimal.container.querySelectorAll("img")].map((img) => img.getAttribute("src")),
    ).toEqual([iconUrl("file")]);
    minimal.unmount();
    setActiveIconTheme(DEFAULT_ICON_THEME);
  });
});
