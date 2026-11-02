#!/usr/bin/env node
// Writes THIRD_PARTY_LICENSES.txt: every production dependency's license text, and (with --node) Node.js's own,
// because a single-executable build embeds the Node runtime. Fails on a license outside the allowlist.
//   node scripts/third-party-licenses.js [--out <file>] [--node]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD"]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = path.resolve(arg("--out") ?? path.join(ROOT, "THIRD_PARTY_LICENSES.txt"));
const withNode = process.argv.includes("--node");

function npmLs() {
  const bundled = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmCli = process.env.npm_execpath ?? (fs.existsSync(bundled) ? bundled : undefined);
  const [cmd, args] = npmCli && npmCli.endsWith(".js")
    ? [process.execPath, [npmCli, "ls", "--omit=dev", "--all", "--json"]]
    : [process.platform === "win32" ? "npm.cmd" : "npm", ["ls", "--omit=dev", "--all", "--json"]];
  return JSON.parse(execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" && cmd.endsWith(".cmd"), maxBuffer: 64 * 1024 * 1024 }));
}

function collect(tree, seen = new Map()) {
  for (const [name, info] of Object.entries(tree.dependencies ?? {})) {
    if (!info.version || info.missing) continue; // an optional peer that is not installed (e.g. ws's bufferutil)
    const id = `${name}@${info.version}`;
    if (!seen.has(id)) {
      seen.set(id, { name, version: info.version });
      collect(info, seen);
    }
  }
  return seen;
}

function findPackageDir(name) {
  const direct = path.join(ROOT, "node_modules", ...name.split("/"));
  return fs.existsSync(direct) ? direct : null;
}

function licenseText(dir) {
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : null;
}

function licenseId(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

function allowed(id) {
  return id.replace(/[()]/g, "").split(/\s+OR\s+/).some((part) => ALLOWED.has(part.trim()));
}

async function nodeLicense() {
  const exeDir = path.dirname(process.execPath);
  for (const p of [path.join(exeDir, "LICENSE"), path.join(exeDir, "..", "LICENSE")]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not get Node.js's license from ${url}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

const packages = [...collect(npmLs()).values()].sort((a, b) => a.name.localeCompare(b.name));
const sections = [];
const problems = [];
const counts = {};
for (const { name, version } of packages) {
  const dir = findPackageDir(name);
  if (!dir) {
    problems.push(`${name}@${version}: not installed`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const id = licenseId(pkg);
  counts[id] = (counts[id] ?? 0) + 1;
  if (!allowed(id)) problems.push(`${name}@${version}: license "${id}" is not in the allowlist`);
  const text = licenseText(dir) ?? `(No license file in the package; package.json declares ${id}.)`;
  sections.push(`${"=".repeat(79)}\n${name}@${version} (${id})\n${"=".repeat(79)}\n\n${text}\n`);
}
if (withNode) {
  sections.push(`${"=".repeat(79)}\nNode.js ${process.version} (embedded runtime)\n${"=".repeat(79)}\n\n${await nodeLicense()}\n`);
}
if (problems.length) {
  console.error(`third-party license check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const header = "Third-party software bundled with see-plan.\n" +
  `Production dependencies: ${packages.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}).\n\n`;
fs.writeFileSync(out, header + sections.join("\n"));
console.log(`wrote ${path.relative(process.cwd(), out)}: ${packages.length} packages${withNode ? " + Node.js" : ""}`);
