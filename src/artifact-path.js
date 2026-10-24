import fs from "node:fs";
import path from "node:path";

function validationError(message) {
  const err = new Error(message);
  err.code = "VALIDATION_ERROR";
  return err;
}

export async function canonicalFile(file) {
  return fs.promises.realpath(path.resolve(file));
}

export async function assertHtmlFile(file) {
  let real;
  try {
    real = await canonicalFile(file);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      throw validationError(`File not found: ${file}`);
    }
    throw e;
  }
  if (!/\.html?$/i.test(real)) {
    throw validationError(`Not an .html or .htm file: ${file}`);
  }
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) {
    throw validationError(`Not a regular file: ${file}`);
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function resolveArtifactAsset(rootDir, relPath) {
  if (relPath.includes("\0")) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relPath);
  if (!isInside(root, target)) return null;
  try {
    const realRoot = await fs.promises.realpath(root);
    const realTarget = await fs.promises.realpath(target);
    return isInside(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}
