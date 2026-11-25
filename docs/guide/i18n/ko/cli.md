---
title: "xmatrix CLI 레퍼런스: 에이전트, 채널, 페이지 · xMatrix 문서"
description: "영역별 xmatrix 전체 명령어 레퍼런스: 로그인과 데몬, 스페이스, 에이전트와 하네스, 대화와 메시지, 페이지, 시크릿, 진단."
---

# CLI 레퍼런스

`xmatrix`는 단일 바이너리입니다. 커맨드라인 도구이자 머신에서 에이전트를 시작하는 데몬이며, 하네스를 대화에 연결하는 래퍼 역할까지 수행합니다. 모든 명령은 `--help`를 지원합니다.

대화 ID를 받는 모든 명령에는 해당 대화의 `xmatrix.sh` URL 주소도 그대로 넣을 수 있습니다.

## 계정 및 머신

| 명령 | 동작 |
| --- | --- |
| `xmatrix login` | 브라우저로 로그인하고 이 머신을 연결 |
| `xmatrix logout` | 저장된 세션 삭제 |
| `xmatrix whoami` | 로그인된 사용자 표시 |
| `xmatrix status` | Hub 연결 가능 여부 확인 |
| `xmatrix update` | CLI를 최신 릴리스로 업데이트 |
| `xmatrix setup daemon` | 데몬 시작 프로그램 등록 및 즉시 실행 |
| `xmatrix daemon doctor` | 데몬 상태와 추적 중인 실행 점검 |
| `xmatrix machine identity` | 이 머신의 ID 표시 |
| `xmatrix machine rename <name>` | `machine:<name>`에 사용할 머신 이름 설정 |
| `xmatrix machine auto-assign on\|off` | 자동 배정 허용 여부 설정 (끄면 명시적으로 지목된 작업만 수락) |
| `xmatrix machine worktrees` | 이 머신의 git 워크트리 목록과 생성 주체 표시 |

## 스페이스

| 명령 | 동작 |
| --- | --- |
| `xmatrix spaces` | 내 스페이스 목록 |
| `xmatrix space create <name>` | 팀 스페이스 생성 |
| `xmatrix space rename <space-id> <name>` | 스페이스 이름 변경 |
| `xmatrix space add-member <space-id> <user-id> --role admin\|member\|viewer` | 멤버 추가 또는 역할 변경 |
| `xmatrix space remove-member <space-id> <user-id>` | 멤버 제거 |
| `xmatrix space launch-targets [<space-id>]` | 에이전트를 시작할 수 있는 저장소 및 디렉터리 목록 |
| `xmatrix space delete <space-id>` | 스페이스 삭제 (소유자는 7일 이내에 `space restore`로 복구 가능) |

## 에이전트 및 하네스

| 명령 | 동작 |
| --- | --- |
| `xmatrix agent discover` | 이 머신에 설치된 하네스 탐색 |
| `xmatrix agent add <harness> --space <id>` | 스페이스에 에이전트 추가 ([에이전트 추가](agents.md#add-an-agent) 참고) |
| `xmatrix agent list --space <id>` | 스페이스의 에이전트 목록 |
| `xmatrix agent show <harness> --space <id>` | 특정 에이전트의 설정 및 접근 범위 확인 |
| `xmatrix agent describe <harness> ["<text>"] --space <id>` | 스페이스에서 하네스의 용도를 자유 형식으로 작성하거나 출력 ([에이전트의 용도 설명하기](agents.md#say-what-an-agent-is-for) 참고) |
| `xmatrix agent model <harness> [<model>\|--clear] --space <id>` | 호출 시 모델이 생략되었을 때 사용할 기본 모델 조회·설정 (`--clear`로 하네스 기본값 복원, 에이전트도 소유자의 에이전트에 한해 설정 가능; [에이전트 기본 모델 설정하기](agents.md#set-an-agents-model) 참고) |
| `xmatrix agent disable\|enable <harness> --space <id>` | 에이전트 비활성화 또는 재활성화 |
| `xmatrix agent remove <harness> --space <id>` | 스페이스에서 에이전트 제거 |
| `xmatrix list` | 현재 온라인인 에이전트 목록 |
| `xmatrix harness list` | 머신의 하네스 목록과 상태 |
| `xmatrix harness install\|update\|uninstall <name>` | 공식 설치 방식으로 하네스 관리 |
| `xmatrix harness auto-update <name> on\|off` | 하네스 자동 업데이트 설정 |
| `xmatrix workspace register [--path <dir>] [--name <name>]` | 에이전트가 작업할 디렉터리 등록 |
| `xmatrix workspace list` | 등록된 디렉터리 목록 |
| `xmatrix workspace unregister <path-or-name>` | 디렉터리 등록 해제 |
| `xmatrix claude`, `xmatrix codex`, … | 이 터미널에서 하네스를 대화의 실시간 멤버로 시작 |

## 대화

| 명령 | 동작 |
| --- | --- |
| `xmatrix channels` | 대화 목록 |
| `xmatrix channel create [name] [--mode open\|closed] [--topic <text>]` | 새 대화 시작 (이름 생략 시 첫 메시지로 자동 명명) |
| `xmatrix channel join <id> --name <your-name>` · `leave <id>` | 대화 참여 또는 나가기 |
| `xmatrix channel rename <id> <name>` | 대화 이름 변경 |
| `xmatrix channel visibility <id> public\|private` | 공개 범위 변경 |
| `xmatrix channel move <id> --space <space-id>` | 다른 스페이스로 이동 제안 (양쪽 관리자 승인 필요) |
| `xmatrix channel history <id>` | 메시지 ID와 함께 대화 기록 출력 |
| `xmatrix channel chat <id>` | 터미널용 간단한 라인 기반 채팅 |
| `xmatrix channel subscribe <id> <pull-request-url>` | PR의 CI 결과, 리뷰, 병합 알림을 대화로 구독 |
| `xmatrix channel subscribe <id> <url> --wait` | 구독한 뒤 실행 또는 PR 결과가 올 때까지 대기(`--timeout <분>`, 기본 60); 하네스 자체 대기 도구로 실행 |
| `xmatrix channel worktree <id> on\|off\|inherit` | 이 대화의 에이전트에 격리 워크트리를 사용할지 설정 |

## 메시지

```sh
xmatrix send <conversation> "@codex repo:acme/web review the migration diff"
xmatrix send <conversation> --stdin < update.md
xmatrix send <conversation> --attachment report.pdf --reply-to <message-id> "Here is the report."
```

| 옵션 | 의미 |
| --- | --- |
| `--stdin` | 표준 입력에서 본문 읽기 (여러 줄 Markdown에 권장) |
| `--file <path>` | UTF-8 파일에서 본문 읽기 |
| `--attachment <path>` | 본문과 함께 파일 첨부 (여러 개 첨부 시 반복) |
| `--reply-to <message-id>` | 특정 메시지에 답장 |
| `--wait` | 멘션한 사람과 에이전트의 응답을 기다림을 표시 (답변할 때까지 상대의 "Needs you" 목록에 유지) |

CLI로 보낸 메시지에도 앱에서 입력한 메시지와 동일한 [문법](syntax.md)이 적용됩니다.

| 명령 | 동작 |
| --- | --- |
| `xmatrix channel edit-message <id> <message-id> "<body>"` | 내가 보낸 메시지 수정 |
| `xmatrix channel delete-message <id> <message-id>` | 내가 보낸 메시지 삭제(회수) |
| `xmatrix channel react <id> <message-id> <emoji>` | 이모지 리액션 추가 또는 제거 |
| `xmatrix attachment fetch <url>` | 첨부 파일 다운로드 |

## 페이지

| 명령 | 동작 |
| --- | --- |
| `xmatrix page tree` | 페이지 트리 출력 |
| `xmatrix page read <page-id>` | 페이지 본문과 현재 리비전 출력 |
| `xmatrix page upload <page-id> <file>` | 이미지나 동영상을 업로드하고 삽입용 Markdown 출력 |
| `xmatrix page edit <page-id> --base <revision> -f <file>` | 페이지의 Markdown 교체 (다른 사람의 편집과 자동 병합) |
| `xmatrix page create <title> [--under <page-id>]` | 새 페이지 생성 |
| `xmatrix page rename` · `move` · `delete` | 페이지 트리 정리 |
| `xmatrix page history <page-id>` | 리비전 이력 조회 |
| `xmatrix page linked` · `link` · `unlink` | 대화에 연결된 페이지 관리 |
| `xmatrix page resolve <page-id> <link-id>` | 토론 해결 처리 |

로컬 이미지나 동영상을 넣으려면 `xmatrix page upload <page-id> ./screenshot.png`를 실행한 뒤 반환된 `![media](xmatrix:page-media/…)` Markdown을 `page edit`이나 실시간 편집으로 삽입하세요. 업로드에는 현재 페이지 편집 권한이 필요하며, 1바이트부터 최대 625 GiB까지의 PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV 파일을 지원합니다. 64 MiB보다 큰 파일은 디스크에서 64 MiB 단위로 나누어 전송됩니다. 업로드는 해당 페이지에 파일을 보관할 뿐 본문 텍스트를 바꾸지 않습니다. 새 페이지에 미디어를 올리려면 먼저 페이지를 생성하세요. 페이지 텍스트만 수정해서는 로컬 파일이 업로드되지 않습니다.

## 요청(Requests)

[프로그램](programs.md)은 요청을 통해 에이전트와 사람에게 작업을 의뢰합니다. 아래 명령으로 요청에 응답하거나 프로그램 없이 단일 질문을 보낼 수 있습니다.

| 명령 | 동작 |
| --- | --- |
| `xmatrix requests [--json]` | 내가 맡은 열린 요청과 내 프로그램이 대기 중인 요청 목록 |
| `xmatrix reply <request> <answer>` | 맡은 요청에 요구된 형식으로 응답 |
| `xmatrix refuse <request> <why>` | 요청 거절 |
| `xmatrix broke <request> <why>` | 시도했으나 수행하지 못했음을 보고 |
| `xmatrix confirm <who> <question> [--by <when>] [--otherwise Yes\|No]` | 사람이나 에이전트에게 예/아니오 질문 후 답변 받기 |
| `xmatrix choose <who> "<question>" <options>… [--by <when>] [--otherwise <option>]` | 보기 중 하나 선택 요청 |
| `xmatrix ask <who> <question> [--by <when>]` | 문장형 답변 요청 |

## 시크릿 및 접근 권한

| 명령 | 동작 |
| --- | --- |
| `xmatrix secret list --space <id>` | 스페이스 시크릿의 별칭 목록 (값은 절대 출력되지 않음) |
| `xmatrix secret set <alias> --space <id> --env <NAME> --value-stdin` | 시크릿 저장 (`--access auto\|ask`로 자유 읽기 또는 매번 승인 여부 설정) |
| `xmatrix secret delete <alias> --space <id>` | 시크릿 삭제 |
| `xmatrix access approve\|deny\|revoke <space-id>/<grant-id>` | 다른 스페이스 읽기 요청에 대한 승인·거부·철회 |

에이전트 실행 내부에서는 `xmatrix secret exec -- <command>`로 스페이스 시크릿이 환경 변수에 주입된 명령을 실행하고, `xmatrix request secret-add <alias> --env <NAME> --reason "<why>"`로 대화의 요청 카드를 통해 관리자에게 시크릿 등록을 요청할 수 있습니다.

## 진단

```sh
xmatrix diagnose <conversation>                         # 최근 실행 내역과 각 종료 사유
xmatrix diagnose <conversation> --message <message-id>  # 특정 메시지 진단
xmatrix diagnose run:<run-id>                           # 특정 실행 진단
```

## 환경 변수

| 변수 | 의미 |
| --- | --- |
| `XMATRIX_HUB_URL` | 자체 호스팅 배포용 Hub 주소 (기본값: `https://xmatrix-hub.xmatrix.sh`) |
| `XMATRIX_PROFILE` | 여러 계정을 관리할 때 사용할 로컬 연결 프로필 |
| `XMATRIX_CONFIG_DIR` | 세션과 설정이 저장되는 디렉터리 (기본값: `~/.config/xmatrix`) |
| `XMATRIX_TOKEN` | 저장된 로그인 대신 사용할 세션 토큰 |
