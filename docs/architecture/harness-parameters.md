# Runtime-discovered harness parameters

Every registered harness and custom execution backend uses one parameter
contract. A runtime publishes a complete `parameters` snapshot with bounded
IDs, labels, string choices and, when observed from the provider, a
`currentValue`. Empty snapshots withdraw old choices. These are execution
configuration observations; they grant no registration, model, workspace,
secret, tool or approval authority. Claude account details are discarded during discovery.

## Discovery and native execution

| Adapter family | Discovery | Execution |
| --- | --- | --- |
| Generic ACP, including Grok and all ACP presets | Native `configOptions`, including boolean controls, future select option IDs and grouped choices | `session/set_config_option`; the returned full snapshot must confirm the selected value |
| Codex app-server | Installed native schemas and `model/list` service tiers | Native `thread/settings/update` where advertised, confirmed by `thread/settings/updated`; remaining fields use `turn/start` |
| Claude stream | Native `initialize` models, effort choices, Fast capability and output-style enumeration | `set_model` and session-only `apply_flag_settings`; Fast/output styles require fresh `initialize` confirmation |
| ZCode app-server and custom/PTY | No verified parameter enumeration/control interface in the current adapters | Explicit unsupported result; parameter controls never become prompt text |

Codex schema export is bounded to ten seconds and one MiB per consumed schema, uses a private
temporary directory and removes it afterward. Only local schema references
and finite scalar enums or booleans are recognized; arbitrary strings, objects, executable
metadata and authority controls are excluded. New supported enum fields and
ACP select and boolean IDs flow through the same generic UI and launch grammar without
adding a tag to the parser. Native boolean and numeric choices retain their
JSON types at execution rather than being converted into strings. New service-tier IDs come from the live model
catalog. The Fast alias maps only to an advertised tier identified as Fast;
`off` sends a native null override. Conflicting `fast` and `serviceTier` launch
selections fail rather than choosing an order.

Automatic discovery requires a provider-owned machine-readable interface.
A harness that does not expose one cannot acquire new controls safely by
scraping help text or guessing RPC methods. Extending those adapters requires
a verified native discovery/control source; all consumers of the parameter
contract are already generic.

## Tags and commands

`@auto param.future-speed:turbo` and direct harness summons use the same
grammar. Values containing spaces use the existing doubled-quote convention:
`@kimi param.future-speed:"very fast"`. `fast:on` is shorthand for
`param.fast:on`; `fast:true/false` are boolean aliases for `on/off`. Existing `model:` and `effort:` tags remain their dedicated
launch fields; their generic spellings are rejected at launch.

An attachment-free message addressing one existing Instance can use
`@kimi:1 /config future-speed turbo`. Omitting the value queries its observed
state, choices and any provider notice (such as a disabled reason or cooldown).
`/fast on`, `/fast off` and `/fast status` follow the same parameter contract;
bare `/fast` toggles the observed boolean value. `/fast status`
queries without mutation. Before applying a toggle, the runtime persists its
explicit target by Instance, Channel, message ID and entity version. A retry after
process recovery reuses that target; a completed or superseded replay only queries.
The journal retains 256 decisions per Instance/Channel, bounds its bytes and rejects
retired or unsequenced toggles rather than guessing. Failed persistence prevents
the native side effect.
Completion derives names and values from the runtime snapshot, and removed
choices disappear. Unavailable choices fail explicitly before submitting
task text. Ordinary prose and attachment-bearing messages retain the existing
delivery semantics.

Codex start/resume responses report the thread's `serviceTier`. The installed
`ClientRequest` schema declares whether immediate settings updates exist, and
`ThreadSettingsUpdateParams` declares which fields they accept. The runtime binds
only validated parameter selections to those fields and requires a fresh
same-thread settings notification to confirm changed values. A native `default`
tier confirms a cleared null override. Repeating an already observed selection
does not require a redundant notification. Provider mismatches, missing
confirmation and unrelated-thread notifications cannot produce a confirmed chip;
an uncertain native process closes before further work. Older providers and
turn-only fields retain explicit pending selections, without claiming an observed
value. A successful settings RPC only queues the native operation: when the old
value was unknown and no change notification arrives, keep the selection pending
without inventing current state or closing the process. Known changed values still
require notification. Model switches clear model-dependent selections. Process recovery refreshes
catalogs and revalidates/restores selections before work resumes.

## Type coverage

| Native type | Parameter contract and execution | Presentation |
| --- | --- | --- |
| Boolean (optionally nullable) | Two finite choices; native JSON booleans remain booleans | Boolean chip from the confirmed value |
| String enum | Bounded, unique textual choices; strings remain strings | Enum chip, including a string enum spelled `on`/`off` |
| Integer/number enum | Finite choices, converted back to their exact native numeric values | Enum chip with the confirmed choice |
| Mixed scalar enum | Accepted only when each textual choice identifies one native value unambiguously | Enum chip; no boolean inference from its spelling |
| Nullable enum | Non-null finite choices are selectable; null is not invented as a choice | Confirmed non-null value; clearing requires a verified native binding |
| Unrestricted text or continuous numeric range | Not admitted by the finite-choice contract | No invented choices or parameter chip |
| Arrays, multi-select, objects and null-only values | Not admitted by the scalar-choice contract | No invented flattening or executable metadata |
| Permission, approval, sandbox, credential or execution settings | Excluded independently of their native type | No public parameter chip |

Explicit native type metadata takes precedence over legacy option-based inference.
ACP select directories explicitly declare enum, including `on`/`off` ids; boolean
controls advertise `clientCapabilities.session.configOptions.boolean` and use native
`type: "boolean"` requests with JSON boolean values. Additional value families require a
typed protocol and verified native control, rather than widening strings or
guessing RPC methods. All current adapters share the same type and display contract.

Claude publishes the model observed on native init/assistant frames independently
of slash-command discovery. Its actual effort comes from assistant transcript
records and is read during streaming. If effort is still unknown at the first
assistant frame, the reader retries transcript polling every 20ms for at most
300ms because native writes can lag stdout. It then publishes the observation;
unknown model/effort values remain absent. Late initialize responses retain these
observed values, and goal transcript updates keep their turn-boundary owner.

## Types

The contract carries finite choices only. Each parameter is one of:

| Kind | Native sources | Values |
| --- | --- | --- |
| `boolean` | ACP `type: "boolean"`, Codex schema booleans, Claude `fastMode` | One affirmative and one negative value id. Any on/off/true/false spelling selects the catalog's own spelling. |
| `enum` | ACP `type: "select"` (flat or grouped), Codex schema enums of strings or numbers, live catalogs such as Codex service tiers and Claude output styles | The provider's value ids. A declared `enum` stays one even when its values read on/off. |

Runtimes always declare `kind`; it is inferred only for catalogs from older
runtimes, where exactly one affirmative and one negative value is a switch.
Value ids are compared as text everywhere outside the runtime, and the runtime
binds them back to their native JSON type when it executes them, so a numeric
enum still sends a number. Free text, numeric ranges, multi-select lists and
objects have no finite choice set and are outside the contract; a catalog that
contains them is rejected.

Each parameter may also carry the provider's `description`, a `category` (the
ACP categories mode, model, model_config, thought_level or a `_custom` one; UX
only), `choices` with a display `label` and `description` per value id, a short
`notice` that qualifies the observed value (a Claude Fast cooldown, why a
selection cannot apply now), and `aliasOf` naming the parameter it is another
spelling of (Codex Fast selects a service tier).

## Status tags

Discovery and presentation are separate layers. Runtimes report every native
parameter they find; the status-tag registry
(`packages/protocol/src/status-tag-registry.ts`) is the curated layer above it
and decides which parameters become tags, under which name and icon. A
parameter that is not listed stays readable and settable through `/config` but
never becomes a tag, so a harness adding options does not add tags by itself.
Showing a new parameter is one registry row, not a code change. The registry
also names the icons of the fixed tags (model, effort, owner, machine,
repository, workspace, name); clients map an icon name to a glyph in one place.

The first listed parameter is Fast. Hub derives the tags by kind: a listed
switch reads as its registry name while on and shows nothing while off; a
listed choice reads as its value's display label, its default included; a
notice qualifies either. Parameters without an observed `currentValue` show no
tag, so a pending selection never looks applied. An enabled alias stands in for
the parameter it spells. Model and effort keep their dedicated tags, and a
runtime-declared tag with the same id wins. A presence update without a catalog
keeps the tags from the last one; a model switch withdraws them.

## Routing and compatibility

Hub validates catalogs and explicit authored values. Jev chooses an eligible
registration, model/effort and workspace; it cannot invent parameter values
or replace the author's constraints. Model-dependent parameters constrain the
launch to the model which advertised them, preserving declared model aliases.
The selected daemon must declare `machine_routing_parameters_v1`; older
daemons receive no parameter-bearing launch. Runtimes declare
`harness_parameters_v1` and revalidate launch values against their new native
session before the first task. If no fresh parameter catalog exists (including
first use on a Machine), an explicitly authored parameter request can reach
a capable daemon for native discovery and validation before task submission.
An observed empty catalog remains an explicit withdrawal and cannot take this
path. Missing catalogs do not populate completion or widen model grants. Registration views omit the dedicated model/effort
descriptors and choices bound to a model outside the admitted model set.

Durable Instance presentation retains parameter catalogs and server-stamped
observation times independently of model catalogs. Routing uses observations
no older than 24 hours, including a newer empty snapshot from an Instance
without a model catalog. Heartbeats do not freshen an omitted catalog. Large
catalogs can be omitted from bounded socket hibernation attachments while the
durable routing observation survives. Permission-sensitive settings remain
outside this public parameter contract; normal server authorization is
unchanged.

Claude model switches explicitly clear the previous Fast selection. Claude
restores confirmed session-only selections after process recovery and
revalidates them before another task. An unconfirmed setting closes that
process, so it cannot silently reach subsequent work. Native Fast restrictions
(such as disabled extra usage) fail with the provider's reason rather than
claiming that Fast was enabled. New native output-style and effort choices
are discovered without parser changes.

Claude Fast cooldown retains the enabled preference and reports that native
rate limiting temporarily uses standard speed; it does not restart the process.

Claude tools run concurrently with stream output. The managed wrapper marks
its first native presentation pending in the existing Run status marker before
spawning Claude. Agent CLI sends wait for that gate before the HTTP append.
The reader publishes the observed model and transcript effort, then sends a
correlated ping on the same WebSocket writer. Hub's ordered frame dispatch
answers it after the presentation write and live-session update; a correlated
presence error is not a successful commit. A connection-generation change also
invalidates the confirmation. The wrapper then releases the gate. Unknown
effort stays unknown, and metadata failure or the bounded 30-second wait never
vetoes a message. Older markers and other harnesses require no wait. Message
headers still come exclusively from Hub's accepted Run-bound snapshot; no
model or effort is copied from the marker into an authored message.
