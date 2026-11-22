---
title: "Claude Code 또는 Codex로 프로젝트 위키 만들기 · xMatrix 문서"
description: "프로젝트 메모를 내 Claude Code나 Codex 에이전트가 최신 상태로 유지하는 살아 있는 위키로 바꾸세요. 상태 페이지를 만들고 검토한 뒤 채팅에서 바로 업데이트할 수 있습니다."
---

# Claude Code 또는 Codex로 프로젝트 위키 만들기

xMatrix에서 내 Claude Code 또는 Codex 에이전트를 사용해 프로젝트 메모를 살아 있는 위키로 만들어 보세요. 프로젝트 상태 페이지를 생성해 결정 사항과 남은 작업을 확인하고, 변경 사항이 생기면 같은 대화에서 바로 업데이트할 수 있습니다.

오픈소스 프로젝트라면 다음 릴리스부터 시작해 보세요. 무엇이 합의되었고, 무엇이 블로커이며, 다음 단계의 담당자가 누구인지 정리하는 것입니다. GitHub을 연결하거나 팀원을 초대하기 전에도 몇 줄의 메모와 로컬 폴더만으로 바로 시도할 수 있습니다.

## 시작하기 전에

Claude Code 또는 Codex가 설치되어 로그인된 컴퓨터와 xMatrix 계정이 필요합니다. 에이전트는 기존 도구 계정을 사용해 내 컴퓨터에서 실행되므로 작업하는 동안 컴퓨터가 온라인 상태여야 합니다. 대화를 나누고 페이지를 읽는 곳은 웹 앱입니다.

아직 컴퓨터를 연결하지 않았다면 [설치 및 로그인](index.md#install)을 먼저 진행하세요. 그런 다음 [웹 앱](https://xmatrix.sh/app)에서 스페이스를 엽니다.

## 에이전트에 폴더 연결하기

첫 페이지를 만들기에는 빈 폴더 하나로 충분합니다. 아래 명령은 macOS 또는 Linux에서 폴더를 만들고 Codex를 스페이스에 추가합니다.

```sh
mkdir -p ~/xmatrix/project-wiki
xmatrix spaces
xmatrix agent add codex --space <space-id> --workspace ~/xmatrix/project-wiki
```

`<space-id>`에는 열어 둔 스페이스의 ID를 넣으세요. Claude Code를 사용한다면 `codex` 대신 `claude`를 입력합니다. Windows에서는 `C:\xmatrix\project-wiki` 같은 폴더를 만들고 `--workspace`에 해당 경로를 지정하세요.

폴더의 전체 경로는 macOS나 Linux에서 `echo "$HOME/xmatrix/project-wiki"`, PowerShell에서는 `Resolve-Path C:\xmatrix\project-wiki`로 확인할 수 있습니다. 아래 메시지에서 큰따옴표를 포함해 이 경로를 사용하세요. 등록 방법과 지원 도구는 [에이전트 사용하기](agents.md)에서 확인할 수 있습니다.

## 첫 페이지 요청하기

스페이스에 새 대화를 만듭니다. 아래 메시지에서 경로와 예시 메모를 실제 프로젝트 내용으로 바꿔 붙여 넣으세요. Claude Code를 추가했다면 `@claude`를 사용합니다.

```text
@codex pwd:"/full/path/to/project-wiki"
Create a page called Release status from these notes.
Use sections for Goal, Decisions, Open work and Next steps.
Keep unknown owners or dates marked unknown.
Work from these notes and link the page here when it is ready.

Goal: Ship the next release with a usable installation guide.
Decided: Support macOS and Windows first. Linux is still open.
Open work: Check the Windows instructions.
The owner and release date are not decided.
Next: Ask a maintainer to try a clean Windows install.
```

폴더 지정(`pwd:`)은 에이전트가 실행될 위치를 선택합니다. 내용은 메모에서 제공하므로 이 작업에는 저장소 접근 권한이 필요 없습니다. Windows에서도 동일한 `pwd:` 문법에 전체 Windows 경로를 넣어 사용합니다.

에이전트의 답변을 기다린 뒤 링크된 페이지를 열거나 **Pages**에서 **Release status**를 찾으세요. 페이지가 결정 사항과 미결 항목을 잘 구분했는지, 정해지지 않은 담당자와 날짜를 미정으로 유지했는지 확인합니다. 잘못된 부분이 있다면 대화에서 바로 수정을 요청하세요.

에이전트가 응답하지 않으면 컴퓨터에서 `xmatrix status`와 `xmatrix agent list --space <space-id>`를 실행해 확인하세요. 에이전트가 활성화되어 있고 코딩 도구에 로그인되어 있는지 점검합니다. 대화의 호출 상세 정보에서 실행 실패 원인을 확인할 수 있으며, 추가 점검 방법은 [에이전트 설정](agents.md)을 참고하세요.

## 결정 사항을 바꾸고 페이지 업데이트 확인하기

응답한 인스턴스에 이어서 답장하세요. 예를 들어 `codex:1`로 나타났다면 다음과 같이 보냅니다.

```text
@codex:1 Windows installation has now been checked.
Update Release status: remove that open item.
Make the next step choosing a release date.
Leave the date unknown until we agree on it.
```

대화에서 실제로 표시된 이름과 번호를 사용하세요. 같은 페이지를 다시 열어 이전 미결 항목이 사라지고 다음 단계가 바뀌었는지 확인합니다. 이것이 핵심 효과입니다. 스레드를 거슬러 올라가 계획을 재구성할 필요 없이, 언제든 돌아와 확인할 수 있는 최신 페이지 하나가 유지됩니다.

## 실제 프로젝트 업무에 활용하기

다음 결정 사항, 이슈 요약, 릴리스 노트를 대화로 가져와 에이전트에게 기존 페이지 업데이트를 맡기세요. 코드를 확인해야 할 때는 실제 프로젝트 폴더에 대한 접근 권한을 부여합니다. 에이전트가 GitHub 이슈나 PR을 읽도록 하려면 먼저 스페이스에 [GitHub](connectors.md#github)을 연결하고 작업에 저장소를 지정하세요.

각 사실은 한 곳에만 기록하세요. 프로젝트가 커지면 하위 페이지를 추가하고 Release status 페이지에서 링크합니다. 페이지 트리, 동시 편집, 예약 업데이트는 [페이지](pages.md)에서 자세히 설명합니다.

페이지는 스페이스 소유자나 관리자가 공개하기로 선택하기 전까지 비공개로 유지됩니다. 팀 외부에 공유하기 전에 내용과 접근 권한을 검토하세요. 이 위키를 만든다고 자동으로 공개되지는 않습니다.
