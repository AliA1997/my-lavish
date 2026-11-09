import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_ASSETS, isSea, readAsset, serverSpawnArgs } from "../src/assets.js";
import { openCommand, openUrl } from "../src/open-url.js";
import { VERSION } from "../src/version.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("readAsset reads public files from disk, or from the SEA blob", () => {
  for (const name of PUBLIC_ASSETS) {
    assert.deepEqual(readAsset(name, { sea: { isSea: () => false } }), fs.readFileSync(path.join(ROOT, "public", name)));
  }
  const fake = { isSea: () => true, getAsset: (n) => new TextEncoder().encode(`asset:${n}`).buffer };
  assert.equal(readAsset("sdk.js", { sea: fake }).toString(), "asset:sdk.js");
  assert.throws(() => readAsset("../package.json"), /Not a public asset/);
  assert.throws(() => readAsset("server.log"), /Not a public asset/);
  assert.equal(isSea(), false);
});

test("every public file is a served asset", () => {
  const onDisk = fs.readdirSync(path.join(ROOT, "public"), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(path.join(ROOT, "public"), path.join(d.parentPath, d.name)).split(path.sep).join("/"))
    .sort();
  assert.deepEqual([...PUBLIC_ASSETS].sort(), onDisk);
});

test("serverSpawnArgs has no script path inside a SEA", () => {
  assert.deepEqual(serverSpawnArgs({ sea: true }), ["server"]);
  const [bin, cmd] = serverSpawnArgs({ sea: false });
  assert.equal(cmd, "server");
  assert.equal(path.basename(bin), "see-plan.js");
});

test("openUrl uses one argv item, never a shell, and only local URLs", async () => {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    return { unref() {} };
  };
  await openUrl("http://127.0.0.1:4388/session/abc?x=1&y=2", { platform: "linux", spawnFn });
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:4388/session/abc?x=1&y=2"]);
  assert.equal(calls[0].command, "xdg-open");
  assert.equal(calls[0].opts.shell, false);
  assert.match(openCommand("http://localhost/", "win32")[0], /explorer\.exe$/i);
  assert.equal(openCommand("http://localhost/", "darwin")[0], "/usr/bin/open");
  for (const bad of ["https://evil.example/", "file:///etc/passwd", "http://10.0.0.1/", "javascript:alert(1)", "not a url"]) {
    const r = await openUrl(bad, { platform: "linux", spawnFn });
    assert.equal(r.opened, false, bad);
  }
  assert.equal(calls.length, 1);
  // H4: a spawn failure (xdg-open missing) is a result, never a throw.
  const failing = () => {
    const handlers = {};
    setImmediate(() => handlers.error?.(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
    return { once: (ev, fn) => { handlers[ev] = fn; }, unref() {} };
  };
  assert.deepEqual(await openUrl("http://127.0.0.1:1/", { platform: "linux", spawnFn: failing }), { opened: false, reason: "xdg-open is not installed" });
  const thrower = () => { throw new Error("EACCES"); };
  assert.equal((await openUrl("http://127.0.0.1:1/", { platform: "linux", spawnFn: thrower })).opened, false);
});

test("VERSION matches package.json (run scripts/write-version.js after a bump)", () => {
  assert.equal(VERSION, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
});
