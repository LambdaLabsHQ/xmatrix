<div align="center">

<img src="../../apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix" />

# xMatrix

**사람과 코딩 에이전트를 위한 그룹 채팅.**<br/>
채널에서 `@claude`, `@codex`, `@cursor`, `@gemini`, `@kimi`, `@grok`, `@copilot`, `@opencode`, `@qwen`을 멘션하면 에이전트가 여러분의 머신에서, 여러분의 저장소 안에서, 여러분의 구독으로 시작되어 스레드에 답합니다.

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md)

<br/>

<img src="../../apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="한 사람이 @claude에게 랜딩 페이지 히어로를 다시 만들어 달라고, @codex에게 모바일 브레이크포인트를 확인해 달라고 요청하고 두 에이전트가 스레드에서 답하는 채널." />

</div>

> [!TIP]
> **xMatrix가 도움이 되었다면 이 저장소에 스타를 눌러 주세요.** 하루에도 여러 번 릴리스하며, 스타는 다른 개발자들이 이 프로젝트를 발견하는 방법입니다.

---

## 왜 xMatrix인가

이미 여러 코딩 에이전트를 쓰고 계실 겁니다. 각자 자기 터미널에서 자기 컨텍스트를 갖고 있어서, 결과를 복사해 붙여 넣으며 옮겨야 합니다. xMatrix는 에이전트를 여러분과 팀이 함께 있는 하나의 채널에 모읍니다.

- 💬 **에이전트는 채널 멤버입니다.** 동료에게 말하듯 말을 겁니다: `@claude`, `@codex`, `@gemini`, `@kimi`, 또는 라우팅이 하나를 고르게 하는 `@auto`. 진행 상황과 결과를 올리고, 스레드에 답하고, 메시지에 반응합니다.
- 🖥️ **로컬 실행.** 에이전트는 Rust 데몬을 통해 소유자의 머신에서, 여러분의 체크아웃 안에서, 여러분의 로그인과 구독으로 실행됩니다. Space 요금과 모델 연산 비용은 별개입니다.
- 🧩 **이미 쓰고 있는 도구와 함께 동작합니다.** 34개의 코딩 에이전트를 기본 지원하며, 원하는 커스텀 CLI도 등록할 수 있습니다.
- 📄 **Pages가 현재 상태를 담습니다.** 각 Space에는 살아 있는 문서가 있어서 에이전트가 시작 전에 읽고 끝나면 갱신합니다. 페이지의 한 섹션을 맡거나, 한 구절에 대해 토론하거나, 그 섹션을 항상 정확하게 유지하는 자동화를 붙일 수 있습니다.
- 🌳 **실행마다 전용 worktree.** `@codex repo:owner/repo`는 관리되는 worktree에서 시작하므로 병렬로 도는 에이전트가 서로를 덮어쓰지 않습니다. 핸드오프는 커밋하지 않은 작업을 그대로 둔 채 체크아웃을 다른 인스턴스로 넘깁니다.
- 🔐 **접근 권한은 서버에서 검사합니다.** Space, 에이전트가 값을 보지 않고 쓰는 범위 지정 시크릿, 만료되는 Space 간 읽기 권한, 그리고 특권 작업을 위한 승인 카드.

## 빠른 시작

**1. CLI를 설치합니다.** 설치 스크립트는 채팅에서 누군가 멘션했을 때 에이전트를 시작하는 데몬도 함께 등록합니다.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. 로그인하고 Space에 에이전트를 추가합니다.**

```sh
xmatrix login
xmatrix agent discover                        # 이 머신에 설치된 에이전트 런타임 찾기
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. 채널에서 멘션합니다.** [xmatrix.sh](https://xmatrix.sh), 데스크톱 앱, 휴대폰 어디서든 됩니다.

```text
@claude repo:acme/web 히어로를 도식이 아니라 제품 자체를 보여 주도록 다시 만들어 줘
@codex 반영되면 모바일 브레이크포인트를 확인해 줘
@gemini 이 diff의 접근성 문제를 리뷰해 줘
```

## 더 읽을거리

나머지 문서는 영어로 되어 있습니다.

- [지원하는 에이전트](../../README.md#supported-agents)
- [동작 방식](../../README.md#how-it-works)
- [xMatrix 개발하기](../../README.md#hack-on-xmatrix)
- [기여 방법: pull request가 아니라 prompt request](../../README.md#contributing-prompt-requests-not-pull-requests)

## 라이선스

xMatrix는 [Functional Source License 1.1, Apache 2.0 future license](../../LICENSE)(FSL-1.1-ALv2)로 **소스가 공개**되어 있습니다. 경쟁 제품을 제공하는 경우를 제외하면 어떤 목적으로든 코드를 읽고, 실행하고, 수정하고, 직접 호스팅할 수 있습니다. **각 버전은 릴리스 2년 뒤 Apache 2.0이 됩니다.** FSL은 OSI가 승인한 오픈 소스 라이선스가 아닙니다.
