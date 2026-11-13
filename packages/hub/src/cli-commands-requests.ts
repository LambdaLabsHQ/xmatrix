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
 * One way of asking. The question becomes a Norn program in the Run's
 * conversation; a person answers on a card, an Agent with `xmatrix reply`,
 * and the answer comes back to the asking Run as the program's result.
 */
function question(verb: "ask" | "confirm" | "choose", about: string): CliCommand {
  const choose = verb === "choose";
  return {
    path: [verb], about,
    positionals: [{ name: "who", help: "Whom to ask: a person or an Agent, as in @Daniel or @codex" },
      { name: "question", ...(choose ? {} : { variadic: true }), help: choose ? "What to decide, as one quoted argument" : "What to ask" },
      ...(choose ? [{ name: "options", variadic: true, help: "What may be chosen: capitalised words, as in Approve Reject Later" }] : [])],
    options: [{ name: "by", kind: "string", help: "When it closes without an answer: 4h, 2d, or a UTC time such as 2026-11-20T09:00Z" },
      ...(verb === "ask" ? [] : [{ name: "otherwise", kind: "string" as const,
        help: `The answer taken when --by passes with none: ${choose ? "one of the options" : "Yes or No"}. Without it, silence comes back as NoReply` }])],
    async run(call, { positionals, options, lists }) {
      const result = await call("POST", HUB_ROUTES.norn_request_ask, { verb, who: positionals.who,
        question: choose ? positionals.question : (lists.question ?? []).join(" "), ...(choose ? { options: lists.options ?? [] } : {}),
        ...(typeof options.by === "string" ? { by: options.by } : {}),
        ...(typeof options.otherwise === "string" ? { otherwise: options.otherwise } : {}) }) as { refusal?: string };
      if (result.refusal) return { stdout: "", stderr: `error: ${result.refusal}\n`, exitCode: 1 };
      return { stdout: "Asked. The answer comes back to you in this conversation as the program's result; end your turn if nothing else is left to do.\n" };
    },
  };
}

/**
 * Requests are how a Norn program asks an Agent for something
 * (docs/architecture/norn-host.md). They are the Hub's, not the language's:
 * a request is answered by what it is, whoever or whatever opened it.
 */
export const NORN_REQUEST_COMMANDS: CliCommand[] = [
  question("confirm", "Ask someone a yes-or-no question and get the answer back"),
  question("choose", "Ask someone to choose among options and get the choice back"),
  question("ask", "Ask someone a question and get their words back"),
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
