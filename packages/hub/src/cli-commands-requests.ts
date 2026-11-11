import { HUB_ROUTES } from "@xmatrix/protocol";
import type { CliCommand } from "./cli-commands";

interface OpenRequest { requestRef: string; holder: string; text: string; by: string | null; held: boolean; asked: boolean }

/** One way of ending a request a Norn program gave this Run. The words after the request are taken together. */
function answer(verb: "reply" | "refuse" | "broke", outcome: "answered" | "refused" | "broke", about: string, what: string): CliCommand {
  return {
    path: [verb], about,
    positionals: [{ name: "request", help: "The request, as its message names it" }, { name: verb === "reply" ? "answer" : "why", variadic: true, help: what }],
    async run(call, { positionals, lists }) {
      const result = await call("POST", HUB_ROUTES.norn_request_answer, { requestRef: positionals.request, outcome,
        text: (lists[verb === "reply" ? "answer" : "why"] ?? []).join(" ") }) as { refusal?: string; status: string };
      if (result.refusal) return { stdout: "", stderr: `error: ${result.refusal}\n`, exitCode: 1 };
      return { stdout: `Recorded. The request is closed${result.status === "running" ? "" : ", and its program has ended"}.\n` };
    },
  };
}

/**
 * Requests are how a Norn program asks an Agent for something
 * (docs/architecture/norn-host.md). They are the Hub's, not the language's:
 * a request is answered by what it is, whoever or whatever opened it.
 */
export const NORN_REQUEST_COMMANDS: CliCommand[] = [
  answer("reply", "answered", "Answer a request you hold",
    "The answer, in the form the request's message asks for, e.g. Sound, or Flawed(\"no owner on failure\")"),
  answer("refuse", "refused", "Decline a request you hold", "Why you will not do it"),
  answer("broke", "broke", "Report that a request you hold could not be done", "What went wrong"),
  {
    path: ["requests"], about: "List the open requests you hold and those your programs wait on",
    options: [{ name: "json", kind: "flag", help: "Print the requests as JSON" }],
    async run(call, { options }) {
      const { requests } = await call("GET", HUB_ROUTES.norn_requests) as { requests: OpenRequest[] };
      if (options.json) return { stdout: `${JSON.stringify(requests)}\n` };
      const lines = (title: string, rows: OpenRequest[], who: (row: OpenRequest) => string) => rows.length
        ? [title, ...rows.map(row => `  ${row.requestRef}\t${who(row)}\t${row.by ? `by ${row.by}\t` : ""}${row.text.split("\n")[0]}`)] : [];
      const text = [...lines("You hold:", requests.filter(row => row.held), () => "answer with xmatrix reply"),
        ...lines("Your programs wait on:", requests.filter(row => row.asked), row => row.holder)];
      return { stdout: `${text.length ? text.join("\n") : "No open requests."}\n` };
    },
  },
];
