---
title: "AI 코딩 에이전트 @멘션 문법 · xMatrix 문서"
description: "xMatrix 메시지 전체 레퍼런스: @멘션으로 Claude Code나 Codex를 시작하고, 저장소·모델·추론 강도를 선택하며, 에이전트를 중지·재시작·핸드오프하는 방법."
---

# 메시지 문법

xMatrix에 요청하는 모든 작업은 일반 메시지입니다. 숨겨진 입력 폼이 따로 없으며, 입력한 텍스트가 그대로 저장되고 서버도 화면에 보이는 것과 똑같은 텍스트를 읽습니다. 입력창에서 `@`, `#`, `[[`를 입력하면 자동 완성되므로 문법을 외울 필요는 거의 없습니다. 이 페이지는 전체 레퍼런스입니다.

## 한눈에 보기

| 입력 | 동작 |
| --- | --- |
| `@claude fix the failing test` | 새 Claude 인스턴스를 시작하고 메시지 전달 |
| `@auto repo:acme/api fix the failing test` | xMatrix가 에이전트를 선택해 `acme/api` 워크트리에서 실행 |
| `@codex pwd:"/Users/me/my app" …` | 등록된 디렉터리에서 직접(in place) 실행 |
| `@codex model:<id> effort:high …` | 특정 모델과 추론 강도로 실행 |
| `@claude:2 also update the changelog` | 이 대화의 2번 Claude 인스턴스와 작업 이어가기 |
| `@claude:2 /model <id>` | 실행 중인 인스턴스의 모델 전환 |
| `@claude:2:stop` | 해당 인스턴스 중지 |
| `@claude:2:reborn` | 메모리를 유지한 채 인스턴스 재시작 |
| `@claude:2:handoff:@codex finish the migration` | 체크아웃 상태를 새 Codex 인스턴스로 넘기기 |
| `/stop all` | 대화의 모든 인스턴스 중지 |
| `@Maya` · `@everyone` | 특정 사람 또는 대화의 모든 멤버에게 알림 |
| `@github:subscribe:acme/web pulls checks` | 연결된 앱의 작업 실행 |
| `page:<id>` · `channel:<id>` | 페이지 또는 대화 참조 |

## 멘션

멘션은 `@` 뒤에 이름을 붙인 형태입니다. 메시지 맨 앞이거나 공백, 여는 괄호 바로 뒤에 올 때 멘션으로 인식됩니다. 전각 `＠`도 `@`와 동일하게 동작합니다.

이름은 대소문자를 구분하지 않으며 가장 길게 일치하는 이름이 우선하므로 `@codex-mba`가 `@codex`로 잘못 읽히는 일은 없습니다.

에이전트를 시작하거나 명령하는 멘션은 독립된 단어여야 합니다. 뒤에 공백, 줄바꿈 또는 닫는 문장부호를 두세요. 사람에게 알림만 보내는 멘션은 `@Maya的方案`처럼 중국어나 일본어 텍스트에 바로 붙일 수 있습니다.

### 멘션으로 인식되지 않는 경우

다음 영역 안에 들어 있는 멘션은 일반 텍스트로 처리되어 누구에게도 알림을 보내지 않고 아무것도 실행하지 않습니다.

- 인라인 코드 및 코드 블록
- 인용문(block quote)
- 링크 및 이미지
- 취소선 텍스트

문법을 트리거하지 않고 예시를 작성하려면 백틱으로 감싸면 됩니다.

### 사람

`@`를 입력하고 사람을 선택하세요. 멘션에는 표시 이름(`@Maya Chen`) 또는 핸들이 사용됩니다. 멘션된 사람에게 알림이 전송되며 메시지를 읽으면 알림이 해제됩니다.

`@everyone`, `@channel`, `@all`, `@here`는 대화의 모든 멤버에게 알림을 보냅니다.

두 사람의 이름이 같거나 사람 이름이 에이전트 이름과 겹치면 핸들로 선택할 때까지 메시지가 거부됩니다.

## 에이전트 시작하기

하네스 이름을 멘션하면 대화에 해당 에이전트의 **새** 인스턴스가 시작됩니다.

```text
@claude rework the hero so it shows the product
@codex check the mobile breakpoints
@auto find out why billing webhooks retry twice
```

- `@<harness>`는 해당 하네스를 요청합니다(`@claude`, `@codex`, `@cursor`, `@gemini` 등). [지원 하네스](agents.md#supported-harnesses)를 참고하세요.
- `@auto`는 xMatrix가 선택하도록 맡깁니다. 작업 내용을 읽고 가장 적합한 하네스와 여유 리소스가 가장 많은 머신을 고릅니다.

메시지의 나머지 부분이 작업 내용입니다. 에이전트는 앞선 대화 맥락도 함께 받으므로 위에서 논의한 내용이 충분하다면 `@claude take this one`처럼 짧게 지시해도 됩니다.

### 실행 조건

실행 조건은 에이전트가 어디서 어떻게 시작할지를 좁혀 줍니다. 멘션 바로 뒤에 공백으로 구분해 `key:value` 형태로 적습니다.

```text
@auto repo:acme/api model:<id> effort:high find out why webhooks retry twice
```

여기서 `@auto`가 멘션이고, 뒤따르는 세 단어가 실행 조건이며, `find`부터 끝까지가 작업 내용입니다.

| 조건 | 의미 |
| --- | --- |
| `repo:<owner/repo>` | 이 저장소의 새 관리형 워크트리에서 작업 |
| `pwd:"<absolute path>"` | 등록된 이 디렉터리에서 직접(in place) 작업 |
| `machine:<name>` | 소유자가 붙인 이름의 머신에서 실행 (`xmatrix agent list`로 이름 확인) |
| `harness:<name>` | `@auto`와 함께 사용해 선택 대상을 특정 하네스로 제한 |
| `model:<id>` | 지정한 모델 사용 |
| `effort:<level>` | 지정한 추론 강도 사용 |
| `fast:on` | 하네스가 빠른 모드를 지원할 경우 활성화 |
| `param.<id>:<value>` | 하네스가 제공하는 기타 옵션 설정 |

규칙은 다음과 같습니다.

- **조건이 아닌 첫 단어에서 조건 파싱이 끝납니다.** 그 단어부터는 모두 작업 내용으로 취급됩니다. 따라서 알 수 없는 `key:value`는 오류가 아니라 일반 텍스트입니다.
- **순서는 상관없으며** 각 조건은 최대 한 번만 적을 수 있습니다.
- **조건은 멘션과 같은 줄에 있어야 합니다.** 줄바꿈이 나오면 조건이 끝납니다.
- **공백이 포함된 값은 큰따옴표로 감싸세요.** 값 안의 리터럴 큰따옴표는 두 번 겹쳐 씁니다(`pwd:"/Users/me/my ""old"" app"`).
- **충족할 수 없는 조건이 있으면 실행이 중단됩니다.** xMatrix는 다른 모델이나 머신으로 임의 대체하지 않으며, 멘션에 시작되지 않은 이유를 표시합니다.

### 에이전트가 작업하는 위치

`repo:`와 `pwd:`는 둘 중 하나만 선택해 사용합니다.

**`repo:`**는 저장소를 지정합니다. 에이전트는 독립된 워크트리를 받으므로 여러 에이전트가 같은 저장소에서 동시에 작업해도 서로 덮어쓰지 않습니다. GitHub 저장소는 `owner/repo`로 적습니다. 전체 HTTPS 또는 SSH 리모트 주소도 지원하며, GitHub 리모트는 자동으로 `owner/repo`로 축약됩니다. 자격 증명, 쿼리 문자열, 프래그먼트가 포함된 참조는 허용되지 않습니다.

```text
@codex repo:acme/web …
@codex repo:https://gitlab.example.com/team/service …
```

**`pwd:`**는 `xmatrix workspace register`로 머신에 등록해 둔 디렉터리를 지정합니다. 에이전트는 현재 체크아웃된 상태 그대로 그 위치에서 작업합니다. 절대 경로여야 하며, 해당 디렉터리가 있는 머신이 자동으로 선택됩니다.

```text
@claude pwd:/srv/app …
@claude pwd:"C:\Users\me\my app" …
```

둘 다 지정하지 않으면 xMatrix가 스페이스의 저장소 및 디렉터리 이름과 설명을 작업 내용과 대조해 선택합니다. 대화 맥락만으로 저장소가 명확하지 않을 때는 직접 지정하세요.

### 모델, 추론 강도 및 기타 옵션

`model:`과 `effort:`에는 하네스가 보고하는 ID를 사용합니다. 입력창에서 하네스를 선택하면 목록이 표시되며 [에이전트 화면](agents.md)에서도 볼 수 있습니다.

모델과 추론 강도 외의 옵션은 하네스마다 다르므로 고정 키워드가 없습니다. 각 하네스가 제공하는 옵션을 `param.<id>:<value>`로 지정합니다.

```text
@kimi param.<id>:<value> summarize the incident
@codex fast:on apply the rename
```

입력창에는 하네스가 현재 제공하는 옵션 ID와 값이 표시됩니다. `fast:on`은 `param.fast:on`의 축약형입니다. 스위치형 옵션은 `on`, `off`, `true`, `false`를 받습니다.

### 누가 에이전트를 시작하는가

xMatrix 입력창에서 메시지를 보내면 호출한 에이전트가 바로 시작됩니다. 반면 에이전트가 보낸 메시지는 `xmatrix send --launch`로 전송한 경우에만 다른 에이전트를 시작합니다. 이 플래그가 없으면 보고서 안의 `@codex`는 단순 멘션일 뿐이므로 에이전트가 실수로 서로를 호출하는 일은 없습니다. 중지, 재시작, 핸드오프는 어느 쪽에서 보내든 동일하게 작동합니다.

에이전트를 시작하지 못한 멘션에는 그 상태가 표시되며, 작성자는 해당 멘션에서 직접 시작할 수 있습니다. 메시지 텍스트만으로는 에이전트가 시작되지 않습니다. 폐기된 `launch:force` 조건은 무시되므로 에이전트가 보고서에 이를 적어 다른 에이전트를 강제 실행할 수 없습니다.

### 새 대화의 첫 메시지

새 대화의 첫 메시지에 아무 멘션도 없으면 몇 초 동안 어떤 에이전트가 맡을지(또는 아무도 맡지 않을지) 고를 수 있습니다. 선택하지 않으면 xMatrix가 메시지를 읽고 작업을 요청하는 내용일 때만 에이전트를 시작합니다.

이후 메시지에서 아무도 멘션하지 않으면 새 에이전트는 시작되지 않습니다. 이미 대화에 참여 중인 인스턴스들은 이를 맥락으로 받아 스스로 응답 여부를 결정합니다.

## 인스턴스와 대화하기

각 인스턴스에는 대화별 번호가 붙어 이름 옆에 표시됩니다(`claude:1`, `codex:2`). `@<name>:<number>`로 호출하세요.

```text
@claude:1 the tests still fail on Windows, take another look
```

메시지는 정확히 그 인스턴스로 전달됩니다. 휴면 상태라면 메시지가 인스턴스를 깨웁니다. 번호는 해당 대화에 속하므로 이곳의 `claude:1`과 다른 대화의 `claude:1`은 서로 다른 인스턴스입니다.

인스턴스의 메시지에 답장하면 멘션 없이도 해당 인스턴스로 전달됩니다.

대화에 있는 다른 인스턴스들은 이 메시지를 맥락으로만 참고하며, 다른 대상에게 보낸 메시지에는 행동하지 않습니다.

## 실행 중인 인스턴스 명령어

특정 인스턴스를 지정한 뒤 `/`로 이어지는 메시지는 작업 요청이 아니라 해당 인스턴스에 대한 제어 명령입니다.

| 명령 | 동작 |
| --- | --- |
| `@claude:1 /model` | 이 인스턴스가 사용할 수 있는 모델 목록 표시 |
| `@claude:1 /model <id>` | 모델 전환 |
| `@claude:1 /effort` | 제공하는 추론 강도 목록 표시 |
| `@claude:1 /effort <level>` | 추론 강도 전환 (`/reasoning`도 동일한 명령) |
| `@claude:1 /config <id>` | 하네스가 제공하는 옵션의 선택지와 현재 값 표시 |
| `@claude:1 /config <id> <value>` | 옵션 값 설정 |
| `@claude:1 /fast on` · `off` · `status` | 빠른 모드 설정. `/fast`만 입력하면 토글 |
| `@claude:1 /goal <condition>` | 여러 턴에 걸쳐 달성할 완료 조건 부여 |
| `@claude:1 /goal status` · `pause` · `resume` · `clear` | 목표 상태 확인 및 제어 |

설정 전환은 실행 중인 세션에 즉시 적용됩니다. 인스턴스의 메모리와 체크아웃은 그대로 유지되며 재시작할 필요가 없습니다.

`/model`과 `/effort`는 메시지 전체가 명령으로만 이루어져야 합니다. 한 메시지에 여러 줄로 나열할 수 있습니다.

```text
@claude:1 /model <id>
@codex:2 /effort high
```

다른 텍스트가 섞여 있으면 전환 명령이 절반만 적용되는 일이 없도록 일반 작업 메시지로 전달됩니다.

하네스 자체의 슬래시 명령도 지원합니다. 입력창에서 `@<name>:<number> /`를 입력하면 실행 중인 인스턴스가 지원하는 명령 목록이 나타나며 그대로 전달됩니다.

## 중지, 재시작, 핸드오프

대화에서 행동할 권한이 있는 누구나(에이전트 포함) 대화 내 인스턴스를 제어할 수 있습니다.

| 입력 | 동작 |
| --- | --- |
| `@claude:1:stop` | 이 인스턴스 중지 (`:kill`과 동일) |
| `@claude:1:stop wrong branch` | 중지 사유와 함께 중지 |
| `/stop all` | 대화의 모든 인스턴스 중지 (`/kill all`과 동일) |
| `/stop claude:1` | 단일 인스턴스를 중지하는 다른 방법 |
| `@claude:1:reborn` | 세션과 체크아웃을 유지한 채 같은 인스턴스 재시작 |
| `@claude:1:handoff:@codex` | 작업과 대화를 새 Codex 인스턴스로 넘기기 |
| `@claude:1:handoff:@auto` | 동일하게 넘기되 xMatrix가 후임 에이전트 선택 |

**중지(Stop)**는 메시지 전체가 중지 명령이어야 하며 명령 뒤의 텍스트는 사유로 기록됩니다. 중지된 인스턴스는 새 메시지가 와도 깨어나지 않으며 `:reborn`으로만 복구할 수 있습니다.

**재시작(Reborn)**은 같은 번호, 같은 메모리, 같은 디렉터리로 동일 인스턴스를 다시 띄웁니다. 인스턴스가 멈췄거나 깨어나지 못했거나 중지되었을 때 사용하세요. 멘션 뒤의 텍스트는 재시작된 인스턴스로 전달됩니다.

**핸드오프(Handoff)**는 기존 인스턴스가 완전히 중지된 것을 확인한 뒤 새 인스턴스(대개 다른 하네스)를 시작합니다. 라우팅에는 일반 호출과 동일한 권한 및 검증 규칙이 적용됩니다. 명시적인 `machine:` 조건으로 시작된 원본 인스턴스는 자동 할당량 핸드오프를 포함해 그 머신을 유지하며, 암묵적 배치였던 경우에는 다른 머신으로 이동할 수 있습니다. 필요한 머신에 적합한 후임이 없으면 핸드오프가 눈에 보이게 거부됩니다. 중지가 완료되지 않은 상태에서는 후임이 시작되지 않으므로 원본 머신의 데몬이 종료를 확인한 뒤 핸드오프를 다시 시도하세요.

후임 주소 바로 뒤에 오는 조건에는 일반 호출 문법이 그대로 적용됩니다. `@claude:1:handoff:@machine:Laptop`이나 `@claude:1:handoff:@model:<id> effort:high`처럼 후임을 조건으로 바로 열 수도 있으며, 이때 하네스 선택은 일반 호출의 `@machine:Laptop`과 마찬가지로 라우팅에 맡깁니다. 명시적으로 지정한 `machine:` 조건은 기존 머신 조건을 덮어쓰며 현재 접근 권한 및 가용성 검사를 통과해야 합니다. 모델, 추론 강도, 하네스 매개변수는 정상적으로 검증되며, 명시적 모델·추론 강도·하네스 매개변수가 주어진 경우 더 선호되는 다른 등록이 없으면 원본과 같은 등록에서 새 인스턴스가 시작될 수도 있습니다. 저장소 또는 디렉터리 조건은 원본 작업 위치와 일치해야 하며, 작업 위치를 바꾸려면 새 작업을 할당하세요. 조건이 아닌 첫 단어부터 작업 지시가 시작됩니다.

```text
@claude:1:handoff:@codex you have the branch; finish the migration and open the PR
@claude:1:handoff:@codex machine:Laptop effort:high continue in the original browser
@claude:1:handoff:@machine:Laptop model:<id> effort:high finish the migration
```

후임은 항상 새 인스턴스이므로 번호 없이 이름을 적습니다. `@auto`를 쓰면 하네스 선택도 라우팅에 맡깁니다.

저장소 체크아웃(커밋되지 않은 변경 포함)은 핸드오프 브랜치로 전달되며, 등록된 디렉터리는 해당 머신에 그대로 남습니다. 이전 인스턴스에서 내보낸 대화 내용은 사전 맥락으로만 전달되며 후임의 정체성이나 세션이 되지는 않습니다. 브라우저 세션이나 기타 로컬 상태는 체크아웃과 함께 이동하지 않습니다.

특정 인스턴스에 지정된 작업은 해당 인스턴스의 업무이자 동료 인스턴스들의 맥락이 됩니다. 일반 채널 메시지는 공유 작업으로 남고, 전체 알림은 여전히 모두를 대상으로 합니다. 에이전트의 신뢰할 수 있는 런타임 인스턴스와 실행(Run) 정보는 복구 과정 내내 유지됩니다. 임시 도우미 에이전트는 맡은 작업을 마치고 최종 결과를 보낸 뒤 스스로 중지해야 하며, 사람이나 CI 응답을 기다리는 인스턴스는 아직 할 일이 남아 있으므로 대기 상태를 유지합니다.

프로바이더 할당량이 소진되면 xMatrix가 자동 핸드오프를 시도합니다. 작업을 넘겨받을 수 있는 적격 에이전트가 없으면 **Retry when quota recovers** 또는 **Not now**를 선택할 수 있습니다. 대기는 페이지를 닫아도 유지되며 언제든 취소할 수 있습니다. 35일이 지나면 만료되며, xMatrix는 재시도 전에 실제 프로바이더 할당량을 다시 확인합니다.

## 연결된 앱

스페이스에 연결된 앱은 에이전트처럼 멘션하되 작업(action)을 함께 적습니다.

```text
@<app>:<action>:<target> <text>
```

```text
@github:subscribe:acme/web pulls checks
@github:comment:acme/web:#42 Reproduced on main.
@sentry:resolve:<issue>
```

명령은 메시지 맨 앞에 와야 하며 한 메시지에는 하나의 명령만 담을 수 있습니다. 첫 줄 이후의 내용은 명령의 텍스트 본문이 됩니다. 앱 목록과 작업은 [연결된 앱](connectors.md)을 참고하세요.

## 참조

| 입력창에서 입력 | 메시지에 저장되는 형식 | 화면 표시 |
| --- | --- | --- |
| `[[` 입력 후 페이지 선택 | `page:<page-id>` | 페이지의 현재 제목이 담긴 칩 |
| `[[page#` 입력 후 섹션 선택 | `page:<page-id>#<heading-slug>` | 해당 섹션으로 열리는 칩 |
| `#` 입력 후 대화 선택 | `channel:<channel-id>` | 대화의 현재 이름이 담긴 칩 |

ID를 기준으로 참조하므로 페이지나 대화 이름을 바꿔도 예전 메시지의 링크가 깨지지 않습니다. 참조 자체가 접근 권한을 부여하지는 않으므로 대상을 볼 수 없는 사용자에게는 제목과 링크가 표시되지 않습니다. 대화에서 페이지를 언급하면 해당 페이지가 대화에 연결됩니다.

페이지 본문에 `page:<page-id>`나 `channel:<channel-id>`를 적어도 똑같이 칩으로 표시되며, 커서를 참조 안에 두면 다시 ID가 보입니다.

`#` 뒤에 숫자가 오면 그대로 텍스트로 남으므로 `#3484`는 PR 번호로 유지됩니다. 중국어 입력기에서는 `【【`로도 페이지 목록을 열 수 있습니다.

## 제한 사항

- 메시지 본문은 최대 131,072자입니다.
- 한 메시지에 최대 8개의 명령을 담을 수 있습니다.
- 인스턴스 이름, 머신 이름, 모델 ID, 추론 강도는 최대 160자이며, 경로 및 저장소 참조는 최대 4,000자입니다.

## 아무것도 시작되지 않을 때

멘션 자체에 대기 중(waiting), 작업 중(working), 응답 완료(replied), 실패(failed), 중지됨(stopped) 상태와 원인이 표시됩니다. 흔한 원인은 다음과 같습니다.

| 멘션 표시 내용 | 해결 방법 |
| --- | --- |
| Mentioned, not started | 전송 시 에이전트 시작을 요청하지 않았습니다. 멘션의 Start를 누르거나 `xmatrix send --launch`로 다시 보내세요. |
| No registered environment offers the requested model, effort or harness | 하네스가 보고하는 ID를 확인하거나 조건을 빼세요. `xmatrix agent list`로 각 머신의 하네스를 확인할 수 있습니다. |
| The requested machine does not run this Agent | `xmatrix agent list`(또는 Agents 화면)에서 머신별 하네스, 온라인 여부, 할당량을 확인하세요. |
| The requested directory is not authorized | 해당 머신에서 `xmatrix workspace register`로 디렉터리를 등록하세요. |
| The repository reference is invalid | 자격 증명 없이 `owner/repo` 형식으로 적으세요. |
| Every matching environment has used up its provider quota | 할당량 초기화를 기다리거나 다른 하네스를 요청하세요. |
| Only machines kept out of automatic assignment can run this | `machine:<name>`으로 머신을 직접 지정하세요. |
| The `:new` and `:once` suffixes are retired | `@agent:new:owner/repo` 대신 `@auto repo:owner/repo` 형식을 사용하세요. |

터미널에서 `xmatrix diagnose <conversation>`을 실행해도 같은 진단 기록을 확인할 수 있습니다.
