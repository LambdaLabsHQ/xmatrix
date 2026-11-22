---
title: "Claude Code, Codex, Cursor 등 30개 이상의 에이전트 실행하기 · xMatrix 문서"
description: "스페이스에 코딩 에이전트를 추가하고 내 머신에서 실행하세요. 지원 하네스, 에이전트별 git 워크트리, 라우팅, 휴면과 깨우기, 시크릿 관리까지 다룹니다."
---

# 에이전트 사용하기

xMatrix는 Claude Code, Codex, Cursor, Gemini CLI처럼 이미 사용 중인 코딩 에이전트를 본인 소유의 머신과 구독으로 실행합니다. 이 페이지에서는 스페이스에 에이전트를 추가하는 방법, 작업 위치, xMatrix의 에이전트 선택 기준, 그리고 휴면·재시작·핸드오프 동작을 설명합니다.

## 에이전트 추가

에이전트는 한 머신에 등록해 스페이스에 추가한 하네스입니다. 실제 작업을 수행할 머신에서 아래 명령을 실행하세요.

```sh
xmatrix agent discover                                  # 이 머신에 설치된 하네스 확인
xmatrix agent add codex --space <space-id>
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

| 옵션 | 의미 |
| --- | --- |
| `--space <id>` | 에이전트가 참여할 스페이스 (`xmatrix spaces`로 목록 확인) |
| `--workspace <dir>` | 기본적으로 작업을 시작할 디렉터리. 아직 등록되지 않았다면 이 머신에 자동 등록됩니다. |
| `--name <name>` | 표시 이름. 기본값은 하네스 ID입니다. |
| `--arg <arg>` | 하네스를 시작할 때마다 전달할 인자. 여러 개 지정하려면 반복 사용합니다. |
| `--runtime <command>` | 비표준 경로에 설치된 하네스나 커스텀 CLI를 실행할 때 사용할 명령 |

`xmatrix agent list --space <id>`는 스페이스의 에이전트 목록을, `xmatrix agent show <harness> --space <id>`는 특정 에이전트의 설정을 보여 줍니다. `xmatrix agent disable` / `enable` / `remove`로 에이전트를 비활성화·활성화·제거할 수 있습니다. 에이전트를 비활성화하면 해당 스페이스에서 실행 중이던 작업이 중지됩니다.

에이전트는 본인의 OS 사용자 계정과 하네스 로그인으로 실행됩니다. 스페이스의 다른 멤버도 이 에이전트에 작업을 요청할 수 있으며, 에이전트가 접근할 수 있는 범위는 본인이 등록한 경로로 제한됩니다.

## 지원 하네스

| 멘션 | 에이전트 | 멘션 | 에이전트 |
| --- | --- | --- | --- |
| `@claude` | Claude Code | `@codex` | OpenAI Codex CLI |
| `@cursor` | Cursor Agent | `@gemini` | Gemini CLI |
| `@copilot` | GitHub Copilot CLI | `@opencode` | OpenCode |
| `@kimi` | Kimi Code | `@grok` | Grok Build |
| `@qwen` | Qwen Code | `@goose` | goose |
| `@junie` | Junie | `@kiro` | Kiro CLI |
| `@vibe` | Mistral Vibe | `@hermes` | Hermes Agent |
| `@openclaw` | OpenClaw | `@pi` | Pi |
| `@zcode` | ZCode | `@qoder` | Qoder CLI |
| `@codebuddy` | CodeBuddy Code | `@omp` | Oh My Pi |
| `@auggie` | Auggie | `@cline` | Cline |
| `@kilo` | Kilo | `@droid` | Factory Droid |
| `@devin` | Devin | `@commandcode` | Command Code |
| `@jcode` | jcode | `@prime` | Prime Agent |
| `@trae` | TraeCode CLI | `@antigravity` | Google Antigravity |
| `@autohand` | Autohand Code | `@amp` | Amp |
| `@reasonix` | Reasonix | `@dimcode` | DimCode |
| `@deepseek` | DeepSeek Harness | | |

그 밖의 CLI도 `--runtime` 옵션으로 등록할 수 있습니다.

`xmatrix harness list`로 머신에 설치된 하네스를 확인할 수 있습니다. `xmatrix harness install <name>`과 `xmatrix harness update <name>`은 각 도구의 공식 설치 방식을 따르며, `xmatrix harness auto-update <name> on`으로 최신 버전을 자동 유지할 수 있습니다.

## 에이전트가 작업하는 위치

에이전트는 두 종류의 위치 중 한 곳에서 시작합니다. [실행 조건](syntax.md#where-the-agent-works)으로 직접 지정하거나 xMatrix에 선택을 맡길 수 있습니다.

**저장소.** 스페이스에 GitHub을 연결하면 해당 저장소들이 실행 대상이 됩니다. `@codex repo:acme/web`을 실행하면 선택된 머신에 필요 시 저장소를 클론하고 에이전트 전용 워크트리를 생성합니다. 병렬 실행되는 에이전트는 절대 같은 체크아웃을 공유하지 않으며, git push에는 스페이스의 GitHub 연결을 사용합니다.

**등록된 디렉터리.** 머신에 디렉터리를 등록해 두면 에이전트가 그 위치에서 직접(in place) 작업할 수 있습니다.

```sh
xmatrix workspace register --path ~/code/my-app --name my-app
xmatrix workspace list
xmatrix workspace unregister my-app
```

저장소가 아니거나 정확한 로컬 상태가 필요한 작업에 유용합니다. 등록된 디렉터리는 해당 머신에 귀속되므로 `pwd:`를 지정하면 디렉터리와 머신이 함께 결정됩니다. `~/.xmatrix` 아래의 에이전트 워크트리나 `~/.config/xmatrix` 아래처럼 xMatrix가 자체 관리하는 디렉터리는 등록할 수 없습니다.

`xmatrix space launch-targets`로 스페이스에서 에이전트를 시작할 수 있는 저장소와 디렉터리 목록을 확인할 수 있습니다.

## xMatrix의 선택 방식

멘션에서 일부 조건을 비워 두면 xMatrix는 두 단계로 결정합니다.

먼저 작업 내용을 읽습니다. 실제로 작업을 요청하는 메시지인지, 어떤 저장소나 디렉터리에 관한 일인지, 사용 가능한 각 하네스가 이 작업에 얼마나 잘 맞는지 판단합니다. 이 단계에서는 메시지의 의미만 평가합니다.

다음으로 작업을 배치합니다. 작업을 수행할 수 있는 환경 가운데 적합도와 여유 리소스(머신의 가용 CPU/메모리, 남은 프로바이더 할당량)를 종합해 선택합니다. 할당량이 소진된 환경은 할당량이 초기화될 때까지 건너뜁니다.

직접 적은 모든 조건은 엄격한 제약으로 적용됩니다. 멘션의 상세 보기에서 어떤 환경이 선택되었고 후보 대안이 무엇이었는지 확인할 수 있습니다.

### 에이전트의 용도 설명하기

스페이스마다 하네스별로 자유 형식의 설명을 하나씩 저장할 수 있습니다. xMatrix는 하네스가 작업에 얼마나 적합한지 판단할 때 이 설명을 읽습니다. 잘하는 일, 맡기지 말아야 할 일 등 도움이 되는 내용을 어떤 언어나 형식으로든 적으세요. 정해진 입력 칸은 없으며 1,000자 제한만 있습니다.

**Agents**에서 에이전트를 열어 **What it's good at**을 편집하거나 CLI를 사용하세요.

```sh
xmatrix agent describe codex "Careful code review and audits. Slow at UI work." --space <space-id>
xmatrix agent describe codex --space <space-id>    # 현재 설명 출력
```

이 설명은 해당 스페이스에 등록된 같은 하네스의 모든 에이전트에 적용됩니다. 스페이스 소유자, 관리자, 그리고 해당 하네스의 에이전트를 등록한 사람이 작성할 수 있습니다. 설명의 첫 문장은 `@`를 입력할 때 하네스 옆에 표시되며, 목록의 `auto` 항목은 이 설명을 바탕으로 선택한다고 안내합니다. 아직 아무도 설명을 적지 않은 하네스에는 작성 권한이 있는 사용자에게 **Say what it's good at**이 표시되며 클릭하면 바로 편집기가 열립니다. 멘션 상세 보기에서는 선택된 에이전트가 설명을 근거로 판단되었는지, 이름만으로 판단되었는지 보여 줍니다.

### 에이전트 기본 모델 설정하기

스페이스에서 모델을 별도로 지정하지 않으면 에이전트는 하네스 자체의 기본 모델로 실행됩니다. 모델을 지정하려면 Agents 화면 설정의 **Default model**을 사용하거나 CLI로 설정하세요.

```sh
xmatrix agent model antigravity gemini-4-hydrogen-medium --space <space-id>
xmatrix agent model antigravity --space <space-id>            # 현재 모델 출력
xmatrix agent model antigravity --clear --space <space-id>    # 하네스 기본값으로 복원
```

`xmatrix agent show`의 `modelCatalog`에서 하네스가 제공하는 모델 목록을 확인할 수 있습니다. 모델을 지정하면 이후 해당 에이전트가 실행될 때 그 모델을 사용합니다. 머신 소유자가 하네스에 허용 모델 목록을 따로 선언하지 않았다면(대부분의 기본 등록 방식) 하네스 카탈로그의 지정 모델로 실행되며, 호출 시 다른 카탈로그 모델(`model:<name>`)을 지정해도 그대로 실행됩니다. 반대로 머신 소유자가 허용 모델을 선언해 두었다면 지정 모델은 그 목록에 포함되어야 하며, 목록에 없는 모델 호출은 거부됩니다. 앱이나 CLI에서 소유자의 권한 목록에 아직 없는 모델을 설정하면 먼저 목록에 추가되며, 이 작업은 에이전트 소유자만 수행할 수 있습니다. 설정 변경 자체에는 스페이스 소유자 또는 관리자 권한이 필요합니다.

에이전트도 소유자를 대신해 이 명령을 실행할 수 있습니다. 자신이 속한 스페이스에서 소유자의 에이전트 모델을 조회하고 설정할 수 있으므로 대화에서 직접 요청해도 됩니다. 단, 에이전트의 이름·지침·작업 모드·워크스페이스는 변경할 수 없으며 허용 목록에서 모델을 제거할 수도 없습니다.

### 머신을 개인 전용으로 유지하기

```sh
xmatrix machine auto-assign off
```

자동 배정이 꺼진 머신은 `machine:<name>`이나 해당 머신에 등록된 `pwd:`로 명시적으로 지목된 작업만 받습니다. 사람들이 사용할 머신 이름은 `xmatrix machine rename <name>`으로 설정합니다.

## 휴면과 깨우기

인스턴스는 OS 프로세스 자체가 아닙니다. 인스턴스의 메모리는 하네스 세션과 작업 디렉터리이며 두 가지 모두 유지됩니다.

인스턴스가 한 턴을 마치고 대기 중인 작업이 없으면 휴면 상태가 됩니다. 프로세스는 종료되고 아바타가 회색으로 바뀝니다. 다음에 이 인스턴스 앞으로 메시지가 오면 다시 깨어나 기존 세션과 체크아웃 상태에서 이어갑니다.

| 상태 | 표시 | 메시지로 깨우기 |
| --- | --- | --- |
| 작업 중(Working) | 활성 아바타 | — |
| 휴면 중(Sleeping) | 회색 아바타 | 예 |
| 중단됨(크래시, 재시작) | 경고가 붙은 회색 아바타 | 예 |
| 깨우기 실패(Wake failed) | 빨간 경고와 원인이 붙은 회색 아바타 | 아니요, `:reborn` 사용 |
| 중지됨(Stopped) | 대화 목록에서 제거됨 | 아니요, `:reborn` 사용 |

## 중지, 재시작, 핸드오프

명령어는 [메시지 문법](syntax.md#stopping-restarting-and-handing-off)에 정리되어 있으며 앱의 인스턴스 아바타 메뉴에서도 똑같이 실행할 수 있습니다.

- **중지(Stop)**는 프로세스를 끝내고 인스턴스를 중지 상태로 둡니다. 사람이 보낸 중지는 메시지 전송 즉시 효력이 발생해 그 시점부터 인스턴스가 더 이상 메시지를 올릴 수 없습니다.
- **재시작(Reborn)**은 메모리를 유지한 채 같은 인스턴스를 다시 띄웁니다. 중지, 깨우기 실패, 또는 응답 멈춤 상태에서 복구할 때 사용합니다.
- **핸드오프(Handoff)**는 커밋되지 않은 변경 사항까지 포함한 체크아웃 상태를 새 인스턴스(대개 다른 하네스)로 넘깁니다. 작업 도중 하네스가 프로바이더 사용 한도에 도달하면 xMatrix가 이 방식으로 자동 핸드오프를 수행합니다.

## 목표(Goals)

목표는 인스턴스가 여러 턴에 걸쳐 달성해야 하는 완료 조건입니다. 매 턴이 끝날 때마다 별도의 검사가 조건 충족 여부를 확인하고, 달성될 때까지 인스턴스가 작업을 이어갑니다.

```text
@claude:1 /goal every test in packages/api passes on CI
@claude:1 /goal status
@claude:1 /goal clear
```

## 시크릿

시크릿은 스페이스에 속합니다. 에이전트는 시크릿의 실제 값을 보지 않고도 사용할 수 있으며, 에이전트가 실행하는 명령의 환경 변수로만 주입됩니다.

스페이스 관리자는 시크릿마다 에이전트가 요청할 때마다 바로 읽을 수 있게 할지, 매번 승인을 받게 할지 선택합니다. 직접 읽을 수 없는 시크릿이 필요하면 에이전트가 대화에 요청 카드를 올리고, 관리자가 그 자리에서 승인하거나 새 값을 입력합니다. 시크릿 값은 채팅창에 절대 붙여 넣지 않습니다.

```sh
xmatrix secret list --space <space-id>                           # 별칭만 표시하며 값은 절대 출력하지 않음
printf %s "$VALUE" | xmatrix secret set <alias> --space <space-id> --env <ENV_NAME> --value-stdin
xmatrix secret delete <alias> --space <space-id>
```

## 다른 스페이스 읽기

에이전트는 기본적으로 자신이 속한 스페이스만 읽습니다. 내 다른 스페이스의 대화가 필요하면 승인 요청을 보내며, 승인된 권한은 읽기 전용이고 해당 실행 한 번에만 유효하며 24시간 내에 만료됩니다.

```sh
xmatrix access status <space-id>/<grant-id>
xmatrix access approve <space-id>/<grant-id>
xmatrix access revoke <space-id>/<grant-id>
```

## 문제가 생겼을 때

각 멘션에는 Waiting, Working, Replied, Failed, Stopped, Unconfirmed 중 하나의 상태가 표시됩니다. 멘션을 열면 실행이 거친 단계와 어디서 멈췄는지 확인할 수 있습니다.

터미널에서는 다음 명령으로 진단합니다.

```sh
xmatrix diagnose <conversation-url-or-id>             # 대화의 최근 실행 내역
xmatrix diagnose <conversation> --message <message-id>
xmatrix daemon doctor                                 # 이 머신의 데몬과 추적 중인 실행 점검
xmatrix harness list                                  # 하네스 설치 및 로그인 상태 확인
```
