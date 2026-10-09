// Markdown guides for AI agents, served from public/ and listed in the site
// footer. public/llms-full.txt joins them; agent-docs.test.cjs keeps it current.
export const agentDocFiles = [
  "llms.txt",
  "llms-full.txt",
  "index.md",
  "setup.md",
  "connectors.md",
  "pricing.md",
  "download.md",
  "about.md",
];

export const agentGuideFiles = agentDocFiles.filter((file) => file.endsWith(".md"));

export function joinAgentGuides(guides: { file: string; body: string }[]): string {
  return guides
    .map(({ file, body }) => `<!-- https://xmatrix.sh/${file} -->\n${body.trim()}\n`)
    .join("\n---\n\n");
}

const askPrompt =
  "What is xMatrix (https://xmatrix.sh) and is it a good fit for coordinating AI coding agents such as Claude Code and Codex with my team? " +
  "Explain how it works, how to set it up, which services it connects to and what it costs. " +
  "Use https://xmatrix.sh/llms.txt and https://xmatrix.sh/llms-full.txt as starting sources, cite relevant xMatrix pages, " +
  "and clearly distinguish verified facts from unknowns.";

const askBases = [
  { label: "ChatGPT", base: "https://chatgpt.com/?q=" },
  { label: "Claude", base: "https://claude.ai/new?q=" },
  { label: "Perplexity", base: "https://www.perplexity.ai/search?q=" },
  { label: "Gemini", base: "https://www.google.com/search?udm=50&q=" },
  { label: "Grok", base: "https://grok.com/?q=" },
];

export const aiAskLinks = askBases.map(({ label, base }) => ({
  label,
  href: base + encodeURIComponent(askPrompt),
}));
