---
title: "살아 있는 페이지와 이를 최신으로 유지하는 프로그램 · xMatrix 문서"
description: "xMatrix 페이지로 프로젝트 문서를 항상 최신 상태로 유지하세요. 사람과 에이전트가 함께 편집하는 Markdown 문서와 일정·이벤트로 에이전트를 실행하는 Norn 프로그램을 지원합니다."
---

# 페이지

대화는 빠르게 흘러가 나중에 다시 읽기 어렵습니다. 페이지는 스페이스가 현재 유효한 정보(현재 상태, 유효한 결정 사항, 남은 작업)를 보관하는 곳입니다. 사람은 대화하고, 에이전트는 페이지를 최신 상태로 유지합니다.

## 페이지 트리

스페이스마다 하나의 페이지 트리가 있습니다. 누가 말했는지가 아니라 스페이스가 다루는 주제를 기준으로 구성하세요. 페이지는 Markdown 문서이며 각 헤딩이 섹션이 됩니다. 문서의 첫 번째 최상위 헤딩(`# Name`)이 페이지의 위치와 상관없이 페이지 이름이 되며, 페이지 이름을 바꾸면 그 헤딩이 함께 수정됩니다.

앱에서 **Pages**를 열면 최근 변경된 페이지가 먼저 보이고 그 아래에 전체 트리가 표시됩니다. 터미널에서는 다음 명령을 사용합니다.

```sh
xmatrix page tree
xmatrix page tree --summaries
xmatrix page search <words>
xmatrix page read <page-id>
xmatrix page create "Billing" --under <parent-page-id>
xmatrix page rename <page-id> "Billing and invoices"
xmatrix page move <page-id> --under <other-page-id>
xmatrix page delete <page-id>
```

`page tree --summaries`는 각 페이지 아래에 현재 상태를 한 줄로 덧붙여 보여 줍니다. `page search`는 검색어의 모든 단어가 포함된 페이지를 찾아 해당 섹션을 `page:<id>#<section>` 형태로 표시하고 일치 부분 주변 텍스트를 보여 주며, 입력한 단어가 정확히 이어지는 페이지를 먼저 정렬합니다. 규모가 큰 스페이스에서는 여러 페이지를 일일이 읽지 말고 검색부터 시작하세요.

## 읽기 및 편집

사람들은 앱에서 실시간 커서를 보며 페이지를 함께 편집합니다. 에이전트는 CLI로 편집하며, 변경 사항이 반영되는 즉시 열려 있는 문서에 나타납니다. 문서 잠금은 없으며, 각 섹션에는 현재 보고 있는 사람과 연결된 대화에서 작업 중인 에이전트가 표시되고 `xmatrix page read`도 에이전트에게 같은 정보를 알려 줍니다.

CLI에서 편집할 때는 읽었던 리비전을 기준으로 페이지의 Markdown을 새 버전으로 교체합니다.

```sh
xmatrix page read <page-id>                       # 페이지 본문과 현재 리비전 출력
xmatrix page edit <page-id> --base <revision> -f page.md
```

`--base`에는 최신 리비전이 아니라 본인이 읽었던 리비전을 지정합니다. xMatrix가 그사이 다른 사람이 쓴 내용과 자동으로 병합합니다. 변경 범위가 겹치면 편집이 거부되고 병합할 수 있도록 최신 본문이 반환됩니다.

긴 페이지는 일부만 고치려고 전체를 다 읽을 필요가 없습니다.

```sh
xmatrix page read <page-id> --outline             # 각 헤딩의 슬러그와 크기 출력
xmatrix page read <page-id> --section <slug>      # 하위 헤딩을 포함한 단일 섹션 출력
xmatrix page edit <page-id> --base <revision> --section <slug> -f section.md
```

섹션 편집은 해당 섹션만 다시 쓰고 그 외 영역(읽은 뒤 다른 사람이 수정한 내용 포함)은 그대로 둡니다. 전달하는 텍스트에는 섹션의 헤딩 줄이 포함되어야 합니다. `page read --section`이 출력한 내용을 그대로 수정해 `-f`로 다시 넘겨도 헤더에 섹션 정보가 들어 있으므로 페이지 전체로 오인되지 않습니다. 섹션을 추가·삭제하거나 순서를 바꾸려면 페이지 전체를 읽고 편집하세요.

`xmatrix page read <page-id> --since <revision>`은 특정 리비전 이후 바뀐 부분만 출력하며, `xmatrix page history <page-id>`는 리비전 이력을 나열합니다.

앱에서 특정 문단을 누가 썼는지 보려면 문단에 마우스를 올리세요. 여백에 작성자와 시점이 표시됩니다. 텍스트를 선택하면 위에 표시되는 안내에서 작성자와 해당 내용이 작성된 대화를 함께 확인할 수 있으며, 클릭하면 페이지 옆에 그 대화가 작성 당시 메시지 위치로 열립니다. 아직 입력 중이라 저장되지 않은 텍스트는 "being written"으로 표시됩니다.

### 페이지에 담을 내용

페이지는 현재 유효한 사실만 기록합니다. 끝났거나 대체된 내용은 로그처럼 쌓아 두지 말고 그 자리에서 고쳐 쓰거나 지우세요. 커밋 해시, 실행 ID, 타임스탬프 같은 근거 자료는 PR과 대화에 남겨 두고 페이지에서는 링크로 연결합니다. 각 사실은 한 곳에만 적고 다른 곳에서는 링크하세요.

## 페이지와 대화

페이지와 대화는 서로를 참조할 때 연결됩니다. 연결된 페이지는 대화 상단에 실시간 카드로 나타나며, 그 대화에서 시작된 에이전트는 작업을 시작하기 전에 연결된 페이지를 먼저 읽습니다.

- 메시지에서 `[[`를 입력해 페이지를 선택하거나 `[[page#`를 입력해 섹션을 선택하세요. 메시지에는 `page:<page-id>` 또는 `page:<page-id>#<heading-slug>`가 저장됩니다.
- 에이전트 실행 중 페이지를 읽으면 해당 페이지가 그 대화에 자동으로 연결됩니다.
- `xmatrix page link <page-id> --block <heading-slug>`으로 명시적으로 연결할 수 있으며, `xmatrix page linked`로 대화에 연결된 페이지를 조회합니다.
- 페이지 변경 사항이 특정 대화에 전달되지 않게 하려면 대화 상단의 페이지 카드에 마우스를 올려 **Unlink from this conversation**을 선택하거나 `xmatrix page unlink <page-id>`를 실행하세요. 연결을 해제하면 누군가 다시 연결하기 전까지 해당 대화의 에이전트가 페이지를 읽거나 편집해도 재연결되지 않습니다.

헤딩 슬러그는 GitHub과 마찬가지로 헤딩을 소문자로 바꾸고 공백을 하이픈으로 치환한 뒤 문장부호를 제거한 형태입니다. 예를 들어 `## Open work`는 `open-work`입니다.

### 토론(Discussions)

페이지에서 특정 문구를 선택해 토론을 시작할 수 있습니다. 해당 문구에 고정된 대화가 열리며, 결론이 나면 결과를 페이지에 반영하고 토론을 해결(resolve) 처리합니다.

## 프로그램

반복 실행되거나, 특정 날짜를 기다리거나, 외부 이벤트에 반응해 시작해야 하는 작업은 페이지 안에 프로그램으로 작성합니다. 최신 상태를 유지하려는 섹션 안에 `norn run`과 이름을 태그한 코드 블록을 넣으면 됩니다. 프로그램은 [Norn](https://norn-lang.org)으로 작성하며 페이지를 저장하는 즉시 시작됩니다. 페이지의 다른 텍스트와 똑같이 읽고 수정할 수 있습니다.

12시간마다 섹션을 최신 상태로 유지하는 에이전트 예시:

````markdown
## Open work

```norn run triage
open Std
routine(~every=12h, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/web"),
  ~otherwise=@claude(~repo="acme/web"),
  "Read the issues opened since the last run and update this section")
```
````

특정 날짜에 보내는 리마인더 예시:

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "Renew the domain this week")
```
````

매일 한 번 실행하고 CI가 실패하면 즉시 실행하는 예시:

````markdown
```norn run build-watch
open Std
routine(~every=1d, ~from=2026-11-16T09:00Z, ~on=ciFailed("acme/web"),
  ~who=@auto(~repo="acme/web"), ~otherwise=@claude(~repo="acme/web"),
  "Check the build and fix what is broken")
```
````

시간은 모두 UTC 기준입니다. `~from`은 첫 실행 시각이자 이후 반복 주기의 기준이며, `~who`는 작업을 수행할 주체, `~otherwise`는 해당 라운드가 응답으로 끝나지 않았을 때 한 번 더 요청할 대체 대상을 지정합니다. `~on`은 `ciFailed("owner/repo")`나 `prMerged("owner/repo")` 같은 이벤트가 발생할 때 즉시 라운드를 추가합니다. 프로그램은 사람에게 질문하고, 마감 기한까지 답변을 기다리며, 여러 에이전트 사이에 작업을 넘길 수도 있습니다. 언어 문법, 요청, 이벤트, 제한 사항은 [프로그램](programs.md)에서 자세히 다룹니다.

### 프로그램 실행 방식

- 각 블록은 페이지에 연결된 전용 대화를 가지며 요청, 답변, 실행 결과가 모두 그곳에 게시됩니다.
- 블록 아래에는 프로그램의 현재 상태가 표시됩니다. 이미 보낸 요청과 결과, 현재 누구의 응답을 기다리고 있는지, 다음에 무엇을 할지 한눈에 보입니다. 작성한 대로 실행할 수 없는 블록은 이유를 표시하며 `xmatrix page edit` 실행 시에도 출력됩니다.
- 프로그램은 마지막으로 페이지를 저장한 사람의 권한으로 실행됩니다. 에이전트가 저장한 경우에는 해당 에이전트 소유자의 권한으로 실행됩니다.
- 프로그램을 바꾸려면 블록을 수정하세요. 이미 보낸 요청은 다시 보내지 않습니다. 중지하려면 블록을 삭제하면 됩니다.

```sh
xmatrix page read <page-id>     # 페이지의 프로그램 목록과 각 상태 출력
```

## 공개 페이지

스페이스 소유자나 관리자는 페이지를 외부에 공개할 수 있습니다. 공개된 페이지는 로그인 없이 공개 주소로 누구나 읽을 수 있으며, 에이전트가 페이지를 수정하면 읽고 있는 화면에도 실시간으로 반영됩니다.

스페이스의 모든 멤버가 읽을 수 있는 페이지만 공개할 수 있습니다. 상위 페이지를 공개해도 하위 페이지가 함께 공개되지는 않습니다. 공개 페이지의 내용은 에이전트가 계속 최신으로 유지할 수 있지만, 공개 및 비공개 전환은 사람만 할 수 있습니다.
