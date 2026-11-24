---
title: "텔레메트리, 진단 및 로컬 개인정보 — xMatrix 문서"
description: "로컬에 남는 데이터, 선택적 로컬 할당량 조회 및 클라이언트 진단 동작 방식, 그리고 끄는 방법."
---

# 텔레메트리 및 로컬 개인정보

xMatrix는 호스팅 협업 Hub와 사용자 머신에서 실행되는 Rust 로컬 데몬으로 구성됩니다. 이 문서는 클라이언트와 데몬이 수행하는 모든 진단 전송 및 로컬 파일 읽기와 이를 끄는 방법을 투명하게 안내합니다.

## 로컬 머신에 남는 데이터

소스 코드, Git 기록, 작업 디렉터리, 모델 도구 대화 내역, 로컬 모델 자격 증명은 모두 사용자 본인의 머신에 남습니다. xMatrix는 로컬 API 키나 OAuth 토큰을 Hub로 전송하지 않으며, 다른 도구의 인증 파일을 읽어 기기 간 신원을 연결하거나 추적하지 않습니다.

재설치 후에도 계정 내에서 같은 컴퓨터를 안정적으로 식별하기 위해 데몬은 로컬에서 xMatrix 사용자 ID와 OS 머신 식별자를 해시하여 소유자별 `machineId`만 생성합니다. 원본 하드웨어 식별자나 계정 비격리 지문은 Hub로 전송되지 않습니다.

## 로컬 공급자 할당량 조회

**요약:** 등록한 AI 도구의 남은 할당량을 보여 주기 위해 xMatrix daemon은 컴퓨터에 있는 해당 도구 자체의 로그인 파일(예: `~/.codex/auth.json`)을 읽고 각 공급자에게 직접 조회합니다. 이 파일에서 읽은 내용(토큰, 계정 ID, 파일 내용, 파일 지문)은 xMatrix로 전송되지 않으며, Hub는 정규화된 할당량 결과만 받습니다. 하나의 스위치로 파일 읽기와 공급자 요청을 모두 중지할 수 있습니다(아래 「로컬 할당량 조회 끄기」 참고).

등록된 하네스(Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai, Antigravity 등)의 남은 구독 할당량을 `xmatrix agent list`와 Agents 화면에 표시하고 `@auto` 라우팅이 한도 초과 계정을 피할 수 있도록, 로컬 데몬이 등록된 도구의 로컬 자격 증명 저장소를 메모리 내에서 읽어 해당 공급자 엔드포인트에 직접 조회할 수 있습니다.

| 하네스 | 로컬 메모리에서만 읽는 위치 | 기기에서 직접 조회하는 공급자 API |
| --- | --- | --- |
| Claude Code | macOS 키체인(`Claude Code-credentials`) 또는 `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `$CODEX_HOME/auth.json` 또는 `~/.codex/auth.json` | `https://chatgpt.com/backend-api/wham/usage` |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`, macOS 키체인(`cursor-access-token`), 또는 Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` 또는 `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` 또는 OpenCode `auth.json` | `https://opencode.ai/zen/go/v1/usage` 또는 ChatGPT `wham/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` 또는 `$DSH_HOME` 인증 파일 | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit` (또는 `open.bigmodel.cn`) |
| Antigravity | 원본 `agy -p "/usage" --output-format json` 명령 위임 | `agy` 자체 처리 |

**엄격한 경계:**

- 자격 증명은 로컬 프로세스 메모리에만 머물며 **해당 공급자의 공식 사용량 엔드포인트로만** 전송됩니다.
- 로컬 SHA-256 지문은 계정 전환 감지용 메모리 캐시 키로만 쓰이며 **로그에 남거나 xMatrix로 전송되지 않습니다**.
- xMatrix Hub로 전송되는 값은 정규화된 잔여 할당량(비율, 초기화 시각, 사용 가능 여부, 잔액)뿐입니다.

### 로컬 할당량 조회 끄기

데스크톱 앱의 **Settings → Legal and privacy → Local provider quota probes** 또는 아래 명령/환경 변수로 끌 수 있습니다:

```sh
xmatrix config quotaProbes off
# 또는 환경 변수 설정(우선 적용)
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Antigravity만 끄려면 `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`을 설정하세요. 비활성화하면 모든 경로에서 로컬 자격 증명 저장소를 읽거나 공급자 API를 호출하지 않습니다.

## 클라이언트 진단 및 오류 보고

xMatrix는 광고 쿠키, 크로스사이트 추적, 세션 리플레이, PostHog·Google Analytics·Cloudflare Web Analytics 같은 서드파티 행동 분석 SDK를 사용하지 않습니다.

**모든 지역에서 선택적 클라이언트 진단과 브라우저 오류 보고는 기본적으로 꺼져 있습니다(명시적 옵트인).** 로그인하지 않은 마케팅·문서·법적 페이지에서는 Sentry를 로드하지 않으며, 사용자가 직접 켜거나 데스크톱 시작 실패 카드에서 수동 전송을 클릭한 경우에만 전송됩니다:

- **오류 및 충돌 보고(Sentry)**: 로그인된 앱에서 옵트인한 경우에만 전송되며, 사용자 정보, 쿠키, HTTP 헤더/본문, URL 쿼리, 콘솔 브레드크럼을 비활성화하고 인용 문자열을 마스킹합니다. DSN이 없는 로컬/셀프호스트 빌드에서는 전송하지 않습니다.
- **퍼스트파티 진단(xMatrix Hub → Cloudflare Analytics Engine)**: 옵트인한 경우에만 시작 시간(`/api/observable/startup-timing`), 온보딩 단계 수(`/api/observable/onboarding-step`), 데스크톱 데몬 시작 실패 정보(`/api/observable/desktop-daemon-failure`), CLI 재연결 샘플(`/api/observable/client-metrics`)을 전송합니다. 식별자는 서버 키 기반 HMAC-SHA-256으로 가명화되며 메시지나 명령 본문은 포함되지 않습니다.

### 진단 및 오류 보고 켜기/끄기

- **Web, Desktop, iOS, Android**: **Settings → Legal and privacy**에서 **Send diagnostics and crash reports**를 전환합니다(기본 꺼짐). 데스크톱에서는 로컬 데몬의 `telemetry` 설정도 함께 동기화됩니다.
- **CLI 및 데몬**: 기본 꺼짐입니다. `xmatrix config telemetry on` 또는 `XMATRIX_TELEMETRY=1`로 켜고, `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0` 또는 `DO_NOT_TRACK=1`로 끌 수 있습니다.

## 법적 문서

- [개인정보처리방침 (EN)](/privacy)
- [쿠키 및 로컬 저장소 안내 (EN)](/cookies)
- [하위 처리자 목록 (EN)](/subprocessors)
- [이용약관 (EN)](/terms)
