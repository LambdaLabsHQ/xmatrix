---
title: "Norn 프로그램: 에이전트와 사람 조율하기 · xMatrix 문서"
description: "xMatrix 페이지에 Norn 프로그램을 작성해 에이전트와 사람을 조율하세요. 타입이 지정된 요청, 마감 기한, 루틴, 이벤트를 지원하며 모든 요청은 명확한 응답으로 끝납니다."
---

# 프로그램

프로그램은 여러 에이전트와 사람이 하나의 작업을 어떻게 협력해 끝낼지 정의합니다. 누구에게 무엇을, 어떤 순서로, 언제까지 요청할지, 거절하거나 응답이 없을 때 어떻게 처리할지 페이지에 한 번만 적어 두면 xMatrix가 그대로 실행합니다. 에이전트 사이에서 메시지를 전달하거나 답변을 독촉할 필요가 없습니다.

프로그램은 오픈 조율 언어인 [Norn](https://norn-lang.org)으로 작성합니다. xMatrix는 Norn의 호스트로서 모든 요청 기록을 보관하고, 요청을 전달하며, 시계를 관리하고, 스페이스 권한을 적용합니다. 실제 팀에 적용하기 전에 [Norn 플레이그라운드](https://norn-lang.org/norn/)에서 시뮬레이션 팀으로 언어를 시험해 볼 수 있습니다.

## 첫 번째 프로그램

페이지를 열고 `norn run` 뒤에 이름을 붙인 코드 블록을 추가한 뒤 저장하세요.

````markdown
```norn run release-notes
let notes = run(@claude, "Draft the release notes for 2.4")->wait?
switch confirm(@alice, "Publish these notes?", ~about=notes, ~by=1d)->wait {
| Answered(Yes) => run(@claude, "Publish the notes", ~about=notes)->wait
| Answered(No) | NoReply => Refused("Not published")
| other => fail(other)
}
```
````

`@claude`는 스페이스의 에이전트로, `@alice`는 팀원 이름으로 바꾸세요. 페이지를 저장하면 프로그램이 즉시 시작됩니다. 에이전트가 릴리스 노트 초안을 작성하고, 팀원에게 게시 여부를 확인한 뒤, 하루 동안 답변이 없으면 게시하지 않고 종료합니다.

`norn`만 태그된 블록이나 인용문 안의 블록은 표시만 되고 실행되지 않습니다. 에이전트에게 프로그램 작성을 맡길 수도 있습니다. 페이지에 프로그램을 추가해 달라고 요청하면 저장 시 검사기 오류를 읽어 스스로 수정합니다.

## 요청과 응답

프로그램은 요청을 보내며 동작합니다. 각 동사는 서로 다른 형식의 답변을 요구합니다.

| 동사 | 요청 내용 |
| --- | --- |
| `run(who, task)` | 작업 수행 후 프로그램이 사용하는 형식으로 결과 보고 |
| `confirm(who, question)` | Yes 또는 No 선택 |
| `choose(who, question, [A, B])` | 보기 중 하나 선택 |
| `ask(who, question)` | 문장으로 된 답변 |

`~about=`은 요청의 대상을 지정하고, `~context=`는 추가 참고 자료를 전달하며, `~by=`는 마감 기한을 기간(`4h`, `2d`) 또는 UTC 시각으로 설정합니다. `->wait`은 요청이 끝날 때까지 기다립니다.

모든 요청은 반드시 아래 여섯 가지 응답 중 하나로 끝나며, 프로그램은 모든 분기를 처리해야 합니다. 빠진 분기가 있으면 프로그램이 시작되지 않습니다.

| 응답 | 의미 |
| --- | --- |
| `Answered(x)` | 응답을 받았으며 `x`가 그 답변임 |
| `Refused(why)` | 상대가 요청을 거절함 |
| `NoReply` | 응답 없이 마감 기한이 지남 |
| `Broke(why)` | 시도했으나 수행하지 못했거나 연락할 수 없음 |
| `Cancelled` | 프로그램이 요청을 취소함 |
| `Revoked` | 요청의 기반 권한이 상실됨 |

`->wait?`은 "응답을 받으면 그 값으로 계속 진행하고, 그 외의 응답이면 프로그램 전체를 종료한다"는 축약 표현입니다. 전체 문법은 [언어 명세](https://github.com/norn-lang/norn/blob/main/docs/spec.md)를 참고하세요.

## 에이전트에게 보낸 요청의 동작

하네스 이름(`@claude`, `@codex`)이나 `@auto`로 보낸 요청은 일반 멘션과 마찬가지로 해당 에이전트를 시작하며, 작업 내용과 함께 반드시 따라야 하는 답변 형식을 전달합니다. 실행 조건은 괄호 안에 적습니다. `@auto(~repo="acme/app", ~effort="high")`는 `repo`, `pwd`, `machine`, `harness`, `model`, `effort`를 지원합니다.

에이전트는 아래 명령어로 답변하며, 답변 내용은 대화에도 에이전트 이름으로 게시됩니다.

```sh
xmatrix reply <request> 'Sound'
xmatrix refuse <request> '<why>'
xmatrix broke <request> '<why>'
xmatrix delegate <request> @Daniel '<why>'   # 다른 사람이 대신 응답하도록 위임
xmatrix requests            # 내가 맡은 요청과 내 프로그램이 대기 중인 요청 목록
```

요청을 배정받은 실행(run)만 그 요청에 답할 수 있습니다. 형식에 맞지 않는 답변은 거부되며 요청은 계속 열린 상태로 남습니다. 요청이 영원히 방치되는 일은 없습니다. 에이전트가 시작에 실패하거나 중지되거나 답하지 않고 턴을 끝내면, 작업이 중단된 경우 새 에이전트에게 한 번 더 넘겨지고, 그렇지 않으면 `Broke`로 종료되어 프로그램이 선언된 분기를 따릅니다.

## 사람에게 보낸 요청의 동작

멤버의 이름이나 핸들로 보낸 요청은 질문, 선택지, 마감 기한이 담긴 카드로 대화에 도착하며 **Needs you** 목록에도 표시됩니다. 오직 해당 멤버만 응답할 수 있으며 **Decline**으로 사유를 적어 거절할 수 있습니다. 침묵은 절대 동의로 간주되지 않습니다. `~by`가 지나면 `NoReply`로 끝나고, `~by`가 없으면 답변할 때까지 기다립니다.

해당 이름의 멤버가 없거나 동명이인이 있으면 사유와 함께 `Broke`로 종료됩니다.

## 요청을 다른 사람에게 위임하기

요청을 받은 사람은 다른 참여자 한 명에게 위임해 대신 답하게 할 수 있습니다. 카드에서 **Delegate…**를 눌러 대화의 다른 멤버, 에이전트 이름(`@claude`), 또는 대화 속 에이전트 인스턴스(`@claude:2`)와 사유를 지정하세요. 프로그램 입장에서는 변화가 없고 마감 기한도 유지되며, 대화에는 누가 누구를 대신해 답했는지 기록됩니다. 위임받은 대상이 답하거나 돌려보내면(**Give back** 또는 `xmatrix refuse`) 요청이 다시 원래 담당자에게 돌아옵니다. 요청이 열려 있는 동안 카드의 **Take back**으로 언제든 회수할 수 있습니다. 에이전트는 `xmatrix delegate`로 위임합니다.

## 프로그램 진행 상황 보기

블록 아래에는 프로그램이 흐름도 형태로 표시됩니다. 이미 보낸 요청과 결과, 현재 누구를 언제까지 기다리는지, 다음에 이어질 수 있는 모든 단계가 나타납니다. 작성한 대로 실행할 수 없는 블록은 코드의 해당 위치 표시와 함께 이유를 알려 줍니다.

각 프로그램은 페이지와 연결된 전용 대화를 가지며, 페이지 이름과 블록 이름으로 명명됩니다. 요청, 답변, 최종 결과가 그곳에 게시되고 마지막 작업을 수행한 에이전트가 대화에 남아 있으므로 바로 후속 메시지를 보낼 수 있습니다.

```sh
xmatrix page read <page-id>     # 페이지의 프로그램 목록과 각 상태 출력
```

## 수정 및 중지

프로그램은 페이지의 일반 텍스트처럼 편집합니다.

- **블록을 수정하고 저장하세요.** 기존 요청 기록을 바탕으로 프로그램이 다시 평가됩니다. 같은 문구로 이미 보낸 요청은 다시 묻지 않고 새 단계만 요청합니다. 검사에 통과하지 못한 변경은 적용되지 않습니다.
- **블록 이름을 바꾸면** 전용 대화를 새로 갖는 별도 프로그램이 됩니다. 한 페이지에 같은 이름의 블록이 두 개 있으면 하나를 변경할 때까지 둘 다 실행되지 않습니다.
- **블록이나 페이지를 삭제하면** 프로그램이 중지되고 열려 있던 요청이 모두 취소됩니다. 프로그램의 대화를 중지해도 동일합니다.
- **종료된 프로그램의 블록을 수정하면** 다시 실행됩니다.

프로그램은 마지막으로 페이지를 저장한 사람의 권한으로 실행되며, 에이전트가 저장한 경우에는 그 에이전트 소유자의 권한으로 실행됩니다.

## 반복 작업

`open Std`로 Norn 표준 라이브러리를 불러오면 루틴을 한 번의 호출로 작성할 수 있습니다.

````markdown
```norn run upkeep
open Std
routine(~every=7d, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/app"),
  ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep: fix the riskiest open issue")
```
````

지정 시각을 기준으로 매주 한 라운드가 실행됩니다. 답변으로 끝나지 않으면 `~otherwise`에 지정한 에이전트에게 한 번 더 요청하고, 그래도 실패하면 프로그램 대화에 보고한 뒤 루틴은 계속 이어집니다. 작업 문구를 수정하면 다음 라운드부터 적용되며 이전 라운드는 다시 실행되지 않습니다.

리마인더는 대기 후 메시지를 보내는 형태입니다.

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "The domain renews this week")
```
````

표준 라이브러리에는 `decide`(기한 내 아무도 답하지 않았을 때만 기본값을 채택하는 선택), `remind`, `followUp`, `schedule`, `all`도 포함되어 있습니다.

## 연결된 앱의 이벤트

프로그램은 외부에서 발생하는 이벤트를 기다릴 수 있습니다.

| 스트림 | 발생 시점 |
| --- | --- |
| `ciFailed("owner/repo")` | 저장소의 기본 브랜치에서 워크플로가 실패했을 때 |
| `prMerged("owner/repo")` | 기본 브랜치로 풀 리퀘스트가 병합되었을 때 |
| `appEvent("sentry", ~feature="issue.created")` | [연결된 앱](connectors.md)이 이벤트를 전달했을 때 (`~feature` 생략 시 모든 이벤트) |

```norn
every(1d)->or(ciFailed("acme/app"))->forEach(_ =>
  run(@auto(~repo="acme/app"), "Check the build and fix what is broken")->wait)
```

이 코드는 매일 한 번, 그리고 CI가 실패하는 즉시 라운드를 실행합니다. 스페이스의 앱 연결이 해당 저장소나 앱을 포함하고 있어야 합니다.

## 연결된 앱에서 동작 실행

프로그램은 [연결된 앱](connectors.md)이 지정한 시각에 한 가지 일을 스스로 하게 할 수 있습니다. 그 시각에 에이전트가 실행 중일 필요가 없습니다. 두 단계입니다. **준비**는 실행할 내용을 그대로 고정하고 승인을 받습니다. 이때는 아무것도 전송되지 않습니다. **게시**는 그것을 한 번 실행합니다.

```norn
open Std
let post = (video, text, ~at) => spawn(~key=video, () => {
  let ready = X.prepareVideo("@acme", video, text)->wait?
  after(at)->wait
  X.publish(ready)->wait
})
ignore(all([
  post("<message id>/<attachment id>", "Stop pasting API keys.", ~at=2026-11-24T01:00Z),
  post("<message id>/<attachment id>", "One table for every agent.", ~at=2026-11-24T09:00Z),
]))
never()->wait
```

프로그램이 시작되면 두 게시물이 바로 승인을 요청하므로 한 번에 모두 답할 수 있습니다. 이후 각 게시물은 자기 시각에 전송됩니다. 목록에 한 줄을 추가하면 새 게시물에 대해서만 묻습니다. 마지막 줄은 프로그램을 계속 실행 상태로 두어 목록을 늘려 갈 수 있게 합니다. 이미 전송된 게시물은 그 줄을 남겨 두든 지우든 다시 전송되지 않습니다.

승인은 해당 앱의 단일 권한을 따릅니다.

| 권한 | 프로그램이 동작을 준비할 때 |
| --- | --- |
| 읽기 및 쓰기(Read and write) | 즉시 승인됩니다 |
| 먼저 묻기(Ask first) | 대화의 **Pending approvals**에 표시되며, Space 관리자가 사용될 계정, 본문, 첨부 파일을 보고 답합니다 |
| 읽기 전용(Read only) | 거부됩니다 |

승인은 그 내용의 그 동작 하나에만 적용되며 30일 동안 유효합니다. 실행 시각에 xMatrix는 연결과 계정이 승인 당시와 같은지, 승인한 사람이 여전히 승인할 수 있는지 다시 확인합니다. 하나라도 성립하지 않으면 아무것도 전송되지 않고 프로그램이 그 이유를 읽습니다. 결과를 알 수 없는 동작은 실패로 보고되며 다시 시도하지 않습니다. 동영상 첨부 파일은 프로그램 자신의 대화에 있어야 합니다.

`X.preparePost(account, text)`는 동영상 없는 게시물을 준비합니다. 다른 앱의 동작은 이름으로 요청하며, 입력은 해당 명령의 두 부분입니다. 작성법은 `xmatrix connector list`에서 볼 수 있습니다.

```norn
type command = {target: string, text: string}
type done = {summary: string, url: option<string>}
let post: Actions.action<command, done> = Actions.action("slack", "post")

let ready = Actions.prepare(post, {target: "#releases", text: "4.2 is out."})->wait?
Actions.perform(ready)->wait
```

## 에이전트의 단일 질문

답변 하나만 필요한 에이전트는 프로그램을 작성하지 않고 명령어로 바로 질문해 답을 받습니다.

```sh
xmatrix confirm @alice Ship 4.2 now? --by 1d --otherwise No
xmatrix choose @alice "Which plan?" Monthly Yearly
xmatrix ask @codex What does the migration change?
```

`--by`는 마감 기한, `--otherwise`는 기한이 지났을 때 채택할 기본 답변입니다. 질문은 대화에 한 번 표시됩니다. 사람에게는 질문한 에이전트 이름과 응답 결과가 표시되는 카드로, 에이전트에게는 요청으로 전달됩니다. 잘못된 내용이나 잘못된 대상에게 질문한 에이전트는 `xmatrix cancel <request>`로 취소할 수 있으며 카드에도 요청이 철회되었음이 표시됩니다.

## 메시지 속 프로그램

`norn run` 블록 하나를 담은 메시지를 보내면 그 대화에서 일회성 작업을 위한 프로그램이 시작됩니다. 동작은 페이지 프로그램과 같지만 전송 후 수정할 수 없으며 각 요청마다 새 에이전트가 시작됩니다.

## 제한 사항

- `@claude:2`처럼 번호가 붙은 인스턴스에는 요청을 보낼 수 없습니다.
- 특정 PR의 병합이나 해당 PR이 포함된 릴리스 같은 개별 사실은 아직 대기할 수 없으며 위 표의 이벤트 스트림만 대기할 수 있습니다.
- 편집 저장 전 변경 영향 미리보기 기능은 아직 제공되지 않습니다.
