// Authenticode-signs the Windows files of an already-built release folder (release/v<version>/windows/<arch>/), then
// makes OpenMind's own updater/LAN signatures, the update feed and the checksums match the final bytes again.
//
// Every effect (files, SignTool, PowerShell, the updater re-signing) is injected, so the rules are tested without a
// certificate (src/services/authenticode.test.ts); scripts/authenticode-release.mjs supplies the real ones.
//
// Order of safety:
//   1. everything is checked before anything changes: SignTool, the certificate, every file present, each file's
//      current signature (a file signed by another certificate or changed after signing is refused), and — when a file
//      will change — that the updater key is available (otherwise its .sig would go stale);
//   2. --dry-run prints the plan and stops;
//   3. every file that will change (and its .sig, SHA256SUMS.txt, latest.json) is copied to
//      validation/pre-authenticode/<time>/ and the copies are verified;
//   4. each change is made on a copy and verified before it replaces the original (a ZIP is rebuilt, unpacked again
//      and compared entry by entry: only OpenMindStudio.exe may differ);
//   5. any failure after a file was replaced puts every replaced file (and its .sig, the manifests) back from the backup;
//   6. the updater signatures, latest.json and SHA256SUMS.txt are regenerated, then the whole folder is verified.
import { compareTrees, describePlan, OUR_BINARIES, planArtifact } from "./authenticodeTools.mjs";

export const PACKAGE_FOLDER = "OpenMind Studio";
const INNER_EXE = `${PACKAGE_FOLDER}/${OUR_BINARIES[0]}`;

/** The Windows release files of one architecture, as paths relative to the release folder. */
export function windowsFiles(version, arch) {
  const dir = `windows/${arch}`;
  return [
    { kind: "setup", path: `${dir}/OpenMind-Studio_${version}_windows_${arch}_setup.exe` },
    { kind: "msi", path: `${dir}/OpenMind-Studio_${version}_windows_${arch}.msi` },
    { kind: "portable", path: `${dir}/OpenMind-Studio_${version}_windows_${arch}_portable.zip` },
  ];
}

/**
 * Runs the whole procedure. `options` = `{ version, arches, dryRun, signInstallersOuter, skipUpdater }`;
 * `fx` = the effects (see the test's fake for the full list). Returns `{ ok, blockers, steps, changed, backup }`.
 */
export function runAuthenticodeRelease(options, fx) {
  const { version, arches, dryRun = false, signInstallersOuter = false, skipUpdater = false } = options;
  const blockers = [];
  const toolProblem = fx.signtoolProblem();
  if (toolProblem) blockers.push(toolProblem);

  const temps = [];
  const steps = [];
  const portableStages = new Map();
  try {
    return fx.withSigningCertificate((cert) => {
      for (const warning of cert.warnings) fx.log(`warning: ${warning}`);
      blockers.push(...cert.problems);
      for (const arch of arches) {
        for (const file of windowsFiles(version, arch)) {
          const exists = fx.exists(file.path);
          const state = { exists, signature: null, innerSignature: null };
          if (exists && file.kind === "portable") {
            const stage = fx.tempDir(`portable-${arch}`);
            temps.push(stage);
            fx.extract(file.path, stage);
            state.innerSignature = fx.exists(`${stage}/${INNER_EXE}`) ? fx.signature(`${stage}/${INNER_EXE}`) : null;
            if (state.innerSignature === null) blockers.push(`${file.path}: ${INNER_EXE} is not in the archive`);
            portableStages.set(file.path, stage);
          } else if (exists) {
            state.signature = fx.signature(file.path);
          }
          const step = { ...file, ...planArtifact(file.kind, state, { thumbprint: cert.thumbprint, signInstallersOuter }) };
          if (step.action === "refuse") blockers.push(`${file.path}: ${step.reason}`);
          steps.push(step);
        }
      }
      const changing = steps.filter((s) => s.action === "sign" || s.action === "repack");
      if (changing.length > 0 && !skipUpdater) {
        const updater = fx.updaterProblem();
        if (updater) {
          blockers.push(
            `the updater key is not available (${updater}): changed files would keep stale .sig files. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD (or the DPAPI file) first`,
          );
        }
      }
      for (const line of describePlan(steps)) fx.log(line);
      if (blockers.length > 0) {
        for (const b of blockers) fx.log(`BLOCKED: ${b}`);
        fx.log(dryRun ? "Dry run: nothing changed. The real run would stop here." : "Nothing was changed.");
        return { ok: false, blockers, steps, changed: [], backup: null };
      }
      if (dryRun) {
        fx.log(`Dry run: ${changing.length} file(s) would change; nothing was changed.`);
        return { ok: true, blockers, steps, changed: [], backup: null };
      }
      if (changing.length === 0) {
        fx.log("Every Windows file is already signed with this certificate: nothing to do.");
        return { ok: true, blockers, steps, changed: [], backup: null };
      }
      return apply(changing, cert, portableStages, { skipUpdater }, fx, temps);
    });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    fx.log(`BLOCKED: ${message}`);
    return { ok: false, blockers: [...blockers, message], steps, changed: [], backup: null };
  } finally {
    for (const dir of temps) fx.removeTree(dir);
  }
}

function backup(changing, fx) {
  const dir = `validation/pre-authenticode/${fx.stamp()}`;
  const copies = [];
  const keep = (path) => {
    if (!fx.exists(path)) return;
    const target = `${dir}/${path}`;
    fx.copyFile(path, target);
    if (fx.sha256(path) !== fx.sha256(target)) throw new Error(`the backup copy of ${path} doesn't match it`);
    copies.push(path);
  };
  for (const step of changing) {
    keep(step.path);
    keep(`${step.path}.sig`);
  }
  keep("metadata/SHA256SUMS.txt");
  keep("metadata/latest.json");
  return { dir, copies };
}

function restore(saved, fx) {
  for (const path of saved.copies) fx.copyFile(`${saved.dir}/${path}`, path);
  fx.log(`Restored ${saved.copies.length} file(s) from ${saved.dir}.`);
}

function signInstaller(step, cert, fx) {
  const work = `${step.path}.authenticode-tmp`;
  fx.copyFile(step.path, work);
  const problem = fx.sign(work, cert);
  if (problem) {
    fx.remove(work);
    throw new Error(`${step.path}: ${problem}`);
  }
  fx.rename(work, step.path);
}

function repackPortable(step, cert, stage, fx, temps) {
  const before = fx.hashTree(stage);
  const problem = fx.sign(`${stage}/${INNER_EXE}`, cert);
  if (problem) throw new Error(`${step.path} (${INNER_EXE}): ${problem}`);
  const work = `${step.path}.authenticode-tmp.zip`;
  fx.createZip(stage, PACKAGE_FOLDER, work);
  const check = fx.tempDir("repack-check");
  temps.push(check);
  fx.extract(work, check);
  const differences = compareTrees(before, fx.hashTree(check), [INNER_EXE]);
  const signature = fx.signature(`${check}/${INNER_EXE}`);
  if (differences.length > 0 || signature.signerThumbprint !== cert.thumbprint) {
    fx.remove(work);
    const why = differences.length > 0 ? differences.join("; ") : "the program in the rebuilt ZIP isn't signed";
    throw new Error(`${step.path}: the rebuilt ZIP doesn't match the original (${why})`);
  }
  fx.rename(work, step.path);
}

function apply(changing, cert, portableStages, { skipUpdater }, fx, temps) {
  const saved = backup(changing, fx);
  fx.log(`Backed up ${saved.copies.length} file(s) to ${saved.dir}.`);
  const changed = [];
  try {
    for (const step of changing) {
      const before = fx.sha256(step.path);
      if (step.action === "sign") signInstaller(step, cert, fx);
      else repackPortable(step, cert, portableStages.get(step.path), fx, temps);
      changed.push({ path: step.path, before, after: fx.sha256(step.path) });
      fx.log(`signed ${step.path}`);
    }
    if (skipUpdater) {
      // Only for a test run: never leave a .sig that doesn't match its file.
      for (const step of changing) fx.remove(`${step.path}.sig`);
      fx.remove("metadata/latest.json");
      const sums = fx.writeChecksums();
      if (sums) throw new Error(`regenerating SHA256SUMS.txt failed: ${sums}`);
      fx.log("NOT RELEASABLE: updater signatures were removed, not remade (--skip-updater-resign).");
    } else {
      const resign = fx.resignUpdater();
      if (resign) throw new Error(`regenerating the updater signatures failed: ${resign}`);
    }
    const verify = fx.verifyRelease({ skipUpdater });
    if (verify) throw new Error(`the release folder didn't verify afterwards: ${verify}`);
    fx.log(`Done: ${changed.length} file(s) Authenticode-signed; checksums${skipUpdater ? "" : ", updater signatures and the update feed"} regenerated.`);
    return { ok: true, blockers: [], steps: changing, changed, backup: saved.dir };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    fx.log(`FAILED: ${message}`);
    restore(saved, fx);
    return { ok: false, blockers: [message], steps: changing, changed: [], backup: saved.dir };
  }
}
