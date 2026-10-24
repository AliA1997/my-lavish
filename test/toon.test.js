import { test } from "node:test";
import assert from "node:assert/strict";
import { toToon } from "../src/toon.js";

test("scalars, nesting, and quoting", () => {
  assert.equal(toToon({ a: 1, b: true, c: null, d: "plain" }), "a: 1\nb: true\nc: null\nd: plain");
  assert.equal(toToon({ s: { file: "C:\\x.html", status: "open" } }), 's:\n  file: "C:\\\\x.html"\n  status: open');
  assert.equal(toToon({ e: "", n: "line1\nline2", t: "true" }), 'e: ""\nn: "line1\\nline2"\nt: "true"');
});
test("arrays", () => {
  assert.equal(toToon({ ids: ["plan", "table"] }), "ids[2]: plan,table");
  assert.equal(toToon({ ids: [] }), "ids[0]:");
  assert.equal(
    toToon({ rows: [{ id: "plan", n: 1 }, { id: "a,b", n: 2 }] }),
    'rows[2]{id,n}:\n  plan,1\n  "a,b",2',
  );
  assert.equal(toToon({ mixed: [{ a: 1 }, { b: { c: 2 } }] }), "mixed[2]:\n  - a: 1\n  - b:\n      c: 2");
});
