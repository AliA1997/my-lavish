export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Safe by construction: the whole input is escaped first, and transforms only
// ever add a fixed set of tags around already-escaped text. Code and link
// pieces are swapped for placeholders so later passes cannot touch them.
export function renderAgentMarkdown(text) {
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);

  let src = escapeHtml(String(text).replace(/\u0000/g, "")).replace(/\r\n?/g, "\n");
  src = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) =>
    `\n\n${hold(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`)}\n\n`);

  const inline = (s, withLinks = true) => {
    s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
    if (withLinks) {
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) =>
        hold(`<a href="${url}" target="_blank" rel="noopener">${restore(inline(label, false))}</a>`));
    }
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return s;
  };

  const out = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    let para = [];
    let list = null; // { tag, items }
    const flush = () => {
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
      para = [];
      list = null;
    };
    for (const line of lines) {
      let m;
      if (/^\u0000\d+\u0000$/.test(line.trim())) {
        flush();
        out.push(line.trim());
      } else if ((m = line.match(/^\s*[-*] +(.*)$/))) {
        if (!list || list.tag !== "ul") { flush(); list = { tag: "ul", items: [] }; }
        list.items.push(inline(m[1]));
      } else if ((m = line.match(/^\s*\d+\. +(.*)$/))) {
        if (!list || list.tag !== "ol") { flush(); list = { tag: "ol", items: [] }; }
        list.items.push(inline(m[1]));
      } else if ((m = line.match(/^#{1,6} +(.*)$/))) {
        flush();
        out.push(`<p><strong>${inline(m[1])}</strong></p>`);
      } else {
        if (list) flush();
        para.push(inline(line));
      }
    }
    flush();
  }
  return restore(out.join(""));
}

export function serializeChat(chat) {
  return chat.map((e) =>
    e.role === "user"
      ? { role: "user", text: e.text, anchor: e.anchor, at: e.at, prompt_id: e.prompt_id }
      : { role: "agent", html: renderAgentMarkdown(e.text), at: e.at });
}
