---
title: "AI 에이전트용 GitHub, Sentry, Linear, Slack 연동 · xMatrix 문서"
description: "GitHub, Sentry, Linear, Slack 등 30개 이상의 앱 이벤트를 대화로 받아 보고, 사람과 에이전트가 한 줄 명령으로 바로 조치하세요."
---

# 연결된 앱

연결된 앱은 외부 서비스를 스페이스와 양방향으로 연결합니다. 외부 서비스의 이벤트가 대화 메시지로 도착하고, 사람과 에이전트는 메시지에서 바로 외부 서비스에 작업을 실행할 수 있습니다.

스페이스 관리자가 앱의 **Apps** 화면에서 연결합니다. 어떤 앱은 해당 서비스 계정 로그인으로 연결되고, 어떤 앱은 웹훅 URL이나 API 토큰을 입력합니다. 자격 증명은 스페이스 단위로 저장되며 다시 표시되지 않습니다.

## 명령 형식

```text
@<app>:<action>:<target> <text>
```

- `<app>`은 `github`, `sentry` 같은 앱 ID입니다.
- `<action>`은 소문자와 밑줄(`_`)로 된 앱 작업 이름입니다.
- `<target>`은 작업 대상(저장소, 이슈, 프로젝트 등)입니다. 대상이 필요 없는 작업은 `*`를 적습니다.
- `<text>`는 댓글 본문, 제목, 옵션, JSON 객체 등 작업에 필요한 추가 내용입니다.

명령은 메시지 맨 앞에 와야 하며 한 메시지에는 하나의 명령만 담을 수 있습니다. 첫 줄 이후의 줄들은 모두 `<text>` 본문에 포함됩니다. 입력창에서 `@`와 앱 이름을 입력하면 작업 목록과 대상이 단계별로 안내됩니다.

모든 명령은 실행 결과를 담은 영수증(receipt)을 대화에 남깁니다.

## 계정 전환, 일시 중지, 제거

연결된 앱의 페이지에서 계정을 관리할 수 있습니다.

- **Switch account**: 앱을 다른 계정으로 전환합니다. OAuth 로그인 방식은 프로바이더의 계정 선택 화면을 열며(Google은 항상 계정을 묻습니다), 새 로그인이 끝날 때까지 기존 계정이 유지됩니다. 자격 증명을 붙여 넣는 방식은 Credentials 섹션으로 이동해 새 값을 저장하면 프로바이더 검증 통과 시 교체됩니다. 스페이스 관리자는 입력란에서 **Use a saved secret**을 선택할 수도 있습니다. 이 경우 허브가 해당 스페이스 시크릿의 현재 값을 화면에 노출하지 않고 연결 설정에 복사해 검증하며, 복사 이력은 시크릿 감사 로그에 기록됩니다.
- **Pause**: 명령 실행과 채널 이벤트 전달을 중단하되 로그인 상태는 유지합니다. **Resume**을 누르면 다시 로그인하지 않고 같은 계정으로 재개합니다.
- **Remove**: 확인 후 연결, 저장된 자격 증명, 채널 구독을 모두 삭제합니다.

Google 앱은 일시 중지를 지원하지 않습니다. xMatrix는 중지 시 Google 로그인을 삭제하므로 대신 **Sign out**을 제공합니다. 여러 계정을 목록으로 관리하는 앱(GitHub, Gmail, Stripe, Cloudflare, X)은 목록에서 각 계정을 개별적으로 추가하거나 제거합니다.

## 이벤트

대화가 특정 소스를 구독하면 해당 소스의 이벤트가 대화에 게시됩니다.

```text
@github:subscribe:acme/web
@github:subscribe:acme/web pulls checks
@github:subscribe:acme/web:#42
@sentry:subscribe:web issue.created issue.regressed
@linear:subscribe:*
@github:unsubscribe:acme/web checks
```

대상 뒤에 붙는 단어들로 게시할 이벤트 종류를 고릅니다. 생략하면 앱의 기본값이 적용되며 `all`은 모든 종류를 뜻합니다.

GitHub의 이벤트 종류는 `issues`, `pulls`, `comments`, `reviews`, `commits`, `checks`, `status`, `releases`입니다. `except:LOGIN`을 추가하면 특정 GitHub 계정이 연 이슈·PR 및 발생시킨 이벤트를 제외할 수 있습니다. 예를 들어 `@github:subscribe:acme/web issues pulls except:octocat`은 해당 계정을 제외한 나머지 이슈와 PR만 게시하며, `@github:unsubscribe:acme/web except:octocat`으로 예외를 해제합니다. 에이전트가 연 PR은 해당 에이전트의 대화에 자동 구독되므로 CI 결과, 리뷰, 병합 알림이 작업을 요청한 대화로 바로 도착합니다.

이벤트로 에이전트를 자동 실행할 수도 있습니다. 페이지의 [프로그램](programs.md#events-from-connected-apps)이 이벤트를 대기합니다.

## GitHub

GitHub 연결은 `repo:` 기능의 기반이기도 합니다. 연결하면 스페이스에서 해당 저장소들을 실행 대상으로 선택할 수 있고 에이전트가 스페이스의 GitHub 연결로 푸시할 수 있습니다.

| 명령 | 동작 |
| --- | --- |
| `@github:subscribe:OWNER/REPO [kinds]` | 저장소 이벤트를 이 대화에 게시 |
| `@github:subscribe:OWNER/REPO:#42` | 특정 이슈 또는 PR 추적 |
| `@github:unsubscribe:OWNER/REPO [kinds]` | 구독 중지 |
| `@github:comment:OWNER/REPO:#42 <body>` | 이슈 또는 PR에 댓글 작성 |
| `@github:create_issue:OWNER/REPO <title>` | 이슈 생성 (다음 줄부터 본문) |
| `@github:close_issue:OWNER/REPO:#42` | 이슈 또는 PR 닫기 |
| `@github:reopen_issue:OWNER/REPO:#42` | 다시 열기 |
| `@github:review:OWNER/REPO:#42 approve <body>` | 리뷰 작성: `approve`, `request_changes`, `comment` |
| `@github:merge:OWNER/REPO:#42 squash` | 병합: `merge`, `squash`, `rebase` |
| `@github:rerun_failed_jobs:OWNER/REPO:RUN_ID` | 워크플로 실행의 실패한 작업 재실행 |
| `@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {…}` | 특정 ref에서 워크플로 수동 실행 (선택적 JSON 입력) |

## 기타 앱

각 앱의 작업 목록은 **Apps** 패널과 입력창에서 확인할 수 있습니다. 현재 지원되는 앱은 다음과 같습니다.

| 앱 | ID | 이벤트 | 작업(Actions) |
| --- | --- | --- | --- |
| GitLab | `gitlab` | 머지 리퀘스트, 푸시, 파이프라인, 이슈, 댓글, 릴리스 | `read_issue`, `read_merge_request`, `comment`, `merge`, `retry_pipeline` |
| Bitbucket | `bitbucket` | 풀 리퀘스트, 댓글, 푸시, 빌드 | `read_pull_request`, `comment` |
| Sentry | `sentry` | 새 이슈, 재발(regression), 해결, 배정, 무시, 알림, 댓글 | `read_issue`, `list_issues`, `resolve`, `unresolve`, `ignore` |
| Linear | `linear` | 이슈, 댓글, 프로젝트 | `read_issue`, `comment`, `create_issue` |
| Jira | `jira` | 이슈, 댓글 | `read_issue`, `comment`, `transition` |
| PagerDuty | `pagerduty` | 발생, 인지, 해결, 업데이트 | `read_incident`, `acknowledge`, `resolve`, `note` |
| Opsgenie | `opsgenie` | 생성, 인지, 종료, 업데이트 | |
| Grafana | `grafana` | 발생(Firing), 해결(Resolved) | |
| Vercel | `vercel` | 배포 시작, 성공, 실패 | `redeploy` |
| Netlify | `netlify` | 배포 시작, 성공, 실패 | |
| Cloudflare | `cloudflare` | 알림 발생, 해결 | `query_logs`, `list_deployments`, `rollback` |
| Google Cloud | `gcp` | 모니터링 인시던트 발생, 해결 | 프로젝트, Cloud Run, 로그, 메트릭, 비용, API |
| CircleCI | `circleci` | 실패, 성공 | |
| Buildkite | `buildkite` | 실패, 통과 | |
| Stripe | `stripe` | 결제 실패, 분쟁, 구독 변경 (Stripe 연결 또는 직접 생성한 웹훅의 객체별 모든 이벤트) | |
| Google Docs, Drive & Sheets | `google` | | `read_doc`, `create_doc`, `append_doc`, `read_sheet`, `update_sheet`, `create_sheet`, `list_files` |
| Google Search Console | `googlesearchconsole` | | `query`, `inspect_url`, 사이트맵, 속성, 인증 |
| Google Calendar | `googlecalendar` | | `list_calendars`, `list_events`, `get_event`, `freebusy`, `create_event`, `update_event`, `delete_event` (쓰기는 기본 승인 필요; [가이드](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-calendar.md)) |
| Google Analytics | `googleanalytics` | | `list_properties`, `report` |
| Google Ads | `googleads` | | `list_accounts`, `read_account`, `query`, `validate_mutations`; `mutate`, `set_campaign_status` (기본 승인 필요) |
| Google Play Console | `googleplay` | | `list_apps`, `tracks`, `release`, `base_plans`, `base_plan`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `api_upload` |
| Google Business Profile | `googlebusinessprofile` | | `list_accounts`, `list_locations`, `performance`, `reviews`, `reply_review` |
| Google AdSense | `googleadsense` | | `list_accounts`, `list_sites`, `list_adunits`, `report`, `list_payments`, `list_alerts`, `list_policy_issues` |
| PageSpeed Insights | `pagespeed` | | `audit`, `field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`, `traffic`, `queries`, `pages`, `crawl_stats`, `submit_urls`, `submit_sitemap`, `indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`, `summary`, `queries`, `recrawl` |
| Gmail | `gmail` | | `search`, `read`; `send`, `reply` (기본값으로 매번 스페이스 관리자 승인 필요). 여러 메일함을 연결할 수 있으며 각 메일함은 소유 멤버나 에이전트만 사용 |
| X | `x` | | `accounts`, `read_post`, `timeline`, `media_status`; `post`, `upload_video`, `quote` (기본 승인 필요). 명시적 계정 선택 필요; 인용 게시(`quote`)는 X Enterprise API 권한 필요 |
| Notion | `notion` | | `read_page`, `append`, `create_page` |
| Slack | `slack` | 메시지, 리액션 | `post` |
| App Store Connect | `appstoreconnect` | 버전 상태, 빌드 업로드, TestFlight 심사 및 피드백 | `list_apps`, `status`, `builds`, `read_version`, `reviews`, `sales`, `review_messages`, `review_attachments`, `review_attachment`, `review_draft`, `edit_review_draft`, `send_review_draft`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `web_session`, `create_app`, `privacy`, `set_privacy`, `read_app`, `create_version`, `set_metadata`, `set_build`, `submit`, `cancel_submission`, `subscriptions`, `submit_subscriptions`, `in_app_purchases`, `submit_in_app_purchases`, `release`, `pause_phased_release`, `resume_phased_release`, `complete_phased_release`, `reply_review`, `set_app_info`, `set_age_rating`, `set_price`, `set_availability`, `set_review_contact`, `upload_build`, `upload_screenshot`, `commit_upload`, `read_upload`, `delete_upload`, `build_uploads`, `screenshot_specs`, `screenshots`, `set_screenshots`, `declare_encryption`, `signing`, `register_bundle_id`, `enable_capability`, `create_certificate`, `read_certificate`, `create_profile`, `read_profile`, `testflight`, `feedback`, `crash_log`, `add_to_group`, `submit_beta_review`, `set_test_notes` |
| Discord | `discord` | | `post` |
| Telegram | `telegram` | 메시지 | `send` |
| Feishu / Lark | `feishu` | 메시지 | `send` |
| Microsoft Teams | `teams` | 메시지 | `post` |
| Google Chat | `googlechat` | 메시지 | `post` |
| DingTalk | `dingtalk` | | `post`, `read`, `send` |
| WeCom | `wecom` | 메시지 | `post`, `send` |
| Webhook | `webhook` | 서명된 임의의 JSON 전달 | |
| OpenConnector | `openconnector` | | `search`, `run`: 자체 OpenConnector 런타임의 작업 실행 |

사용 예시:

```text
@sentry:read_issue:WEB-1A2
@sentry:list_issues:* firstRelease:xmatrix-v1.2.3
@linear:create_issue:ENG Login fails on Safari
@gitlab:comment:group/project!5 Looks good.
@cloudflare:query_logs:api-worker 30 error
@google:create_doc:new Launch notes
@slack:post:C0123456789 Deploy finished.
```

## X 크레딧

Pro 플랜에서 유료 X 작업은 에이전트가 실행하든 사람이 실행·승인하든 스페이스의 크레딧 잔액에서 차감됩니다.

| 작업 | 크레딧 |
| --- | --- |
| 일반 텍스트 게시물 | 30 |
| URL, 인용 또는 미디어 포함 게시물 | 400 |
| 게시물 또는 타임라인 조회 | 반환된 게시물당 10 |
| 프로필 조회 (Connect 및 Check 포함) | 프로필당 20 |
| 미디어 업로드 또는 상태 확인 | 30 |

계정 목록 조회, 승인 요청, 토큰 갱신은 무료입니다. X가 거부하거나 X에 도달하기 전에 실패한 호출은 환불됩니다. 미디어 및 URL·인용·미디어 포함 게시물의 요율은 X의 실제 과금 확인에 따라 변경될 수 있습니다.

## Google Ads 관리

**Apps**에서 Google Ads를 연결하고 Credentials에서 광고주 고객 ID를 선택한 뒤 Check를 실행하세요. 이 Google 연결은 Analytics, Search Console, Drive와 별개입니다. 읽기 및 변경 요청은 다른 광고주 계정을 대상으로 할 수 없습니다.

```text
@googleads:read_account:1234567890
@googleads:query:1234567890 SELECT campaign.id, campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 50
@googleads:set_campaign_status:1234567890/987654321 {"status":"PAUSED"}
```

`validate_mutations`는 광고 변경안을 실제로 적용하지 않고 검증합니다. `mutate`는 예산, 캠페인, 크리에이티브, 타겟팅을 함께 생성하거나 수정하며, 새 캠페인은 반드시 일시 중지 상태로 생성해야 합니다. `mutate`와 캠페인 상태 변경은 모두 기본값으로 매 요청마다 스페이스 관리자 승인을 요구합니다. 캠페인을 활성화하려면 통화와 예상 현재 평균 일일 예산을 정수 micros 단위로 명시해야 합니다.

```text
@googleads:set_campaign_status:1234567890/987654321 {"status":"ENABLED","currencyCode":"USD","expectedDailyBudgetMicros":"1000000"}
```

100만 micros는 계정 통화의 1단위입니다. 평균 일일 예산은 엄격한 지출 상한이 아니므로 Google이 특정 날에 평균보다 더 많이 지출할 수 있습니다. 네이티브 광고 심사 및 게재는 비동기로 진행됩니다. 결과가 확실하지 않은 쓰기 작업은 재시도하기 전에 먼저 조회하세요. 전체 구성과 안정화된 승인 계약은 [Google Ads 커넥터 문서](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-ads.md)에서 확인할 수 있습니다.

## App Store에 앱 배포하기

App Store Connect를 연결하면 에이전트가 빌드 업로드부터 스토어 출시까지 진행하고 심사 결과를 알려 줄 수 있습니다. **Apps**에서 App Store Connect API 키(사용자 및 액세스 → 통합)의 Key ID, Issuer ID, `.p8` 파일 내용을 입력해 연결하세요. API 키에는 App Manager 역할이 필요합니다.

```text
@appstoreconnect:subscribe:com.example.app
@appstoreconnect:create_version:com.example.app 1.2.0
@appstoreconnect:set_metadata:com.example.app 1.2.0 {"locale":"en-US","whatsNew":"Faster sync and two crash fixes."}
@appstoreconnect:set_build:com.example.app 1.2.0 412
@appstoreconnect:submit:com.example.app 1.2.0
@appstoreconnect:release:com.example.app 1.2.0
```

- `subscribe`는 Apple에 앱 웹훅을 자동으로 등록합니다. 이후 빌드 처리 완료 시점과 버전 상태가 바뀔 때마다(심사 대기, 심사 중, 리젝, 승인, 출시) 대화에 알림이 옵니다. [프로그램](programs.md#events-from-connected-apps)으로 이 이벤트를 대기해 리젝 발생 시 에이전트가 즉시 대응하게 할 수 있습니다.
- `create_version`은 수동 출시 방식으로 다음 버전을 생성합니다. 승인 즉시 Apple이 자동 출시하게 하려면 `release=after_approval`을 추가하세요. App Review 연락처와 로그인 정보는 대화에 노출되지 않은 채 이전 버전에서 자동 승계됩니다.
- `set_build`는 Apple 처리가 끝난 업로드 빌드 번호를 연결합니다. 앱을 빌드한 에이전트는 머신에 Apple 키가 없어도 빌드를 업로드할 수 있습니다. 아래 [파일 업로드](#uploading-files)를 참고하세요.
- `submit`은 버전을 App Review에 제출합니다. 스토어 등록 정보가 부족해 Apple이 거부하면 영수증에 누락 항목이 표시됩니다.
- `release`는 승인되어 개발자 출시 대기 중인 버전을 배포합니다. `phased`를 붙이면 7일간 단계적 출시를 시작하며, `pause_phased_release`로 일시 중지, `resume_phased_release`로 재개, `complete_phased_release`로 전체 사용자 즉시 배포가 가능합니다. 출시 자체는 되돌릴 수 없습니다. 스페이스 관리자는 App Store Connect 권한을 읽기 전용(Read only)으로 설정해 쓰기를 막을 수 있습니다.

`@appstoreconnect:status:com.example.app`은 모든 버전의 상태를 보여 주며, `reviews`와 `reply_review`로 고객 리뷰를 확인하고 답글을 달 수 있습니다. 다른 플랫폼 버전은 `macos/1.2.0`, `tvos/1.2.0`, `visionos/1.2.0`처럼 표기합니다.

신규 앱은 앱 레코드 생성부터 시작합니다. 번들 ID를 등록하고(아래 `register_bundle_id`) 스페이스 관리자가 Credentials에 Web 세션을 저장하면, `create_app`으로 첫 버전과 함께 앱 레코드를 만들고 `set_privacy`로 App Privacy 응답을 작성해 게시할 수 있으며 `privacy`로 저장된 응답을 조회합니다. Apple 공식 API가 이 두 기능을 제공하지 않으므로 저장된 Web 세션을 통해 App Store Connect 웹사이트로 처리됩니다.

```text
@appstoreconnect:create_app:com.example.app {"name":"Example","sku":"EXAMPLE","locale":"en-US","version":"1.0","platform":"ios"}
@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY"],"linked":true,"tracking":false}]}
```

`set_privacy`는 기존 응답을 모두 덮어쓰며 `{"data":[]}`는 앱이 데이터를 수집하지 않음을 뜻합니다. 연령 등급과 마찬가지로 Apple에 제출하는 공식 선언이므로 앱의 실제 동작에 맞게 작성하세요.

첫 제출 전에는 몇 가지 기본 정보를 한 번 채워야 합니다. `@appstoreconnect:read_app:com.example.app`으로 누락된 항목을 확인하고 대부분을 에이전트로 설정할 수 있습니다.

```text
@appstoreconnect:set_app_info:com.example.app {"locale":"en-US","name":"Example","subtitle":"Ship faster","privacyPolicyUrl":"https://example.com/privacy","primaryCategory":"PRODUCTIVITY"}
@appstoreconnect:set_app_info:com.example.app {"contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}
@appstoreconnect:set_age_rating:com.example.app {"gambling":false,"userGeneratedContent":true,"violenceRealistic":"NONE"}
@appstoreconnect:set_price:com.example.app free
@appstoreconnect:set_availability:com.example.app all
@appstoreconnect:set_review_contact:com.example.app 1.0.0 {"contactFirstName":"Ada","contactLastName":"Lovelace","contactEmail":"ada@example.com","contactPhone":"+1 555 0100"}
```

연령 등급 응답은 Apple에 제출하는 공식 선언이므로 자동 채우기 없이 설문의 모든 항목을 직접 전달해야 하며, `read_app`에서 미응답 항목은 `null`로 표시됩니다.

### App Review 답변하기

`review_messages`는 최신 심사 스레드의 스레드 ID, 메시지 ID, 첨부 파일 메타데이터를 읽어 옵니다. 이전 스레드는 스레드 ID를, 긴 본문은 메시지 ID를 지정해 조회하세요. 저장된 Web 세션이 있으면 `review_attachments`로 파일 목록을 보고 `review_attachment`로 만료되는 서명된 다운로드 URL을 받아 Apple 쿠키나 API 키 없이 파일을 내려받을 수 있습니다.

`review_draft`는 미전송 답변 초안과 현재 다이제스트를 읽습니다. `edit_review_draft`는 새 초안을 만들거나 다이제스트를 지정해 기존 초안을 수정·삭제합니다. `send_review_draft`는 해당 초안을 전송하고 Apple에 반영된 메시지를 검증합니다. 이 별도 작업을 실행하기 전까지 초안은 전송되지 않으며, 답변을 보낸다고 앱이 자동 재제출되지는 않습니다. 전송 결과가 불확실하면 재시도 전에 스레드를 먼저 확인하세요. 자세한 인자와 제한 사항은 [심사 워크플로 문서](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/app-store-connect-review.md)를 참고하세요.

### 파일 업로드

빌드나 스크린샷은 세 단계로 Apple에 직접 전송되며 파일 자체는 xMatrix를 거치지 않습니다.

```text
@appstoreconnect:upload_build:com.example.app 1.2.0 412 Example.ipa 48211034
@appstoreconnect:commit_upload:<upload id> build
@appstoreconnect:build_uploads:com.example.app 412
```

1. `upload_build`로 업로드를 예약합니다. 파일 내부의 버전·빌드 번호, 파일명, 정확한 바이트 크기를 전달하면 영수증에 하나 이상의 파트(메서드, URL, 바이트 범위, 헤더)가 반환됩니다.
2. 파일이 있는 머신의 에이전트가 각 파트의 바이트를 해당 URL과 헤더로 전송합니다. 이 URL은 Apple이 발급한 것으로 일정 시간 후 만료되며 이 파일에만 사용할 수 있습니다.
3. `commit_upload`로 업로드 완료를 Apple에 알립니다. 이후 Apple이 빌드를 처리하며, 구독된 대화에 완료 알림이 오고 `build_uploads`로 Apple이 발견한 오류를 확인할 수 있습니다.

스크린샷도 같은 방식으로 업로드한 뒤 스토어 등록 정보에 배치합니다.

```text
@appstoreconnect:screenshot_specs:* iphone
@appstoreconnect:upload_screenshot:com.example.app home-6.9.png 1482113
@appstoreconnect:commit_upload:<image id> image
@appstoreconnect:set_screenshots:com.example.app 1.2.0 {"locale":"en-US","group":"<group>","images":["<image id>","<image id>"]}
```

`screenshot_specs`는 기기군별 Apple 배치 그룹과 허용 픽셀 크기를 보여 줍니다. `set_screenshots`는 해당 언어와 그룹에 지정한 이미지를 순서대로 배치하며, 같은 이미지를 여러 언어에 재사용할 수 있습니다. `screenshots`로 현재 버전에 등록된 스크린샷을 확인합니다.

Apple이 수출 규정 준수 여부를 물으면 `@appstoreconnect:declare_encryption:com.example.app 1.2.0 412 exempt`로 응답하세요.

### Apple ID 없는 머신에서 서명 설정하기

새 Mac이나 CI 러너의 에이전트도 커넥터를 통해 App Store 서명을 설정할 수 있습니다. 개인 키는 해당 머신에서 생성되어 로컬에만 남고 인증서 서명 요청(CSR)만 전송됩니다.

```text
@appstoreconnect:signing:com.example.app
@appstoreconnect:register_bundle_id:com.example.app Example App
@appstoreconnect:create_certificate:distribution -----BEGIN CERTIFICATE REQUEST----- …
@appstoreconnect:read_certificate:<certificate id>
@appstoreconnect:create_profile:com.example.app <certificate id>
@appstoreconnect:read_profile:<profile id>
```

`signing`으로 이미 존재하는 항목을 확인하세요. 팀당 배포 인증서 수량이 제한되어 있으므로 기존 인증서의 개인 키를 보유한 머신이 없을 때만 새로 발급하세요. `enable_capability`로 번들 ID에 `PUSH_NOTIFICATIONS` 같은 기능을 활성화한 뒤 프로파일을 생성하면 됩니다.

### TestFlight

```text
@appstoreconnect:testflight:com.example.app
@appstoreconnect:add_to_group:com.example.app 1.2.0 412 Early Access
@appstoreconnect:set_test_notes:com.example.app 1.2.0 412 en-US Try the new sync.
@appstoreconnect:submit_beta_review:com.example.app 1.2.0 412
@appstoreconnect:feedback:com.example.app
@appstoreconnect:crash_log:<feedback id>
```

구독 이벤트 종류에 `feedback`을 포함하면 테스터가 보낸 제보를 에이전트가 바로 확인할 수 있습니다. `feedback`은 기기, OS, 빌드 정보와 함께 댓글을 나열하고, `feedback:… crashes`와 `crash_log`로 해당 리포트의 크래시 로그를 가져옵니다.

### App Review에서 버전이 리젝되었을 때

리젝 알림이 대화로 전달됩니다. 저장된 Web 세션을 사용해 `@appstoreconnect:review_messages:com.example.app`으로 리젝 사유와 심사자 메시지를 읽으세요. xMatrix 앱에서 Sign in to App Store Connect를 누르면 Apple 공식 로그인 페이지가 열리고 세션이 저장됩니다. `review_attachments`로 첨부 파일 목록을, `review_attachment`로 자격 증명 없이 내려받을 수 있는 만료형 다운로드 URL을 받습니다. `review_draft`를 확인하고 `edit_review_draft`로 미전송 답변 초안을 만든 뒤, 정확한 ID와 다이제스트로 `send_review_draft`를 호출해 전송하세요. 답변 전송만으로는 앱이 재제출되지 않습니다. 문제를 수정한 뒤 `submit`으로 같은 제출 건을 다시 심사에 보내거나, `cancel_submission` 후 `submit`으로 새 제출을 시작할 수 있습니다.

앱의 첫 구독 상품은 앱 버전과 함께 심사됩니다. `subscriptions`로 심사 상태를 확인하고, `submit_subscriptions`로 준비된 모든 구독(또는 지정한 상품 ID)을 초안 제출에 구독 버전으로 담은 뒤 다음 버전 `submit` 시 함께 제출하세요. 일회성 인앱 결제(크레딧 팩 같은 소모성, 비소모성, 비갱신 구독)는 별도입니다. `in_app_purchases`로 유형과 심사 상태를 보고 `submit_in_app_purchases`로 초안 제출에 담은 뒤 앱 버전과 함께 `submit`하세요.

로그인, 계약, 은행/세금 정보 및 비공개 심사 계정 자격 증명은 Apple 계정 소유자가 직접 관리합니다. 저장된 Web 세션은 앱 레코드 생성, App Privacy 설정, 심사 답변 전송을 지원합니다.

### 기타 App Store Connect 리소스

`api_operations:* <resource>`로 고정된 공식 API를 검색하고 `api_schema:<operation or schema>`로 정확한 파라미터를 확인할 수 있습니다. `api_read`는 구독/IAP 구성, TestFlight 테스터 및 그룹, 가격/오퍼, 알림, 에셋, 기기, 팀 권한, 리포트 등 나머지 리소스를 지원합니다. 개인정보나 재무 데이터가 포함된 조회에는 비공개 읽기를 사용하세요. 쓰기 작업은 먼저 `api_plan`으로 Apple 상태를 바꾸지 않고 요청을 검증해 다이제스트를 받은 뒤, `api_write`로 다이제스트와 현재 대상 상태를 확인하며 실행합니다. 두 작업 모두 로그인 시크릿을 받지 않습니다. 특히 새 리소스를 생성할 때 결과가 불확실한 쓰기는 재시도 전에 반드시 현재 상태를 조회하세요.

## 에이전트와 앱

에이전트도 사람이 직접 명령을 입력하는 것과 똑같은 규칙과 작업으로 대화에 보이는 메시지를 통해 앱을 호출합니다. `xmatrix connector list`로 연결된 앱과 명령을 조회하고, `xmatrix send <channel-id> "<command>"`로 명령을 보내면 결과가 해당 메시지에 답장으로 돌아옵니다. 에이전트 쪽에 별도 설정은 필요하지 않습니다.

Gmail의 `search`와 `read`는 메일 내용을 대화 영수증에 게시하며 실행 이력에도 제한된 발췌본이 저장됩니다. 대화를 볼 수 있는 모든 사람이 그 내용을 읽을 수 있습니다. `@gmail:search:* is:unread newer_than:1h`처럼 검색하거나 `*` 자리에 연결된 메일함 주소를 지정하세요. 커넥터용 MCP나 호출자 전용 비공개 메일 조회 기능은 없습니다.

대화창에 노출되어서는 안 되는 로그인 인증 코드나 자격 증명을 가져오는 데 이 작업을 사용하지 마세요. Gmail에서 스페이스 시크릿으로 직접 옮기는 작업은 제공되지 않습니다. 승인된 수동 로그인을 위해서는 에이전트가 `xmatrix request secret-add <fresh-alias> --env QA_LOGIN_CODE --reason "QA login"`으로 요청하고, 스페이스 관리자가 채팅창이 아닌 요청 카드에 코드를 입력하게 하세요. 이후 에이전트는 `xmatrix secret exec --secret <fresh-alias>=QA_LOGIN_CODE -- <login-command>`로 값을 출력하거나 스크린샷·트레이스·요청 로그에 남기지 않는 프로세스에 안전하게 주입합니다. 이 수동 시크릿 입력은 커넥터 메일 수신이나 자동 로그인을 검증하지 않으며, 이미 채널 영수증으로 읽은 값을 나중에 시크릿에 저장해도 이전 노출을 되돌릴 수 없습니다.

## 작업 권한 제한하기

Gmail의 `send`와 `reply`는 기본값이 **Ask(먼저 묻기)**입니다. 각 요청은 발신자, 수신자, 제목, 본문과 함께 대화의 **Pending approvals**에 표시됩니다. 스페이스 관리자가 **Allow once** 또는 **Disallow**를 선택합니다. 이메일 한 건을 승인해도 다음 이메일이 자동 승인되지는 않으며, 승인 대기 중에는 아무것도 발송되지 않습니다.

**Apps → Gmail → Permissions**에서 **Read only(읽기 전용)**, **Ask first(먼저 묻기)**, **Read and write(읽기 및 쓰기)** 중 하나를 선택할 수 있습니다. 이 설정은 모든 대화의 해당 연결 전체에 적용됩니다. 읽기는 세 모드 모두에서 가능하며, Ask first는 모든 변경을 승인 대기시키고, Read and write는 변경을 바로 실행합니다. 채널별 규칙이나 작업별 세부 설정은 없습니다. Calendar는 기본값이 Read and write이며 Gmail, Google Ads, X, Linear는 기본값이 Ask first입니다. GitHub은 Read only 또는 Read and write를 지원합니다.
