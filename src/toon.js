// Compact TOON-style encoder for agent-facing CLI output.
const IND = "  ";

function str(s) {
  const bare = s !== "" && !/^(true|false|null|-?\d)/.test(s) && s === s.trim() && !/[:,"\n\r\t[\]{}#\\]/.test(s);
  return bare ? s : JSON.stringify(s);
}

function prim(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return str(v);
  return String(v);
}

const isPrim = (v) => v === null || typeof v !== "object";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function entry(key, v) {
  if (Array.isArray(v)) return arrayLines(key, v);
  if (isObj(v)) {
    const inner = objectLines(v);
    return [`${key}:`, ...inner.map((l) => IND + l)];
  }
  return [`${key}: ${prim(v)}`];
}

function objectLines(o) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => entry(k, v));
}

function arrayLines(key, arr) {
  const head = `${key}[${arr.length}]`;
  if (arr.length === 0) return [`${head}:`];
  if (arr.every(isPrim)) return [`${head}: ${arr.map(prim).join(",")}`];
  if (arr.every(isObj)) {
    const keys = Object.keys(arr[0]);
    const tabular =
      keys.length > 0 &&
      arr.every((o) => {
        const ks = Object.keys(o);
        return ks.length === keys.length && keys.every((k, i) => ks[i] === k && isPrim(o[k]));
      });
    if (tabular) {
      return [`${head}{${keys.join(",")}}:`, ...arr.map((o) => IND + keys.map((k) => prim(o[k])).join(","))];
    }
  }
  const lines = [`${head}:`];
  for (const item of arr) {
    const sub = isObj(item) ? objectLines(item) : Array.isArray(item) ? arrayLines("", item) : [prim(item)];
    sub.forEach((l, i) => lines.push(IND + (i === 0 ? "- " : IND) + l));
  }
  return lines;
}

export function toToon(value) {
  return objectLines(value).join("\n");
}
