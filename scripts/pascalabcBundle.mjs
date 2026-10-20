// Pure helpers of the PascalABC.NET bundle (pascalabc-bundle/): the official PABCNETC.zip, unchanged, next to its
// record and licence texts. The archive must be exactly the file the Runtime Manager manifest pins (version, SHA-256,
// size), because the app puts it in the download cache in place of that download. Used by
// scripts/prepare-pascalabc-bundle.mjs and the packaging checks; tested in src/services/pascalabcBundle.test.ts.

export const BUNDLE_FORMAT = "openmind-pascalabc-bundle";
export const ARCHIVE = "PABCNETC.zip";
/** Licence texts shipped beside the archive (copied from licenses/pascalabc/). */
export const LICENSE_FILES = [
  "License_en.txt",
  "copyright.txt",
  "LGPL-3.0.txt",
  "GPL-3.0.txt",
  "PT4-license-en.txt",
  "NOTICE.txt",
];

/** The manifest's Windows x64 download of its default version: what the bundle must be. */
export function pinnedArtifact(manifest) {
  const version = manifest.versions?.find((v) => v.version === manifest.defaultVersion);
  const artifact = version?.artifacts?.find((a) => a.platform === "windows-x64");
  if (!artifact) throw new Error(`the ${manifest.id} manifest has no windows-x64 download for ${manifest.defaultVersion}`);
  return { version: manifest.defaultVersion, url: artifact.url, sha256: artifact.sha256, size: artifact.sizeBytes };
}

/** Why `actual` ({sha256, size}) isn't the pinned archive, or null when it is. */
export function archiveProblem(pinned, actual) {
  if (actual.size !== pinned.size) {
    return `it is ${actual.size} bytes, the pinned PascalABC.NET ${pinned.version} archive is ${pinned.size}`;
  }
  if (actual.sha256 !== pinned.sha256) {
    return `its SHA-256 is ${actual.sha256}, the pinned archive's is ${pinned.sha256} (pascalabc.net may have published a newer build: update the manifest first)`;
  }
  return null;
}

/** bundle.json: what the app reads (src-tauri/src/commands/pascalabc.rs). */
export function bundleRecord(pinned) {
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    compilerVersion: pinned.version,
    file: ARCHIVE,
    sha256: pinned.sha256,
    size: pinned.size,
    source: pinned.url,
    licenses: LICENSE_FILES,
  };
}

/** Problems of a built bundle: its record against the pinned archive and the files present. Empty when ready. */
export function validateBundle(record, pinned, files) {
  const problems = [];
  const expected = bundleRecord(pinned);
  for (const key of ["format", "version", "compilerVersion", "file", "sha256", "size", "source"]) {
    if (record?.[key] !== expected[key]) problems.push(`bundle.json ${key} is ${JSON.stringify(record?.[key])}, expected ${JSON.stringify(expected[key])}`);
  }
  for (const name of [ARCHIVE, ...LICENSE_FILES]) {
    if (!files.includes(name)) problems.push(`${name} is missing`);
  }
  return problems;
}

export const NOTICE = `PascalABC.NET console compiler (PABCNETC.zip), shipped unchanged by OpenMind Studio

PascalABC.NET - Copyright (C) 2005-2026 by Ivan Bondarev, Stanislav Mikhalkovich.
Distributed under the GNU LGPL version 3 with the clarifications and exceptions in License_en.txt
(the GNU LGPL v3 and GNU GPL v3 texts are LGPL-3.0.txt and GPL-3.0.txt).

The archive is the official file from https://pascalabc.net/downloads/PABCNETC.zip, byte for byte; OpenMind Studio
has not modified it. The source code of PascalABC.NET is available at https://github.com/pascalabcnet/pascalabcnet.

The archive also contains the interface units of PROGRAMMING TASKBOOK FOR PASCALABC.NET (Lib/PT4*.pcu),
Copyright (c) M. Abramyan, 1998-2026, under its own licence (PT4-license-en.txt): it may be distributed freely only
unmodified and free of charge. OpenMind Studio is free of charge and ships the archive unmodified.
`;
