---
title: "텔레메트리, 진단 및 로컬 개인정보 — xMatrix 문서"
description: "로컬에 남는 데이터, Hub로 전송되는 데이터(및 종단간 암호화를 하지 않는 이유), 선택적 로컬 할당량 조회와 클라이언트 진단 동작 방식 및 끄는 방법."
---

# 텔레메트리 및 로컬 개인정보

xMatrix는 호스팅 협업 Hub와 사용자 머신에서 실행되는 Rust 로컬 데몬으로 구성됩니다. 이 문서는 신뢰 경계(로컬에 남는 데이터, Hub로 전송되는 데이터, 채널과 Pages가 종단간 암호화가 아닌 이유)와 클라이언트·데몬의 모든 진단 전송, 로컬 파일 읽기, 비활성화 방법을 투명하게 안내합니다.

## 로컬 머신에 남는 데이터

소스 코드, Git 기록, 작업 디렉터리, 커밋되지 않은 파일, SSH 키, 모델 도구 대화 내역, 로컬 모델 자격 증명은 사람·Agent·도구·기능이 명시적으로 올리거나 첨부하지 않는 한 모두 사용자 본인의 머신에 남습니다. 원시 터미널 출력은 Hub에 상시 보관되지 않습니다. 실시간 **Instance Trace**는 호스트 프로세스 메모리에만 보관되며(Instance당 최대 5,000건, 16 MiB, 24시간), 권한이 있는 사용자가 요청할 때만 전달됩니다. xMatrix는 로컬 API 키나 OAuth 토큰을 Hub로 전송하지 않으며, 다른 도구의 인증 파일을 읽어 기기 간 신원을 연결하거나 추적하지 않습니다.

재설치 후에도 계정 내에서 같은 컴퓨터를 안정적으로 식별하기 위해 데몬은 로컬에서 xMatrix 사용자 ID와 OS 머신 식별자를 해시하여 소유자별 `machineId`만 생성합니다. 원본 하드웨어 식별자나 계정 비격리 지문은 Hub로 전송되지 않습니다.

## Hub로 전송되는 데이터와 종단간 암호화를 하지 않는 이유

**전송 암호화와 저장 암호화는 적용하지만 종단간 암호화(E2EE)는 아닙니다.** 클라이언트, 로컬 데몬, xMatrix Hub 사이의 통신은 HTTPS/TLS를 사용하며, Hub 저장소(PlanetScale 관리형 PostgreSQL, Cloudflare Durable Objects, 비공개 R2 객체 스토리지)는 저장 시 암호화를 제공합니다. Saved Secrets 값에는 보호된 키로 추가 인증 암호화가 적용됩니다. **채널 메시지, Pages, 첨부 파일은 종단간 암호화되지 않습니다.**

**종단간 암호화를 하지 않는 이유.** 1인용 원격 터미널 터널과 달리 xMatrix는 여러 사람과 여러 Agent가 함께 일하는 호스팅 협업 워크스페이스입니다. Hub가 협업 내용을 읽을 수 있어야 다음 핵심 기능을 제공할 수 있습니다:

- 팀원과 여러 기기 간 채널, 스레드, Pages의 실시간 동기화
- 채널 및 Pages 인덱싱과 전체 텍스트 검색
- `@auto`의 적합한 Agent·저장소 라우팅, 대화와 Page 자동 연결, 공급자 간 자동 인계
- Page 내 자동화 프로그램(`norn` 프로그램) 실행 및 GitHub·Gmail·Linear·Sentry 등 외부 앱 웹훅 처리

**Hub에 저장되는 내용:** 채널 메시지, 스레드, Pages, 첨부 파일, Space/Agent/머신 메타데이터, 정규화된 잔여 할당량, 연결된 앱 결과, 암호화된 Saved Secrets(평문 값은 메시지나 Agent 목록에 노출되지 않으며 `auto` 또는 실행별 `ask` 승인 정책에 따라 Run에만 주입됩니다).

**계정 유입 경로.** 계정이 만들어질 때 Hub는 xMatrix로 안내한 웹사이트의 도메인(예: `x.com` 또는 `direct`)과 연 링크의 `?ref=` 태그를 한 번 기록합니다. 어떤 경로로 사용자가 오는지 알기 위해서입니다. 전체 주소는 기록하지 않으며 기기에 아무것도 저장하지 않습니다. 계정이 만들어지기 전까지 웹은 자체 링크와 페이지 메모리에만 담아 둡니다. 계정을 삭제하면 함께 삭제됩니다.

**머신 연결 및 내부 접근 경계:**

- 머신 연결에는 로그인한 소유자의 명시적 승인이 필요하며, 기본으로 열린 상시 터널이 아닙니다. 언제든 머신 연결을 해제하거나 실행 중인 Agent를 중지할 수 있고, 외부 앱 커넥터는 앱별 읽기 전용/매번 확인/읽기·쓰기 정책을 따릅니다.
- Hub에 저장된 내용은 Space 및 채널 권한을 가진 멤버와 Agent만 읽을 수 있습니다. 사용자가 대화를 명시적으로 지원팀에 넘기지 않는 한(아래 [대화를 xMatrix 지원팀에 넘기기](#대화를-xmatrix-지원팀에-넘기기) 참고) xMatrix 직원과 지원 Agent는 고객 대화를 읽지 않으며, 제품 분석에는 본문이 없는 메타데이터만 사용합니다.

## 로컬 공급자 할당량 조회

**요약:** 등록한 AI 도구의 남은 할당량을 보여 주기 위해 xMatrix daemon은 컴퓨터에 있는 해당 도구 자체의 로그인 파일(예: `~/.grok/auth.json`)을 읽고 각 공급자에게 직접 조회합니다. Codex, Claude Code, OpenCode는 예외로, xMatrix는 도구 자체에 묻고 그 로그인 파일은 열지 않습니다. Codex는 실행 중인 세션이나 잠시 실행한 `codex app-server`를 통해, Claude Code는 실행 중인 세션이나 잠시 실행한 `claude`를 통해(프롬프트를 보내지 않는 `get_usage` 요청), OpenCode는 잠시 실행한 `opencode serve`를 통해 묻습니다. 이 파일에서 읽은 내용(토큰, 계정 ID, 파일 내용, 파일 지문)은 xMatrix로 전송되지 않으며, Hub는 정규화된 할당량 결과만 받습니다. 하나의 스위치로 파일 읽기, Codex·Claude Code·OpenCode 요청, 공급자 요청을 모두 중지할 수 있습니다(아래 「로컬 할당량 조회 끄기」 참고). 공식 할당량 인터페이스가 없는 도구(예: Cursor)는 그 컴퓨터에서 허용하기 전까지 전혀 읽지 않습니다(아래 「허용한 경우에만 읽는 도구」 참고). 공식 할당량 인터페이스가 없는 OpenCode 2.2.0 이전 버전도 해당 컴퓨터에서 허용하기 전에는 전혀 읽지 않습니다.

등록된 하네스(Claude Code, Codex, Cursor, Grok, OpenCode, DeepSeek, Z.ai, Antigravity 등)의 남은 구독 할당량을 `xmatrix agent list`와 Agents 화면에 표시하고 `@auto` 라우팅이 한도 초과 계정을 피할 수 있도록, 로컬 데몬이 등록된 도구의 로컬 자격 증명 저장소를 메모리 내에서 읽어 해당 공급자 엔드포인트에 직접 조회할 수 있습니다.

| 하네스 | 로컬 메모리에서만 읽는 위치 | 기기에서 직접 조회하는 공급자 API |
| --- | --- | --- |
| Claude Code | 읽지 않음: Claude Code 자체 `get_usage` 제어 요청(실행 중인 세션 또는 잠시 실행한 `claude`), 프롬프트는 보내지 않음 | Claude Code가 자체 로그인으로 처리 |
| Codex | 읽지 않음: Codex 자체 app-server 메서드 `account/rateLimits/read`(실행 중인 세션 또는 잠시 실행한 `codex app-server`) | Codex가 자체 로그인으로 처리 |
| Cursor(그 컴퓨터에서 허용한 경우에만) | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`, macOS 키체인(`cursor-access-token`), 또는 Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` 또는 `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode 2.2.0 이상 | 읽지 않음: 잠시 실행한 `opencode serve`의 `GET /api/experimental/usage/limits`(루프백에서만 수신, 일회용 비밀번호 사용). OpenCode가 다른 공급자로 라우팅하는 모델은 아무것도 읽지 않음 | OpenCode가 자체 로그인으로 처리 |
| OpenCode 2.2.0 이전(해당 컴퓨터에서 허용한 경우에만) | `OPENCODE_API_KEY` 또는 OpenCode `auth.json`의 `opencode-go` 항목 | `https://opencode.ai/zen/go/v1/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` 또는 `$DSH_HOME` 인증 파일 | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit` (또는 `open.bigmodel.cn`) |
| Antigravity | 원본 `agy -p "/usage" --output-format json` 명령 위임 | `agy` 자체 처리 |

**엄격한 경계:**

- 자격 증명은 로컬 프로세스 메모리에만 머물며 **해당 공급자의 공식 사용량 엔드포인트로만** 전송됩니다.
- 로컬 SHA-256 지문은 계정 전환 감지용 메모리 캐시 키로만 쓰이며 **로그에 남거나 xMatrix로 전송되지 않습니다**.
- xMatrix Hub로 전송되는 값은 정규화된 잔여 할당량(비율, 초기화 시각, 사용 가능 여부, 잔액)뿐입니다.

### 허용한 경우에만 읽는 도구

Cursor에는 할당량을 묻는 공식 방법이 없어, 유일한 방법은 Cursor가 자신을 위해 저장한 로그인 정보를 읽는 것입니다. 그 로그인 정보는 Cursor를 위한 것이므로 xMatrix는 이를 허가로 보지 않습니다. 컴퓨터 소유자가 허용하기 전까지 xMatrix는 그 컴퓨터에서 Cursor의 로그인 정보(macOS 키체인 항목 `cursor-access-token`, Cursor의 `auth.json`, 환경에 이미 설정된 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`)를 전혀 읽지 않으며, Cursor의 할당량은 **알 수 없음**으로 표시됩니다. 할당량 소진은 여전히 Cursor 자체 오류 메시지로 인식합니다.

허용하려면 컴퓨터 소유자가 Agents 또는 Machines 화면에서 Cursor 할당량이 표시되는 곳의 **Allow reading Cursor sign-in to show quota**를 선택하거나, 그 컴퓨터에서 다음을 실행합니다.

```sh
xmatrix config quotaAccess cursor on    # 허용
xmatrix config quotaAccess cursor off   # 중지
xmatrix config quotaAccess              # 이 컴퓨터에서 허용된 도구 보기
```

- 허용은 컴퓨터별·도구별이며 기본값은 꺼짐입니다. 할당량 조회 스위치와는 별개로, `quotaProbes`가 켜져 있어도 허용으로 간주하지 않습니다.
- 로그인 정보는 그 컴퓨터에서만, Cursor에 자신의 사용량을 묻는 데에만 읽습니다. 그 내용은 컴퓨터 밖으로 나가지 않으며, Hub는 Cursor가 알려 준 사용량과 허용 여부만 받습니다.
- 허용은 처음 사용될 때 로그인된 Cursor 계정에 묶이며, 그 지문은 그 컴퓨터의 xMatrix 설정에만 저장되고 전송되지 않습니다. 계정이나 자격 증명이 바뀌면 허용은 무효가 되고 마지막 할당량 수치도 삭제됩니다.
- 같은 곳, **Settings → Legal and privacy → Reading sign-ins for quota**, 또는 `xmatrix config quotaAccess cursor off`로 언제든 중지할 수 있으며, 다음 읽기부터 바로 거부됩니다.
- 로컬 할당량 조회 끄기(아래)가 허용보다 우선합니다. 허용했더라도 아무것도 읽지 않습니다.

OpenCode 2.2.0 이전 버전에도 공식 할당량 인터페이스가 없어 같은 방식으로 처리합니다. 허용하지 않으면 xMatrix는 OpenCode의 `auth.json`도, 이를 위해 설정된 `OPENCODE_API_KEY`도 열지 않고, OpenCode 엔드포인트에 요청하지 않으며, 할당량은 **Unknown**으로 표시됩니다. 허용하면(**Allow reading OpenCode sign-in to show quota** 또는 `xmatrix config quotaAccess opencode on`) xMatrix는 OpenCode가 OpenCode Go용으로 저장한 키만 읽고 `https://opencode.ai/zen/go/v1/usage`에 대한 한 번의 요청에만 사용합니다. 만료된 로그인을 OpenCode 대신 갱신하지 않으며, OpenCode에 다시 로그인할 때까지 할당량은 알 수 없음(만료됨)으로 표시됩니다. 위의 계정 연결, 철회, 전체 스위치는 그대로 적용됩니다. OpenCode 2.2.0부터는 xMatrix가 `opencode serve`에 묻고, 허용 여부와 관계없이 OpenCode 자격 증명을 읽지 않습니다.

### 로컬 할당량 조회 끄기

데스크톱 앱의 **Settings → Legal and privacy → Local provider quota probes** 또는 아래 명령/환경 변수로 끌 수 있습니다:

```sh
xmatrix config quotaProbes off
# 또는 환경 변수 설정(우선 적용)
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Antigravity만 끄려면 `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`을 설정하세요. 비활성화하면 모든 경로에서 로컬 자격 증명 저장소를 읽거나, `codex app-server`, `claude`, `opencode serve`를 실행하거나 Codex·Claude Code 세션에 묻거나, 공급자 API를 호출하지 않습니다.

## 클라이언트 진단 및 오류 보고

xMatrix는 광고 쿠키, 크로스사이트 추적, 세션 리플레이, PostHog·Google Analytics·Cloudflare Web Analytics 같은 서드파티 행동 분석 SDK를 사용하지 않습니다.

선택적 클라이언트 진단과 브라우저 오류 보고는 **안정 버전 앱과 CLI에서 기본적으로 꺼져 있습니다**. 베타 버전의 기본값은 아래 표와 같습니다. 로그인하지 않은 마케팅, 문서, 법적 문서 페이지는 Sentry를 불러오지 않습니다. 진단이 켜져 있을 때 보내는 내용:

- **오류 및 충돌 보고(Sentry)**: 로그인된 앱에서만 오류의 클래스, 오류 자체의 코드(있는 경우), 스택의 코드 위치만 전송합니다. 오류 메시지, 브레드크럼, URL, 쿠키, HTTP 헤더, 요청 본문, 사용자 정보는 전송하지 않습니다. DSN이 없는 로컬/셀프호스트 빌드에서는 전송하지 않습니다. (Hub 서버 측 오류는 호스팅 서비스 운영을 위해 서버 측에서 보고됩니다. 아래 참조.)
- **퍼스트파티 진단(xMatrix Hub → Cloudflare Analytics Engine)**: 시작 시간(`/api/observable/startup-timing`), 온보딩 단계 수(`/api/observable/onboarding-step`), 데스크톱 데몬 시작 실패 정보(`/api/observable/desktop-daemon-failure`), CLI 재연결 샘플(`/api/observable/client-metrics`)을 전송합니다. 식별자는 서버 키 기반 HMAC-SHA-256으로 가명화됩니다.

### 진단 이벤트에 담길 수 있는 것

모든 진단 이벤트에는 선언된 필드가 있으며, 클라이언트가 만들 때 한 번, Hub가 받을 때 다시 한 번 검사합니다. 필드에는 목록의 고정 값, 숫자, true/false, 버전, 불투명 식별자, 또는 `websocket_connect_failed` 같은 짧은 코드(소문자, 숫자, `_`, `-`)만 담을 수 있습니다. 선언되지 않은 필드나 범위를 벗어난 값이 하나라도 있으면 이벤트 전체가 거부되며 잘라서 통과시키지 않습니다. 따라서 사용자가 쓴 글이 실려 갈 필드가 없습니다. 오류는 클래스와 코드로만 보고하며 메시지는 포함하지 않습니다.

글을 담는 경로는 다음 두 가지뿐입니다:

- **데스크톱 시작 실패 카드의 「실패 보고서 보내기」**: CLI의 마지막 몇 줄로, 데스크톱 앱이 사용자의 기기에서 먼저 마스킹합니다(홈 디렉터리, 이메일 주소, URL 쿼리, 토큰이나 키처럼 보이는 문자열을 대체). 카드는 보내기 전에 이 내용을 보여 주며 버튼을 눌렀을 때만 전송합니다. 진단이 켜져 있을 때의 자동 보고에는 실패 단계, 종료 코드, 플랫폼, 앱 버전만 담깁니다.
- **Hub 서버 측 오류 보고**: 서버 자체의 오류 메시지로, 인용된 값, 이메일 주소, URL 쿼리, 홈 디렉터리 경로, 토큰처럼 보이는 문자열은 제거됩니다. 로그에 덧붙은 항목은 숫자, true/false, 불투명 식별자일 때만 보고됩니다.

### 베타와 안정 버전의 기본값

| | 안정 버전 앱과 CLI | 베타 버전 앱과 CLI |
| --- | --- | --- |
| 직접 켬 | 보냄 | 보냄 |
| 직접 끔, 또는 Do Not Track, Global Privacy Control, `XMATRIX_TELEMETRY=0` | 보내지 않음 | 보내지 않음 |
| 선택 없음. 가입 국가**와** 현재 국가가 모두 EU, EEA, 영국, 스위스 밖 | 보내지 않음 | 보냄(끄는 링크가 있는 한 줄 안내 표시) |
| 선택 없음. 어느 한 국가가 EU, EEA, 영국, 스위스이거나 알 수 없음 | 보내지 않음 | 보내지 않음. 체크되지 않은 「Send diagnostics to help improve the beta」 상자 표시 |

행은 위에서부터 순서대로 적용됩니다. 직접 켠 경우에는 Do Not Track이나 Global Privacy Control이 켜져 있어도 존중됩니다. 그 상자를 체크하거나 설정의 스위치를 바꾸는 것(또는 `xmatrix config telemetry on|off`)만 선택으로 봅니다. 안내를 닫는 것은 선택이 아니며, xMatrix가 설정을 대신 바꾸지 않습니다.

**지역 판단 방법.** 클라이언트에는 믿을 만한 위치 정보가 없으므로(시간대와 언어는 사용자 설정) Hub가 알려 줍니다:

- **가입 지역.** 계정을 만들 때 Hub는 Cloudflare가 알려 주는 그 요청의 국가로부터 사전 동의가 필요한 국가인지 여부만 기록합니다. 국가나 IP 주소는 저장하지 않으며 이후 요청으로 바뀌지 않습니다. 기존 계정은 처음 베타를 사용할 때 기록됩니다. 계정을 삭제하면 함께 삭제됩니다.
- **현재 지역.** 보낼 때마다 클라이언트는 현재 연결에 대해 Hub가 준 10분 이내의 답을 사용합니다. 더 오래되었으면 진단 데이터가 없는 작은 요청으로 Hub에 다시 묻습니다. 조회가 실패하거나 시간 초과되거나 국가를 알 수 없으면 보내지 않습니다. 따라서 동의가 필요한 국가로 이동하면 기본 전송은 10분 안에 멈춥니다.

### 진단 및 오류 보고 켜기/끄기

- **웹, 데스크톱, iOS, Android**: **Settings → Legal and privacy**에서 **Send diagnostics and crash reports**를 전환합니다. 선택은 계정에 저장되어 모든 클라이언트가 따릅니다. 데스크톱에서는 이 스위치가 로컬 daemon의 `telemetry` 설정도 바꿉니다.
- **CLI와 daemon**: `xmatrix config telemetry on` 또는 `XMATRIX_TELEMETRY=1`로 켜고, `xmatrix config telemetry off`, `XMATRIX_TELEMETRY=0`, `DO_NOT_TRACK=1`로 끕니다. `xmatrix config telemetry on|off`는 선택을 계정에도 저장합니다.

## 대화를 xMatrix 지원팀에 넘기기

xMatrix 직원과 Agent는 사용자가 대화를 지원팀에 넘겼을 때만 그 대화를 읽습니다. 제품 분석에는 메타데이터만 쓰며, 사용자가 쓴 내용은 쓰지 않습니다.

도움이 필요하면 대화 메뉴, xMatrix가 올리는 장애 알림(시작 실패, 반복되는 실패, 몇 분째 진행 없음), 또는 대화가 열린 상태에서 **Help → Report an issue**에서 **Hand to xMatrix support**를 고릅니다. 그런 다음:

- 무엇이 잘못됐는지 한 줄로 씁니다.
- 포함할 항목을 체크합니다. 처음에는 아무것도 체크되어 있지 않습니다:
  - **This conversation's messages**(스레드 포함).
  - **Diagnostics for this conversation**: Agent가 여기서 언제 시작·중지·실패했는지와 그 실패 코드. 상태, 코드, 횟수, 시각만 담은 진단 이벤트이며 메시지 본문, 프롬프트, 오류 메시지, ID는 없습니다.
  - **Daemon logs**: 온라인 상태인 내 머신 중 하나에서 xMatrix 데몬이 최근에 남긴 로그의 끝부분. 홈 폴더 경로, 이메일 주소, 웹 주소의 쿼리 부분, 토큰이나 키처럼 보이는 문자열은 머신을 떠나기 전에 그 머신에서 제거되며, 보내기 전에 대화 상자에서 보낼 내용을 그대로 확인할 수 있습니다. 미리보기는 약 일주일 동안 본인만 읽을 수 있고, 보낸 로그는 넘긴 것을 철회하는 즉시 삭제됩니다.
- **I agree to let xMatrix support read what I selected**를 체크합니다. 체크하기 전에는 아무것도 보내지 않습니다.

넘기면 허용되는 것:

- **누가 읽나요:** xMatrix 지원팀, 즉 xMatrix 팀과 지원 Agent가 이 요청을 위해 열린 지원 대화에서 처리합니다.
- **읽기 전용:** 지원팀은 체크한 내용을 사용자에게 보이는 그대로 읽을 뿐, 사용자의 대화에 쓰거나 반응하거나 무언가를 시작할 수 없습니다. 지원팀의 답은 "xMatrix support"가 보낸 메시지로 대화에 오거나 이메일로 옵니다.
- **기간:** 14일. 사용자 본인 또는 스페이스의 소유자나 관리자는 대화에 남는 안내의 **Withdraw now**로 언제든 철회할 수 있습니다. 철회되거나 만료되면 읽기가 즉시 멈춥니다.
- **읽을 때마다 알 수 있습니다:** 지원팀이 한 시간 안에 처음 읽으면 대화에 "xMatrix support read this conversation"과 시각이 표시됩니다. 그 한 시간 안에 다시 읽을 때마다 같은 표시가 업데이트되어 읽은 횟수와 마지막으로 읽은 시각을 보여 줍니다(예: "xMatrix support read this conversation 3 times (latest 14:05 UTC)"). 다음 한 시간에는 새 표시가 생깁니다.
- 대화를 넘길 수 있는 사람은 그 대화를 시작한 사람, 또는 해당 스페이스의 소유자나 관리자뿐입니다.

## 법적 문서

- [개인정보처리방침 (EN)](/privacy)
- [쿠키 및 로컬 저장소 안내 (EN)](/cookies)
- [하위 처리자 목록 (EN)](/subprocessors)
- [이용약관 (EN)](/terms)
