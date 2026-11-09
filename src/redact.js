// Removes secrets from text before it leaves this machine (Pinecone is shared with the whole team).
// Errors are often logged straight from an agent's transcript, which can contain keys and tokens.

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]"],
  [/\bpcsk_[A-Za-z0-9_]{20,}/g, "[REDACTED pinecone key]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED api key]"],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED github token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED aws key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED slack token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/g, "$1 [REDACTED]"],
  // key=value and key: value, for names that usually hold a secret; the name is kept so the error still reads.
  [/\b((?:password|passwd|pwd|secret|client_secret|token|access_token|api[_-]?key)\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi, "$1$2[REDACTED]$2"],
];

/** `text` with known secret shapes replaced by [REDACTED ...]; anything that is not a string comes back unchanged. */
export function redactSecrets(text) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
