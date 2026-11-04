import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "see-plan.js");
const EXAMPLE = path.join(ROOT, "examples", "plan.html");
// --bin <path>: drive a built single executable instead of `node bin/see-plan.js`.
const binIndex = process.argv.indexOf("--bin");
let EXE = binIndex >= 0 ? path.resolve(process.argv[binIndex + 1]) : null;
if (EXE && process.platform === "win32" && !EXE.endsWith(".exe") && fs.existsSync(`${EXE}.exe`)) EXE += ".exe";
const ASSETS = ["sdk.js", "chrome-client.js", "chrome.css", "logs-client.js", "logs.css", "home-client.js", "home.css"];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function cli(args, env) {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = EXE ? [EXE, args] : [process.execPath, [BIN, ...args]];
    execFile(cmd, argv, { env, timeout: 25000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${args.join(" ")} failed: ${err.message}\n${stdout}\n${stderr}`));
      resolve(stdout);
    });
  });
}

function postPrompts(baseUrl, key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/api/${key}/prompts`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), origin: baseUrl },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main(env, workDir) {
  const file = path.join(workDir, "plan.html");
  fs.copyFileSync(EXAMPLE, file);

  const opened = JSON.parse(await cli(["open", file, "--no-open", "--json"], env));
  const url = new URL(opened.session.url);
  const key = url.pathname.split("/").filter(Boolean).pop();
  const baseUrl = url.origin;

  // The page, the dashboard, and every browser file load from this build's server.
  for (const p of [url.pathname, "/", "/claude", ...ASSETS.map((a) => `/${a}`)]) {
    const res = await fetch(baseUrl + p);
    assert(res.status === 200, `GET ${p} answered ${res.status}`);
    assert((await res.text()).length > 0, `GET ${p} is empty`);
  }
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert(health.app === "my-lavish-axi", "health names the app");

  const pollPromise = cli(["poll", file, "--json"], env);
  await new Promise((r) => setTimeout(r, 500));
  const posted = await postPrompts(baseUrl, key, {
    prompts: [{ prompt_id: "smoke-1", prompt: "Make the title bigger", tag: "h1", selector: "h1", text: "Plan" }],
  });
  assert(posted.status === 200, `POST prompts answered ${posted.status}: ${posted.text}`);

  const polled = JSON.parse(await pollPromise);
  assert(polled.prompts?.[0]?.prompt === "Make the title bigger", "poll returned the posted prompt");

  await cli(["reply", file, "--agent-reply", "Done", "--json"], env);
  await cli(["end", file, "--json"], env);
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-lavish-smoke-state-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-lavish-smoke-work-"));
const port = await freePort();
const env = {
  ...process.env,
  MY_LAVISH_STATE_DIR: stateDir,
  MY_LAVISH_PORT: String(port),
  MY_LAVISH_NO_OPEN: "1",
};

let failure = null;
const timer = setTimeout(() => {
  console.error("smoke timed out after 30s");
  cli(["stop"], env).catch(() => {}).finally(() => process.exit(1));
}, 30000);

try {
  await main(env, workDir);
} catch (e) {
  failure = e;
} finally {
  try {
    await cli(["stop", "--json"], env);
  } catch (e) {
    failure ??= e;
  }
  clearTimeout(timer);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.stack ?? String(failure));
  process.exit(1);
}
console.log(EXE ? `SMOKE OK (${path.basename(EXE)})` : "SMOKE OK");
