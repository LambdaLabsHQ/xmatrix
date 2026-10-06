#![deny(warnings)]

mod page;
mod page_automation;
pub use page::cmd_page;

use colored::Colorize;
use xmatrix_cli_args::AnnotationCommand;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::http;
use xmatrix_cli_core::protocol::{
    AnnotationEnvelope, AnnotationTarget, CreateAnnotationRequest, ListAnnotationsResponse,
    channel_annotation_route, channel_annotations_route, with_route,
};

pub async fn cmd_annotation(
    hub_url: &str,
    token: &str,
    command: AnnotationCommand,
) -> error::Result<()> {
    match command {
        AnnotationCommand::Create {
            channel_id,
            namespace,
            target_kind,
            message_id,
            start_sequence,
            end_sequence,
            payload,
            payload_file,
            payload_stdin,
        } => {
            let payload_str = if payload_stdin {
                use std::io::Read;
                let mut s = String::new();
                std::io::stdin()
                    .read_to_string(&mut s)
                    .map_err(|e| CliError::Launch(format!("read stdin: {e}")))?;
                s
            } else if let Some(f) = payload_file {
                std::fs::read_to_string(&f)
                    .map_err(|e| CliError::Launch(format!("read {}: {e}", f.display())))?
            } else if let Some(p) = payload {
                p
            } else {
                return Err(CliError::Launch(
                    "one of --payload / --payload-file / --payload-stdin required".into(),
                ));
            };
            let payload_json: serde_json::Value = serde_json::from_str(&payload_str)
                .map_err(|e| CliError::Launch(format!("invalid JSON payload: {e}")))?;
            let target = AnnotationTarget {
                kind: target_kind.clone(),
                message_id: if target_kind == "message" {
                    message_id
                } else {
                    None
                },
                start_sequence: if target_kind == "message_range" {
                    start_sequence
                } else {
                    None
                },
                end_sequence: if target_kind == "message_range" {
                    end_sequence
                } else {
                    None
                },
            };
            let body = CreateAnnotationRequest {
                namespace,
                target,
                payload: payload_json,
            };
            let url = with_route(hub_url, &channel_annotations_route(&channel_id));
            let body_value = serde_json::to_value(&body)
                .map_err(|e| CliError::Launch(format!("encode body: {e}")))?;
            let resp: AnnotationEnvelope =
                http::request_json(&url, "POST", Some(token), Some(body_value)).await?;
            println!(
                "{} Created annotation {} ({})",
                "✓".green().bold(),
                resp.annotation.id.dimmed(),
                resp.annotation.namespace
            );
            Ok(())
        }
        AnnotationCommand::List {
            channel_id,
            namespace,
            target_kind,
            message_id,
            after_created_at,
            json,
        } => {
            let mut url = with_route(hub_url, &channel_annotations_route(&channel_id));
            let mut qs: Vec<String> = Vec::new();
            if let Some(n) = namespace {
                qs.push(format!("namespace={}", urlencoding::encode(&n)));
            }
            if let Some(k) = target_kind {
                qs.push(format!("targetKind={}", urlencoding::encode(&k)));
            }
            if let Some(m) = message_id {
                qs.push(format!("messageId={}", urlencoding::encode(&m)));
            }
            if let Some(a) = after_created_at {
                qs.push(format!("afterCreatedAt={}", urlencoding::encode(&a)));
            }
            if !qs.is_empty() {
                url.push('?');
                url.push_str(&qs.join("&"));
            }
            let resp: ListAnnotationsResponse =
                http::request_json(&url, "GET", Some(token), None).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&resp.annotations).unwrap_or_default()
                );
            } else if resp.annotations.is_empty() {
                println!("(no annotations)");
            } else {
                for ann in &resp.annotations {
                    let target_summary = match ann.target.kind.as_str() {
                        "message" => format!(
                            "message {}",
                            ann.target.message_id.as_deref().unwrap_or("?")
                        ),
                        "message_range" => format!(
                            "messages {}..{}",
                            ann.target.start_sequence.unwrap_or(0),
                            ann.target.end_sequence.unwrap_or(0)
                        ),
                        _ => "channel".to_string(),
                    };
                    let author = match &ann.author_label {
                        Some(l) => format!("{} ({})", ann.author, l),
                        None => ann.author.clone(),
                    };
                    println!(
                        "{}  {}  target={}  by={}\n    {}",
                        ann.id.dimmed(),
                        ann.namespace,
                        target_summary,
                        author,
                        serde_json::to_string(&ann.payload).unwrap_or_default()
                    );
                }
            }
            Ok(())
        }
        AnnotationCommand::Delete {
            channel_id,
            annotation_id,
        } => {
            let url = with_route(
                hub_url,
                &channel_annotation_route(&channel_id, &annotation_id),
            );
            let _: serde_json::Value =
                http::request_json(&url, "DELETE", Some(token), None).await?;
            println!(
                "{} Deleted annotation {}",
                "✓".green().bold(),
                annotation_id
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests;
