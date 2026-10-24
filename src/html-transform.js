export function injectSdk(html, key, revision) {
  const tag = `<script src="/sdk.js?key=${encodeURIComponent(key)}&rev=${revision}"></script>`;
  // Match on the original string: toLowerCase() can change string length
  // (e.g. "İ" -> 2 code units), which would shift indexes.
  let idx = -1;
  for (const m of html.matchAll(/<\/body>/gi)) idx = m.index;
  if (idx === -1) return `${html}\n${tag}`;
  return html.slice(0, idx) + tag + html.slice(idx);
}
