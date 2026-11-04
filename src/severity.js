/** Error severities, mildest first. Plain data so the browser scripts can carry a copy. */
export const SEVERITIES = ["low", "medium", "high", "send_to_it"];

export const SEVERITY_TITLES = {
  low: "Low",
  medium: "Medium",
  high: "High",
  send_to_it: "Send to IT",
};

export const SEVERITY_HINTS = {
  low: "Minor miscommunication between the human and the AI.",
  medium: "Wrote buggy code, or a plan that was slightly off course.",
  high: "A plan that went badly off course; a sign of lost context (\"lost in the middle\").",
  send_to_it: "Malicious code, or work that ran without supervision.",
};

/** These severities need a reason, in the dialog, the popover and a later rating. */
export const REASON_REQUIRED = ["high", "send_to_it"];

/** `includes`, never an object lookup: "__proto__" and "constructor" are not severities. */
export const isSeverity = (v) => typeof v === "string" && SEVERITIES.includes(v);

export const needsReason = (v) => typeof v === "string" && REASON_REQUIRED.includes(v);

/** The worse of two severities (null = unrated, the mildest). */
export function worseSeverity(a, b) {
  return SEVERITIES.indexOf(b) > SEVERITIES.indexOf(a) ? b : a;
}
