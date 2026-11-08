// Tests talk to the server the way the CLI does: with its real token (T8: there is no auth bypass).
// createServer here is the real one; it remembers each server's token by port, and the global fetch
// sends `Authorization: Bearer <token>` to that port unless the request already carries credentials.
// `rawFetch` sends nothing extra, for tests of what an unauthenticated caller gets.
import { createServer as realCreateServer } from "../../src/server.js";

export const rawFetch = globalThis.fetch;
const tokens = new Map(); // port -> token

function portOf(url) {
  try {
    const u = new URL(typeof url === "string" ? url : url.url ?? String(url));
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" ? Number(u.port) : null;
  } catch {
    return null;
  }
}

function hasCredentials(headers) {
  if (!headers) return false;
  const h = headers instanceof Headers ? headers : new Headers(headers);
  return h.has("authorization") || h.has("cookie");
}

globalThis.fetch = (url, init = {}) => {
  const token = tokens.get(portOf(url));
  if (!token || hasCredentials(init.headers)) return rawFetch(url, init);
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${token}`);
  return rawFetch(url, { ...init, headers });
};

/** The headers a raw http.request or a WebSocket needs for `port`. */
export function authHeaders(port) {
  const token = tokens.get(Number(port));
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function tokenFor(port) {
  return tokens.get(Number(port));
}

export function createServer(opts) {
  const srv = realCreateServer(opts);
  const listen = srv.listen;
  srv.listen = async (...args) => {
    const r = await listen(...args);
    tokens.set(r.port, srv.token);
    return r;
  };
  return srv;
}
