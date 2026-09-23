import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { FileSystemService } from "./fileSystemService";
import type { DirEntryInfo } from "./ipc";

function direntry(name: string): DirEntryInfo {
  return { name, path: `C:/proj/${name}`, isDir: false, isSymlink: false };
}

describe("FileSystemService", () => {
  it("delegates readDir/metadata/isBinary to the IPC client", async () => {
    const ipc = createFakeIpc();
    const service = new FileSystemService(ipc);

    await service.readDir("C:/proj");
    await service.metadata("C:/proj/a.txt");
    await service.isBinary("C:/proj/a.png");

    expect(ipc.fsReadDir).toHaveBeenCalledWith("C:/proj");
    expect(ipc.fsMetadata).toHaveBeenCalledWith("C:/proj/a.txt");
    expect(ipc.fsIsBinary).toHaveBeenCalledWith("C:/proj/a.png");
  });

  it("delegates create/rename/delete/move/copy with the workspace root", async () => {
    const ipc = createFakeIpc();
    const service = new FileSystemService(ipc);
    const root = "C:/proj";

    await service.createFile(root, "C:/proj/src", "a.ts");
    await service.createFolder(root, "C:/proj/src", "sub");
    await service.rename(root, "C:/proj/a.ts", "b.ts");
    await service.delete(root, "C:/proj/a.ts");
    await service.move(root, "C:/proj/a.ts", "C:/proj/src");
    await service.copy(root, "C:/proj/a.ts", "C:/proj/src");

    expect(ipc.fsCreateFile).toHaveBeenCalledWith(root, "C:/proj/src", "a.ts");
    expect(ipc.fsCreateFolder).toHaveBeenCalledWith(root, "C:/proj/src", "sub");
    expect(ipc.fsRename).toHaveBeenCalledWith(root, "C:/proj/a.ts", "b.ts");
    expect(ipc.fsDelete).toHaveBeenCalledWith(root, "C:/proj/a.ts");
    expect(ipc.fsMove).toHaveBeenCalledWith(root, "C:/proj/a.ts", "C:/proj/src");
    expect(ipc.fsCopy).toHaveBeenCalledWith(root, "C:/proj/a.ts", "C:/proj/src");
  });

  it("duplicate picks 'name copy.ext' when that name is free", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockResolvedValue([direntry("a.txt")]),
      fsDuplicate: vi.fn().mockResolvedValue("C:/proj/a copy.txt"),
    });
    const service = new FileSystemService(ipc);

    await service.duplicate("C:/proj", "C:/proj/a.txt");

    expect(ipc.fsDuplicate).toHaveBeenCalledWith("C:/proj", "C:/proj/a.txt", "a copy.txt");
  });

  it("duplicate skips names already taken by siblings", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi
        .fn()
        .mockResolvedValue([direntry("a.txt"), direntry("a copy.txt"), direntry("a copy 2.txt")]),
      fsDuplicate: vi.fn().mockResolvedValue("C:/proj/a copy 3.txt"),
    });
    const service = new FileSystemService(ipc);

    await service.duplicate("C:/proj", "C:/proj/a.txt");

    expect(ipc.fsDuplicate).toHaveBeenCalledWith("C:/proj", "C:/proj/a.txt", "a copy 3.txt");
  });

  it("duplicate handles names without an extension", async () => {
    const ipc = createFakeIpc({
      fsReadDir: vi.fn().mockResolvedValue([direntry("README")]),
      fsDuplicate: vi.fn().mockResolvedValue("C:/proj/README copy"),
    });
    const service = new FileSystemService(ipc);

    await service.duplicate("C:/proj", "C:/proj/README");

    expect(ipc.fsDuplicate).toHaveBeenCalledWith("C:/proj", "C:/proj/README", "README copy");
  });
});
