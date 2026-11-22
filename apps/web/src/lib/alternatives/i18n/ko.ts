import type { AlternativeLocaleCopy, AlternativeSlug } from "../types";

export const alternativesCopyKo: Readonly<Record<AlternativeSlug, AlternativeLocaleCopy>> = {
  raft: {
    alsoKnownAs: "구 Slock",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Raft 대안 (2026): Raft vs xMatrix",
    metaDescription:
      "Raft(구 Slock) 대안을 찾고 계신가요? Raft와 xMatrix를 비교해 보세요. 채팅에 묻힌 기록과 종료된 Wiki Agent 대신 살아 있는 프로젝트 페이지, 35종 코딩 에이전트, 35개 연동 앱 권한 거버넌스를 제공합니다.",
    eyebrow: "Raft 대안 · Raft vs xMatrix",
    headline: "결정 사항이 채팅에 묻히지 않고 살아 있는 페이지로 남는 Raft 대안",
    lead: "Raft는 코딩 에이전트를 채팅 팀원으로 취급하며 2026년 9월 Wiki Agent를 종료했습니다. xMatrix는 사람과 35종 코딩 에이전트가 함께 쓰는 공유 채널을 유지하면서도, 완료된 작업을 살아 있는 페이지로 정리해 모든 머신과 35개 연동 앱에서 최신 상태를 유지합니다.",
    productCaption:
      "xMatrix 화면: 사람과 코딩 에이전트가 채널에서 협업하는 동시에 채팅 스크롤과 로컬 MEMORY.md에 맥락을 흩뿌리지 않고 하나의 살아 있는 프로젝트 페이지를 최신 상태로 유지합니다.",
    painPoints: [
      {
        title: "작업 맥락이 채팅 기록과 머신별 MEMORY.md 파일에 갇힘",
        problem:
          "Raft는 2026년 9월 24일 Wiki Agent를 종료했고, 각 에이전트가 단일 머신의 로컬 MEMORY.md와 notes/에 묶여 있습니다. 에이전트가 초기에 잘못된 가정을 기록하면 사람이 직접 정리할 때까지 오래된 맥락이 핸드오프 내내 남으며, Free 플랜에서는 워크스페이스 기록이 30일로 제한됩니다.",
        xmatrixAnswer:
          "xMatrix는 살아 있는 페이지를 제품의 핵심 결과물로 삼습니다. 작업이 완료되면 에이전트가 관련 섹션을 바로 업데이트하며, 사람이 문단을 편집하면 에이전트가 대기했다가 사람이 쓴 내용을 기준으로 이어갑니다.",
      },
      {
        title: "Stamp는 GitHub에만 적용되어 운영 커넥터 전반의 단일 승인 체계가 없음",
        problem:
          "Raft의 Stamp는 GitHub 푸시와 PR에 사람 승인을 추가하지만, 실제 소프트웨어를 배포하는 팀은 Vercel, Cloudflare, Linear, Sentry, Gmail, Stripe, Google Workspace도 함께 다룹니다. 그 외 영역에서 Raft의 에이전트 런타임은 권한 검사를 우회해 실행됩니다.",
        xmatrixAnswer:
          "xMatrix는 35개 연동 앱 전체에 하나의 앱별 정책(읽기 전용, 먼저 묻기, 읽기·쓰기 — GitHub는 읽기 전용과 읽기·쓰기 제공)을 적용하며, 스페이스 시크릿을 xmatrix secret exec로 주입해 에이전트가 원본 시크릿 값을 직접 읽지 못하게 합니다.",
      },
      {
        title: "Pro 플랜에서도 에이전트에 시트 비용이 들고 한 대의 컴퓨터에 묶임",
        problem:
          "Raft Pro(사람 시트당 월 $10, 연간 결제 시 $8.80)에서는 모든 에이전트가 0.1 시트로 과금되며 각 에이전트가 머신 한 대에 고정됩니다. 해당 노트북이 오프라인이 되면 에이전트도 멈춥니다.",
        xmatrixAnswer:
          "xMatrix는 등록한 모든 macOS, Windows, Linux 머신에서 에이전트 시트당 $0로 35종 코딩 에이전트(및 --runtime 커스텀 CLI)를 지원하며, 적합도와 여유 리소스에 따라 작업을 라우팅합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "프로젝트 상태가 저장되는 곳",
        xmatrix: "에이전트가 최신으로 유지하고 사람과 공동 편집하는 살아 있는 페이지",
        competitor: "채팅 스레드, 번호가 붙은 태스크, 머신별 MEMORY.md (Wiki Agent 종료)",
      },
      {
        dimension: "승인 및 시크릿 계층",
        xmatrix: "35개 앱의 앱별 정책 + 스페이스 시크릿(GitHub: 읽기 전용 / 읽기·쓰기)",
        competitor: "GitHub 푸시/PR용 Stamp; 로컬 프록시 토큰; 런타임 권한 검사 우회",
      },
      {
        dimension: "지원 에이전트 및 요금",
        xmatrix: "35종 코딩 에이전트(+ --runtime); Free(총 500회 쓰기) / Pro 사람 시트당 월 $10(연간 월 $8)",
        competitor: "제한된 런타임 수; Free(30일 기록); Pro 시트당 월 $10(연간 $8.80) + 에이전트당 0.1 시트",
      },
      {
        dimension: "라우팅 및 페일오버",
        xmatrix: "@auto가 적합도와 머신 여유량으로 선택; 할당량 소진 시 프로바이더 간 핸드오프",
        competitor: "에이전트당 단일 런타임 고정; 해당 프로바이더나 머신이 멈추면 중단",
      },
      {
        dimension: "소스 코드 공개 여부",
        xmatrix: "FSL-1.1-ALv2 라이선스로 소스 공개(Source-available)",
        competitor: "소스 미러 공개; Enterprise SSO 미출시",
      },
    ],
    stayWhen: [
      "살아 있는 문서보다 30일 무제한 무료 채팅이 가능한 메신저·태스크 중심 레이아웃을 선호하는 경우.",
      "승인 요건이 Stamp로 처리되는 GitHub 푸시와 PR에만 한정된 경우.",
    ],
    switchWhen: [
      "실제로 무엇이 배포되었는지 파악하려고 채널을 거슬러 올라가거나 낡은 로컬 MEMORY.md를 디버깅하는 데 지친 경우.",
      "Vercel, Cloudflare, Linear, Sentry, Gmail, Stripe에 대해 하나의 스페이스 시크릿 저장소 아래 통제된 접근 권한이 필요한 경우.",
      "0.1 시트 과금 부담 없이 여러 머신에서 수십 개의 특화·단기 에이전트를 운영하고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 로컬 저장소와 CLI 구독을 그대로 유지하세요",
        detail:
          "Raft Computer를 돌리던 macOS, Windows, Linux 호스트에 xMatrix CLI를 설치하세요. Claude Code, Codex, Cursor 로그인은 로컬에 그대로 남습니다.",
      },
      {
        title: "고정된 채널 맥락을 살아 있는 페이지로 승격하세요",
        detail:
          "진행 중인 프로젝트나 제품 라인마다 페이지를 하나씩 만들면, 제각각 어긋나는 MEMORY.md 대신 모든 에이전트가 최신 결정을 한곳에서 읽습니다.",
      },
      {
        title: "API 토큰을 스페이스 시크릿으로 옮기고 앱을 연결하세요",
        detail:
          "GitHub(읽기 전용 또는 읽기·쓰기)과 함께 Linear, Vercel, Cloudflare, Sentry를 먼저 묻기(Ask first) 규칙으로 연결하고 나머지 자격 증명은 스페이스 시크릿에 보관하세요.",
      },
    ],
    faqs: [
      {
        question: "둘 다 사람과 에이전트가 함께 쓰는 채널이 있는데, xMatrix는 Raft와 무엇이 다른가요?",
        answer:
          "Raft에서는 채팅 메시지와 태스크가 최종 기록이며 Wiki Agent는 종료되었습니다. xMatrix에서는 대화가 작업을 실행하는 공간이고, 살아 있는 페이지가 결정 사항·현재 상태·남은 작업을 최신으로 보관하는 공식 기록입니다.",
      },
      {
        question: "xMatrix도 Raft Pro처럼 에이전트당 0.1 시트를 과금하나요?",
        answer:
          "아니요. Free와 Pro 모두 에이전트 시트 비용은 없습니다. Pro는 사람 시트당 월 $10(연 $96/시트)이며 매월 시트당 5,000 에이전트 크레딧이 포함되고, 사람의 편집과 메시지는 무료입니다.",
      },
      {
        question: "xMatrix도 Raft처럼 비공개 채널을 지원하나요?",
        answer:
          "네. 스페이스 내에서 공개 채널과 비공개 채널을 모두 지원하며, 스페이스 시크릿과 앱별 승인 정책도 함께 제공합니다.",
      },
    ],
  },
  lody: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Lody 대안 (2026): Lody vs xMatrix",
    metaDescription:
      "Lody 대안을 비교 중이신가요? 단일 세션 워크트리와 데몬 동기화 끊김 대신 xMatrix의 다중 사용자 공유 채널, 살아 있는 페이지, 스페이스 시크릿, 웹훅 루틴으로 전환하세요.",
    eyebrow: "Lody 대안 · Lody vs xMatrix",
    headline: "팀 전체와 모든 에이전트가 함께 쓰는 하나의 채널, 하나의 살아 있는 페이지",
    lead: "Lody는 비공개 소스 클라우드 릴레이로 동기화되는 1세션-1워크트리 스레드 중심으로 동작합니다. xMatrix는 팀원과 35종 코딩 에이전트를 하나의 공유 채널로 모으고, 작업이 완료될 때마다 살아 있는 페이지를 최신화하며, 스페이스 시크릿과 이벤트 기반 Norn 프로그램을 함께 제공합니다.",
    productCaption:
      "xMatrix 화면: 고립된 코딩 세션을 한 명씩 주고받는 대신, 팀원들과 35종 코딩 에이전트가 하나의 공유 채널에서 협업하고 결과를 살아 있는 페이지에 반영합니다.",
    painPoints: [
      {
        title: "세션 중심 UX에 공유 팀 채널과 살아 있는 문서가 빠져 있음",
        problem:
          "Lody는 개별 코딩 세션과 하위 세션 트리를 중심으로 설계되었습니다. 팀원에게 세션을 넘길 수는 있지만 다중 사용자+다중 에이전트 채널, 멤버 @멘션, 공유 프로젝트 문서는 핵심 워크플로가 아니라 로드맵 항목에 머물러 있습니다.",
        xmatrixAnswer:
          "xMatrix는 첫날부터 여러 사람과 여러 에이전트가 같은 채널에서 일하며, 완료된 모든 실행이 프로젝트 상태를 추적하는 공유 페이지를 업데이트합니다.",
      },
      {
        title: "기기 간 데몬 하트비트 끊김과 워크트리 락 경합",
        problem:
          "커뮤니티 피드백과 GitHub 이슈 트래커(LodyAI/Lody의 미해결 이슈 334건, 일일 E2E 데스크톱 추적 이슈 #507 포함)에서는 원격 npx lody 데몬 연결 끊김, 로그인 링크 시간 초과, 동시 git 워크트리 락 오류, ACP 트랜스크립트 멈춤 문제가 꾸준히 보고되고 있습니다.",
        xmatrixAnswer:
          "xMatrix는 허브 권한과 로컬 데몬 실행을 분리하고 제한된 결과 아웃박스와 명시적 실행 수명주기 전이를 사용해 재연결 시 상태 유실 없이 깔끔하게 복구합니다.",
      },
      {
        title: "워크스페이스 시크릿, 앱 승인 정책, 웹훅 자동화 부재",
        problem:
          "Lody는 워크스페이스 시크릿 볼트 없이 세션 단위로만 권한을 지정하며, 운영 도구용 앱별 커넥터 거버넌스가 없고 크론 작업은 지원하지만 인바운드 웹훅 트리거가 없습니다.",
        xmatrixAnswer:
          "xMatrix는 런타임에 주입되는 스페이스 시크릿, 35개 연동 앱의 앱별 승인 제어, 그리고 일정과 GitHub·Sentry 같은 외부 이벤트로 실행되는 페이지 내장 Norn 프로그램을 제공합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "핵심 협업 단위",
        xmatrix: "다중 사용자·다중 에이전트 채널이 뒷받침하는 살아 있는 페이지",
        competitor: "개별 세션과 하위 세션 트리(세션당 워크트리 1개)",
      },
      {
        dimension: "시크릿 및 외부 운영 도구",
        xmatrix: "스페이스 시크릿(xmatrix secret exec) + 35개 연동 앱 거버넌스",
        competitor: "세션별 권한만 제공; 워크스페이스 시크릿 저장소 없음",
      },
      {
        dimension: "자동화 트리거",
        xmatrix: "페이지 안에 내장된 일정 및 이벤트 기반 Norn 프로그램",
        competitor: "예약 크론 태스크 및 할당량 초기화 재개; 웹훅 트리거 없음",
      },
      {
        dimension: "지원 에이전트 및 라우팅",
        xmatrix: "35종 코딩 에이전트(+ --runtime)를 적합도·여유량·할당량 핸드오프로 라우팅",
        competitor: "같은 프로바이더의 할당량이 초기화될 때까지 대기 후 재개",
      },
      {
        dimension: "요금제",
        xmatrix: "Free(최대 3명, 총 500회 쓰기) / Pro 시트당 월 $10(연간 월 $8)",
        competitor: "Free(3명, 워크스페이스 2개) / Plus 시트당 월 $8(연간) / Enterprise",
      },
    ],
    stayWhen: [
      "세션 트리 모델 기반의 iOS Dynamic Island 잠금 화면 승인 워크플로를 꼭 원하시는 경우.",
      "팀이 코딩 세션만 조율하면 되고 살아 있는 문서나 git 외 운영 커넥터가 필요 없는 경우.",
    ],
    switchWhen: [
      "단일 세션을 주고받는 대신 여러 팀원과 다양한 하네스가 하나의 실시간 채널에서 협업하고 싶은 경우.",
      "읽기 쉬운 페이지로 프로젝트 상태를 유지하고 웹훅 기반 루틴과 스페이스 시크릿까지 필요한 경우.",
      "데몬 동기화 끊김이나 워크트리 락 경합으로 원격 멀티 머신 작업 속도가 떨어지고 있는 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 머신을 xMatrix 데몬으로 등록하세요",
        detail:
          "사용 중인 Claude Code, Codex, Kimi 또는 ACP 호환 CLI를 그대로 유지하세요. xMatrix가 구독을 교체하지 않고 바로 감지·등록합니다.",
      },
      {
        title: "세션 이동 대신 프로젝트 페이지와 채널을 쓰세요",
        detail:
          "활성 저장소를 스페이스 페이지에 연결하면 사람과 에이전트가 한 스레드에서 조율하고 영구적인 결과를 페이지에 기록합니다.",
      },
      {
        title: "GitHub, Sentry 및 배포 커넥터를 연결하세요",
        detail:
          "외부 이벤트 소스를 연결해 수동 세션 시작을 기다리지 않고 루틴이 에이전트를 자동으로 깨우게 하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix도 Lody처럼 내 머신에서 코딩 에이전트를 실행할 수 있나요?",
        answer:
          "네. 에이전트는 등록한 폴더와 저장소에서 본인 소유의 macOS, Windows, Linux 컴퓨터(또는 자체 서버)에서 직접 실행됩니다.",
      },
      {
        question: "프로바이더 사용량 제한(rate limit) 처리는 Lody와 어떻게 다른가요?",
        answer:
          "한 프로바이더의 초기화 주기를 기다리며 세션을 멈추는 대신, xMatrix는 Claude Code에서 Codex나 Gemini 등 사용 가능한 다른 하네스로 대화를 핸드오프할 수 있습니다.",
      },
      {
        question: "xMatrix의 동기화 서버도 Lody처럼 비공개 소스인가요?",
        answer:
          "xMatrix는 Hub, Web, CLI, 클라이언트 전체 소스를 FSL-1.1-ALv2로 공개합니다. 다만 자체 호스팅 패키지가 아닌 셀프서브 호스팅 서비스 형태로 제공됩니다.",
      },
    ],
  },
  multica: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Multica 대안 (2026): Multica vs xMatrix",
    metaDescription:
      "Multica 대안을 검토 중이신가요? 헤드리스 티켓 실행, 조용한 bypassPermissions 해제(#9559), 평문 환경 변수 대신 xMatrix의 실시간 채널, 살아 있는 페이지, 스페이스 시크릿을 써 보세요.",
    eyebrow: "Multica 대안 · Multica vs xMatrix",
    headline: "모든 요청을 티켓으로 만들지 마세요 — 한 번 말하면 에이전트가 배포하고 페이지가 최신화됩니다",
    lead: "Multica는 모든 에이전트 작업을 bypassPermissions 기본값의 헤드리스 칸반 이슈로 강제하며 살아 있는 문서 계층이 없습니다. xMatrix는 사람과 35종 코딩 에이전트가 공유 채널에서 실시간으로 협업(또는 xmatrix claude로 대화형 세션 연결)하고, 살아 있는 페이지를 최신으로 유지하며, 스페이스 시크릿으로 35개 연동 앱을 통제합니다.",
    productCaption:
      "xMatrix 화면: 보이지 않는 헤드리스 보드 실행 대신, 공유 채널에서 팀원들과 함께 Claude Code, Codex 및 33종 기타 코딩 에이전트를 실시간으로 조율하고 명시적 앱 승인과 살아 있는 페이지를 유지합니다.",
    painPoints: [
      {
        title: "강제 bypassPermissions 기본값, 제한 옵션의 조용한 무시, 서버 평문 환경 변수",
        problem:
          "Multica는 Claude Code를 --permission-mode bypassPermissions로, Codex를 full-auto 모드로 실행하며 서버 환경 변수를 평문으로 저장합니다. 커뮤니티 버그 #9559에서는 custom_args가 사용자가 지정한 --permission-mode 제한을 조용히 무시하는 문제가 드러났습니다.",
        xmatrixAnswer:
          "xMatrix는 35개 연동 앱 전반의 외부 작업을 앱별 읽기 전용, 먼저 묻기, 읽기·쓰기 정책(GitHub는 읽기 전용 / 읽기·쓰기)으로 통제하고, 스페이스 시크릿을 xmatrix secret exec로 런타임에 주입해 원본 자격 증명이 서버 환경 변수나 채팅 기록에 남지 않도록 합니다.",
      },
      {
        title: "모든 일을 헤드리스 티켓으로 만들어야 하며 공유 채널과 대화형 세션 연결이 없음",
        problem:
          "Multica의 앱 내 채팅은 1:1 비공개로 제한되며, 작업을 헤드리스 보드 티켓으로 전환해야 합니다. 실행 중인 에이전트의 방향을 중간에 수정하거나 진행 중인 로컬 터미널 세션을 팀 대화로 끌어오는 기능도 지원되지 않습니다.",
        xmatrixAnswer:
          "xMatrix에서는 팀원과 35종 코딩 에이전트가 공유 채널에서 실시간으로 함께 일하며, xmatrix claude로 기존 로컬 터미널 세션을 채널에 바로 연결하고 결과를 살아 있는 페이지에 반영할 수 있습니다.",
      },
      {
        title: "살아 있는 페이지와 내장 프로젝트 메모리 부재",
        problem:
          "Multica는 이슈와 스킬만 추적할 뿐 변화하는 프로젝트의 현재 상태를 담지 못합니다. 커뮤니티의 메모리 기능 요청(#838)은 2026년 4월 이후 답변 없이 방치되어 결정 사항이 닫힌 티켓 속에 흩어집니다.",
        xmatrixAnswer:
          "살아 있는 페이지는 모든 xMatrix 스페이스에 기본 내장되어 있습니다. 모든 결정은 한 번만 기록되어 제안 모드와 문단별 작성자 기록을 갖춘 채 사람과 공동 편집되며 작업을 수행하는 에이전트가 최신 상태로 유지합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "협업 모델",
        xmatrix: "다중 사용자 + 다중 에이전트 공유 채널 + xmatrix claude 세션 연결 + 살아 있는 페이지",
        competitor: "칸반 이슈 보드 + 헤드리스 실행 전용 + 1:1 비공개 채팅",
      },
      {
        dimension: "외부 작업 및 시크릿",
        xmatrix: "35개 앱의 앱별 정책 + 마스킹된 스페이스 시크릿(런타임 주입)",
        competitor: "bypassPermissions 기본값(#9559); 서버 평문 환경 변수; MCP 스키마 승인",
      },
      {
        dimension: "살아 있는 문서",
        xmatrix: "에이전트가 업데이트하는 네이티브 페이지; 제안 모드, 작성자 기록, 사람 편집 우선",
        competitor: "없음 (메모리 기능 요청 #838 미해결)",
      },
      {
        dimension: "지원 코딩 에이전트",
        xmatrix: "35종 코딩 에이전트 내장(+ --runtime 커스텀 CLI)",
        competitor: "28종 CLI 런타임",
      },
      {
        dimension: "외부 운영 커넥터",
        xmatrix: "35개 네이티브 연동 앱(GitHub, Linear, Vercel, Cloudflare, Sentry, Gmail, Stripe 등)",
        competitor: "채팅 브리지(Slack, Lark, DingTalk, WeCom, Telegram) + MCP 플러그인",
      },
    ],
    stayWhen: [
      "사내망 내부에서 자체 호스팅 Go + PostgreSQL 이슈 보드 자동화가 반드시 필요한 조직인 경우.",
      "모든 업무 단위를 독립된 칸반 티켓으로 처리하며 DingTalk, WeCom, Lark 트리거 의존도가 높은 경우.",
    ],
    switchWhen: [
      "블라인드 헤드리스 티켓 실행 대신 팀원들과 여러 코딩 에이전트가 실시간으로 방향을 조율하며 협업하고 싶은 경우.",
      "프로덕션 배포나 운영 도구에 평문 서버 환경 변수와 bypassPermissions 기본값을 허용할 수 없는 경우.",
      "닫힌 이슈에 파묻히는 대신 프로젝트 결정과 남은 작업을 살아 있는 페이지에 자동 유지하고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 개발자 머신을 그대로 연결하세요",
        detail:
          "Multica 데몬을 돌리던 머신에 xMatrix CLI를 설치하면 로컬 Claude Code, Codex, Cursor 설정이 즉시 작동합니다.",
      },
      {
        title: "반복 Autopilot 작업을 페이지 Norn 루틴으로 옮기세요",
        detail:
          "일정 및 이벤트 기반 루틴을 최신 상태로 유지할 프로젝트 페이지 안에 직접 배치하면 매 실행 결과가 모두가 읽는 자리에 바로 반영됩니다.",
      },
      {
        title: "평문 환경 변수를 스페이스 시크릿으로 교체하세요",
        detail:
          "토큰을 xMatrix 스페이스 시크릿에 저장하고 GitHub, Linear, Sentry, Vercel을 명시적 승인 정책으로 연결하세요.",
      },
    ],
    faqs: [
      {
        question: "Multica 보드에서 벗어나도 Linear나 GitHub Issues와 함께 쓸 수 있나요?",
        answer:
          "네. xMatrix는 GitHub과 Linear에 직접 연결되므로 기존 이슈 트래커를 버리지 않고도 에이전트가 이슈를 읽고 PR을 열며 프로젝트 페이지를 업데이트할 수 있습니다.",
      },
      {
        question: "xMatrix는 Claude Code에 bypassPermissions를 강제하나요?",
        answer:
          "아니요. xMatrix는 머신 접근과 외부 앱 권한을 명시적으로 통제합니다. 연결된 앱은 읽기 전용, 먼저 묻기, 읽기 및 쓰기 모드를 지원하며 스페이스 시크릿은 에이전트 대화 기록에 평문으로 노출되지 않습니다.",
      },
      {
        question: "xMatrix에서는 여러 사람이 같은 에이전트를 함께 보고 조종할 수 있나요?",
        answer:
          "네. 여러 사람과 에이전트가 같은 채널을 공유하며 실시간 진행 내역과 승인 카드를 함께 보고 연결된 페이지를 공동 편집합니다.",
      },
    ],
  },
  paradev: {
    alsoKnownAs: "구 Superset",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Paradev (Superset) 대안 (2026): Paradev vs xMatrix",
    metaDescription:
      "Paradev(구 Superset) 대안을 찾고 계신가요? macOS, Windows, Linux, Android에서 공유 채널, 살아 있는 페이지, 35개 앱 승인, 시트당 $10 요금으로 코딩 팀을 운영하세요.",
    eyebrow: "Paradev (Superset) 대안 · Paradev vs xMatrix",
    headline: "어떤 OS에서도 쓰는 팀용 Paradev 대안: 공유 채널, 살아 있는 페이지, 시트당 $10",
    lead: "Paradev(2026년 10월 Superset에서 리브랜딩)는 macOS 우선 구조이며, 팀 협업은 사용자당 월 $60로 뛰고 원격 호스트를 열면 머신 전체가 노출됩니다. xMatrix는 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 사람 시트당 월 $10에 공유 채널, 살아 있는 페이지, 35개 연동 앱 거버넌스를 제공합니다.",
    productCaption:
      "xMatrix 화면: 터미널 창 20개를 번갈아 감시하는 대신 깔끔한 채널과 살아 있는 페이지로 수십 개의 병렬 에이전트 대화를 차분하게 감독하세요.",
    painPoints: [
      {
        title: "터미널과 워크트리 난립이 병목을 사용자의 집중력으로 떠넘김",
        problem:
          "Product Hunt와 Reddit의 개발자들은 Paradev의 병렬 워크트리를 호평하면서도, 수십 개의 독립 터미널·diff 창·겹치는 브랜치를 오갈 때의 시각적 혼잡과 리뷰 피로, 그리고 클라우드 자동화 지출 상한 없이 치솟는 LLM 비용을 일관되게 지적합니다.",
        xmatrixAnswer:
          "xMatrix는 모든 터미널을 지켜보는 대신 프로젝트당 하나의 살아 있는 페이지를 읽는 방식으로 인터페이스를 뒤집었습니다. 대화는 백그라운드에서 진행되고, 사용자는 페이지를 훑어보다가 결정이나 예외가 필요할 때만 스레드에 개입합니다.",
      },
      {
        title: "원격 및 팀 협업에 붙는 가파른 시트당 $20~$60 페이월",
        problem:
          "Paradev 로컬 클라이언트는 무료(MIT)지만 원격 기능은 Pro(사용자당 월 $20, 연 $192)가 필요하고 팀 협업은 사용자당 월 $60로 뛰어오릅니다. 기존 Anthropic·OpenAI 구독료는 별도입니다.",
        xmatrixAnswer:
          "xMatrix Pro는 사람 시트당 월 $10(연간 결제 시 월 $8)에 에이전트 무제한, 시트당 에이전트 크레딧 5,000, 멀티 머신 채널을 모두 포함하며 별도 팀 티어 추가 요금이 없습니다.",
      },
      {
        title: "릴레이를 열면 머신 전체가 노출되며 스페이스 시크릿과 운영 커넥터가 없음",
        problem:
          "Paradev에는 스페이스 시크릿과 크로스 앱 승인 거버넌스 계층이 없어 원격 릴레이 권한을 부여하면 사실상 호스트 머신 전체가 권한 있는 팀원에게 열리게 됩니다.",
        xmatrixAnswer:
          "xMatrix는 에이전트를 등록된 저장소와 폴더로 제한하고, 원본 값을 출력하지 않고 스페이스 시크릿을 주입하며, 35개 연동 앱에 앱별 정책을 강제합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "팀 요금제",
        xmatrix: "사람 시트당 월 $10(연간 월 $8); 최대 3명까지 무료(총 500회 쓰기)",
        competitor: "Free(1인 로컬) / Pro 사용자당 월 $20 / Team 사용자당 월 $60(클라우드 150시간)",
      },
      {
        dimension: "핵심 워크플로",
        xmatrix: "공유 채널 + 작업 완료 시 에이전트가 최신화하는 살아 있는 페이지",
        competitor: "병렬 IDE/워크트리 워크스페이스 + 고정 댓글이 달린 게시 페이지",
      },
      {
        dimension: "에이전트 실행 위치",
        xmatrix: "본인 소유의 macOS, Windows, Linux 머신(노트북·데스크톱·자체 서버)",
        competitor: "macOS 우선 로컬 IDE, 원격 SSH/릴레이 호스트, 또는 Vercel 클라우드 샌드박스",
      },
      {
        dimension: "시크릿 및 운영 앱",
        xmatrix: "스페이스 시크릿 볼트 + 앱별 승인 정책을 갖춘 35개 연동 앱",
        competitor: "워크스페이스 외부 인라인 승인; 스페이스 시크릿 없음; 개발 트리거만 지원",
      },
      {
        dimension: "다중 사용자 실시간 채팅",
        xmatrix: "네이티브 다중 사용자 + 다중 에이전트 공개·비공개 채널",
        competitor: "워크스페이스 및 페이지 댓글; 다중 에이전트 공유 팀 채널 없음",
      },
    ],
    stayWhen: [
      "직접 VM을 띄우지 않고 노트북을 덮어도 계속 돌아가는 Paradev의 턴키 Vercel 클라우드 샌드박스가 꼭 필요한 경우.",
      "시각적 워크트리 diff와 요소 고정 페이지 리뷰 댓글 중심의 IDE형 데스크톱 앱을 선호하는 경우.",
    ],
    switchWhen: [
      "이미 내고 있는 Claude/Codex 구독료에 더해 본인 머신에서 소규모 팀을 조율하려고 시트당 $20~$60를 내는 것이 과하다고 느끼는 경우.",
      "터미널 20개를 오가는 대신 20개 병렬 에이전트 스레드를 한 장으로 요약하는 살아 있는 페이지를 원하는 경우.",
      "git 워크트리뿐만 아니라 Cloudflare, Vercel, Gmail, Stripe, Sentry, Google Workspace에 대한 승인 기반 접근이 필요한 경우.",
    ],
    migrationSteps: [
      {
        title: "macOS, Linux, Windows 호스트를 xMatrix에 등록하세요",
        detail:
          "macOS 전용 클라이언트 제약 없이 기존 워크스테이션과 자체 상시 가동 Linux 서버를 하나의 스페이스로 묶으세요.",
      },
      {
        title: "멀티 탭 감시를 프로젝트 페이지로 대체하세요",
        detail:
          "하나의 페이지에 연결된 채널에서 에이전트를 호출하면 모든 PR, 테스트 실행, 결정 사항이 자동으로 취합됩니다.",
      },
      {
        title: "자격 증명과 앱 권한을 중앙에서 관리하세요",
        detail:
          "연결된 앱에 읽기 전용 또는 먼저 묻기 정책을 설정하고 공유 토큰은 스페이스 시크릿에 보관하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix도 Paradev Team처럼 관리형 클라우드 샌드박스를 제공하나요?",
        answer:
          "현재는 제공하지 않습니다. xMatrix는 사용자가 직접 제어하는 컴퓨터와 클라우드 VM(macOS, Windows, Linux)에서 에이전트를 실행합니다. 이미 상시 켜 둔 VPS나 빌드 머신이 있다면 노트북과 함께 깔끔하게 연결할 수 있습니다.",
      },
      {
        question: "xMatrix는 Paradev의 터미널 난립 문제를 어떻게 해결하나요?",
        answer:
          "수십 개의 원시 터미널 창을 일일이 확인하는 대신, xMatrix의 각 대화가 결과를 살아 있는 페이지에 보고하므로 현재 상태를 몇 초 만에 파악할 수 있습니다.",
      },
      {
        question: "Superset이 Paradev로 바뀐 건가요?",
        answer:
          "네. Superset은 2026년 10월 Paradev(GitHub: ParadevAI/Paradev)로 리브랜딩했습니다. 이 페이지의 모든 내용은 2026년 11월 22일 기준 Paradev의 최신 요금제와 아키텍처를 반영합니다.",
      },
    ],
  },
  conductor: {
    verifiedDate: "2026년 11월 22일",
    statusNote: "2026년 11월 Meta에 인수되었으며, Conductor Cloud는 2026년 11월 20일 서비스를 종료했습니다.",
    metaTitle: "Conductor 대안 (2026): Meta 종료 후 xMatrix 전환",
    metaDescription:
      "Conductor가 Meta에 인수되어 2026년 11월 20일 Conductor Cloud가 종료되었습니다. macOS, Windows, Linux에서 시트당 $10로 Claude Code와 Codex 팀을 운영하는 xMatrix로 전환하세요.",
    eyebrow: "Conductor 대안 · Meta 인수 이후 마이그레이션",
    headline: "Meta의 Conductor 종료 후 옮겨 갈 곳: Mac·Windows·Linux와 살아 있는 페이지",
    lead: "Meta는 2026년 11월 Conductor를 인수한 뒤 신규 가입을 중단하고 2026년 11월 20일 Conductor Cloud를 종료했으며, macOS 전용 로컬 앱도 2027년 초까지만 유지보수 모드로 전환했습니다. xMatrix는 macOS, Windows, Linux에서 35종 코딩 에이전트를 운영하고 팀 맥락을 살아 있는 페이지로 유지할 수 있는 독립적이고 활발한 대안입니다.",
    productCaption:
      "xMatrix 화면: Conductor에서 내보낸 저장소와 Claude Code·Codex 로그인을 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)을 아우르는 하나의 크로스 OS 워크스페이스로 옮겨 오세요.",
    painPoints: [
      {
        title: "Conductor Cloud 종료 및 제품 로드맵 축소",
        problem:
          "2026년 11월 Meta 인수 이후 Conductor Cloud는 11월 13일 읽기 전용으로 전환된 뒤 11월 20일 영구 종료되었습니다. 신규 사용자는 더 이상 가입할 수 없으며, 팀이 Meta Superintelligence Labs로 이동함에 따라 로컬 앱도 2027년 초까지만 치명적 버그 수정만 제공됩니다.",
        xmatrixAnswer:
          "xMatrix는 활발히 개발 중인 소스 공개(FSL-1.1-ALv2) 제품으로, 빅테크 인수자에 의존하지 않고 셀프서브 요금제로 장기적인 독립 팀 워크플로를 지원합니다.",
      },
      {
        title: "Windows와 Linux 팀원을 배제했던 macOS 전용 종속성",
        problem:
          "독립 운영 기간 내내 Conductor는 Windows나 Linux 네이티브 앱을 출시하지 않아, 혼합 OS 엔지니어링 팀은 도구를 쪼개 쓰거나 워크스페이스 공유만을 위해 Mac을 구매해야 했습니다.",
        xmatrixAnswer:
          "xMatrix는 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 모두 실행됩니다. Linux 빌드 서버, Windows 개발 머신, MacBook을 정확히 같은 스페이스에 연결할 수 있습니다.",
      },
      {
        title: "살아 있는 프로젝트 페이지 부재와 종료 전 월 $50~$60의 높은 가격",
        problem:
          "Conductor는 Pro 월 $50, Teams 사용자당 월 $60를 받으면서도 긴 대화 로그에서 UI 지연이 발생했고, 지식이 공유된 살아 있는 문서가 아니라 고립된 워크스페이스 안에 머물렀습니다.",
        xmatrixAnswer:
          "xMatrix Pro는 사람 시트당 월 $10(연간 월 $8)에 35종 코딩 에이전트를 무제한으로 제공하며, 완료된 작업을 살아 있는 페이지로 정리하고 35개 연동 앱 거버넌스와 스페이스 시크릿을 더해 줍니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "제품 상태 (2026년 11월 기준)",
        xmatrix: "활발히 운영 중, 독립 제품, 신규 가입 가능, 소스 공개",
        competitor: "Meta에 인수; 2026년 11월 20일 Cloud 종료; 신규 가입 중단",
      },
      {
        dimension: "지원 운영체제",
        xmatrix: "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)",
        competitor: "macOS 및 iOS 전용; Windows·Linux 네이티브 미지원",
      },
      {
        dimension: "요금제",
        xmatrix: "무료 플랜(총 500회 쓰기) + Pro 사람 시트당 월 $10(연간 월 $8)",
        competitor: "기존 Pro 월 $50, Teams 사용자당 월 $60 (종료 시 환불)",
      },
      {
        dimension: "멀티 에이전트 산출물",
        xmatrix: "35종 코딩 에이전트를 아우르는 살아 있는 페이지 + 다중 사용자 공유 채널",
        competitor: "병렬 워크트리 세션 및 diff 뷰",
      },
      {
        dimension: "거버넌스 및 커넥터",
        xmatrix: "35개 앱의 앱별 정책 + 스페이스 시크릿",
        competitor: "로컬 에이전트가 OS 전체 사용자 권한으로 실행; 운영 승인 계층 없음",
      },
    ],
    stayWhen: [
      "이미 Conductor Cloud 워크스페이스를 Mac 로컬로 내보냈고 2027년 초까지 임시로만 유지하면 되는 경우.",
    ],
    switchWhen: [
      "11월 20일 Conductor Cloud 종료 이후 지금 바로 Claude Code와 Codex용 멀티 머신 워크스페이스가 필요한 경우.",
      "팀에 Mac뿐 아니라 Windows나 Linux 머신이 함께 있는 경우.",
      "예측 가능한 시트당 $10 요금, 살아 있는 프로젝트 페이지, 그리고 GitHub·Linear·Vercel·Cloudflare용 승인 커넥터를 원하는 경우.",
    ],
    migrationSteps: [
      {
        title: "Conductor에서 내보낸 로컬 저장소를 그대로 유지하세요",
        detail:
          "Conductor의 'Transfer to local' 기능으로 내보냈다면 git 저장소와 브랜치가 이미 디스크에 있습니다. xMatrix는 해당 폴더에서 바로 동작합니다.",
      },
      {
        title: "머신과 기존 구독을 연결하세요",
        detail:
          "Mac, Linux VPS, Windows 머신에 xMatrix CLI를 설치하고 xmatrix agent add로 기존 Claude Code, Codex, Cursor 하네스를 추가하세요.",
      },
      {
        title: "팀 스페이스를 만들고 GitHub을 연결하세요",
        detail:
          "팀원을 초대하고 제품 영역별로 살아 있는 페이지를 만들면 macOS나 특정 벤더 종속 없이 병렬 에이전트를 계속 운영할 수 있습니다.",
      },
    ],
    faqs: [
      {
        question: "Conductor Cloud에서 내보낸 워크스페이스를 xMatrix로 옮길 수 있나요?",
        answer:
          "네. 로컬로 옮겼거나 GitHub에 호스팅된 모든 git 저장소를 xMatrix에 즉시 등록할 수 있으며, 이미 결제 중인 Claude Code와 Codex 구독을 그대로 사용합니다.",
      },
      {
        question: "xMatrix는 macOS뿐 아니라 Windows와 Linux에서도 동작하나요?",
        answer:
          "네. macOS 전용이었던 Conductor와 달리 xMatrix는 macOS, Windows, Linux 머신을 같은 스페이스에서 지원하며 웹과 모바일 클라이언트도 제공합니다.",
      },
      {
        question: "xMatrix도 Conductor Cloud처럼 호스팅 클라우드 VM을 제공하나요?",
        answer:
          "xMatrix는 독점 클라우드 샌드박스를 묶어 파는 대신 사용자가 제어하는 노트북, 사무실 서버, 자체 클라우드 VM(Fly, AWS, Hetzner 등)을 연결합니다. 덕분에 외부 클라우드 서비스 종료로 작업 환경이 사라질 위험이 없습니다.",
      },
    ],
  },
  orca: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Orca 대안 (2026): Orca vs xMatrix",
    metaDescription:
      "Orca(stablyai/orca) 대안을 비교 중이신가요? 싱글플레이어 RAM 폭증, 8,900건 이상의 미해결 이슈, 불안정한 LAN 모바일 페어링 대신 xMatrix의 멀티플레이어 채널과 살아 있는 페이지를 사용해 보세요.",
    eyebrow: "Orca 대안 · Orca vs xMatrix",
    headline: "혼자가 아닌 팀을 위한 Orca 대안: 하나의 채널, 하나의 살아 있는 페이지, 알맞은 라우팅",
    lead: "Orca는 병렬 로컬 워크트리에 프롬프트를 뿌려 주는 인기 오픈소스 싱글플레이어 ADE이지만, 멀티플레이어 UI는 아직 없고 프롬프트 하나를 N개 에이전트에 복제 실행하면 토큰 소모가 배로 뛰며 대규모 실행 시 로컬 RAM이 급증합니다. xMatrix는 35종 코딩 에이전트 중 가장 적합한 에이전트로 작업을 라우팅하고 팀 전체를 위해 살아 있는 페이지를 최신화합니다.",
    productCaption:
      "xMatrix 화면: 내장 브라우저의 RAM 폭증 없이 병렬 코딩 작업을 여러 머신에 분산하고, 데스크톱이나 모바일에서 깔끔하게 결과를 확인하세요.",
    painPoints: [
      {
        title: "여전히 싱글플레이어—공유 채널, 팀 ID, 스페이스 시크릿 부재",
        problem:
          "Orca는 개발자 혼자 로컬 에이전트 무리를 지휘하도록 만들어졌습니다. 멀티플레이어 UI는 출시되지 않았고, 실험적 Slack/Discord 브리지는 팀원 메시지를 수동 맥락으로만 취급하며, 스페이스 단위 시크릿 볼트나 앱별 승인 계층도 없습니다.",
        xmatrixAnswer:
          "xMatrix는 태생부터 멀티플레이어입니다. 여러 팀원과 에이전트가 공개·비공개 채널을 공유하고 앱별 정책으로 외부 작업을 승인하며 스페이스 시크릿을 안전하게 공유합니다.",
      },
      {
        title: "로컬 리소스 폭증, 크래시 적체, UI와 실제 에이전트 상태 불일치",
        problem:
          "stablyai/orca에는 8,988건의 미해결 이슈(크래시 언급 100건 이상)가 쌓여 있으며, 병렬 xterm과 내장 Chromium 인스턴스로 인한 심각한 RAM/CPU 스파이크, 개발 헬퍼 권한 오류(#26498), 에이전트가 파일을 계속 수정 중인데 UI가 멈추며 '완료'로 표시하는 문제, 단일 프롬프트를 4~5개 에이전트에 복제 실행해 할당량을 급속 소진하는 문제가 빈번히 보고됩니다.",
        xmatrixAnswer:
          "xMatrix는 창마다 브라우저를 띄우거나 중복 팬아웃을 강요하지 않습니다. 에이전트는 등록된 적합한 머신에서 깔끔하게 실행되어 명시적 실행 상태를 스트리밍하고 결과를 한 장의 읽기 쉬운 페이지로 요약합니다.",
      },
      {
        title: "취약한 로컬 네트워크 모바일 페어링과 살아 있는 프로젝트 메모리 부재",
        problem:
          "Orca의 모바일 컴패니언은 사내 VPN이나 분리된 Wi-Fi에서 자주 끊기는 로컬 네트워크 E2EE QR 페어링에 의존하며, 작업이 끝나도 유지되는 프로젝트 위키가 남지 않습니다.",
        xmatrixAnswer:
          "xMatrix는 허브 릴레이를 통해 셀룰러, VPN, 데스크톱 어디서나 안정적으로 연결되며, 완료된 작업을 웹·데스크톱·모바일에서 팀 누구나 읽을 수 있는 살아 있는 페이지로 정리합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "멀티플레이어 및 권한",
        xmatrix: "다중 사용자 + 다중 에이전트 채널, 역할, 스페이스 시크릿, 앱별 승인",
        competitor: "싱글플레이어 데스크톱 ADE; 멀티플레이어 UI 미출시; 공유 시크릿 없음",
      },
      {
        dimension: "살아 있는 프로젝트 상태",
        xmatrix: "에이전트가 지속적으로 업데이트하는 페이지; 사람 편집 우선",
        competitor: "워크트리 diff 및 실험적 DAG 오케스트레이션; 살아 있는 문서 없음",
      },
      {
        dimension: "모바일 및 원격 접속",
        xmatrix: "어떤 VPN 환경에서도 연결되는 허브 릴레이 웹(iPhone·iPad 포함), 데스크톱, Android",
        competitor: "사내 VPN/방화벽에서 끊기기 쉬운 로컬 네트워크 QR 페어링",
      },
      {
        dimension: "라우팅 및 토큰 비용",
        xmatrix: "@auto가 역량, CPU/RAM, 할당량 여유를 보고 최적 에이전트 하나를 선택",
        competitor: "팬아웃 프롬프트가 N개 병렬 워크트리에 토큰 소모를 배수로 증폭",
      },
      {
        dimension: "운영 커넥터",
        xmatrix: "앱별 정책을 갖춘 35개 연동 앱 + 스페이스 시크릿",
        competitor: "실험적 Slack/Discord 맥락 브리지; 운영 승인 계층 없음",
      },
    ],
    stayWhen: [
      "1인 개발자로서 프롬프트 하나를 4개 모델에 동시 팬아웃하고 내장 브라우저로 시각적 diff를 나란히 비교하는 것이 주목적인 경우.",
      "호스팅 허브 개입이 전혀 없는 100% MIT 라이선스 로컬 데스크톱 IDE를 원하는 경우.",
    ],
    switchWhen: [
      "같은 워크스페이스에서 각자의 계정, 알림, 승인 제어가 필요한 팀원들과 함께 일하는 경우.",
      "로컬 브라우저·워크트리 다중 실행이 노트북 RAM을 고갈시키거나 Claude/OpenAI 한도를 빠르게 태우고 있는 경우.",
      "VPN이나 모바일 데이터에서도 끊기지 않는 원격 제어와 프로젝트 현황을 한눈에 보여 주는 살아 있는 페이지가 필요한 경우.",
    ],
    migrationSteps: [
      {
        title: "워크스테이션과 여유 빌드 서버를 함께 연결하세요",
        detail:
          "노트북 한 대의 RAM을 혹사하는 대신 MacBook과 Linux 서버를 하나의 xMatrix 스페이스에 연결해 에이전트 실행을 분산하세요.",
      },
      {
        title: "기존 CLI 하네스를 그대로 유지하세요",
        detail:
          "xmatrix agent add로 Claude Code, Codex, Kimi, Cursor를 한 번만 등록하면 독자 런타임 재인증 없이 바로 사용할 수 있습니다.",
      },
      {
        title: "저장소를 살아 있는 페이지에 연결하세요",
        detail:
          "원시 터미널 탭을 일일이 비교하는 대신 에이전트가 PR, CI 상태, 결정 사항을 공유 페이지에 보고하게 하세요.",
      },
    ],
    faqs: [
      {
        question: "Orca는 미해결 이슈가 많은데 왜 GitHub 스타 수가 그렇게 높은가요?",
        answer:
          "Orca는 앱 내에서 에이전트 35회 실행 후 원클릭 스타를 유도해 스타 수가 132k를 넘겼으며, 동시에 미해결 이슈도 8,988건에 달합니다. 두 도구를 비교할 때는 일상적인 안정성과 멀티플레이어 거버넌스 필요 여부를 기준으로 판단하는 것이 좋습니다.",
      },
      {
        question: "xMatrix는 사내 VPN이나 모바일 데이터에서도 잘 작동하나요?",
        answer:
          "네. 로컬 데몬이 xMatrix 허브로 아웃바운드 연결을 유지하므로 어디서나 휴대폰으로 페이지를 읽고 에이전트에 메시지를 보내며 커넥터 작업을 승인할 수 있습니다.",
      },
      {
        question: "xMatrix에서도 여러 에이전트를 병렬로 실행할 수 있나요?",
        answer:
          "네. 등록된 한 대 또는 여러 대의 머신에서 수십 개의 대화를 병렬로 실행할 수 있으며, 각 대화가 진행 상황과 최종 결과를 프로젝트 페이지에 보고합니다.",
      },
    ],
  },
  lobehub: {
    alsoKnownAs: "구 LobeChat",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "LobeHub (LobeChat) 대안 (2026): LobeHub vs xMatrix",
    metaDescription:
      "LobeHub 또는 LobeChat 대안을 찾고 계신가요? 크레딧 재판매 마진, 2.0 PostgreSQL/S3 마이그레이션 부담, RAG 청크 오염 대신 xMatrix의 로컬 코딩 에이전트와 살아 있는 페이지를 써 보세요.",
    eyebrow: "LobeHub (LobeChat) 대안 · LobeHub vs xMatrix",
    headline: "이미 Claude Code나 Codex를 구독 중인 코딩 팀을 위해 — 크레딧 이중 결제를 멈추세요",
    lead: "LobeHub(구 LobeChat)는 모델 크레딧 재판매로 수익화하는 범용 AI 워크스페이스로, 무거운 2.0 자체 호스팅 스택을 요구하며 다중 사용자+다중 에이전트 공유 채널이 없습니다. xMatrix는 기존 구독 그대로 실제 저장소에서 35종 코딩 에이전트를 실행하며, 완료 조건을 검증하는 Goals와 35개 연동 앱 거버넌스를 제공합니다.",
    productCaption:
      "xMatrix 화면: 토큰 재판매나 Docker 스택 관리 없이 본인의 Claude Code, Codex, Cursor 구독을 실시간 팀 채널과 살아 있는 페이지로 조율하세요.",
    painPoints: [
      {
        title: "긴 코딩 컨텍스트에서 예측 불가하게 소모되는 크레딧 재판매 과금",
        problem:
          "LobeHub Cloud의 무료 플랜(약 500k 크레딧)은 다수의 프런티어 모델을 막아 두며, 유료 플랜(월 $12.9 / $24.9 / $49.9)은 모든 토큰을 클라우드 크레딧으로 계량합니다. 개발자들은 긴 코딩 컨텍스트와 딥 리서치 에이전트가 예상보다 훨씬 빠르게 크레딧을 소진한다고 보고합니다.",
        xmatrixAnswer:
          "xMatrix는 LLM 토큰을 재판매하거나 마진을 붙이지 않습니다. 에이전트는 이미 보유한 Claude Code, Codex, Cursor, Gemini 구독과 API 키로 직접 실행되며, xMatrix는 Pro 기준 사람 시트당 월 $10의 정액만 받습니다.",
      },
      {
        title: "무거워진 2.0 아키텍처 전환과 깨진 자체 호스팅 가이드",
        problem:
          "LobeChat에서 LobeHub 2.0으로의 전면 재작성 과정에서 PostgreSQL, S3 호환 오브젝트 스토리지, 새 인증 흐름이 필수가 되었고 LobeHub Community License로 전환되면서 기존 1.x Docker Compose 튜토리얼이 깨지고 설정 복잡도에 대한 커뮤니티 반발이 이어졌습니다.",
        xmatrixAnswer:
          "xMatrix는 시작하기 위해 자체 호스팅 DB나 S3 버킷을 구축할 필요가 없습니다. 로그인 후 머신에 가벼운 CLI 하나만 설치하면 몇 분 안에 기존 저장소를 연결할 수 있습니다.",
      },
      {
        title: "다중 사용자+다중 에이전트 실시간 코딩 채널 부재 및 RAG 오염",
        problem:
          "LobeHub은 에이전트 그룹과 지식 베이스를 오케스트레이션하지만, 벡터 검색이 무관한 청크를 컨텍스트로 끌어오는 문제와 여러 엔지니어·로컬 코딩 에이전트가 한 방에서 릴리스를 함께 조율할 실시간 공간이 없다는 한계가 있습니다.",
        xmatrixAnswer:
          "xMatrix는 모호한 RAG 청킹을 사람이 읽을 수 있는 명확한 살아 있는 페이지와 실시간 다중 사용자 채널로 대체해 에이전트가 낡은 벡터 조각이 아닌 최신 결정을 정확히 읽게 합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "모델 및 토큰 과금",
        xmatrix: "본인 구독/API 키 사용; 토큰 마진 $0; Pro 사람 시트당 월 $10",
        competitor: "Cloud에서 모델 크레딧 재판매(월 $12.9~$49.9); 무료 플랜 프런티어 모델 제한",
      },
      {
        dimension: "다중 사용자 + 다중 에이전트 방",
        xmatrix: "팀원과 여러 코딩 하네스가 함께 쓰는 네이티브 공개·비공개 채널",
        competitor: "리더가 조율하는 Agent Groups; Discord/Slack/Lark 외부 봇 연동",
      },
      {
        dimension: "지식 모델",
        xmatrix: "에이전트와 사람이 제자리에서 수정하는 살아 있는 Markdown 페이지",
        competitor: "벡터 지식 베이스(청크 오염 우려) + 편집 잠금이 있는 Pages",
      },
      {
        dimension: "설치 부담",
        xmatrix: "호스팅 허브 + 본인 머신의 단일 네이티브 CLI 데몬",
        competitor: "클라우드 SaaS 또는 자체 호스팅 PostgreSQL + S3 + 인증 스택(2.0 마이그레이션)",
      },
      {
        dimension: "완료 검증 및 거버넌스",
        xmatrix: "매 턴 후 Goals로 완료 조건 검증 + 모든 에이전트에 35개 연동 앱 거버넌스 적용",
        competitor: "내장 완료 검증 제공; 외부 lh connect 코딩 에이전트는 거버넌스 밖에서 실행",
      },
    ],
    stayWhen: [
      "Anthropic이나 OpenAI를 따로 구독하지 않고 단일 크레딧 청구서로 40개 이상의 호스팅 채팅 모델을 묶어 쓰는 범용 AI 포털을 원하는 경우.",
      "LobeHub 내장 Discord, Telegram, WeChat, Lark 봇 바인딩이나 멤버·에이전트별 예산 대시보드에 크게 의존하는 경우.",
    ],
    switchWhen: [
      "이미 Claude Code, Codex, Cursor를 구독 중이며 긴 코딩 컨텍스트에 크레딧 마진을 이중으로 내고 싶지 않은 경우.",
      "RAG 검색 오염을 디버깅하는 대신 엔지니어와 35종 코딩 에이전트가 공유 채널에서 협업하며 신뢰할 수 있는 살아 있는 페이지를 유지하고 싶은 경우.",
      "로컬 코딩 에이전트를 조율하기 위해 PostgreSQL + S3 자체 호스팅 스택을 운영하고 싶지 않은 경우.",
    ],
    migrationSteps: [
      {
        title: "네이티브 코딩 CLI와 구독을 그대로 유지하세요",
        detail:
          "35종 코딩 에이전트(Claude Code, Codex, Gemini, Cursor 등) 중 원하는 하네스를 xMatrix에 직접 등록해 호스팅 크레딧 풀 이중 과금을 멈추세요.",
      },
      {
        title: "정적 지식 베이스를 살아 있는 페이지와 Goals로 전환하세요",
        detail:
          "핵심 아키텍처 메모와 남은 작업을 xMatrix 페이지로 옮겨 에이전트가 최신 상태로 유지하게 하고, /goal로 완료 조건을 자동 검증하세요.",
      },
      {
        title: "앱별 거버넌스로 운영 앱을 연결하세요",
        detail:
          "GitHub(읽기 전용 또는 읽기·쓰기)과 함께 Linear, Vercel, Cloudflare, Sentry, Gmail을 읽기 전용 / 먼저 묻기 / 읽기·쓰기 규칙으로 연결하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix도 LobeHub Cloud처럼 AI 모델 크레딧을 재판매하나요?",
        answer:
          "아니요. 에이전트는 본인이 이미 보유한 구독이나 API 키로 실행됩니다. xMatrix Pro 크레딧(사람 시트당 월 $10, 에이전트 메시지/페이지 리비전 5,000건)은 협업 조율 용도일 뿐 LLM 토큰 재판매가 아닙니다.",
      },
      {
        question: "xMatrix는 LobeHub의 지식 베이스 검색 오염 문제를 어떻게 피하나요?",
        answer:
          "문서를 불투명한 벡터 청크로 쪼개는 대신 간결한 살아 있는 페이지로 상태를 정리하고 개요·섹션 단위 읽기를 제공해 에이전트가 필요한 최신 섹션만 정확히 읽습니다.",
      },
      {
        question: "xMatrix도 도구별 승인과 시크릿을 지원하나요?",
        answer:
          "네. 모든 연결된 앱이 읽기 전용, 먼저 묻기, 읽기 및 쓰기 권한을 지원하며 스페이스 시크릿은 에이전트에 값을 노출하지 않고 명령 실행 시점에 주입됩니다.",
      },
    ],
  },
  cumora: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Cumora 대안 (2026): Cumora vs xMatrix",
    metaDescription:
      "Cumora(yetone/cumora) 대안을 비교 중이신가요? 오프라인 샌드박스 차단(#350), bwrap 오류, 초대 전용 프리뷰 없이 실제 로컬 저장소에서 코딩 에이전트를 실행하세요.",
    eyebrow: "Cumora 대안 · Cumora vs xMatrix",
    headline: "Cumora 대안: 실제 저장소에서 일하고 거버넌스 커넥터로 배포하는 에이전트",
    lead: "Cumora는 페르소나 기반 에이전트를 팀 채팅에 넣었지만, 로컬 BYOA 실행을 실제 세션과 분리된 오프라인 샌드박스에 가두어 Bubblewrap·CDN 가져오기 오류(#350)가 발생하며 초대 전용 프리뷰에 머물러 있습니다. xMatrix는 실제 저장소에서 35종 코딩 에이전트를 직접 실행하고 35개 연동 앱 거버넌스와 살아 있는 페이지로 배포까지 이어갑니다.",
    productCaption:
      "xMatrix 화면: 초대 대기열도 오프라인 샌드박스 장벽도 없습니다. 실제 로컬 Claude Code와 Codex 하네스가 저장소 안에서 바로 팀과 협업합니다.",
    painPoints: [
      {
        title: "오프라인 샌드박스 장벽이 실제 개발 워크플로와 CDN 에셋을 막음",
        problem:
          "Cumora의 BYOA 모드는 로컬 CLI를 아웃바운드 네트워크가 기본 차단된 격리 샌드박스 워크스페이스 안에서 실행합니다. 이 때문에 외부 패키지, 문서, 심지어 자체 채팅 첨부 파일까지 가져오기 실패가 발생하며(이슈 #350), 에이전트가 실제 작업 디렉터리에 접근하지 못합니다.",
        xmatrixAnswer:
          "xMatrix는 사용자가 머신에 명시적으로 등록한 저장소와 폴더에서 에이전트를 직접 실행하므로 로컬 툴체인, git 리모트, 테스트 스위트를 그대로 사용할 수 있습니다.",
      },
      {
        title: "Bubblewrap 오류, 클라우드-로컬 동작 괴리, 미완성 모바일 클라이언트",
        problem:
          "사용자들은 로컬 bwrap 실행 오류, Cumora Cloud의 Kubernetes FUSE 파드와 로컬 BYOA 호스트 간 동작 차이, 'coming soon' 자리표시자가 남은 모바일 화면을 겪고 있으며, 저장소 커밋도 2026년 11월 1일 이후 멈춘 상태입니다.",
        xmatrixAnswer:
          "xMatrix는 일관된 로컬 머신 실행 모델과 검증된 릴리스 트레인을 바탕으로 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함) 전반에 걸쳐 지속적으로 배포됩니다.",
      },
      {
        title: "배포 및 운영을 위한 승인 기반 커넥터 부재",
        problem:
          "Cumora는 채팅, 문서, 칸반, 캘린더 기능을 담고 있지만 GitHub, Vercel, Cloudflare, Linear, Sentry, Gmail, Stripe를 아우르는 크로스 앱 승인 계층과 스페이스 시크릿 볼트가 없습니다.",
        xmatrixAnswer:
          "xMatrix는 35개 연동 앱을 앱별 정책과 스페이스 시크릿으로 안전하게 연결합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "로컬 에이전트 작업 위치",
        xmatrix: "35종 코딩 에이전트가 등록한 실제 로컬 저장소와 툴체인에서 직접 실행",
        competitor: "Cumora 자체 오프라인 샌드박스 워크스페이스 내부(아웃바운드 차단, #350)",
      },
      {
        dimension: "이용 가능 여부 및 개발 속도",
        xmatrix: "누구나 가입 가능한 셀프서브 Free(총 500회 쓰기)·Pro 플랜; 매일 활발한 릴리스",
        competitor: "초대 전용 프리뷰; 2026년 11월 1일 이후 저장소 푸시 없음",
      },
      {
        dimension: "외부 앱 거버넌스",
        xmatrix: "앱별 정책을 갖춘 35개 연동 앱 + 스페이스 시크릿",
        competitor: "프로덕션 배포 승인; 상응하는 운영 커넥터 승인 계층 없음",
      },
      {
        dimension: "살아 있는 프로젝트 문서",
        xmatrix: "사람과 공동 편집하고 실행 중인 작업이 자동 업데이트하는 페이지",
        competitor: "페르소나 채팅과 함께 제공되는 내장 문서, 칸반, 캘린더",
      },
      {
        dimension: "모바일 및 크로스 OS 클라이언트",
        xmatrix: "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)",
        competitor: "데스크톱/웹 중심; 모바일 세션 미완성('coming soon' 상태)",
      },
    ],
    stayWhen: [
      "초대 전용 프리뷰 기간 동안 관리형 Kubernetes 파드 안에서 Cumora Cloud가 추론 비용을 부담하는 방식을 꼭 원하는 경우.",
      "로컬 저장소와 격리된 무네트워크 샌드박스 안에서 페르소나 기반 채팅 에이전트를 돌리는 방식을 선호하는 경우.",
    ],
    switchWhen: [
      "오프라인 샌드박스 오류 없이 실제 저장소, 의존성, 테스트 환경에서 에이전트가 직접 일하기를 원하는 경우.",
      "초대 전용 프리뷰가 아니라 오늘 바로 쓸 수 있고 활발히 배포되는 워크스페이스가 필요한 경우.",
      "하나의 스페이스에서 GitHub, Linear, Vercel, Cloudflare, Sentry, Gmail에 대한 승인 기반 접근을 원하는 경우.",
    ],
    migrationSteps: [
      {
        title: "대기열 없이 바로 시작하세요",
        detail: "몇 초 만에 무료 xMatrix 스페이스를 만들 수 있습니다(최대 3명, 에이전트 무제한).",
      },
      {
        title: "기존 로컬 저장소와 하네스를 등록하세요",
        detail:
          "Mac, Linux, Windows 호스트에서 xmatrix agent add를 실행하면 Claude Code, Codex, Cursor가 실제 코드가 있는 곳에서 바로 작동합니다.",
      },
      {
        title: "진행 중인 프로젝트 맥락을 살아 있는 페이지로 옮기세요",
        detail:
          "채팅 페르소나와 칸반 보드에 맥락을 흩어 두지 말고 결정 사항, 릴리스, 남은 작업을 페이지에서 최신으로 유지하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix도 Cumora처럼 로컬 코딩 에이전트의 아웃바운드 네트워크를 차단하나요?",
        answer:
          "아니요. 에이전트는 등록된 로컬 환경에서 일반 개발 네트워크 접근 권한으로 실행되므로 패키지 설치, API 문서 조회, 테스트 스위트가 정상 작동하며, 외부 SaaS 쓰기 작업은 xMatrix의 앱별 승인 계층을 거칩니다.",
      },
      {
        question: "xMatrix를 사용해 보려면 초대 코드가 필요한가요?",
        answer:
          "아니요. xMatrix는 개방형 셀프서브 서비스이며 최대 3명과 무제한 에이전트를 지원하는 Free 플랜을 바로 사용할 수 있습니다.",
      },
      {
        question: "xMatrix는 코드 작업만 되나요, 문서와 운영 업무도 최신화할 수 있나요?",
        answer:
          "둘 다 가능합니다. 에이전트가 저장소에서 코드를 배포하는 동시에 출시, 리서치, 채용, 인시던트, 운영을 위한 살아 있는 페이지를 최신 상태로 유지합니다.",
      },
    ],
  },
  "t3-code": {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "T3 Code 대안 (2026): T3 Code vs xMatrix",
    metaDescription:
      "T3 Code 대안을 찾고 계신가요? 실제 사용자 계정 구분, 공유 채널(GitHub Discussion #27974), 살아 있는 프로젝트 페이지(GitHub Discussion #15858), 스페이스 시크릿, 프로바이더 간 핸드오프(GitHub Discussion #15846)를 팀에 더해 보세요.",
    eyebrow: "T3 Code 대안 · T3 Code vs xMatrix",
    headline: "팀을 위한 T3 Code 대안: 실제 계정 구분, 하나의 채널, 하나의 살아 있는 페이지",
    lead: "T3 Code는 뛰어난 무료 싱글플레이어 코딩 워크벤치이지만, 환경 하나가 계정 하나에 묶이고 공유 살아 있는 프로젝트 페이지가 없으며 프로바이더 할당량이 소진되면 'Limited'에서 그대로 멈춥니다. xMatrix는 공유 채널, 살아 있는 페이지, 스페이스 시크릿, 그리고 보유 머신 전반의 35종 코딩 에이전트를 팀에 제공합니다.",
    productCaption:
      "xMatrix 화면: 35종 코딩 에이전트가 모든 머신에서 함께 일하고 팀 전체를 위해 살아 있는 페이지를 최신으로 유지하는 진짜 멀티플레이어 채널.",
    painPoints: [
      {
        title: "진짜 멀티플레이어 계정 구분과 공유 팀 채널 부재",
        problem:
          "T3 Code는 각 환경을 단일 T3 Connect 계정에 묶어 두어 로그의 모든 사람이 그냥 'user'로 남으며, 게스트 링크는 24시간 뒤 만료되고 게스트 메시지마다 호스트 승인이 필요합니다. 반복된 GitHub Discussions 요청(#27974, #12283, #27708)이 답변 없이 남아 팀들이 서드파티 포크로 이탈하고 있습니다.",
        xmatrixAnswer:
          "xMatrix는 처음부터 다중 사용자 + 다중 에이전트 스페이스로 설계되어 실제 사용자 계정 구분, 공개·비공개 채널, 작성자가 기록되는 페이지 편집, 요청자에게 정확히 전달되는 알림을 제공합니다.",
      },
      {
        title: "'Limited'에서 멈춰 버림—자동 프로바이더 간 할당량 핸드오프 없음",
        problem:
          "T3 Code에서 Claude나 Codex가 사용 한도에 도달하면 초기화되거나 수동으로 전환할 때까지 스레드가 Limited 상태로 얼어붙습니다. 자동 프로바이더 간 페일오버를 요청하는 GitHub Discussions(#15846, #24453, #18949)은 미구현 상태이며, 래퍼 서브태스크 오버헤드로 한도가 더 빨리 소진되거나 잘못된 'Limited' 상태가 뜬다는 보고도 이어집니다.",
        xmatrixAnswer:
          "xMatrix는 등록된 하네스들의 프로바이더 할당량 주기를 모니터링하다가 한도에 걸린 프로바이더(예: Claude Code)의 작업을 여유 있는 다른 프로바이더(예: Codex 또는 Gemini)로 자동 핸드오프해 작업이 끊기지 않게 합니다.",
      },
      {
        title: "살아 있는 프로젝트 페이지, 스페이스 시크릿, 운영 커넥터 부재",
        problem:
          "T3 Code는 로컬 diff와 에뮬레이터에 강하지만 공유 프로젝트 메모리나 살아 있는 문서가 없고(GitHub Discussion #15858), 새 스레드가 기본으로 Full access로 열리며, 무료 T3 Connect 터널은 3대 머신으로 제한되고 승인 기반 운영 앱 대신 코드에만 집중합니다.",
        xmatrixAnswer:
          "xMatrix는 완료된 대화를 살아 있는 페이지로 정리하고, 35종 코딩 에이전트로 팀의 머신을 대수 제한 없이 연결하며, 스페이스 시크릿을 안전하게 보관하고, Vercel·Cloudflare·Sentry·Gmail·Stripe 등 35개 연동 앱을 거버넌스 아래 둡니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "멀티플레이어 및 작성자 구분",
        xmatrix: "팀 스페이스, 개인별 계정 구분, 공개·비공개 채널, 작성자 기록 편집",
        competitor: "단일 사용자 환경; 24시간 게스트 링크 베타; 팀 계정 구분 없음",
      },
      {
        dimension: "프로바이더 할당량 한도 도달 시",
        xmatrix: "커밋되지 않은 변경 사항을 유지한 채 프로바이더 간 자동 핸드오프",
        competitor: "Limited에서 일시 정지; 수동 전환 또는 초기화 대기만 가능",
      },
      {
        dimension: "프로젝트 현황 및 살아 있는 문서",
        xmatrix: "에이전트가 최신으로 유지하고 사람과 공동 편집하는 살아 있는 페이지",
        competitor: "스레드별 기록; 프로젝트 메모리 및 살아 있는 문서 없음(GitHub Discussion #15858)",
      },
      {
        dimension: "기본 안전성 및 운영 거버넌스",
        xmatrix: "35개 앱의 앱별 정책 + 스페이스 시크릿",
        competitor: "새 스레드 기본 Full access; 머신 로컬 시크릿; 개발 이슈 중심",
      },
      {
        dimension: "지원 에이전트 및 원격 머신",
        xmatrix: "보유한 모든 macOS, Windows, Linux 머신에서 35종 코딩 에이전트(+ --runtime)",
        competitor: "10종 하네스 + ACP; T3 Connect 무료 플랜 3대 제한",
      },
    ],
    stayWhen: [
      "완전히 혼자 작업하면서 내장 diff 리뷰, 체크포인트 롤백, 브라우저 미리보기, iOS/Android 시뮬레이터가 있는 무료 로컬 IDE 워크벤치를 원하는 경우.",
      "1~3대 머신에서 계정 없는 로컬 설정만 필요하고 팀원, 살아 있는 문서, 비코드 커넥터가 필요 없는 경우.",
    ],
    switchWhen: [
      "2명 이상이 실제 계정 구분과 공유 맥락을 갖추고 같은 워크스페이스에서 코딩 에이전트와 협업해야 하는 경우.",
      "Codex나 Gemini 할당량이 남아 있는데도 Claude의 5시간 또는 주간 한도 때문에 스레드가 'Limited'에 멈추는 것을 더 이상 보고 싶지 않은 경우.",
      "수십 개 스레드의 작업 결과를 살아 있는 페이지로 압축하고 Vercel, Cloudflare, Linear, Sentry, Gmail까지 승인 기반으로 다루고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "로컬 CLI를 그대로 유지하거나 MCP로 함께 쓰세요",
        detail:
          "xMatrix는 T3 Code용으로 이미 설치해 둔 로컬 Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity CLI를 그대로 사용합니다.",
      },
      {
        title: "T3 Chat 번들 없이 3대 이상의 머신을 연결하세요",
        detail:
          "노트북, 빌드 머신, 자체 서버를 하나의 스페이스에 등록하면 @auto가 여유 있는 머신과 프로바이더로 자동 라우팅합니다.",
      },
      {
        title: "모든 프로젝트에 살아 있는 페이지를 두세요",
        detail:
          "새 스레드마다 아키텍처 결정을 반복 설명하지 말고 프로젝트 페이지에 한 번 적어 두면 모든 하네스가 읽고 따릅니다.",
      },
    ],
    faqs: [
      {
        question: "T3 Code는 무료인데 왜 xMatrix Pro를 쓰나요?",
        answer:
          "1~3대 머신에서 혼자 쓰는 무료 코딩 워크벤치만 필요하다면 T3 Code는 훌륭합니다. 팀들이 xMatrix를 선택하는 이유는 진짜 멀티플레이어 스페이스, 살아 있는 프로젝트 페이지, 자동 프로바이더 간 할당량 핸드오프, 스페이스 시크릿, 35개 연동 앱 거버넌스 때문입니다.",
      },
      {
        question: "Claude가 한도에 걸리면 xMatrix가 자동으로 다른 프로바이더로 전환해 주나요?",
        answer:
          "네. 한 프로바이더의 할당량 주기가 소진되면 단일 벤더 다중 계정 약관 우회 없이 사용자가 등록해 둔 다른 가용 하네스로 작업을 라우팅하거나 핸드오프합니다.",
      },
      {
        question: "T3 Code와 xMatrix를 함께 사용할 수도 있나요?",
        answer:
          "네. xMatrix는 페이지 읽기/업데이트와 채널 메시지 전송을 위한 MCP 서버를 제공하며, 로컬 저장소를 잠그지 않고 함께 작동합니다.",
      },
    ],
  },
  herdr: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "herdr 대안 (2026): herdr vs xMatrix",
    metaDescription:
      "herdr(herdr-core) 대안을 검토 중이신가요? 대기열 없이 지금 바로 쓰는 크로스 기기 릴레이, 내장 인증, 팀 권한, 앱별 승인, 살아 있는 페이지를 xMatrix에서 만나보세요.",
    eyebrow: "herdr 대안 · herdr vs xMatrix",
    headline: "팀 인증, 승인, 살아 있는 페이지를 갖춘 herdr 대안 — 지금 바로 모든 기기에서 연결",
    lead: "herdr는 사랑받던 Rust TUI 멀티플렉서에서 herdr-core와 네이티브 앱으로 전환하며 호환성 깨짐과 GUI 종속에 대한 Reddit 반발을 겪었으며, 여전히 다중 사용자 인증·승인·시크릿과 실시간 클라우드 릴레이가 없습니다. xMatrix는 오늘 바로 쓸 수 있는 완전한 거버넌스 협업 계층을 제공합니다.",
    productCaption:
      "xMatrix 화면: 인증 없는 프리뷰 소켓 대신, 인증된 스페이스·스페이스 시크릿·살아 있는 페이지와 함께 데스크톱·웹·모바일 크로스 기기 협업을 지금 바로 이용하세요.",
    painPoints: [
      {
        title: "인증, 권한 경계, 승인, 시크릿 계층 부재",
        problem:
          "herdr-core는 명시적인 단일 사용자 로컬 런타임으로, 소켓에 닿을 수 있는 누구나 사실상 셸 접근 권한을 갖습니다. 사용자 역할, 작업 승인, 시크릿 볼트, 예약·웹훅 기반 자동화가 전혀 없습니다.",
        xmatrixAnswer:
          "xMatrix는 로컬 실행 위에 신뢰 경계를 세웁니다. 검증된 사람·에이전트 계정, 값 노출 없이 주입되는 스페이스 시크릿, 앱별 승인 정책, Norn 자동화를 기본 제공합니다.",
      },
      {
        title: "프로토콜 변경, 호환성 깨짐, TUI에서 GUI 전환 반발",
        problem:
          "herdr-core 재작성으로 기존 서드파티 클라이언트가 깨졌고 v0.9.2에서 pane 그래픽스 API가 제거되었으며, 범용 SSH TUI에서 전용 클라이언트 앱 중심으로 옮겨간 데 대해 Reddit 사용자들이 반발했습니다. SSH stderr가 pane으로 새는 문제, macOS 메인 스레드 멈춤(os error 35), systemd 유닛 간 CLAUDE_CODE_* 환경 변수 누출 이슈도 열려 있습니다.",
        xmatrixAnswer:
          "xMatrix는 버전 관리되는 Hub/CLI 호환성 계약과 명시적 실행 격리를 기반으로 웹, 데스크톱, CLI, 모바일이 일관되게 연동되는 경험을 제공합니다.",
      },
      {
        title: "Herdr Cloud는 여전히 대기자 명단—터미널은 살아 있는 문서를 유지하지 못함",
        problem:
          "기기 간 암호화 릴레이(Herdr Cloud)와 공식 모바일 앱은 여전히 대기열/개발 중이며, 출시되더라도 PTY 멀티플렉서는 모든 결정을 터미널 스크롤백 속에 묻어 둡니다.",
        xmatrixAnswer:
          "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함) 간 멀티 머신 릴레이가 xMatrix에서는 지금 즉시 작동하며, 완료된 실행이 살아 있는 페이지를 자동으로 최신화합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "인증 및 보안 경계",
        xmatrix: "인증된 스페이스, 멤버 역할, 스페이스 시크릿, 앱별 승인",
        competitor: "없음—로컬 소켓 접근이 곧 전체 셸 접근 권한",
      },
      {
        dimension: "크로스 기기 릴레이 및 모바일",
        xmatrix: "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 지금 즉시 사용 가능",
        competitor: "현재는 수동 SSH 구성 필요; Herdr Cloud 릴레이는 대기열 상태",
      },
      {
        dimension: "작업 결과가 남는 곳",
        xmatrix: "에이전트가 관리하는 살아 있는 페이지 + 검색 가능한 채널",
        competitor: "영구 PTY 스크롤백 창",
      },
      {
        dimension: "자동화 및 커넥터",
        xmatrix: "일정·이벤트 기반 Norn 프로그램 + 35개 연동 앱",
        competitor: "내장 크론, 웹훅 자동화, 앱 커넥터 없음",
      },
      {
        dimension: "대상 사용자",
        xmatrix: "여러 에이전트와 앱을 조율하는 솔로 개발자 및 팀",
        competitor: "PTY 런타임 위에서 작업하는 단일 사용자 터미널 파워 유저",
      },
    ],
    stayWhen: [
      "SSH 너머로 커스텀 터미널 UI를 스크립팅하기 위해 원시 JSON-RPC/OpenRPC 소켓을 제공하는 Apache-2.0 로컬 PTY 데몬이 꼭 필요한 경우.",
      "터미널에서 완전히 혼자 작업하며 팀 접근, 살아 있는 페이지, 외부 앱 승인이 전혀 필요 없는 경우.",
    ],
    switchWhen: [
      "Herdr Cloud 대기열을 기다리거나 SSH ProxyCommand 누출을 디버깅하지 않고 지금 당장 데스크톱·모바일 크로스 기기 접속을 원하는 경우.",
      "에이전트가 GitHub, Vercel, Cloudflare, 프로덕션 서비스에 손대기 전에 진짜 인증, 스페이스 시크릿, 사람 승인이 필요한 경우.",
      "영구 PTY 창을 뒤지는 대신 살아 있는 페이지에서 프로젝트 현황을 한눈에 보고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 도구 옆에 xMatrix CLI를 설치하세요",
        detail:
          "수동 SSH 터널 설정 없이 명령 한 줄로 macOS, Linux, Windows 머신을 등록하세요.",
      },
      {
        title: "코딩 하네스를 한 번만 연결하세요",
        detail:
          "xmatrix agent add로 Claude Code, Codex, Cursor, Gemini, OpenCode를 추가하세요. 구독은 로컬에 그대로 유지됩니다.",
      },
      {
        title: "반복적인 현황 추적을 살아 있는 페이지로 옮기세요",
        detail:
          "진행 중인 프로젝트마다 페이지를 만들고 일정·이벤트 기반 루틴이 최신 상태를 유지하게 하세요.",
      },
    ],
    faqs: [
      {
        question: "브라우저를 닫거나 노트북을 덮어도 에이전트 실행이 유지되나요?",
        answer:
          "네. 깨어 있는 머신(데스크톱, Mac Studio, Linux VPS 등)이라면 데몬에서 실행이 계속 진행되며, 웹·데스크톱·모바일 클라이언트로 다시 접속하면 업데이트가 그대로 스트리밍됩니다.",
      },
      {
        question: "로컬 PTY 소켓을 여는 것보다 xMatrix가 왜 더 안전한가요?",
        answer:
          "xMatrix는 서버 측 스페이스 인증과 멤버십을 강제하고, 머신 등록과 스페이스 접근 권한을 분리하며, xmatrix secret exec로 스페이스 시크릿을 마스킹하고, 연결된 SaaS 작업에 읽기 전용 또는 먼저 묻기 정책을 적용합니다.",
      },
      {
        question: "터미널에서도 xMatrix를 계속 쓸 수 있나요?",
        answer:
          "네. 네이티브 Rust CLI(xmatrix)로 사람과 에이전트 모두 셸에서 바로 페이지를 읽고 메시지를 보내며 실행을 점검하고 승인 기반 커넥터를 호출할 수 있습니다.",
      },
    ],
  },
  seedmux: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Seedmux 대안 (2026): Seedmux vs xMatrix",
    metaDescription:
      "Seedmux 대안을 찾고 계신가요? macOS + iPhone 종속, 비공개 바이너리, 모바일 YOLO 기본값 대신 macOS, Windows, Linux, Android, iOS를 모두 지원하는 xMatrix를 써 보세요.",
    eyebrow: "Seedmux 대안 · Seedmux vs xMatrix",
    headline: "크로스 OS 팀, Android, 안전한 모바일 제어를 위한 Seedmux 대안",
    lead: "Seedmux는 세련된 Ghostty + tmux macOS 터미널과 iPhone 컴패니언 앱을 결합했지만, 비공개 소스이며 Mac 전용 싱글플레이어이고 휴대폰에서 시작한 세션이 기본으로 YOLO 모드로 실행됩니다. xMatrix는 macOS, Windows, Linux, Android, iOS 전역에 멀티 머신 협업, 팀 스페이스, 살아 있는 페이지를 제공합니다.",
    productCaption:
      "xMatrix 화면: 모바일 YOLO 기본값 대신 승인 기반 앱 거버넌스와 함께 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)을 아우르는 단일 워크스페이스.",
    painPoints: [
      {
        title: "Windows, Linux, Android를 소외시키는 macOS + iPhone 종속",
        problem:
          "Seedmux는 노치 알림에 의존하는 네이티브 macOS 앱과 유료 Seedmux Pro용 iPhone 컴패니언만 제공합니다. 네이티브 Windows·Linux 데스크톱 앱도, 웹 워크스페이스도, Android 앱도 없습니다.",
        xmatrixAnswer:
          "xMatrix는 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 모두 실행되어 나와 팀원이 어떤 머신과 휴대폰을 쓰든 같은 스페이스에 참여할 수 있습니다.",
      },
      {
        title: "싱글플레이어 터미널 창과 모바일의 YOLO 기본 권한",
        problem:
          "Seedmux에는 팀 채널, 공유 역할, 스페이스 시크릿이 없습니다. iPhone 컴패니언에서 시작한 세션은 기본으로 YOLO 권한으로 실행되며, 셀룰러나 사내 방화벽 릴레이 환경에서는 승인 지연이 발생할 수 있습니다.",
        xmatrixAnswer:
          "xMatrix는 모바일과 데스크톱 모두에서 동일한 명시적 거버넌스(앱별 읽기 전용 / 먼저 묻기 / 읽기 및 쓰기 정책, 마스킹된 스페이스 시크릿, 팀원이 함께 검토·승인하는 다중 사용자 채널)를 유지합니다.",
      },
      {
        title: "취약한 CLI 상태 스크래핑과 살아 있는 프로젝트 문서 부재",
        problem:
          "Seedmux는 tmux를 통해 로컬 CLI 창을 감싸므로 CLI 업그레이드나 토큰 만료 시 창 상태 감지가 멈출 수 있고, 다중 창 실행이 로컬 MacBook RAM을 압박하며, 작업 결과도 영구 팀 문서가 아닌 스크롤백으로 끝납니다.",
        xmatrixAnswer:
          "xMatrix는 명시적 수명주기 상태를 갖춘 구조화된 하네스 어댑터를 사용하고, 연결된 모든 머신에 작업을 분산하며, 완료된 작업을 살아 있는 페이지로 정리합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "지원 플랫폼",
        xmatrix: "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)",
        competitor: "macOS + iPhone 컴패니언 전용 (Linux 호스트는 SSH/릴레이)",
      },
      {
        dimension: "팀 협업",
        xmatrix: "다중 사용자 + 다중 에이전트 채널 및 공동 편집 살아 있는 페이지",
        competitor: "싱글플레이어 터미널 전용; 공유 팀 채널 및 문서 없음",
      },
      {
        dimension: "모바일 안전 기본값",
        xmatrix: "모바일과 웹 모두 동일한 앱별 승인 정책 및 스페이스 시크릿 적용",
        competitor: "휴대폰에서 시작한 세션은 기본으로 YOLO 모드 실행",
      },
      {
        dimension: "소스 투명성",
        xmatrix: "FSL-1.1-ALv2 라이선스로 소스 공개",
        competitor: "비공개 소스 바이너리 배포",
      },
      {
        dimension: "외부 운영 앱",
        xmatrix: "35개 연동 앱(GitHub, Linear, Vercel, Cloudflare, Sentry, Gmail, Stripe 등)",
        competitor: "터미널 CLI 명령만 지원; SaaS 커넥터 승인 계층 없음",
      },
    ],
    stayWhen: [
      "Ghostty 렌더링, tmux 분할 창, MacBook 노치 팝업을 꼭 원하는 1인 macOS + iPhone 터미널 애호가인 경우.",
    ],
    switchWhen: [
      "Windows, Linux, Android를 사용하거나 해당 플랫폼을 쓰는 팀원과 협업하는 경우.",
      "원격 세션을 YOLO 권한 기본값으로 열지 않고도 안전하게 모바일 제어를 하고 싶은 경우.",
      "휘발성 터미널 분할 창 대신 살아 있는 페이지에 결정 사항과 프로젝트 진행도를 남기고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 CLI 도구와 구독을 그대로 유지하세요",
        detail:
          "Mac과 Linux 호스트에 xMatrix를 설치하고 xmatrix agent add로 35종 코딩 에이전트(Claude Code, Codex, Grok, OpenCode, Kimi 등)를 추가하세요.",
      },
      {
        title: "릴레이를 직접 호스팅하지 않고 웹·데스크톱·모바일을 쓰세요",
        detail:
          "모든 브라우저(iPhone·iPad 포함), 데스크톱 앱, Android 기기 어디서나 진행 상황을 확인하고 승인 요청에 응답하세요.",
      },
      {
        title: "워커 결과를 하나의 살아 있는 페이지에 모으세요",
        detail:
          "워커 창 영수증을 일일이 확인하는 대신 각 에이전트가 프로젝트 페이지의 담당 섹션을 직접 업데이트하게 하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix도 Seedmux 워커처럼 구조화된 작업 영수증을 제공하나요?",
        answer:
          "네. 에이전트에 보낸 모든 프로그램 요청은 명시적인 수명주기 상태와 채널·연결 페이지 업데이트와 함께 타입이 지정된 프로그램 응답(typed reply)으로 마무리됩니다.",
      },
      {
        question: "MacBook과 함께 Linux 서버도 연결할 수 있나요?",
        answer:
          "네. Linux, macOS, Windows 머신에 네이티브 xMatrix 데몬을 설치하면 스페이스 안의 통합 Agents 매트릭스에 모두 함께 표시됩니다.",
      },
      {
        question: "xMatrix는 오픈소스인가요, 비공개 소스인가요?",
        answer:
          "비공개 소스인 Seedmux와 달리 xMatrix는 GitHub(LambdaLabsHQ/xmatrix)에 FSL-1.1-ALv2 라이선스로 소스를 공개하고 있습니다.",
      },
    ],
  },
  "claude-code": {
    alsoKnownAs: "Claude Code Desktop, Cowork 및 Dispatch",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Claude Code 대안 (2026): 팀 협업과 살아 있는 페이지 추가",
    metaDescription:
      "Claude Code에 멀티플레이어 채널, 살아 있는 페이지, 34종 기타 코딩 에이전트를 더하고 싶으신가요? xMatrix 안에서 Claude Code를 그대로 쓰면서 5시간 한도 도달 시 자동 할당량 핸드오프까지 활용하세요.",
    eyebrow: "Claude Code 대안 · Claude Code vs xMatrix",
    headline: "Claude Code는 그대로 — 팀원, 34종 코딩 에이전트, 살아 있는 페이지를 더하세요",
    lead: "Claude Code Desktop과 Cowork는 단일 Claude 세션과의 1인 페어링에 훌륭하지만, 팀원들이 함께 참여할 수 없고 맥락이 개인 세션에 갇히며 2026년 11월 더 빡빡해진 5시간·주간 한도에 걸리면 작업이 그대로 멈춥니다. xMatrix는 Claude Code 위에 공유 채널, 살아 있는 페이지, 34종 기타 코딩 에이전트, 스페이스 시크릿을 더해 줍니다.",
    productCaption:
      "xMatrix 화면: 로컬 Claude Code CLI는 그대로 실행하면서 팀원들과 34종 기타 코딩 에이전트가 같은 채널에서 협업하고 살아 있는 페이지를 최신으로 유지합니다.",
    painPoints: [
      {
        title: "멀티플레이어 팀이나 공유 살아 있는 문서가 아닌 1인 페어링 중심 설계",
        problem:
          "Claude Code Desktop은 한 사람이 에이전트 하나의 단계를 일일이 지켜보도록 설계되었습니다. Projects 메모리는 단일 사용자에게 귀속되고, Claude Tag는 Slack Team/Enterprise로 제한되며, 사람과 여러 하네스가 공동으로 최신화하는 살아 있는 페이지가 없습니다.",
        xmatrixAnswer:
          "xMatrix는 한 층 위에서 작동합니다. 팀원들과 수십 개의 병렬 에이전트가 공유 채널에서 협업하고 완료된 실행마다 공유 살아 있는 페이지를 업데이트하므로, 터미널 한 줄 한 줄을 감시하지 않고 결과와 결정 중심으로 감독할 수 있습니다.",
      },
      {
        title: "공유 5시간·주간 할당량 벽에 걸리면 작업이 그대로 중단됨",
        problem:
          "Claude Code, Claude Desktop, Cowork가 모두 같은 플랜 한도를 공유하고 백그라운드 서브에이전트와 /code-review가 토큰 소모를 가속하면서(2026년 11월 다수의 r/claude 사용자가 3배 소모 체감을 보고), Pro 및 하위 플랜은 한낮에 한도에 걸린 뒤 다른 프로바이더로 이어갈 방법이 없습니다.",
        xmatrixAnswer:
          "xMatrix는 Claude Code를 대체하지 않고 한 단계 끌어올립니다. Claude Code가 5시간 또는 주간 한도에 도달하면 xMatrix가 작업 체크아웃(커밋되지 않은 변경 사항 포함)과 페이지 맥락을 Codex, Gemini, Cursor 또는 다른 등록 하네스로 넘겨 작업이 끊기지 않게 합니다.",
      },
      {
        title: "머신 전반의 스페이스 시크릿 및 이기종 하네스 거버넌스 부재",
        problem:
          "Claude Code Desktop은 로컬 실행을 Anthropic 생태계에 묶어 두며 이기종 하네스 간 스페이스 시크릿 주입 기능이 없고, Anthropic의 지역 제한으로 미지원 지역은 아예 차단됩니다.",
        xmatrixAnswer:
          "xMatrix는 하나의 스페이스 시크릿과 35개 연동 앱의 앱별 승인 체계 아래 macOS, Windows, Linux 머신 전반에서 35종 코딩 에이전트(및 --runtime 커스텀 CLI)를 함께 조율합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "협업 및 공유 메모리",
        xmatrix: "멀티플레이어 공개·비공개 채널 + 사람과 에이전트가 공동 편집하는 살아 있는 페이지",
        competitor: "단일 사용자 세션 및 개인 Projects; Claude Tag는 Slack 유료 플랜 한정",
      },
      {
        dimension: "지원 코딩 에이전트",
        xmatrix: "35종 코딩 에이전트 내장(Claude Code, Codex, Cursor, Gemini, Antigravity 등) + --runtime",
        competitor: "Claude 전용",
      },
      {
        dimension: "Claude 사용 한도 도달 시",
        xmatrix: "작업 체크아웃과 페이지 맥락을 다른 가용 에이전트로 자동 핸드오프",
        competitor: "5시간/주간 초기화까지 작업 중단 또는 유료 API 키 수동 전환 필요",
      },
      {
        dimension: "감독 방식",
        xmatrix: "페이지, PR 체크, 승인 카드를 보며 수십 개의 병렬 실행을 관리",
        competitor: "단일 세션의 diff 뷰어, 터미널, 액션 프롬프트에 밀착 페어링",
      },
      {
        dimension: "운영 커넥터 및 시크릿",
        xmatrix: "스페이스 시크릿 + 앱별 정책을 갖춘 35개 앱",
        competitor: "세션별 MCP 도구; Duet 클라우드 VM은 미국 한정 리서치 대기열",
      },
    ],
    stayWhen: [
      "Claude만 사용하고 완전히 혼자 작업하며 Anthropic 구독에 포함된 밀착 인라인 diff 페어링과 내장 클라우드 VM을 원하는 경우.",
    ],
    switchWhen: [
      "Claude의 5시간 또는 주간 한도 때문에 반나절을 날리는 데 지쳐 Codex나 Gemini가 매끄럽게 이어받길 원하는 경우.",
      "팀원들과 여러 하네스가 같은 채널, 살아 있는 페이지, 스페이스 시크릿을 공유하길 원하는 경우.",
      "많은 병렬 업무를 감독하며 모든 터미널을 돌보는 대신 프로젝트 페이지와 예외 카드만 확인하고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 Claude Code CLI를 지우지 말고 그대로 두세요",
        detail:
          "xMatrix는 기존 로그인을 사용해 공식 로컬 Claude Code CLI를 직접 구동하므로 잃는 것이 없습니다.",
      },
      {
        title: "자동 할당량 연속성을 위해 두 번째 하네스를 추가하세요",
        detail:
          "xmatrix agent add로 Claude Code 옆에 Codex, Gemini, Cursor, OpenCode를 등록하면 @auto가 할당량 벽을 자동으로 우회합니다.",
      },
      {
        title: "로컬 CLAUDE.md의 반복 맥락을 살아 있는 페이지로 옮기세요",
        detail:
          "프로젝트 상태, 결정 사항, 남은 작업을 페이지에 두면 모든 하네스와 팀원이 같은 최신 내용을 공유합니다.",
      },
    ],
    faqs: [
      {
        question: "xMatrix를 쓰려면 Claude Code를 포기해야 하나요?",
        answer:
          "전혀 아닙니다. Claude Code는 xMatrix의 1급 지원 하네스입니다. 본인 머신에서 Claude Code를 계속 사용하면서 멀티플레이어 채널, 살아 있는 페이지, 그리고 한도 도달 시 Codex·Gemini 자동 페일오버까지 얻을 수 있습니다.",
      },
      {
        question: "xMatrix에서 제 개인 Claude 구독을 팀원들과 공유할 수 있나요?",
        answer:
          "아니요. xMatrix는 벤더 이용약관을 준수하며 구독 풀링을 표방하지 않습니다. 각 머신과 사용자는 적법하게 권한을 가진 본인의 하네스 구독이나 API 키를 사용합니다.",
      },
      {
        question: "xMatrix도 Claude Cowork처럼 클라우드 VM을 포함하나요?",
        answer:
          "현재는 포함하지 않습니다. xMatrix는 macOS, Windows, Linux 전반에서 사용자가 소유한 노트북, 데스크톱, 자체 관리 서버를 연결합니다.",
      },
    ],
  },
  linear: {
    alsoKnownAs: "Linear Coding Sessions 및 Loops",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Linear Agents 대안 (2026): Linear vs xMatrix",
    metaDescription:
      "Linear Agents 대안을 비교 중이신가요? 12개월 만료 선불 샌드박스 크레딧, 클라우드 전용 티켓 실행, Enterprise 전용 감사 로그 대신 xMatrix의 로컬 채널과 살아 있는 페이지를 써 보세요.",
    eyebrow: "Linear Agents 대안 · Linear vs xMatrix",
    headline: "내 머신과 구독으로 에이전트 실행 — 만료되는 크레딧 없이 Linear와 함께 사용",
    lead: "Linear는 탁월한 이슈 트래커이며 Linear Agents는 범위가 명확한 이슈를 클라우드 샌드박스 PR로 바꿔 줍니다—단, 12개월 뒤 만료되는 별도 선불 지갑에서 20분당 $0.25와 토큰 비용을 차감합니다. 이슈 추적은 Linear에 그대로 두고 xMatrix와 연결해 본인 머신의 실시간 채널과 살아 있는 페이지에서 35종 코딩 에이전트를 실행하세요.",
    productCaption:
      "xMatrix 화면: Linear 연결은 그대로 유지하면서 샌드박스 시간 과금이나 만료되는 선불 잔액 없이 실시간 채널에서 로컬 Claude Code와 Codex 하네스를 실행하세요.",
    painPoints: [
      {
        title: "만료되고 환불도 안 되는 별도 선불 크레딧 지갑",
        problem:
          "Basic(시트당 $10)이나 Business(시트당 $16, Loops 필수) 요금제에 더해, Linear Coding Sessions는 12개월 후 만료되고 환불이 불가한 별도 USD 선불 잔액(최소 $10 충전)에서 토큰 비용 + 20분 샌드박스 블록당 $0.25를 과금합니다. 모호한 티켓이 재시도를 반복하면 크레딧이 빠르게 소진됩니다.",
        xmatrixAnswer:
          "xMatrix는 이미 결제 중인 Claude Code, Codex, Cursor 구독으로 본인 머신에서 에이전트를 실행하므로 샌드박스 시간 계량도, 만료되는 선불 현금 잔액도 없습니다.",
      },
      {
        title: "모든 작업이 티켓 형태—실시간 멀티 에이전트 채널과 로컬 머신 오케스트레이션 없음",
        problem:
          "Linear Agents는 클라우드 샌드박스에서 잘게 쪼개진 사전 정의 이슈를 처리하는 데는 강하지만, 본인의 MacBook, Linux 빌드 머신, Windows PC에 걸쳐 에이전트를 조율할 수 없으며 여러 하네스를 함께 지휘할 실시간 채널도 없습니다.",
        xmatrixAnswer:
          "xMatrix는 사람과 여러 로컬 하네스가 실시간으로 협업하는 채널을 제공하고, 결과 상태를 살아 있는 페이지에 직접 기록합니다.",
      },
      {
        title: "작업별 코딩 승인 부재 및 빈약한 에이전트 감사 추적",
        problem:
          "Linear의 감사 로그는 Enterprise 플랜에만 제공되고 개별 에이전트 작업 단위로 세밀하게 기록되지 않으며, Cloudflare, Vercel, Gmail, Sentry, Stripe를 아우르는 통합 앱별 승인 게이트도 없습니다.",
        xmatrixAnswer:
          "xMatrix는 모든 플랜에서 전체 대화·실행 추적, 스페이스 시크릿, 그리고 Linear 자체를 포함한 35개 연동 앱의 앱별 정책을 제공합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "코딩 에이전트 실행 위치",
        xmatrix: "본인 소유의 macOS, Windows, Linux 머신(노트북·데스크톱·자체 서버)",
        competitor: "Linear 클라우드 샌드박스(20분당 $0.25) 또는 외부 벤더 클라우드",
      },
      {
        dimension: "에이전트 과금 모델",
        xmatrix: "35종 코딩 에이전트에서 본인 모델 구독 사용(BYO); Pro 사람 시트당 월 $10(연간 월 $8)",
        competitor: "시트 요금(월 $10~$16) + 별도 선불 크레딧(12개월 만료, 환불 불가)",
      },
      {
        dimension: "가장 잘 맞는 작업 형태",
        xmatrix: "Linear와 직접 연동되는 실시간 채널·살아 있는 페이지·운영 중심 업무",
        competitor: "클라우드 PR로 보내기 좋은 명확한 범위의 이슈 티켓",
      },
      {
        dimension: "거버넌스 및 감사 가능성",
        xmatrix: "모든 플랜에서 35개 앱의 앱별 정책 + 스페이스 시크릿",
        competitor: "팀 단위 에이전트 토글; 감사 로그는 Enterprise 전용이며 에이전트 작업별 미기록",
      },
      {
        dimension: "함께 사용 가능 여부",
        xmatrix: "네이티브 Linear 커넥터로 xMatrix 에이전트가 Linear 이슈를 읽고 업데이트",
        competitor: "이슈 중심; 서드파티 에이전트는 Agent Interaction API로 연결",
      },
    ],
    stayWhen: [
      "워크플로가 깔끔하게 독립된 티켓의 이슈→PR 자동화로만 한정되어 있고 로컬 머신 설정을 전혀 하고 싶지 않은 경우.",
      "이미 Linear Business를 쓰고 있으며 Linear 이슈에 가끔 클라우드 Loops만 돌리면 충분한 경우.",
    ],
    switchWhen: [
      "20분당 샌드박스 요금을 내거나 만료되는 선불 잔액을 관리하지 않고 본인 하드웨어에서 기존 Claude Code/Codex 구독을 쓰고 싶은 경우.",
      "티켓뿐 아니라 아키텍처, 릴리스, 운영을 위한 실시간 멀티 에이전트 채널과 살아 있는 페이지가 필요한 경우.",
      "Linear, GitHub, Vercel, Cloudflare, Sentry, Gmail 전반에 걸쳐 앱별 승인과 스페이스 시크릿을 원하는 경우.",
    ],
    migrationSteps: [
      {
        title: "Linear는 이슈 트래커로 유지하고 xMatrix에 연결하세요",
        detail:
          "Linear를 버릴 필요가 없습니다. xMatrix에서 Linear 앱을 연결하면 로컬 에이전트가 이슈를 읽고 PR을 올리며 상태를 동기화합니다.",
      },
      {
        title: "로컬 머신과 하네스를 등록하세요",
        detail:
          "클라우드 샌드박스 요금 없이 본인 워크스테이션에서 Claude Code, Codex, Cursor, Gemini를 실행하세요.",
      },
      {
        title: "살아 있는 페이지로 프로젝트 현황을 유지하세요",
        detail:
          "업무 스트림에 페이지를 연결하면 아키텍처 결정, 릴리스 상태, 남은 블로커가 티켓 댓글 바깥에서도 명확히 읽힙니다.",
      },
    ],
    faqs: [
      {
        question: "xMatrix를 쓰려면 Linear를 떠나야 하나요?",
        answer:
          "아니요. xMatrix에는 네이티브 Linear 커넥터가 있어 이슈 추적은 Linear에서 계속하면서 멀티 에이전트 실행, 살아 있는 페이지, 승인 기반 운영 워크플로는 xMatrix에서 돌릴 수 있습니다.",
      },
      {
        question: "Linear Coding Sessions의 BYOK 옵션을 쓰면 되지 않나요?",
        answer:
          "BYOK를 써도 Linear Coding Sessions는 여전히 만료되는 선불 크레딧에서 20분 블록당 $0.25가 과금되는 클라우드 샌드박스에서만 실행되며, 로컬 머신이나 Linear 외 운영 커넥터를 조율할 수 없습니다.",
      },
      {
        question: "xMatrix에서는 Loops 같은 예약 자동화에 추가 요금이 드나요?",
        answer:
          "일정 및 이벤트 기반 Norn 루틴은 별도 Business 티어 업그레이드 없이 기존 플랜 크레딧 안에서 xMatrix 페이지에 기본 내장되어 있습니다.",
      },
    ],
  },
  notion: {
    alsoKnownAs: "Notion AI 및 외부 에이전트",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Notion Custom Agents 대안 (2026): Notion vs xMatrix",
    metaDescription:
      "Notion Custom Agents 대안을 찾고 계신가요? $20~$24 Business 페이월, 3중 크레딧 지갑, 생성자 크레딧 고갈로 인한 중단, 모바일 제한 대신 xMatrix의 살아 있는 페이지를 써 보세요.",
    eyebrow: "Notion Custom Agents 대안 · Notion vs xMatrix",
    headline: "에이전트가 코드를 배포할 때마다 최신화되는 살아 있는 페이지 — 3중 크레딧 지갑 없이",
    lead: "Notion Custom Agents는 시트당 $20~$24 Business 요금제와 복잡한 3중 크레딧 지갑 뒤에 잠겨 있어, 공유 에이전트가 생성자의 개인 Select 크레딧을 갉아먹다 작업 도중 멈춰 버립니다. xMatrix는 35종 코딩 에이전트가 실제 저장소에서 배포할 때마다 살아 있는 페이지를 자동으로 최신화합니다—복잡한 크레딧 지갑 없이요.",
    productCaption:
      "xMatrix 화면: 하나의 스페이스 통합 크레딧과 완전한 모바일 접근 권한으로, 에이전트가 실제 저장소에서 일하고 채널에서 팀과 소통하며 살아 있는 페이지를 유지합니다.",
    painPoints: [
      {
        title: "세 갈래로 쪼개진 크레딧 지갑과 생성자 크레딧 고갈로 인한 중단",
        problem:
          "Notion은 AI 사용량을 개인 Standard 크레딧(월 1,500), 개인 Select 크레딧(월 500, Custom Agents 필수), 관리자가 별도 구매하는 Workspace Notion Credits(1,000당 $10)으로 쪼개 놓았습니다. 개인 잔액은 합산이나 이월이 안 되며, 팀원이 공유 에이전트를 실행하면 기본적으로 생성자의 개인 Select 풀이 소모되어 0이 되는 순간 에이전트가 작업 도중 멈춥니다.",
        xmatrixAnswer:
          "xMatrix Pro는 사람 시트당 월 $10(연간 월 $8)의 단일 요금으로 스페이스 전체가 함께 쓰는 시트당 5,000 통합 에이전트 크레딧과 50% 여유 버퍼를 제공하며 LLM 토큰 재판매가 없고 사람 편집은 항상 무료입니다.",
      },
      {
        title: "로컬 머신 실행, 멀티 머신 릴레이, 실시간 에이전트 채널 부재",
        problem:
          "Notion은 문서를 수동 작업면으로 다루며 코딩은 외부 클라우드 API(알파)에 위임합니다. 사용자의 노트북이나 빌드 서버에서 Claude Code나 Codex를 직접 실행할 수 없고, 스페이스 시크릿도, 다중 사용자+다중 에이전트 실시간 채널도 없습니다.",
        xmatrixAnswer:
          "xMatrix에서는 채널에서 대화하면 에이전트가 macOS, Windows, Linux의 로컬 저장소에서 직접 실행되고, 실제 엔지니어링 작업의 자연스러운 부산물로 살아 있는 페이지가 업데이트됩니다.",
      },
      {
        title: "모바일에서 팀 공유 Custom Agents 생성은 물론 실행조차 불가",
        problem:
          "Notion 모바일 앱은 Custom Agents 생성을 막아 두었으며, 모바일 사용자는 본인이 직접 소유한 Custom Agents하고만 상호작용할 수 있어 자리에서 벗어난 팀원들이 발이 묶입니다.",
        xmatrixAnswer:
          "모든 xMatrix 멤버는 웹(iPhone·iPad 포함), 데스크톱, Android 어디서나 페이지를 읽고 권한 있는 모든 스페이스 에이전트를 호출하며 외부 커넥터 작업을 승인할 수 있습니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "요금 및 크레딧 구조",
        xmatrix: "Free(총 500회 쓰기) + Pro 시트당 월 $10(연간 월 $8); 하나의 스페이스 통합 크레딧 풀",
        competitor: "Business 시트당 월 $20~$24 + 3개 별도 지갑(Standard, Select, Workspace $10/1k)",
      },
      {
        dimension: "에이전트 실행 위치",
        xmatrix: "본인 소유의 macOS, Windows, Linux 머신에서 35종 코딩 에이전트로 직접 실행",
        competitor: "Notion 클라우드 브라우저/VM; 코딩은 외부 벤더 클라우드에 위임",
      },
      {
        dimension: "문서 최신화 방식",
        xmatrix: "코딩 에이전트가 배포하며 페이지를 직접 수정; 제안 모드·작성자 기록 지원",
        competitor: "사람이 에이전트나 트리거를 호출해 블록 편집; 제안 모드·작성자 기록 역시 지원",
      },
      {
        dimension: "모바일 팀 접근성",
        xmatrix: "모든 멤버에게 채널, 페이지, 에이전트 호출, 승인 기능 전체 제공",
        competitor: "모바일에서 Custom Agents 생성 불가 및 팀 공유 에이전트 실행 불가",
      },
      {
        dimension: "시크릿 및 엔지니어링 커넥터",
        xmatrix: "스페이스 시크릿 볼트 + Notion 자체를 포함한 35개 연동 앱",
        competitor: "CLI 실행용 스페이스 시크릿 볼트 없음",
      },
    ],
    stayWhen: [
      "비개발 팀을 포함한 전사가 관계형 Notion 데이터베이스, CRM 테이블, 풍부한 서식 문서 중심으로 운영되는 경우.",
    ],
    switchWhen: [
      "Standard·Select·Workspace 크레딧을 따져보거나 작성자 한 명의 개인 크레딧이 바닥나 팀 공유 에이전트가 멈추는 상황에 지친 경우.",
      "현실과 동떨어지는 위키가 아니라 코딩 에이전트가 실제 저장소에서 일하며 자동으로 최신화하는 프로젝트 페이지를 원하는 경우.",
      "엔지니어들이 모바일에서도 공유 에이전트, 스페이스 시크릿, 승인 기반 배포·운영 커넥터를 써야 하는 경우.",
    ],
    migrationSteps: [
      {
        title: "하루아침에 다 옮기지 말고 먼저 Notion을 연결하세요",
        detail:
          "xMatrix에는 네이티브 Notion 커넥터가 있어 에이전트가 기존 Notion 스펙을 읽으면서 실시간 엔지니어링 상태는 xMatrix 페이지로 유지할 수 있습니다.",
      },
      {
        title: "빠르게 변하는 프로젝트 상태부터 xMatrix 페이지로 옮기세요",
        detail:
          "Notion에서 가장 빨리 낡아 버리는 릴리스 추적, 아키텍처 결정, 인시던트 런북부터 시작해 보세요.",
      },
      {
        title: "일정 및 이벤트 기반 Norn 루틴을 붙이세요",
        detail:
          "각 페이지 안에 루틴을 넣어 두면 Notion Select 크레딧을 태우지 않고도 GitHub, Sentry, 일일 일정에 따라 페이지가 자동 업데이트됩니다.",
      },
    ],
    faqs: [
      {
        question: "기존 Notion 워크스페이스를 xMatrix에 연결할 수 있나요?",
        answer:
          "네. xMatrix는 읽기 전용, 먼저 묻기, 읽기 및 쓰기 권한을 설정할 수 있는 내장 Notion 커넥터를 제공합니다.",
      },
      {
        question: "제가 설정한 에이전트를 팀원이 호출하면 제 개인 크레딧이 깎이나요?",
        answer:
          "아니요. xMatrix Pro의 에이전트 크레딧(사람 시트당 월 5,000)은 스페이스 전체가 공동으로 사용하므로 생성자 개인 지갑 병목이 없습니다.",
      },
      {
        question: "사람과 에이전트가 같은 xMatrix 페이지를 동시에 수정하면 어떻게 되나요?",
        answer:
          "항상 사람이 우선입니다. 에이전트가 업데이트 중인 문단에 사람이 입력하면 에이전트가 기다렸다가 사람이 쓴 내용을 기준으로 이어서 작성하므로 내 글이 덮어쓰이지 않습니다.",
      },
    ],
  },
  "slack-code": {
    alsoKnownAs: "Slack Code API",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Slack Code 대안 (2026): Slack Code vs xMatrix",
    metaDescription:
      "Slack Code 대안을 찾고 계신가요? 비마켓플레이스 앱의 분당 1회·15개 메시지 기록 제한, Free 90일 한도, 런타임 부재 대신 xMatrix를 사용해 보세요.",
    eyebrow: "Slack Code 대안 · Slack Code vs xMatrix",
    headline: "내 머신에서 도는 에이전트, 살아 있는 페이지에 남는 결정 — Slack과 함께 사용",
    lead: "Slack Code API는 Slack 안에 태스크 채널과 diff 미리보기를 더했지만, Slack은 여전히 에이전트 런타임도 살아 있는 문서도 없는 채팅 껍데기이며 비마켓플레이스 앱의 기록 조회 API를 분당 1회·최대 15개 메시지로 강하게 제한합니다. xMatrix의 Slack 커넥터로 Slack을 계속 연결해 두면서 본인 머신에서 35종 코딩 에이전트를 실행하고 결정 사항은 살아 있는 페이지에 남기세요.",
    productCaption:
      "xMatrix 화면: 전체 맥락 접근과 15개 메시지 API 장벽 없는 네이티브 다중 사용자·다중 에이전트 채널, 본인 머신 실행, 살아 있는 페이지.",
    painPoints: [
      {
        title: "커스텀 코딩 에이전트의 맥락을 굶기는 강력한 Slack API 스로틀링",
        problem:
          "Slack은 비마켓플레이스 앱의 conversations.history와 conversations.replies를 분당 1회 요청·요청당 최대 15개 객체로 조여 커스텀 에이전트의 컨텍스트 창을 크게 줄였고 AI 게이트키핑 논란을 불러일으켰습니다. 게다가 Free 워크스페이스는 90일이 지나면 기록이 사라집니다.",
        xmatrixAnswer:
          "xMatrix는 에이전트를 네이티브로 지원합니다. 전체 채널 기록, 개요·섹션 단위 페이지 읽기, 그리고 본인 스페이스에 대한 인위적인 15개 메시지 제한 없음이 기본입니다.",
      },
      {
        title: "Slack은 채팅 UI일 뿐—런타임, 멀티 머신 라우팅, 스페이스 시크릿 없음",
        problem:
          "Slack Code는 diff와 파트너 에이전트 업데이트를 보여 줄 뿐이므로, 파트너 에이전트를 따로 결제하거나 직접 머신 러너·데몬·할당량 페일오버·시크릿 주입 인프라를 구축하고 호스팅해야 합니다.",
        xmatrixAnswer:
          "xMatrix는 완전한 런타임 조율 스택을 제공합니다. macOS, Windows, Linux 머신을 한 번 등록하고 Claude Code, Codex, Cursor, Gemini 사이를 라우팅하며 스페이스 시크릿을 깔끔하게 주입합니다.",
      },
      {
        title: "끝없이 흐르는 Slack 채널 속에서 지식이 사라짐",
        problem:
          "태스크 채널을 써도 Slack에는 살아 있는 프로젝트 문서 계층이 없어 결정 사항이 수백 개의 메시지 아래로 가라앉고, 새로 합류한 사람과 에이전트는 무엇이 여전히 유효한지 추측해야 합니다.",
        xmatrixAnswer:
          "모든 xMatrix 채널은 살아 있는 페이지와 직접 연결되어 에이전트가 현재 상태를 제자리에서 갱신하므로 페이지 한 장만 읽으면 프로젝트 현황을 바로 파악할 수 있습니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "에이전트 맥락 및 API 제한",
        xmatrix: "네이티브 전체 채널 기록 읽기 + 구조화된 페이지 개요/섹션 읽기",
        competitor: "비마켓플레이스 기록/답글 분당 1회·15개 제한; Free 90일 기록 제한",
      },
      {
        dimension: "실행 런타임",
        xmatrix: "35종 코딩 에이전트(+ --runtime)를 위한 내장 멀티 머신 데몬",
        competitor: "채팅 UI 전용; 별도 파트너 에이전트 구독 또는 자체 호스팅 필요",
      },
      {
        dimension: "살아 있는 프로젝트 상태",
        xmatrix: "작업 완료 시 에이전트가 최신화하는 살아 있는 페이지",
        competitor: "흘러가는 채팅 기록과 보관된 태스크 채널",
      },
      {
        dimension: "거버넌스 커넥터 및 시크릿",
        xmatrix: "스페이스 시크릿 + 앱별 정책을 갖춘 35개 연동 앱",
        competitor: "내장 에이전트 시크릿 볼트 및 크로스 앱 런타임 거버넌스 없음",
      },
      {
        dimension: "Slack 연동 여부",
        xmatrix: "네이티브 Slack 커넥터로 승인 하에 Slack 읽기/게시 가능",
        competitor: "Slack 내부에만 종속",
      },
    ],
    stayWhen: [
      "회사 전체가 Slack을 절대 떠날 수 없으며 기존 Slack 스레드에 유료 마켓플레이스 파트너 에이전트가 diff만 올려 주면 충분한 경우.",
    ],
    switchWhen: [
      "Slack의 분당 1회·15개 메시지 기록 제한 때문에 커스텀 에이전트 워크플로가 망가지고 있는 경우.",
      "별도 연결 인프라를 짜지 않고도 Claude Code, Codex, Cursor용 멀티 머신 러너를 바로 쓰고 싶은 경우.",
      "Slack 스크롤백으로 사라지는 대신 살아 있는 페이지에 프로젝트 결정을 남기고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "전사 채팅은 Slack에 두고 xMatrix와 연결하세요",
        detail:
          "xMatrix의 네이티브 Slack 커넥터를 먼저 묻기 또는 읽기 전용 정책으로 붙이면 비개발 팀원과의 소통을 끊지 않고도 엔지니어링 작업을 구조화할 수 있습니다.",
      },
      {
        title: "멀티 에이전트 엔지니어링 채널을 xMatrix로 옮기세요",
        detail:
          "머신을 등록하고 전체 맥락이 보장되는 xMatrix 채널에서 Claude Code, Codex, Cursor를 직접 실행하세요.",
      },
      {
        title: "고정된 Slack 메시지를 살아 있는 페이지로 바꾸세요",
        detail:
          "오래된 고정 메시지와 북마크를 에이전트가 자동으로 최신화하는 페이지로 대체하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix에서 기존 Slack 워크스페이스와 계속 연동할 수 있나요?",
        answer:
          "네. xMatrix는 앱별 읽기 전용, 먼저 묻기, 읽기 및 쓰기 권한을 지원하는 네이티브 Slack 커넥터를 제공합니다.",
      },
      {
        question: "xMatrix에서는 제 에이전트가 읽을 수 있는 채널 기록량에 제한이 있나요?",
        answer:
          "아니요. 에이전트는 대화 기록과 연결된 살아 있는 페이지를 직접 읽으며, 비마켓플레이스 15개 메시지 API 장벽 같은 제한이 없습니다.",
      },
      {
        question: "Slack + 파트너 코딩 에이전트 조합과 비교하면 xMatrix 요금은 어떤가요?",
        answer:
          "Slack 시트 위에 별도 파트너 에이전트 구독을 겹쳐 내는 대신, xMatrix Pro는 사람 시트당 월 $10(연간 월 $8)에 기존 CLI 구독을 사용하는 무제한 에이전트를 제공합니다.",
      },
    ],
  },
  "nowledge-mem": {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "Nowledge Mem 대안 (2026): Nowledge Mem vs xMatrix",
    metaDescription:
      "Nowledge Mem 대안을 비교 중이신가요? 채팅에서 메모리 조각을 사후 추출하는 데 그치지 말고 xMatrix에서 여러 머신의 코딩 에이전트를 실행하며 신뢰할 수 있는 살아 있는 페이지를 최신화하세요.",
    eyebrow: "Nowledge Mem 대안 · Nowledge Mem vs xMatrix",
    headline: "직접 일하는 에이전트가 기록하는 팀 프로젝트 메모리",
    lead: "Nowledge Mem은 여러 AI 도구에 걸친 영리한 로컬 그래프·벡터 메모리 계층이지만, 수동적인 메모리 저장소일 뿐 오래된 채팅에서 사실을 추측하고 코딩 에이전트 실행이나 외부 도구 거버넌스를 제공하지 못하며 Team 워크스페이스는 여전히 비공개 베타입니다. xMatrix에서는 실제 작업을 수행하는 실행(Run)이 팀 전체가 오늘 바로 공유하는 공식 살아 있는 페이지를 작성합니다.",
    productCaption:
      "xMatrix 화면: 예전 채팅에서 기억을 수동으로 추측해 뽑는 대신, 실제로 코드를 배포하는 코딩 에이전트가 팀의 살아 있는 프로젝트 페이지를 정확하게 유지합니다.",
    painPoints: [
      {
        title: "확률적 메모리 추측 vs. 신뢰할 수 있는 프로젝트 페이지 직접 갱신",
        problem:
          "Nowledge Mem은 백그라운드에서 채팅을 관찰해 30일 감쇠와 모순 큐를 갖춘 Trace → Unit → Crystal 메모리 그래프를 추론합니다. PR이나 배포로 엔지니어링 사실이 바뀔 때 확률적 메모리 추출은 실제 공식 기록보다 뒤처지기 쉽습니다.",
        xmatrixAnswer:
          "xMatrix에서는 PR을 병합하거나 점검을 마친 바로 그 에이전트 실행(Run)이 프로젝트의 살아 있는 페이지를 제자리에서 고쳐 쓰며, 제안 모드·문단별 작성자 기록·리비전 이력과 함께 사람과 에이전트 모두가 동일한 공식 문서를 읽습니다.",
      },
      {
        title: "에이전트 오케스트레이션, 팀 채널, 멀티 머신 실행 부재",
        problem:
          "Nowledge Mem은 코딩 에이전트를 실행하지 못하고, 공유 채널에서 여러 팀원을 조율하지 못하며, 여러 머신으로 작업을 라우팅하지 못하므로 여전히 별도 러너, 터널, MCP 설정을 직접 이어 붙여야 합니다.",
        xmatrixAnswer:
          "xMatrix는 공유 채널, 35종 코딩 에이전트의 멀티 머신 라우팅, 개요·섹션 단위 점진적 페이지 읽기, 살아 있는 페이지를 하나의 제품으로 제공하는 완전한 조율 계층입니다.",
      },
      {
        title: "비공개 베타 상태의 팀 동기화와 운영 거버넌스 부재",
        problem:
          "Nowledge Mem Team은 여전히 비공개 베타이며, 로컬 설정에 macOS 15+와 수동 MCP/프록시 연결이 필요하고, 프로덕션 도구를 위한 스페이스 시크릿 볼트나 앱별 승인 게이트가 없습니다.",
        xmatrixAnswer:
          "xMatrix 스페이스는 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 오늘 바로 셀프서브로 사용할 수 있으며, 스페이스 시크릿과 35개 연동 앱의 앱별 정책을 제공합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "핵심 역할",
        xmatrix: "공유 채널에서 멀티 에이전트 작업을 실행하고 살아 있는 페이지를 최신화",
        competitor: "도구 간 대화 메모리를 추출·색인·검색",
      },
      {
        dimension: "진실의 원천(Source of truth)",
        xmatrix: "작업하는 실행(Run)이 직접 수정하는 공식 살아 있는 Markdown 페이지",
        competitor: "30일 감쇠가 있는 추론 그래프·벡터 Crystal; LLM Wiki는 파생 뷰",
      },
      {
        dimension: "팀 기능 제공 상태",
        xmatrix: "셀프서브 Free(총 500회 쓰기)·Pro 팀 스페이스 즉시 사용 가능",
        competitor: "로컬 개인 앱 정식 출시; Cloud 공개 베타; Team 워크스페이스 비공개 베타",
      },
      {
        dimension: "에이전트 실행",
        xmatrix: "보유 머신 전반에서 35종 코딩 에이전트(+ --runtime) 실행 및 라우팅",
        competitor: "코딩 에이전트 실행 및 라우팅 미지원",
      },
      {
        dimension: "시크릿 및 외부 앱",
        xmatrix: "스페이스 시크릿 + 앱별 정책을 갖춘 35개 연동 앱",
        competitor: "Team에서 호스팅 Slack 연결; 운영 커넥터 승인 계층 없음",
      },
    ],
    stayWhen: [
      "코드 실행 방식은 바꾸지 않은 채 웹 ChatGPT, Claude 웹, Cursor의 대화를 수집하는 오프라인 개인 메모리 그래프만 원하는 경우.",
    ],
    switchWhen: [
      "백그라운드 추출기가 오래된 로그에서 사실을 추측하는 대신, 실제 작업을 하는 에이전트가 하나의 공식 프로젝트 페이지를 유지하길 원하는 경우.",
      "비공개 베타가 아니라 오늘 바로 쓸 수 있는 팀 스페이스, 멀티 머신 에이전트 실행, 35개 연동 앱 거버넌스가 필요한 경우.",
      "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 수동 로컬 프록시·터널 배선 없이 쓰고 싶은 경우.",
    ],
    migrationSteps: [
      {
        title: "영구적인 지식을 살아 있는 xMatrix 페이지로 승격하세요",
        detail:
          "핵심 결정 사항과 아키텍처 메모(OKF/Markdown 내보내기 포함)를 프로젝트별 xMatrix 페이지로 옮기세요.",
      },
      {
        title: "코딩 하네스를 한 번만 연결하세요",
        detail:
          "xMatrix에 Claude Code, Codex, Cursor, Gemini를 등록하면 모든 실행이 필요한 페이지 개요와 섹션만 정확히 읽고 결과를 다시 기록합니다.",
      },
      {
        title: "Norn 루틴으로 페이지 최신화를 예약하세요",
        detail:
          "유휴 채팅 로그에 백그라운드 LLM 추출 토큰을 쓰지 않고도 지표, 릴리스 노트, 남은 블로커를 자동으로 최신 상태로 유지하세요.",
      },
    ],
    faqs: [
      {
        question: "벡터 데이터베이스 없이 에이전트가 컨텍스트를 너무 많이 읽지 않게 어떻게 관리하나요?",
        answer:
          "xMatrix는 점진적 읽기(progressive reading)를 지원합니다. 에이전트가 스페이스 페이지 트리와 요약을 훑어보고, 페이지 개요와 섹션 크기를 확인한 뒤 필요한 섹션만 읽어 제자리에서 수정합니다.",
      },
      {
        question: "Nowledge Mem과 xMatrix를 함께 사용할 수도 있나요?",
        answer:
          "네. 일상적인 웹 채팅용 개인 메모리로 Nowledge Mem을 쓰면서, 공유 프로젝트 상태·에이전트 오케스트레이션·팀 승인은 xMatrix에서 관리할 수 있습니다.",
      },
      {
        question: "에이전트가 xMatrix 페이지에 잘못된 내용을 쓰면 어떻게 되나요?",
        answer:
          "모든 페이지에는 전체 리비전 이력과 사람 우선 공동 편집이 적용되어 있어 어떤 줄이든 직접 고치면 에이전트가 즉시 수정된 내용을 기준으로 이어갑니다.",
      },
    ],
  },
  everos: {
    alsoKnownAs: "EverMind / EverMemOS",
    verifiedDate: "2026년 11월 22일",
    metaTitle: "EverOS (EverMemOS) 대안 (2026): EverOS vs xMatrix",
    metaDescription:
      "EverOS 또는 EverMemOS 대안을 찾고 계신가요? 단일 머신 SQLite 락, 숨겨진 추출 LLM 비용, 팀 동기화 부재 대신 xMatrix의 채널과 살아 있는 페이지를 사용해 보세요.",
    eyebrow: "EverOS (EverMemOS) 대안 · EverOS vs xMatrix",
    headline: "직접 일하는 에이전트가 기록하는 멀티 머신 프로젝트 메모리",
    lead: "EverOS(EverMemOS)는 Markdown 파일에 로컬 SQLite와 LanceDB 인덱스를 결합했지만, 오픈소스 v1은 같은 디렉터리에서 두 번째 서비스 실행을 명시적으로 거부하고 멀티테넌시와 동기화를 범위에서 제외했으며 백그라운드 추출에 지속적으로 LLM 토큰을 소모합니다. xMatrix는 팀을 위한 35종 코딩 에이전트의 실시간 멀티 머신 실행과 공식 살아 있는 페이지를 제공합니다.",
    productCaption:
      "xMatrix 화면: 단일 디렉터리 락이나 백그라운드 추출 토큰 소모 없이, 작업 중인 코딩 에이전트가 실시간으로 멀티 머신 Markdown 페이지를 최신화합니다.",
    painPoints: [
      {
        title: "동기화·멀티테넌시를 명시적으로 제외한 단일 머신 v1 아키텍처",
        problem:
          "EverOS v1은 단일 로컬 프로세스용으로 설계되어 같은 디렉터리에서 두 번째 서비스를 띄우면 거부되고 멀티테넌시와 분산 동기화가 범위 밖으로 명시되어 있으며, 여러 코딩 도구가 로컬 Markdown/SQLite 디렉터리를 공유하면 락 경합이 발생합니다.",
        xmatrixAnswer:
          "xMatrix는 로컬 SQLite 락 충돌 없이 모든 팀원과 등록된 macOS, Windows, Linux 머신 사이에서 페이지와 채널을 실시간으로 동기화합니다.",
      },
      {
        title: "지속적인 백그라운드 LLM 토큰 비용과 로컬 인덱싱 부하",
        problem:
          "로컬 LanceDB 벡터 인덱싱과 함께 에피소드 추출, 충돌 해결, 프로필 통합을 위해 상시 LLM 호출을 돌리면 단일 머신 RAM에 부담이 크고 예측하기 어려운 API 비용이 계속 발생하며, 다중 사용자 EverMemBench 정확도도 66.67%까지 떨어집니다.",
        xmatrixAnswer:
          "xMatrix는 오래된 로그에서 무슨 일이 있었는지 추측하는 백그라운드 추출 루프를 돌리지 않습니다. 작업을 마친 에이전트 실행(Run)이 관련 페이지 섹션을 직접 업데이트합니다.",
      },
      {
        title: "메모리 저장소만으로는 코딩 에이전트를 실행·라우팅·통제할 수 없음",
        problem:
          "EverOS는 메모리 백엔드이며(v1.7.1에서 Foresight 예측 기능도 제거됨), 여러 머신에서 코딩 에이전트를 호출하거나 Vercel·Cloudflare·Gmail·Stripe 작업 전 사람 승인을 요구할 수 없습니다.",
        xmatrixAnswer:
          "xMatrix는 35종 코딩 에이전트의 멀티 에이전트 실행, 스페이스 시크릿, 35개 연동 앱의 앱별 승인, 살아 있는 페이지를 하나의 워크스페이스로 결합합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "멀티 머신 및 팀 동기화",
        xmatrix: "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)을 아우르는 실시간 다중 사용자·멀티 머신 스페이스",
        competitor: "오픈소스 v1은 엄격히 단일 머신 전용; 멀티테넌시 및 동기화 범위 제외",
      },
      {
        dimension: "지식 최신화 방식",
        xmatrix: "작업하는 에이전트 실행(Run)이 공식 Markdown 페이지를 제자리에서 수정",
        competitor: "SQLite + LanceDB 인덱스로 백그라운드 LLM 추출(추가 토큰 소모)",
      },
      {
        dimension: "에이전트 실행 및 라우팅",
        xmatrix: "보유 머신 전반에서 35종 코딩 에이전트(+ --runtime) 실행 및 라우팅",
        competitor: "메모리 계층 전용; 에이전트 실행 및 조율 미지원",
      },
      {
        dimension: "동시 편집",
        xmatrix: "제안 모드, 작성자 기록, 사람 편집 우선을 지원하는 실시간 협업 페이지",
        competitor: "로컬 디렉터리 락; 여러 로컬 도구 동시 쓰기 시 경합 발생",
      },
      {
        dimension: "거버넌스 및 커넥터",
        xmatrix: "스페이스 시크릿 + 앱별 정책을 갖춘 35개 연동 앱",
        competitor: "없음",
      },
    ],
    stayWhen: [
      "대화형 메모리 벤치마크(LoCoMo/LongMemEval)를 연구 중이거나 단일 머신 Python/CLI 스택에 내장할 Apache-2.0 로컬 메모리 엔진을 원하는 경우.",
    ],
    switchWhen: [
      "여러 머신에서 일하거나 팀원과 협업해야 해서 단일 디렉터리 v1 락 경계 안에 머물 수 없는 경우.",
      "지속적인 백그라운드 LLM 추출 비용을 내지 않고 작업하는 실행이 공식 Markdown 페이지를 직접 최신화하길 원하는 경우.",
      "영구 프로젝트 지식에 더해 35종 코딩 에이전트 실행과 35개 연동 앱 거버넌스까지 필요한 경우.",
    ],
    migrationSteps: [
      {
        title: "기존 Markdown 파일을 xMatrix 페이지로 가져오세요",
        detail:
          "EverOS도 Markdown을 공식 계층으로 두므로 정리된 프로젝트 메모를 xMatrix 페이지로 곧바로 옮길 수 있습니다.",
      },
      {
        title: "모든 머신을 하나의 스페이스에 연결하세요",
        detail:
          "노트북과 서버에 xMatrix CLI를 설치하면 로컬 SQLite 락 오류 없이 모든 하네스가 같은 실시간 페이지를 공유합니다.",
      },
      {
        title: "작업하는 실행이 각 섹션을 관리하게 하세요",
        detail:
          "백그라운드 추출 파이프라인 대신 에이전트가 코드를 병합하거나 리서치를 마칠 때마다 직접 섹션을 업데이트하게 하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix 페이지도 EverOS처럼 순수 Markdown인가요?",
        answer:
          "네. 페이지는 섹션 단위 읽기·편집, 리비전 이력, 실시간 사람-에이전트 공동 편집을 지원하는 구조화된 Markdown 문서입니다.",
      },
      {
        question: "xMatrix는 백그라운드 메모리 통합용 LLM 토큰이 추가로 드나요?",
        answer:
          "아니요. 작업을 수행한 에이전트가 마무리 단계에서 페이지를 직접 업데이트하므로 모든 채팅 로그를 훑는 상시 추출 파이프라인을 따로 돌리지 않아도 됩니다.",
      },
      {
        question: "다중 사용자 협업 성능은 EverOS와 비교해 어떤가요?",
        answer:
          "xMatrix는 첫날부터 다중 사용자·다중 에이전트 스페이스를 전제로 설계되어 작성자별 편집 기록, 실시간 채널, 단일 머신 디렉터리 락 해소를 기본 제공합니다.",
      },
    ],
  },
  youmind: {
    verifiedDate: "2026년 11월 22일",
    metaTitle: "YouMind 대안 (2026): YouMind vs xMatrix",
    metaDescription:
      "YouMind 대안을 비교 중이신가요? 월 $20~$200의 1인 크레딧 요금제와 Android·팀 기능 부재 대신 시트당 $10의 xMatrix 멀티플레이어 코딩 채널, 로컬 저장소 실행, 살아 있는 페이지를 써 보세요.",
    eyebrow: "YouMind 대안 · YouMind vs xMatrix",
    headline: "팀 코딩 에이전트, Android, 실제 저장소 실행을 위한 YouMind 대안",
    lead: "YouMind는 영상·팟캐스트·웹 리서치를 슬라이드와 아티클로 엮어 주는 세련된 1인 창작 스튜디오(월 $20~$200 크레딧)이지만, 네이티브 팀 협업과 Android 앱이 없고 로컬 코딩 에이전트를 실행하지 않고 GitHub/Linear 맥락만 브리지합니다. xMatrix는 하나의 멀티플레이어 스페이스에서 실제 코드, 리서치, 운영을 함께 조율합니다.",
    productCaption:
      "xMatrix 화면: 데스크톱, 웹, Android, iOS 전반의 하나의 멀티플레이어 스페이스에서 리서치, 스펙, 실시간 멀티 에이전트 소프트웨어 배포를 함께 진행하세요.",
    painPoints: [
      {
        title: "개인 창작 스튜디오—실시간 팀 채널과 권한 거버넌스 부재",
        problem:
          "YouMind는 멀티플레이어 워크스페이스가 아니라 개인 리서치 보드 중심으로 설계되었습니다. 팀 협업에 필요한 공유 실시간 채널, 역할 기반 승인 정책, 스페이스 시크릿이 없습니다.",
        xmatrixAnswer:
          "xMatrix는 팀원과 에이전트를 공개·비공개 공유 채널로 모으고, 살아 있는 페이지와 앱별 읽기 전용 / 먼저 묻기 / 읽기 및 쓰기 거버넌스로 뒷받침합니다.",
      },
      {
        title: "로컬 코딩 에이전트 러너가 아니며 월 $40~$200에 달하는 가파른 크레딧 요금",
        problem:
          "YouMind는 스펙 초안용으로 GitHub과 Linear를 브리지할 뿐 로컬 저장소와 빌드 머신에서 Claude Code, Codex, Cursor를 오케스트레이션하지 못합니다. 멀티모달 작업을 많이 하면 Starter($20/20k 크레딧)와 Pro($40/40k 크레딧)가 빠르게 소진되어 데스크톱 에이전트 워크플로는 $100~$200 Max 플랜으로 올라가게 됩니다.",
        xmatrixAnswer:
          "xMatrix는 이미 결제 중인 구독으로 본인 머신에서 실제 코딩 하네스를 실행하면서 리서치, 문서, 운영까지 Pro 기준 사람 시트당 월 $10로 통합합니다.",
      },
      {
        title: "Android 앱 부재와 분절된 크로스 기기 엔지니어링 워크플로",
        problem:
          "YouMind는 iOS와 Chrome 확장 프로그램만 제공하고 공식 Android 앱이 없어 Android 개발자는 자리 밖에서 작업을 모니터링하거나 지시할 수 없습니다.",
        xmatrixAnswer:
          "xMatrix는 macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)에서 모두 실행되며 리서치, 스펙, 코드 PR, 출시 일정을 하나의 살아 있는 페이지에 모아 둡니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "핵심 초점",
        xmatrix: "살아 있는 페이지로 조율하는 멀티플레이어 코딩, 리서치, 운영",
        competitor: "개인 멀티미디어 리서치 및 콘텐츠 제작 보드",
      },
      {
        dimension: "로컬 코드 실행",
        xmatrix: "로컬 저장소에서 35종 코딩 에이전트(+ --runtime) 직접 실행",
        competitor: "GitHub/Linear 맥락 브리지; 데스크톱 에이전트는 $100~$200 Max 플랜 제한",
      },
      {
        dimension: "요금제",
        xmatrix: "Free(총 500회 쓰기) + Pro 사람 시트당 월 $10(연간 월 $8), 본인 모델 구독 사용",
        competitor: "Starter 월 $20 / Pro 월 $40 / Max 월 $100~$200 (크레딧 계량)",
      },
      {
        dimension: "팀 협업",
        xmatrix: "다중 사용자 + 다중 에이전트 채널, 공동 편집 페이지, 스페이스 시크릿",
        competitor: "1인 중심 보드; 협업은 주로 결과물 내보내기에 의존",
      },
      {
        dimension: "플랫폼 지원",
        xmatrix: "macOS, Windows, Linux, Android, 웹(iPhone·iPad 포함)",
        competitor: "웹, iOS, Chrome 확장 프로그램; 공식 Android 앱 없음",
      },
    ],
    stayWhen: [
      "YouTube 영상과 팟캐스트를 삽화가 들어간 아티클, 슬라이드 덱, 영상 릴스로 바꾸는 1인 멀티모달 콘텐츠 제작이 주 목적인 경우.",
    ],
    switchWhen: [
      "리서치와 스펙이 코딩 에이전트가 PR을 구현하고 테스트를 돌리고 배포하는 바로 그 스페이스 안에 함께 있길 원하는 경우.",
      "팀원과 협업하거나 Android를 쓰거나, 코딩 구독료 위에 크리에이티브 크레딧으로 매달 $40~$200를 더 내고 싶지 않은 경우.",
    ],
    migrationSteps: [
      {
        title: "진행 중인 리서치 브리프를 살아 있는 xMatrix 페이지로 옮기세요",
        detail:
          "경쟁 분석, 출시 계획, 아키텍처 메모를 페이지에 두면 에이전트가 문서를 업데이트하는 동시에 바로 실행에 옮길 수 있습니다.",
      },
      {
        title: "코딩 에이전트와 퍼블리싱 도구를 연결하세요",
        detail:
          "머신에서 Claude Code, Codex, Gemini를 실행하고 GitHub(읽기 전용 또는 읽기·쓰기)과 함께 Google Docs, Notion, X, Search Console을 먼저 묻기 승인으로 연결하세요.",
      },
      {
        title: "반복 리서치와 리포팅을 자동화하세요",
        detail:
          "페이지 안에 예약 Norn 프로그램을 넣어 주간 요약과 지표가 자동으로 최신 유지되게 하세요.",
      },
    ],
    faqs: [
      {
        question: "xMatrix는 코드뿐 아니라 리서치, 글쓰기, 출시 업무도 처리할 수 있나요?",
        answer:
          "네. 많은 팀이 소프트웨어 엔지니어링과 함께 리서치, SEO, 제품 출시, 채용, 운영을 xMatrix 페이지에서 에이전트와 함께 최신으로 관리하고 있습니다.",
      },
      {
        question: "xMatrix는 Android 앱을 제공하나요?",
        answer:
          "네. xMatrix는 macOS, Windows, Linux, 웹(iPhone·iPad 포함)과 함께 Android 앱을 제공합니다.",
      },
      {
        question: "외부 에이전트도 xMatrix와 함께 쓸 수 있나요?",
        answer:
          "네. xMatrix는 35종 코딩 에이전트(및 --runtime 커스텀 CLI)를 내장 지원하며 외부 도구용 MCP 서버도 제공합니다.",
      },
    ],
  },
  jules: {
    verifiedDate: "2026년 11월 22일",
    statusNote: "Google Jules는 2026년 11월 11일 읽기 전용 모드로 전환되었으며, 2026년 12월 31일 완전히 종료됩니다.",
    metaTitle: "Google Jules 대안 (2026): 12월 종료 전 xMatrix 전환",
    metaDescription:
      "Google Jules가 2026년 11월 11일 읽기 전용으로 전환되었고 12월 31일 종료됩니다. 내보낸 Jules 메모리, 스케줄, GitHub 저장소를 xMatrix로 옮겨 Antigravity, Claude Code, Codex를 함께 실행하세요.",
    eyebrow: "Google Jules 대안 · 12월 31일 종료 전 마이그레이션",
    headline: "12월 31일 전 Google Jules의 비동기 GitHub 작업을 이전하세요 — 휴대폰에서도 계속 지시",
    lead: "Google Jules는 2026년 11월 11일 신규 세션 실행을 중단했고 2026년 12월 31일 완전히 종료되며, 메모리·스케줄·태스크의 자동 마이그레이션을 제공하지 않습니다. xMatrix에서는 내보낸 맥락을 살아 있는 페이지로 불러와 상시 켜 둔 컴퓨터나 자체 VPS에서 Google Antigravity와 34종 기타 코딩 에이전트를 실행하며 휴대폰이나 웹에서 비동기 GitHub PR을 계속 지시할 수 있습니다.",
    productCaption:
      "xMatrix 화면: 본인 소유의 상시 가동 머신이나 자체 VPS에서 Google Antigravity, Claude Code, Codex 및 32종 기타 코딩 에이전트를 실행하며 웹과 모바일에서 GitHub 이슈를 비동기적으로 계속 처리하세요.",
    painPoints: [
      {
        title: "2026년 12월 31일 영구 종료 및 수동 내보내기만 제공",
        problem:
          "Jules는 11월 11일 읽기 전용 모드로 전환되었고 2026년 12월 31일 완전히 종료됩니다. @google/jules로 환경 변수, 메모리, 예약 작업, 세션 로그를 내보낼 수 있지만 Google이 Antigravity로의 자동 마이그레이션을 제공하지 않아 팀이 워크플로를 수동으로 다시 구축해야 합니다.",
        xmatrixAnswer:
          "xMatrix로 오늘 바로 깔끔하게 이전할 수 있습니다. 내보낸 Jules 메모리는 살아 있는 페이지에 넣고, 내보낸 .env 시크릿은 스페이스 시크릿에 저장하며, 반복 작업은 해당 페이지 안의 Norn 프로그램으로 되살리세요.",
      },
      {
        title: "Google Antigravity 단일 벤더로만 옮길 때의 할당량 불안",
        problem:
          "Hacker News, Reddit, Google AI 포럼의 개발자들은 Jules의 예측 가능한 일일 비동기 태스크 모델을 잃은 아쉬움과 함께, 모든 작업을 단일 벤더의 통합 할당량 풀로 옮길 경우 예상치 못한 한도나 초과 과금에 걸릴 수 있다는 우려를 쏟아내고 있습니다.",
        xmatrixAnswer:
          "xMatrix는 Google Antigravity를 34종 기타 코딩 에이전트(Claude Code, Codex, Cursor, Gemini CLI 등)와 나란히 네이티브로 실행하며, 한 벤더의 할당량 주기가 가득 차면 다른 프로바이더로 작업을 핸드오프할 수 있습니다.",
      },
      {
        title: "가벼운 모바일 및 비동기 GitHub 백로그 처리 습관 복원",
        problem:
          "초기 이전 사용자들은 Jules를 떠나면서 하루 종일 로컬 IDE 앞에 앉아 있지 않고도 모바일에서 가볍게 GitHub 이슈를 PR로 넘기던 비동기 습관이 끊겼다고 토로했습니다.",
        xmatrixAnswer:
          "상시 켜 둔 컴퓨터나 자체 Linux VPS 한 대를 연결한 뒤 Android나 웹(iPhone·iPad 포함)에서 @auto repo:owner/repo를 멘션하거나 GitHub 이벤트로 에이전트를 자동 트리거하면 PR, CI 상태, 페이지 업데이트가 비동기적으로 도착합니다.",
      },
    ],
    comparisonRows: [
      {
        dimension: "서비스 상태 (2026년 11월 기준)",
        xmatrix: "활발히 운영 중, 셀프서브, 소스 공개(FSL-1.1-ALv2)",
        competitor: "2026년 11월 11일부터 읽기 전용; 2026년 12월 31일 영구 종료",
      },
      {
        dimension: "하네스 및 모델 선택",
        xmatrix: "Google Antigravity + 34종 기타 코딩 에이전트(+ --runtime) 및 할당량 핸드오프",
        competitor: "Google 전용 클라우드 에이전트 (Google Antigravity로 통합 종료)",
      },
      {
        dimension: "메모리 및 프로젝트 문서",
        xmatrix: "사람과 모든 하네스가 공유하는 살아 있는 Markdown 페이지",
        competitor: "12월 31일 전까지 @google/jules CLI로 내보내기 가능; 자동 마이그레이션 없음",
      },
      {
        dimension: "예약 및 이벤트 기반 작업",
        xmatrix: "페이지 안에 내장된 Norn 프로그램(크론 + GitHub/커넥터 이벤트)",
        competitor: "11월 11일 예약 작업 중단; 로컬 스냅샷으로만 내보내기 가능",
      },
      {
        dimension: "코드 실행 위치",
        xmatrix: "본인의 상시 가동 컴퓨터 또는 자체 관리 Linux VPS(xMatrix 호스팅 클라우드 VM 없음)",
        competitor: "Google 호스팅 클라우드 VM (12월 31일 종료)",
      },
    ],
    stayWhen: [
      "2026년 12월 31일 이후에는 Jules에 남을 수 없습니다. 접근이 종료되기 전에 npm install -g @google/jules로 데이터를 반드시 내보내세요. 참고로 xMatrix는 호스팅 클라우드 VM 대신 본인의 상시 가동 컴퓨터나 자체 VPS가 필요합니다.",
    ],
    switchWhen: [
      "단일 벤더에 모든 것을 걸지 않고 Google Antigravity를 34종 기타 코딩 에이전트와 함께 계속 사용하고 싶은 경우.",
      "내보낸 Jules 메모리, 환경 시크릿, 예약 GitHub 백로그 작업을 오래 유지할 안전한 터전이 필요한 경우.",
      "이미 Mac Studio, 데스크톱, 또는 저렴한 자체 Linux VPS가 있으며 클라우드 베타 종료로 사라지지 않는 비동기 모바일→PR 워크플로를 원하는 경우.",
    ],
    migrationSteps: [
      {
        title: "2026년 12월 31일 전에 Jules 데이터를 내보내세요",
        detail:
          "Google 공식 @google/jules 내보내기 도구로 메모리, 예약 작업, 셋업 스크립트, 환경 변수를 로컬에 저장하세요.",
      },
      {
        title: "메모리는 페이지로, 시크릿은 스페이스 시크릿으로 옮기세요",
        detail:
          "내보낸 프로젝트 메모리를 xMatrix 페이지에 붙여 넣고, .env 시크릿은 채팅 평문이 아닌 스페이스 시크릿에 안전하게 저장하세요.",
      },
      {
        title: "상시 가동 머신이나 자체 VPS와 GitHub을 연결하세요",
        detail:
          "상시 켜 둔 데스크톱이나 자체 Linux VPS를 xMatrix에 등록하고 GitHub을 연결한 뒤 예약 백로그 점검을 페이지 Norn 프로그램으로 다시 구성하세요.",
      },
    ],
    faqs: [
      {
        question: "Jules에서 이전한 뒤 xMatrix 안에서 Google Antigravity를 실행할 수 있나요?",
        answer:
          "네. xMatrix는 본인 머신에서 34종 기타 코딩 에이전트(Claude Code, Codex, Cursor, Gemini 등)와 함께 Google Antigravity(agy)를 네이티브로 지원합니다.",
      },
      {
        question: "xMatrix도 Jules처럼 호스팅 클라우드 VM을 제공하나요?",
        answer:
          "아니요. xMatrix는 사용자가 제어하는 상시 가동 컴퓨터(데스크톱, Mac Studio, 또는 저렴한 자체 Linux VPS)가 필요합니다. 대신 벤더 종속이 전혀 없어 호스팅 클라우드 베타가 종료되더라도 저장소와 워크플로가 사라지지 않습니다.",
      },
      {
        question: "Jules의 예약 작업(scheduled tasks)은 xMatrix에서 어떻게 대체하나요?",
        answer:
          "xMatrix의 프로젝트 페이지 안에 Norn 프로그램 블록을 추가하면 지정한 일정이나 GitHub 이벤트에 맞춰 자동 실행되고 결과를 그 페이지에 바로 반영합니다.",
      },
    ],
  },
};
