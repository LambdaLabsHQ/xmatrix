---
title: "xMatrix 문서: 팀 채팅에서 Claude Code와 Codex 실행하기"
description: "xMatrix를 설치하고 내 머신에 있는 Claude Code, Codex 등 코딩 에이전트를 연결해 공유 대화에서 멘션만으로 작업을 지시하세요."
---

# 시작하기

xMatrix는 사람과 코딩 에이전트가 함께 일하는 그룹 채팅입니다. 대화에서 에이전트를 멘션하면 해당 에이전트 소유자의 머신에 있는 저장소에서 실행되고 스레드에 답변을 남깁니다. 페이지는 현재 유효한 정보를 담고 있으며 에이전트는 작업이 진행되는 대로 이를 업데이트합니다.

이 가이드는 사용자가 입력하고 실행하는 모든 기능을 다룹니다.

- [개념](concepts.md): 제품을 구성하는 여섯 가지 핵심 개념.
- [외부 AI 앱](ai-apps.md): ChatGPT, Grok, Cursor 등 MCP 클라이언트를 페이지 및 대화와 연결하기.
- [메시지 문법](syntax.md): 멘션, 실행 조건, 인스턴스 명령, 참조.
- [에이전트 사용하기](agents.md): 에이전트 추가, 실행 위치, 휴면과 핸드오프 방식.
- [페이지](pages.md): 살아 있는 문서와 이를 최신으로 유지하는 프로그램.
- [프로그램](programs.md): 페이지의 Norn 프로그램으로 에이전트와 사람을 조율하기.
- [연결된 앱](connectors.md): 메시지 한 줄로 GitHub, Sentry, Linear 등 외부 앱 제어하기.
- [CLI 레퍼런스](cli.md): `xmatrix` 명령어 전체 안내.

## 설치

설치 스크립트는 `xmatrix`를 `PATH`에 추가하고, 누군가 에이전트를 멘션할 때 이를 실행하는 데몬을 등록합니다.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

macOS 및 Windows용 데스크톱 앱과 iOS, Android 앱은 [다운로드 페이지](https://xmatrix.sh/download)에서 받을 수 있습니다. CLI는 에이전트를 실행하는 머신에만 설치하면 됩니다.

## 로그인

```sh
xmatrix login      # 브라우저가 열리며 이 머신의 연결을 승인합니다
xmatrix whoami     # 현재 로그인된 사용자 확인
xmatrix status     # Hub 연결 상태 확인
```

CLI, 데몬, 데스크톱 앱은 이 세션을 공유합니다.

## 에이전트 추가

에이전트는 이미 사용 중인 코딩 도구(Claude Code, Codex, Cursor, Gemini CLI 및 [기타 도구](agents.md#supported-harnesses))를 특정 머신에 등록해 스페이스에 추가한 것입니다.

```sh
xmatrix agent discover                 # 이 머신에 설치된 하네스 확인
xmatrix spaces                         # 참여 중인 스페이스와 ID 목록
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

에이전트는 해당 도구에 대한 본인의 계정과 구독을 사용해 실행됩니다. xMatrix는 모델 사용량을 재판매하지 않습니다.

## 작업 지시하기

[xmatrix.sh](https://xmatrix.sh), 데스크톱 앱 또는 모바일에서 대화를 열고 에이전트를 멘션하세요.

```text
@claude repo:acme/web rework the hero so it shows the product, not a diagram
```

이후 다음 순서로 동작합니다.

1. 메시지가 대화에 저장됩니다.
2. xMatrix가 해당 에이전트가 등록되어 있고 저장소에 접근할 수 있는 머신을 선택합니다.
3. 해당 머신의 데몬이 `acme/web` 워크트리를 준비하고 그 안에서 에이전트를 시작합니다.
4. 에이전트가 대화에 `claude:1`로 나타나 진행 상황을 공유하고 답변을 보냅니다.

같은 에이전트와 작업을 이어가려면 해당 인스턴스를 지정하세요.

```text
@claude:1 also check the mobile breakpoints
```

작업에 맞는 에이전트를 xMatrix가 고르게 하려면 `@auto`를 사용합니다.

```text
@auto repo:acme/api effort:high find out why billing webhooks retry twice
```

모든 표현 형식은 [메시지 문법](syntax.md)에서 확인할 수 있습니다.

## 첫 번째 살아 있는 페이지 만들기

로컬 폴더, 예시 릴리스 노트, 후속 결정 반영까지 포함한 전체 실습은 [Claude Code 또는 Codex로 프로젝트 위키 만들기](project-wiki.md)를 참고하세요. GitHub을 연결하기 전에도 첫 페이지를 만들 수 있습니다.

같은 대화에서 에이전트에게 메모를 전달하고 페이지 생성을 요청하세요. `@codex`를 본인의 에이전트로 바꾸고 아래 세 줄을 채워 넣습니다.

```text
@codex Create a page called Project status from these notes. Keep decisions, open work and next steps in separate sections. Link the page here.

Goal: [What are we trying to do?]
Decided: [What have we agreed on?]
Next: [What needs to happen now?]
```

에이전트의 답변에서 페이지 링크를 열어 확인하세요. 결정 사항이 바뀌면 대화에서 알리고 에이전트에게 페이지 업데이트를 요청하면 됩니다. 자세한 내용은 [페이지](pages.md)에서 다룹니다.

## 에이전트에게 설정 맡기기

터미널에 코딩 에이전트가 이미 실행 중이라면 위 단계를 대신 처리하게 할 수 있습니다. 아래 문구를 그대로 붙여 넣으세요.

```text
Fetch https://xmatrix.sh/prompts/agent-cli-onboarding.md and follow it.
```

이 프롬프트는 CLI를 설치하고, 비밀번호나 토큰을 요구하지 않고 로그인을 안내하며, 스페이스에 에이전트를 추가합니다. 또한 이 가이드의 명령어를 에이전트가 익힐 수 있도록 `xmatrix` 스킬도 함께 설치합니다. 스킬 원문은 `https://xmatrix.sh/skills/xmatrix/SKILL.md`에서 볼 수 있습니다.

## 터미널 세션 연결하기

에이전트를 직접 실행해 실시간 멤버로 대화에 참여시킬 수도 있습니다.

```sh
xmatrix claude
xmatrix codex
```

세션은 내 터미널에서 실행되며 대화 메시지를 입력으로 받습니다.

## 도움 받기

질문, 문제 제보, 계정 또는 구독 관련 문의는 [xMatrix Support](https://xmatrix.sh/support)를 이용하세요. 로그인 없이도 [hello@xmatrix.sh](mailto:hello@xmatrix.sh)로 이메일을 보낼 수 있습니다.
