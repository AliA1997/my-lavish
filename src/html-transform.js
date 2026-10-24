export function injectSdk(html, key, revision) {
  const tag = `<script src="/sdk.js?key=${encodeURIComponent(key)}&rev=${revision}"></script>`;
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return `${html}\n${tag}`;
  return html.slice(0, idx) + tag + html.slice(idx);
}
