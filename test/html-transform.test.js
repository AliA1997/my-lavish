import { test } from "node:test";
import assert from "node:assert/strict";
import { injectSdk } from "../src/html-transform.js";

test("injects before </body>", () => {
  assert.equal(
    injectSdk("<html><body><p>x</p></body></html>", "abc", 3),
    '<html><body><p>x</p><script src="/sdk.js?key=abc&rev=3"></script></body></html>',
  );
});

test("appends after newline when no </body>", () => {
  const out = injectSdk("<p>x</p>", "abc", 0);
  assert.ok(out.startsWith("<p>x</p>"));
  assert.ok(out.endsWith('\n<script src="/sdk.js?key=abc&rev=0"></script>'));
});

test("uses last </body>, case-insensitive", () => {
  const out = injectSdk("<BODY>a</BODY><!-- </body> --></BoDy>", "k", 1);
  assert.ok(out.endsWith('<script src="/sdk.js?key=k&rev=1"></script></BoDy>'));
  assert.ok(out.startsWith("<BODY>a</BODY><!-- </body> -->"));
});

test("locates </body> on original string when lowercasing changes length", () => {
  const html = "<p>İ İİ</p><body>İ</body><!-- İ --></BODY>";
  const out = injectSdk(html, "k", 1);
  const tag = '<script src="/sdk.js?key=k&rev=1"></script>';
  const idx = html.lastIndexOf("</BODY>");
  assert.equal(out, html.slice(0, idx) + tag + html.slice(idx));
});

test("encodes key", () => {
  assert.ok(injectSdk("x", "a b&c", 1).includes("key=a%20b%26c&rev=1"));
});
