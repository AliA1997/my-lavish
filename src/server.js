import { EventEmitter } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { assertHtmlFile, canonicalFile, resolveArtifactAsset } from "./artifact-path.js";
import { injectSdk } from "./html-transform.js";
import { createChromeHtml } from "./chrome-page.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase();
  return hostHeader.split(":")[0].toLowerCase();
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True only when an Origin header is present and equals http://<Host>. */
export function requireSameOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin === `http://${req.headers.host}`;
}

function errorBody(code, message) {
  return { error: { code, ...(message ? { message } : {}) } };
}

export function createServer({
  store,
  stateDir,
  port = 4388,
  host = "127.0.0.1",
  idleTimeoutMs = 1800000, // eslint-disable-line no-unused-vars -- used by idle exit (Task 6)
  version,
  log = () => {},
}) {
  const app = express();
  const events = new EventEmitter();
  let httpServer = null;
  let baseUrl = null;
  let closing = null;

  // Task 6 fills this with a chokidar watcher that bumps the revision.
  function watchSession(session) { // eslint-disable-line no-unused-vars
  }

  app.disable("x-powered-by");

  // Host allowlist: blocks DNS rebinding.
  app.use((req, res, next) => {
    if (!ALLOWED_HOSTNAMES.has(hostnameOf(req.headers.host))) {
      return res.status(403).json(errorBody("FORBIDDEN_HOST", "Host not allowed"));
    }
    next();
  });

  // Origin guard: blocks cross-site writes. Header-less (CLI) requests pass.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const source = req.headers.origin ?? req.headers.referer;
    if (source !== undefined && originOf(source) !== `http://${req.headers.host}`) {
      return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
    }
    next();
  });

  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "my-lavish-axi", version, state_dir: stateDir });
  });

  app.post("/shutdown", (req, res) => {
    res.json({ ok: true });
    res.on("finish", () => setImmediate(() => close().catch(() => {})));
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const { file, reopen } = req.body ?? {};
      if (typeof file !== "string" || !file) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "file is required"));
      }
      let real;
      try {
        await assertHtmlFile(file);
        real = await canonicalFile(file);
      } catch (e) {
        if (e.code === "VALIDATION_ERROR") {
          return res.status(400).json(errorBody("VALIDATION_ERROR", e.message));
        }
        throw e;
      }
      const { status, session } = await store.upsertSession(real, baseUrl, { reopen: Boolean(reopen) });
      watchSession(session);
      res.json({ status, key: session.key, url: session.url });
    } catch (e) {
      next(e);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.key);
      if (!session) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
      res.set("X-Frame-Options", "DENY");
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      res.type("html").send(createChromeHtml(session, { baseUrl }));
    } catch (e) {
      next(e);
    }
  });

  app.get("/artifact/:key/index.html", async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.key);
      if (!session) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
      let html;
      try {
        html = await fs.promises.readFile(session.file, "utf8");
      } catch {
        return res.status(404).json(errorBody("NOT_FOUND", "Artifact file missing"));
      }
      res.set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups");
      res.set("Cache-Control", "no-cache");
      res.type("html").send(injectSdk(html, session.key, session.revision));
    } catch (e) {
      next(e);
    }
  });

  app.get("/artifact/:key/*splat", async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.key);
      if (!session) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
      const rel = [].concat(req.params.splat).join("/");
      const real = await resolveArtifactAsset(session.dir, rel);
      const stat = real && (await fs.promises.stat(real).catch(() => null));
      if (!stat || !stat.isFile()) return res.status(404).json(errorBody("NOT_FOUND", "No such asset"));
      res.set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups");
      res.sendFile(real, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (e) {
      next(e);
    }
  });

  for (const name of ["sdk.js", "chrome-client.js", "chrome.css"]) {
    app.get(`/${name}`, (req, res, next) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(name, { root: PUBLIC_DIR }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    });
  }

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    log(`error: ${err?.stack ?? err}`);
    if (res.headersSent) return;
    const status = err?.status === 400 || err?.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json(errorBody(status === 400 ? "BAD_REQUEST" : "INTERNAL", err?.message));
  });

  function listen() {
    return new Promise((resolve, reject) => {
      httpServer = app.listen(port, host);
      httpServer.requestTimeout = 0;
      httpServer.timeout = 0;
      httpServer.once("error", reject);
      httpServer.once("listening", () => {
        const actual = httpServer.address().port;
        baseUrl = `http://127.0.0.1:${actual}`;
        resolve({ port: actual, baseUrl });
      });
    });
  }

  function close() {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      if (!httpServer) return resolve();
      httpServer.close(() => resolve());
      httpServer.closeAllConnections?.();
    }).then(() => events.emit("closed"));
    return closing;
  }

  return { app, events, listen, close };
}
