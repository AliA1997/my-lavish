export const DESIGN_TEXT = [
  "Write one self-contained HTML file the human reviews in the browser.",
  "- Give the page an explicit background color (the page is shown inside a frame).",
  "- Define colors as CSS custom properties on :root and add a dark-mode override with @media (prefers-color-scheme: dark).",
  "- Put sibling assets (images, CSS, JS) next to the HTML file and reference them with relative paths.",
  "- Prefer inline SVG for diagrams so they scale and follow the theme.",
  "- For decision buttons call window.lavish.queuePrompt(text) so the choice reaches the agent.",
  "- data-lavish-action marks custom (non-native) controls: clicking them runs their own handler instead of opening a note card (e.g. decision buttons that call window.lavish.queuePrompt).",
  "- Mark open questions with data-lavish-question; it is only a marker that makes them easy to find and annotate (no special UI).",
].join("\n");

export const PLAYBOOKS = [
  {
    id: "plan",
    use_when: "Presenting a plan, proposal or design for the human to approve or change",
    guidance: [
      "Start with a one-sentence goal.",
      "List the steps in order, each with a short why.",
      "Add a risks section with likelihood and mitigation.",
      "Put every open question in its own block marked data-lavish-question so it is easy to find and annotate.",
      "Keep each section short; the human annotates sections, not paragraphs.",
      "End with the decision you need from the human.",
    ].join("\n"),
  },
  {
    id: "diagram",
    use_when: "Explaining a system, flow or architecture visually",
    guidance: [
      "Draw with inline SVG, not images.",
      "Use CSS custom properties for stroke and fill so dark mode works.",
      "Label every box and arrow with plain words.",
      "Give each diagram node a unique id so notes point at it; never put data-lavish-action on things the human should annotate.",
      "Add a short legend if you use more than two colors.",
      "Keep one idea per diagram; split big systems into several.",
    ].join("\n"),
  },
  {
    id: "table",
    use_when: "Showing structured data, inventories or results in rows and columns",
    guidance: [
      "Use a real table element with a header row.",
      "Keep columns few; put long text in a notes column.",
      "Right-align numbers and keep units in the header.",
      "Make the header sticky if the table is long.",
      "Make the table scroll horizontally on narrow screens.",
      "Highlight the rows that need the human's attention.",
    ].join("\n"),
  },
  {
    id: "comparison",
    use_when: "Comparing options so the human can pick one",
    guidance: [
      "Show options side by side with the same criteria in each.",
      "Lead with your recommendation and say why in one line.",
      "List pros and cons as short bullets.",
      "Put a button under each option calling window.lavish.queuePrompt(\"Choose <option>\").",
      "Call out the trade-off that matters most.",
      "Do not hide a weak option; show it honestly.",
    ].join("\n"),
  },
  {
    id: "input",
    use_when: "Collecting answers or preferences from the human",
    guidance: [
      "Ask each question as a radio or checkbox group with clear labels.",
      "Put a free-text field for answers the options miss.",
      "Group related questions under short headings.",
      "Mark required questions visibly.",
      "End with exactly one Submit button.",
      "Submit calls window.lavish.queuePrompt(JSON.stringify(answers)) with one object of all answers.",
    ].join("\n"),
  },
];

export const HOME_USAGE = [
  "see-plan <file.html|file.md>  open the plan in the browser (--with-claude also starts Claude in PowerShell)",
  "see-plan poll <file>          wait for the human's feedback (--agent-reply, --agent-reply-file, --timeout-ms)",
  "see-plan reply <file>         post a chat reply without polling (--agent-reply)",
  "see-plan end <file>           end the session",
  "see-plan design               page design rules",
  "see-plan playbook [id]        page recipes: plan, diagram, table, comparison, input",
  "see-plan stop                 stop the local server",
  "flags: --json, --no-open, --reopen, --version, --help",
].join("\n");
