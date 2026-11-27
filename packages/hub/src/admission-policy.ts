/**
 * A Space's admission policy (docs/design/admission-policy.md, Norn spec
 * §10.1): a Space library whose `admit` answers what the Hub is about to
 * admit with `Allow`, `Deny(why)` or `AlsoAsk(participant)`.
 *
 * The policy is a pure function. It is checked here before a Space admin
 * adopts it, and evaluated here on the text that admin adopted, never on the
 * Page's. What it is asked about reaches it as a value: nothing of a request
 * is written into Norn source.
 */
import { builtinInterface, checkSource, elaborate, hostSources, readLibrary, type Library } from "./vendor/norn/frontend/check/index";
import { compile } from "./vendor/norn/runtime/code";
import { evaluateAdmissionPolicy } from "./vendor/norn/runtime/ledger";
import { text, variant, type Value } from "./vendor/norn/runtime/value";

/** What the Hub is about to admit, as `Admission.request` carries it. */
export interface AdmissionRequest {
  /** The kind of thing, as in `secret.use`. */
  what: string;
  /** What it is done to: a secret's alias. */
  target: string;
  /** The Channel it is asked from. */
  place: string;
  /** The user whose authority the asker runs under. */
  owner: string;
  /** The Page program whose open request the asker is working on now. */
  work?: { program: string; digest: string };
}

/** Why a library's text cannot be adopted as a policy, where the text says it. */
export interface AdmissionPolicyProblem { message: string; line: number; column: number }

/** What an adopted policy answers. `card` is everything the Hub does not carry out by itself: the request gets its card. */
export type AdmissionAnswer = { answer: "allow" } | { answer: "deny"; reason: string } | { answer: "card"; why: string };

/** A policy reads the language's own modules and `Admission`; it names no host stream and no other library. */
const HOST = builtinInterface();
const SOURCES = hostSources(HOST);
/** The name the policy's library is checked and evaluated under; its own name on the Page does not matter to the text. */
const POLICY = "Policy";

/** The program whose value is the policy's function, handed the request as a value. */
const ENTRY = `(asked: Admission.request) => ${POLICY}.admit(asked)`;
/** A call that holds only if `admit` takes an `Admission.request` and answers an `admission`. Its effects are the policy's. */
const SHAPE = `switch ${POLICY}.admit({what: "", target: "", place: "", owner: "", work: None}) {
| Allow => ()
| Deny(_) => ()
| AlsoAsk(_) => ()
}`;

const at = (diagnostic: { message: string; span: { start: { line: number; column: number } } }): AdmissionPolicyProblem =>
  ({ message: diagnostic.message, line: diagnostic.span.start.line, column: diagnostic.span.start.column });
const whole = (message: string): AdmissionPolicyProblem => ({ message, line: 1, column: 1 });

function read(source: string): { library: Library; problems: AdmissionPolicyProblem[] } {
  const library = readLibrary(source, `${POLICY}.norn`, HOST, { name: POLICY });
  return { library, problems: library.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map(at) };
}

/**
 * What keeps a library's text from being adopted; empty when it can be. The
 * text must check by itself, export `admit` from an `Admission.request` to an
 * `admission`, and have no effect: a policy asks nobody and waits for nothing.
 * A text that names another library does not check here, so what is adopted
 * is everything that was read.
 */
export function admissionPolicyProblems(source: string): AdmissionPolicyProblem[] {
  return checked(source).problems;
}

/** The library as read once, with what keeps it from being a policy. */
function checked(source: string): { library: Library; problems: AdmissionPolicyProblem[] } {
  const { library, problems } = read(source);
  if (problems.length) return { library, problems };
  return { library, problems: shapeProblems(library) };
}

function shapeProblems(library: Library): AdmissionPolicyProblem[] {
  const shape = checkSource(SHAPE, { host: HOST, std: null, libraries: { [POLICY]: library } });
  const errors = shape.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length) {
    return [whole(`The library must export \`admit\`, a function from an Admission.request to Allow, Deny(why) or AlsoAsk(participant): ${errors[0]!.message}`)];
  }
  const effects = [...new Set((shape.effects ?? []).map((effect) => effect.family))];
  return effects.length ? [whole(`A policy has no effect, and \`admit\` may ${effects.join(", ")}. It answers AlsoAsk(participant) where someone must be asked.`)] : [];
}

/**
 * What an adopted policy answers about one request. A text that no longer
 * checks (the language moved on under it), that fails, does not stop, or
 * answers something else decides nothing, and the request gets its card.
 * `AlsoAsk` gets the card too: this host asks on the card, whoever is named.
 */
export function admit(source: string, request: AdmissionRequest): AdmissionAnswer {
  try {
    const { library, problems } = checked(source);
    if (problems.length) return { answer: "card", why: "the adopted policy no longer checks" };
    const entry = checkSource(ENTRY, { host: HOST, std: null, libraries: { [POLICY]: library } });
    if (!entry.ok || !entry.program) return { answer: "card", why: "the adopted policy no longer checks" };
    const code = compile(elaborate(entry.program, entry.reports), { sources: SOURCES, libraries: { [POLICY]: library.program } });
    const asked: Value = { type: "record", fields: {
      what: text(request.what), target: text(request.target), place: text(request.place), owner: text(request.owner),
      work: request.work ? variant("Some", { type: "record", fields: { program: text(request.work.program), digest: text(request.work.digest) } })
        : variant("None"),
    } };
    const decided = evaluateAdmissionPolicy(code, asked, Date.now());
    if (decided.decision === "Allow") return { answer: "allow" };
    if (decided.decision === "Deny") return { answer: "deny", reason: decided.reason };
    return { answer: "card", why: `the policy answers AlsoAsk(${decided.participant})` };
  } catch (error) {
    return { answer: "card", why: error instanceof Error ? error.message : String(error) };
  }
}
