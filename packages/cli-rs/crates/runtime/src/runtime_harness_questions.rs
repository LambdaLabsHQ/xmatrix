// Questions a harness asks its person through its own protocol (Claude's
// AskUserQuestion, Codex's request_user_input, ACP's elicitation/create).
// xMatrix invents no question tool of its own: each runtime parks the
// harness's native request, posts it as a questionnaire card, and answers the
// request with what the person picked, so the harness continues the same turn.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::{agent_instance_connection, protocol};

/// The card a questionnaire message carries.
pub(crate) const QUESTIONNAIRE_KIND: &str = "xmatrix.questionnaire.v1";
/// The reply a person sends from that card.
pub(crate) const QUESTIONNAIRE_ANSWER_KIND: &str = "xmatrix.questionnaire_answer.v1";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HarnessQuestion {
    pub(crate) id: String,
    pub(crate) header: Option<String>,
    pub(crate) prompt: String,
    pub(crate) multiple: bool,
    pub(crate) options: Vec<HarnessQuestionOption>,
    /// Whether the person may type an answer instead of picking an option.
    pub(crate) allow_other: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HarnessQuestionOption {
    pub(crate) label: String,
    pub(crate) description: Option<String>,
}

/// What the person answered: the option labels they picked, or their own
/// text, per question id.
pub(crate) type HarnessAnswers = BTreeMap<String, Vec<String>>;

/// The channel message that shows `questions` as a card.
pub(crate) fn questionnaire_message(
    source: &str,
    harness: &str,
    request_key: &str,
    questions: &[HarnessQuestion],
) -> (String, Value) {
    let mut lines = Vec::new();
    for question in questions {
        lines.push(format!("{harness} asks: {}", question.prompt));
        for (index, option) in question.options.iter().enumerate() {
            lines.push(format!("{}. {}", index + 1, option.label));
        }
    }
    let multiple = questions.iter().any(|question| question.multiple);
    let metadata = serde_json::json!({
        "kind": QUESTIONNAIRE_KIND,
        "source": source,
        "harness": harness,
        "requestKey": request_key,
        "selectionMode": if multiple { "multiple" } else { "single" },
        "questions": questions.iter().map(|question| serde_json::json!({
            "id": question.id,
            "label": question.prompt,
            "header": question.header,
            "selectionMode": if question.multiple { "multiple" } else { "single" },
            "allowOther": question.allow_other,
            "options": question.options.iter().enumerate().map(|(index, option)| serde_json::json!({
                "id": format!("o{}", index + 1),
                "label": option.label,
                "description": option.description,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    (lines.join("\n"), metadata)
}

/// Post a questionnaire card to `channel_id`.
pub(crate) fn publish_questionnaire(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: &str,
    (body, metadata): (String, Value),
) {
    if let Err(err) = relay.send_message(protocol::AgentInstanceClientMessage::ChannelMessage {
        request_id: None,
        channel_id: channel_id.to_string(),
        body,
        reply_to_message_id: None,
        app_mentions: None,
        metadata: Some(metadata),
    }) {
        eprintln!("xmatrix failed to publish a harness question: {err}");
    }
}

/// A person's answer from a questionnaire card, as it arrives in the channel.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct QuestionnaireReply {
    pub(crate) request_key: String,
    pub(crate) answers: HarnessAnswers,
    pub(crate) message_id: String,
    pub(crate) channel_id: String,
    pub(crate) sequence: Option<u64>,
}

/// The questionnaire answer `event` delivers, if it is one.
pub(crate) fn questionnaire_reply(
    event: &agent_instance_connection::AgentInstanceConnectionEvent,
) -> Option<QuestionnaireReply> {
    let agent_instance_connection::AgentInstanceConnectionEvent::Server(
        protocol::AgentInstanceServerMessage::ChannelMessageReceived { message, .. },
    ) = event
    else {
        return None;
    };
    let metadata = message.metadata.as_ref()?;
    if metadata.get("kind").and_then(Value::as_str) != Some(QUESTIONNAIRE_ANSWER_KIND) {
        return None;
    }
    let request_key = metadata
        .get("requestKey")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())?;
    let answers = metadata
        .get("answers")
        .and_then(Value::as_object)?
        .iter()
        .map(|(id, values)| {
            let values = values
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default();
            (id.clone(), values)
        })
        .collect();
    Some(QuestionnaireReply {
        request_key: request_key.to_string(),
        answers,
        message_id: message.message_id.clone(),
        channel_id: message.channel_id.clone(),
        sequence: message.sequence,
    })
}

/// The harness requests a runtime has parked until their person answers, by
/// request key. Shared between the reader that receives them and the turn
/// loop that receives the answers.
pub(crate) struct PendingQuestions<T>(Arc<Mutex<HashMap<String, T>>>);

impl<T> Clone for PendingQuestions<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> Default for PendingQuestions<T> {
    fn default() -> Self {
        Self(Arc::default())
    }
}

impl<T> PendingQuestions<T> {
    pub(crate) fn park(&self, key: String, native: T) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key, native);
    }

    pub(crate) fn take(&self, key: &str) -> Option<T> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(key)
    }

    pub(crate) fn any(&self) -> bool {
        !self.0.lock().unwrap_or_else(|p| p.into_inner()).is_empty()
    }

    /// Every parked request, for cancelling them all.
    pub(crate) fn drain(&self) -> Vec<T> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain()
            .map(|(_, native)| native)
            .collect()
    }

    /// Remove the parked requests whose native data `matches`.
    pub(crate) fn forget(&self, matches: impl Fn(&T) -> bool) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, native| !matches(native));
    }
}

/// Acknowledge the answer message: the harness consumed it, so it is no turn.
pub(crate) fn ack_questionnaire_reply(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    reply: &QuestionnaireReply,
) {
    let _ = relay.ack_channel_message(
        reply.message_id.clone(),
        reply.channel_id.clone(),
        reply.sequence,
    );
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn options_from(value: Option<&Value>) -> Vec<HarnessQuestionOption> {
    value
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(HarnessQuestionOption {
                        label: non_empty(option.get("label"))?,
                        description: non_empty(option.get("description")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- Claude Code: `can_use_tool` for AskUserQuestion ----

/// The questions of an AskUserQuestion input. Claude identifies a question by
/// its text, so that text is the id too.
pub(crate) fn claude_questions(input: &Value) -> Vec<HarnessQuestion> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .filter_map(|question| {
                    let prompt = non_empty(question.get("question"))?;
                    Some(HarnessQuestion {
                        id: prompt.clone(),
                        header: non_empty(question.get("header")),
                        prompt,
                        multiple: question.get("multiSelect").and_then(Value::as_bool)
                            == Some(true),
                        options: options_from(question.get("options")),
                        // Claude Code always offers "Other".
                        allow_other: true,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The AskUserQuestion input Claude runs with the person's answers.
pub(crate) fn claude_answered_input(input: &Value, answers: &HarnessAnswers) -> Value {
    let mut input = input.clone();
    let answers: serde_json::Map<String, Value> = answers
        .iter()
        .filter(|(_, values)| !values.is_empty())
        .map(|(question, values)| (question.clone(), Value::String(values.join(", "))))
        .collect();
    if let Some(object) = input.as_object_mut() {
        object.insert("answers".to_string(), Value::Object(answers));
    }
    input
}

// ---- Codex: `item/tool/requestUserInput` ----

/// The questions of a requestUserInput request. A secret is never relayed:
/// the channel is no place for one, so it gets an empty answer.
pub(crate) fn codex_questions(params: &Value) -> Vec<HarnessQuestion> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .filter(|question| question.get("isSecret").and_then(Value::as_bool) != Some(true))
                .filter_map(|question| {
                    let options = options_from(question.get("options"));
                    Some(HarnessQuestion {
                        id: non_empty(question.get("id"))?,
                        header: non_empty(question.get("header")),
                        prompt: non_empty(question.get("question"))?,
                        multiple: false,
                        allow_other: options.is_empty()
                            || question.get("isOther").and_then(Value::as_bool) == Some(true),
                        options,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The requestUserInput response for `answers`.
pub(crate) fn codex_answer_result(answers: &HarnessAnswers) -> Value {
    let answers: serde_json::Map<String, Value> = answers
        .iter()
        .map(|(id, values)| (id.clone(), serde_json::json!({ "answers": values })))
        .collect();
    serde_json::json!({ "answers": answers })
}

// ---- ACP: `elicitation/create` in form mode ----

/// The questions of a form elicitation: one per schema property. The message
/// heads the first question when a property has no title of its own.
pub(crate) fn acp_questions(params: &Value) -> Vec<HarnessQuestion> {
    if params.get("mode").and_then(Value::as_str).unwrap_or("form") != "form" {
        return Vec::new();
    }
    let message = non_empty(params.get("message"));
    let Some(properties) = params
        .pointer("/requestedSchema/properties")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let single = properties.len() == 1;
    properties
        .iter()
        .map(|(id, schema)| {
            let title = non_empty(schema.get("title"));
            let description = non_empty(schema.get("description"));
            let prompt = match (single, &message, title.clone().or(description.clone())) {
                (true, Some(message), _) => message.clone(),
                (_, _, Some(own)) => own,
                (_, Some(message), None) => format!("{message} ({id})"),
                (_, None, None) => id.clone(),
            };
            let multiple = schema.get("type").and_then(Value::as_str) == Some("array");
            let choices = if multiple {
                schema.get("items").unwrap_or(&Value::Null)
            } else {
                schema
            };
            let mut options = acp_schema_options(choices);
            if options.is_empty() && schema.get("type").and_then(Value::as_str) == Some("boolean") {
                options = ["true", "false"]
                    .into_iter()
                    .map(|label| HarnessQuestionOption {
                        label: label.to_string(),
                        description: None,
                    })
                    .collect();
            }
            HarnessQuestion {
                id: id.clone(),
                header: (!single).then_some(title).flatten(),
                prompt,
                multiple,
                allow_other: options.is_empty(),
                options,
            }
        })
        .collect()
}

/// The choices an enum schema offers: `enum` values, or titled `oneOf`/`anyOf`
/// constants (the label is the value; a title describes it).
fn acp_schema_options(schema: &Value) -> Vec<HarnessQuestionOption> {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .iter()
            .filter_map(|value| {
                Some(HarnessQuestionOption {
                    label: value.as_str()?.to_string(),
                    description: None,
                })
            })
            .collect();
    }
    schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
        .map(|choices| {
            choices
                .iter()
                .filter_map(|choice| {
                    let label = non_empty(choice.get("const"))?;
                    Some(HarnessQuestionOption {
                        description: non_empty(choice.get("title")).filter(|title| *title != label),
                        label,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `accept` content for `answers`, typed as the schema asks.
pub(crate) fn acp_answer_content(params: &Value, answers: &HarnessAnswers) -> Value {
    let properties = params
        .pointer("/requestedSchema/properties")
        .and_then(Value::as_object);
    let content: serde_json::Map<String, Value> = answers
        .iter()
        .filter_map(|(id, values)| {
            let schema_type = properties
                .and_then(|properties| properties.get(id))
                .and_then(|schema| schema.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("string");
            let first = values.first();
            let value = match schema_type {
                "array" => Value::Array(values.iter().cloned().map(Value::String).collect()),
                "boolean" => Value::Bool(first? == "true"),
                "integer" => Value::from(first?.parse::<i64>().ok()?),
                "number" => Value::from(first?.parse::<f64>().ok()?),
                _ => Value::String(first?.clone()),
            };
            Some((id.clone(), value))
        })
        .collect();
    serde_json::json!({ "action": "accept", "content": content })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answers(pairs: &[(&str, &[&str])]) -> HarnessAnswers {
        pairs
            .iter()
            .map(|(id, values)| {
                (
                    id.to_string(),
                    values.iter().map(ToString::to_string).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn claude_questions_round_trip_through_the_card() {
        // As Claude Code 2.1.295 sends it in `can_use_tool`.
        let input = json!({ "questions": [{
            "question": "Pick A or B?",
            "header": "A or B",
            "multiSelect": false,
            "options": [
                { "label": "A", "description": "Choose A." },
                { "label": "B", "description": "Choose B." }
            ]
        }]});
        let questions = claude_questions(&input);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].id, "Pick A or B?");
        assert_eq!(questions[0].header.as_deref(), Some("A or B"));
        assert_eq!(questions[0].options[1].label, "B");
        assert!(questions[0].allow_other);

        let (body, metadata) =
            questionnaire_message("claude_code", "Claude", "toolu_1", &questions);
        assert_eq!(body, "Claude asks: Pick A or B?\n1. A\n2. B");
        assert_eq!(metadata["kind"], QUESTIONNAIRE_KIND);
        assert_eq!(metadata["requestKey"], "toolu_1");
        assert_eq!(
            metadata["questions"][0]["options"][0]["description"],
            "Choose A."
        );

        let answered = claude_answered_input(&input, &answers(&[("Pick A or B?", &["B"])]));
        assert_eq!(answered["answers"], json!({ "Pick A or B?": "B" }));
        assert_eq!(answered["questions"], input["questions"]);
    }

    #[test]
    fn codex_questions_drop_secrets_and_answer_by_id() {
        let params = json!({
            "threadId": "t", "turnId": "u", "itemId": "call_1", "isBlocking": false,
            "questions": [
                { "id": "pick", "header": "Pick", "question": "A or B?", "isOther": true,
                  "options": [{ "label": "A", "description": "a" }, { "label": "B", "description": "b" }] },
                { "id": "token", "header": "Token", "question": "API token?", "isSecret": true },
                { "id": "name", "header": "Name", "question": "Name it", "options": null }
            ]
        });
        let questions = codex_questions(&params);
        assert_eq!(
            questions.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(),
            ["pick", "name"]
        );
        assert!(questions[0].allow_other);
        assert!(
            questions[1].allow_other,
            "a question without options is free text"
        );
        assert_eq!(
            codex_answer_result(&answers(&[("pick", &["B"]), ("name", &["x"])])),
            json!({ "answers": { "pick": { "answers": ["B"] }, "name": { "answers": ["x"] } } })
        );
    }

    #[test]
    fn acp_form_schema_becomes_questions_and_typed_content() {
        let params = json!({
            "sessionId": "s",
            "mode": "form",
            "message": "How should I refactor?",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "strategy": { "type": "string", "enum": ["conservative", "aggressive"] }
                },
                "required": ["strategy"]
            }
        });
        let questions = acp_questions(&params);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].prompt, "How should I refactor?");
        assert_eq!(questions[0].options.len(), 2);
        assert!(!questions[0].allow_other);
        assert_eq!(
            acp_answer_content(&params, &answers(&[("strategy", &["aggressive"])])),
            json!({ "action": "accept", "content": { "strategy": "aggressive" } })
        );

        let form = json!({
            "mode": "form",
            "message": "Settings",
            "requestedSchema": { "type": "object", "properties": {
                "tags": { "type": "array", "title": "Tags",
                          "items": { "anyOf": [{ "const": "x", "title": "Ex" }, { "const": "y" }] } },
                "confirm": { "type": "boolean", "title": "Confirm?" },
                "count": { "type": "integer", "title": "How many?" }
            }}
        });
        let questions = acp_questions(&form);
        let tags = questions.iter().find(|q| q.id == "tags").expect("tags");
        assert!(tags.multiple);
        assert_eq!(tags.options[0].description.as_deref(), Some("Ex"));
        let confirm = questions
            .iter()
            .find(|q| q.id == "confirm")
            .expect("confirm");
        assert_eq!(confirm.options.len(), 2);
        let count = questions.iter().find(|q| q.id == "count").expect("count");
        assert!(count.allow_other);
        assert_eq!(
            acp_answer_content(
                &form,
                &answers(&[
                    ("tags", &["x", "y"]),
                    ("confirm", &["true"]),
                    ("count", &["3"])
                ])
            ),
            json!({ "action": "accept", "content": { "tags": ["x", "y"], "confirm": true, "count": 3 } })
        );
        assert!(acp_questions(&json!({ "mode": "url", "url": "https://x" })).is_empty());
    }

    #[test]
    fn only_a_questionnaire_answer_with_a_request_key_is_a_reply() {
        let event = |metadata: Value| {
            agent_instance_connection::AgentInstanceConnectionEvent::Server(
                protocol::AgentInstanceServerMessage::ChannelMessageReceived {
                    message: serde_json::from_value(json!({
                        "messageId": "m1",
                        "channelId": "c1",
                        "sequence": 4,
                        "from": { "kind": "user", "label": "Yiming", "userId": "u1", "email": "y@example.com" },
                        "body": "A or B?: B",
                        "metadata": metadata,
                        "sentAt": "2026-10-08T00:00:00Z"
                    }))
                    .expect("message"),
                    client_message_id: None,
                    ack_required: None,
                    interrupt_requested: Some(true),
                    delivery_intent: None,
                },
            )
        };
        let reply = questionnaire_reply(&event(json!({
            "kind": QUESTIONNAIRE_ANSWER_KIND,
            "requestKey": "toolu_1",
            "answers": { "A or B?": ["B", " "] }
        })))
        .expect("an answer");
        assert_eq!(reply.request_key, "toolu_1");
        assert_eq!(reply.answers, answers(&[("A or B?", &["B"])]));
        assert_eq!(reply.sequence, Some(4));
        // A card from before request keys existed answers as plain text.
        assert!(
            questionnaire_reply(&event(json!({ "kind": QUESTIONNAIRE_ANSWER_KIND }))).is_none()
        );
        assert!(questionnaire_reply(&event(json!({ "kind": "other" }))).is_none());
    }
}
