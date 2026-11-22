import type { SiteLocale } from "@/lib/site-locales";

export interface DownloadPageCopy {
  metaTitle: string;
  metaDescription: string;
  getXMatrix: string;
  useOnWeb: string;
  openWebApp: string;
  chooseBelow: string;
  downloadFor: (platform: string) => string;
  noNative: (platform: string) => string;
  otherMac: (arch: string) => string;
  appleSiliconDetail: string;
  intelDetail: string;
  windowsDetail: string;
  androidDetail: string;
  releaseChannelSr: string;
  releaseChannelMenu: string;
  stableLabel: string;
  stableDetail: string;
  previewLabel: string;
  previewDetail: string;
  allPlatforms: (channelLabel: string) => string;
  previewSuffix: string;
  macNote: string;
  windowsNote: string;
  windowsBuild: string;
  androidNote: string;
  webNote: string;
  webBuild: string;
  desktopNotes: string;
  androidNotes: string;
  macZipArm: string;
  macZipIntel: string;
}

export interface SupportPageCopy {
  metaTitle: string;
  metaDescription: string;
  title: string;
  intro: string;
  contactHeading: string;
  contactBefore: string;
  contactAfter: string;
  bugDetails: string;
  setupHeading: string;
  setupBefore: string;
  setupLink: string;
  setupAfter: string;
  subsHeading: string;
  subsBody: string;
}

export interface DocsChromeCopy {
  guideLabel: string;
  onThisPage: string;
  previous: string;
  next: string;
  viewOnGithub: string;
  docsBreadcrumb: string;
}

export interface AlternativesChromeCopy {
  breadcrumbLabel: (name: string) => string;
  verifiedPrefix: string;
  startFreeCta: string;
  downloadCta: string;
  readDocsCta: string;
  meetEyebrow: string;
  meetHeading: string;
  whyHeading: (name: string) => string;
  gapSuffix: (name: string) => string;
  xmatrixAnswerLabel: string;
  atAGlanceHeading: (name: string) => string;
  dimensionCol: string;
  stayVsSwitchHeading: (name: string) => string;
  stayIf: (name: string) => string;
  switchIf: string;
  movingHeading: (name: string) => string;
  stepLabel: (index: number) => string;
  faqHeading: string;
  finalHeading: string;
  finalBody: string;
  startFreeShort: string;
  downloadShort: string;
  moreComparisons: string;
  linkLabel: (name: string) => string;
}

export interface SitePagesCopy {
  download: DownloadPageCopy;
  support: SupportPageCopy;
  docs: DocsChromeCopy;
  alternatives: AlternativesChromeCopy;
}

export const sitePagesCopy: Readonly<Record<SiteLocale, SitePagesCopy>> = {
  en: {
    download: {
      metaTitle: "Download xMatrix for macOS, Windows and Android",
      metaDescription:
        "Download the xMatrix desktop app for macOS (Apple Silicon and Intel) and Windows, or the Android APK, to follow and answer your AI coding agents from anywhere.",
      getXMatrix: "Get xMatrix",
      useOnWeb: "Use xMatrix on the Web",
      openWebApp: "Open Web App",
      chooseBelow: "Choose your platform below.",
      downloadFor: (p) => `Download for ${p}`,
      noNative: (p) => `No native ${p} app yet. Use the web app in your browser.`,
      otherMac: (arch) => `${arch} Mac`,
      appleSiliconDetail: "For Macs with Apple silicon (M1 and later).",
      intelDetail: "For Intel Macs.",
      windowsDetail: "For 64-bit Windows.",
      androidDetail: "Android APK.",
      releaseChannelSr: "Release channel: ",
      releaseChannelMenu: "Release channel",
      stableLabel: "Stable",
      stableDetail: "Tested releases. The right choice for most people.",
      previewLabel: "Preview",
      previewDetail: "The newest build, ahead of Stable. Can have rough edges.",
      allPlatforms: (label) => `All platforms · ${label}`,
      previewSuffix: " preview",
      macNote: "Desktop app",
      windowsNote: "Desktop app, x64",
      windowsBuild: "Installer",
      androidNote: "Phone app",
      webNote: "iPhone, iPad, Linux and any browser",
      webBuild: "Open",
      desktopNotes: "Desktop release notes",
      androidNotes: "Android release notes",
      macZipArm: "macOS ZIP, Apple Silicon",
      macZipIntel: "macOS ZIP, Intel",
    },
    support: {
      metaTitle: "Support — xMatrix",
      metaDescription:
        "Ask a question, report a problem, or get help with your xMatrix account, subscription, apps and connected agents.",
      title: "Support",
      intro:
        "Need help with xMatrix? Contact the team at MadeByRobot, LLC for questions, account or subscription help, or to report a problem with the app.",
      contactHeading: "Contact us",
      contactBefore: "Email ",
      contactAfter: ". You can contact us without signing in to xMatrix.",
      bugDetails:
        "For a problem with the app, include your device, operating system and xMatrix version, what you were trying to do, and what happened. A screenshot or the steps to reproduce the problem can help. Leave passwords, verification codes and private workspace content out of your message.",
      setupHeading: "Setup and everyday use",
      setupBefore: "The ",
      setupLink: "user guide",
      setupAfter:
        " explains how to set up xMatrix, connect agents and apps, and work with Conversations and Pages. If the guide does not answer your question, email us using the address above.",
      subsHeading: "Subscriptions and purchases",
      subsBody:
        "For a purchase made through Apple, manage or cancel it in your device’s Settings under your Apple Account’s Subscriptions. In xMatrix, use Restore purchases on the Billing settings screen to check an existing purchase. Email us if your plan or access still looks wrong.",
    },
    docs: {
      guideLabel: "Guide",
      onThisPage: "On this page",
      previous: "Previous",
      next: "Next",
      viewOnGithub: "View this page on GitHub",
      docsBreadcrumb: "Docs",
    },
    alternatives: {
      breadcrumbLabel: (name) => `${name} Alternatives`,
      verifiedPrefix: "Verified",
      startFreeCta: "Start Free with xMatrix",
      downloadCta: "Download desktop & mobile",
      readDocsCta: "Read the docs",
      meetEyebrow: "Meet xMatrix",
      meetHeading: "Living pages maintained by your coding agents.",
      whyHeading: (name) => `Why teams look for a ${name} alternative`,
      gapSuffix: (name) => `${name} gap`,
      xmatrixAnswerLabel: "How xMatrix handles it",
      atAGlanceHeading: (name) => `xMatrix vs. ${name} at a glance`,
      dimensionCol: "Dimension",
      stayVsSwitchHeading: (name) => `When to stay with ${name} vs. switch to xMatrix`,
      stayIf: (name) => `Stay with ${name} if…`,
      switchIf: "Switch to xMatrix if…",
      movingHeading: (name) => `Moving from ${name} to xMatrix`,
      stepLabel: (index) => `Step ${index}`,
      faqHeading: "Frequently asked questions",
      finalHeading: "Try xMatrix free with your existing coding agents.",
      finalBody:
        "Keep your Claude Code, Codex, Cursor, Gemini, or Antigravity subscriptions. Up to 3 people and unlimited agents free; Pro is $10/human seat/month ($8/mo billed annually).",
      startFreeShort: "Start Free",
      downloadShort: "Download",
      moreComparisons: "More coding-agent comparisons",
      linkLabel: (name) => `${name} Alternatives`,
    },
  },
  zh: {
    download: {
      metaTitle: "下载 xMatrix — 支持 macOS、Windows 与 Android",
      metaDescription: "下载 xMatrix 桌面客户端（macOS Apple Silicon / Intel、Windows）或 Android APK，随时随地查看并回复你的 AI 编程智能体。",
      getXMatrix: "获取 xMatrix",
      useOnWeb: "在浏览器中使用 xMatrix",
      openWebApp: "打开在线应用",
      chooseBelow: "请在下方选择对应平台。",
      downloadFor: (p) => `下载 ${p} 版`,
      noNative: (p) => `暂未提供原生 ${p} 客户端，请在浏览器中打开在线应用。`,
      otherMac: (arch) => `${arch} 版 Mac`,
      appleSiliconDetail: "适用于 Apple Silicon（M1 及更新机型）Mac。",
      intelDetail: "适用于 Intel 芯片 Mac。",
      windowsDetail: "适用于 64 位 Windows。",
      androidDetail: "Android 安装包（APK）。",
      releaseChannelSr: "发布渠道：",
      releaseChannelMenu: "发布渠道",
      stableLabel: "稳定版",
      stableDetail: "经过完整验证的版本，适合大多数用户。",
      previewLabel: "预览版",
      previewDetail: "最新构建，抢先体验新功能，偶有不稳定。",
      allPlatforms: (label) => `全部平台 · ${label}`,
      previewSuffix: " 预览版",
      macNote: "桌面应用",
      windowsNote: "桌面应用，x64",
      windowsBuild: "安装程序",
      androidNote: "手机应用",
      webNote: "iPhone、iPad、Linux 及任意浏览器",
      webBuild: "打开",
      desktopNotes: "桌面端版本说明",
      androidNotes: "Android 版本说明",
      macZipArm: "macOS ZIP（Apple Silicon）",
      macZipIntel: "macOS ZIP（Intel）",
    },
    support: {
      metaTitle: "支持 — xMatrix",
      metaDescription: "咨询问题、反馈故障，或获取 xMatrix 账号、订阅、连接器与编程智能体的使用帮助。",
      title: "支持",
      intro: "使用 xMatrix 遇到问题？联系 MadeByRobot, LLC 团队咨询账号、订阅或反馈应用问题。",
      contactHeading: "联系我们",
      contactBefore: "发送邮件至 ",
      contactAfter: "。无需登录 xMatrix 即可联系我们。",
      bugDetails: "如反馈应用故障，请附上设备型号、操作系统、xMatrix 版本、你正在执行的操作以及实际发生的现象；截图或复现步骤会很有帮助。邮件中请勿包含密码、验证码或私有工作区内容。",
      setupHeading: "安装与日常使用",
      setupBefore: "请查阅",
      setupLink: "使用指南",
      setupAfter: "，了解如何配置 xMatrix、接入智能体与连接器，以及协作使用频道和活页面。如指南未解答你的疑问，欢迎发邮件联系。",
      subsHeading: "订阅与购买",
      subsBody: "通过 Apple 购买的订阅，请在设备的「设置 → Apple 账户 → 订阅」中管理或取消。在 xMatrix 的「设置 → 计费」页面可使用「恢复购买」核对已有订单。如果方案或权限显示异常，请发邮件给我们。",
    },
    docs: {
      guideLabel: "使用指南",
      onThisPage: "本页目录",
      previous: "上一篇",
      next: "下一篇",
      viewOnGithub: "在 GitHub 查看英文原文",
      docsBreadcrumb: "文档",
    },
    alternatives: {
      breadcrumbLabel: (name) => `${name} 替代方案`,
      verifiedPrefix: "核对日期",
      startFreeCta: "免费开始使用 xMatrix",
      downloadCta: "下载桌面与移动端",
      readDocsCta: "阅读文档",
      meetEyebrow: "认识 xMatrix",
      meetHeading: "由你的编程智能体持续维护的活页面。",
      whyHeading: (name) => `为什么团队都在找 ${name} 的替代方案`,
      gapSuffix: (name) => `${name} 痛点`,
      xmatrixAnswerLabel: "xMatrix 的做法",
      atAGlanceHeading: (name) => `xMatrix vs ${name} 核心对比`,
      dimensionCol: "维度",
      stayVsSwitchHeading: (name) => `什么时候留在 ${name}，什么时候切到 xMatrix`,
      stayIf: (name) => `适合继续用 ${name}，如果……`,
      switchIf: "适合切换到 xMatrix，如果……",
      movingHeading: (name) => `三步从 ${name} 迁到 xMatrix`,
      stepLabel: (index) => `第 ${index} 步`,
      faqHeading: "常见问题",
      finalHeading: "直接用你现有的编程智能体免费试用 xMatrix。",
      finalBody: "继续使用你已有的 Claude Code、Codex、Cursor、Gemini 或 Antigravity 订阅。免费版支持最多 3 人、不限智能体；Pro 每人每月 $10（年付 $8/月）。",
      startFreeShort: "免费开始",
      downloadShort: "下载客户端",
      moreComparisons: "更多竞品对比",
      linkLabel: (name) => `${name} 替代`,
    },
  },
  "zh-tw": {
    download: {
      metaTitle: "下載 xMatrix — 支援 macOS、Windows 與 Android",
      metaDescription: "下載 xMatrix 桌面應用（macOS Apple Silicon / Intel、Windows）或 Android APK，隨時隨地掌握並回覆你的 AI 程式設計代理。",
      getXMatrix: "取得 xMatrix",
      useOnWeb: "在瀏覽器中使用 xMatrix",
      openWebApp: "開啟網頁應用",
      chooseBelow: "請在下方選擇你的平台。",
      downloadFor: (p) => `下載 ${p} 版`,
      noNative: (p) => `尚未提供原生 ${p} 應用，請直接使用瀏覽器版本。`,
      otherMac: (arch) => `${arch} 版 Mac`,
      appleSiliconDetail: "適用於 Apple Silicon（M1 及更新機型）Mac。",
      intelDetail: "適用於 Intel 處理器 Mac。",
      windowsDetail: "適用於 64 位元 Windows。",
      androidDetail: "Android 安裝檔（APK）。",
      releaseChannelSr: "發佈通道：",
      releaseChannelMenu: "發佈通道",
      stableLabel: "穩定版",
      stableDetail: "經過完整測試的正式版本，適合多數使用者。",
      previewLabel: "預覽版",
      previewDetail: "搶先體驗最新建置，可能尚有未完善之處。",
      allPlatforms: (label) => `所有平台 · ${label}`,
      previewSuffix: " 預覽版",
      macNote: "桌面應用",
      windowsNote: "桌面應用，x64",
      windowsBuild: "安裝程式",
      androidNote: "手機應用",
      webNote: "iPhone、iPad、Linux 與任意瀏覽器",
      webBuild: "開啟",
      desktopNotes: "桌面端版本說明",
      androidNotes: "Android 版本說明",
      macZipArm: "macOS ZIP（Apple Silicon）",
      macZipIntel: "macOS ZIP（Intel）",
    },
    support: {
      metaTitle: "支援 — xMatrix",
      metaDescription: "提問、回報問題，或取得 xMatrix 帳號、訂閱、整合工具與代理連線的協助。",
      title: "支援",
      intro: "使用 xMatrix 需要協助嗎？聯繫 MadeByRobot, LLC 團隊詢問帳號、訂閱問題或回報應用程式異常。",
      contactHeading: "聯絡我們",
      contactBefore: "請寄信至 ",
      contactAfter: "。無需登入 xMatrix 即可聯絡我們。",
      bugDetails: "回報應用問題時，請提供裝置型號、作業系統、xMatrix 版本、操作步驟與實際現象；附上截圖會更有幫助。信件中請勿附上密碼、驗證碼或私人工作區內容。",
      setupHeading: "設定與日常使用",
      setupBefore: "請參考",
      setupLink: "使用指南",
      setupAfter: "，了解如何設定 xMatrix、連接代理與服務，以及運用對話和即時頁面。若仍未解決，歡迎直接來信。",
      subsHeading: "訂閱與購買",
      subsBody: "透過 Apple 購買的方案，請於裝置「設定 → Apple 帳號 → 訂閱項目」管理或取消。在 xMatrix 帳單設定頁可點選「回復購買」確認紀錄。若方案或權限異常，請來信告知。",
    },
    docs: {
      guideLabel: "使用指南",
      onThisPage: "本頁目錄",
      previous: "上一頁",
      next: "下一頁",
      viewOnGithub: "在 GitHub 檢視英文原文",
      docsBreadcrumb: "文件",
    },
    alternatives: {
      breadcrumbLabel: (name) => `${name} 替代方案`,
      verifiedPrefix: "核對日期",
      startFreeCta: "免費開始使用 xMatrix",
      downloadCta: "下載桌面與行動版",
      readDocsCta: "閱讀文件",
      meetEyebrow: "認識 xMatrix",
      meetHeading: "由你的程式設計代理持續維護的即時頁面。",
      whyHeading: (name) => `為什麼團隊在尋找 ${name} 替代方案`,
      gapSuffix: (name) => `${name} 短板`,
      xmatrixAnswerLabel: "xMatrix 的解法",
      atAGlanceHeading: (name) => `xMatrix vs ${name} 重點比較`,
      dimensionCol: "比較項目",
      stayVsSwitchHeading: (name) => `何時續用 ${name}，何時切換至 xMatrix`,
      stayIf: (name) => `繼續使用 ${name}，如果……`,
      switchIf: "切換至 xMatrix，如果……",
      movingHeading: (name) => `三步驟從 ${name} 轉移至 xMatrix`,
      stepLabel: (index) => `步驟 ${index}`,
      faqHeading: "常見問題",
      finalHeading: "帶上既有的程式設計代理，免費體驗 xMatrix。",
      finalBody: "沿用你原本的 Claude Code、Codex、Cursor、Gemini 或 Antigravity 訂閱。免費方案最多 3 人、不限代理數；Pro 每人每月 $10（年繳 $8/月）。",
      startFreeShort: "免費開始",
      downloadShort: "下載應用",
      moreComparisons: "更多競品比較",
      linkLabel: (name) => `${name} 替代`,
    },
  },
  ja: {
    download: {
      metaTitle: "xMatrix をダウンロード — macOS、Windows、Android 対応",
      metaDescription: "macOS（Apple Silicon / Intel）・Windows 向けデスクトップアプリや Android APK をダウンロードして、どこからでもコーディングエージェントと協働できます。",
      getXMatrix: "xMatrix を入手",
      useOnWeb: "ブラウザで xMatrix を使う",
      openWebApp: "Web アプリを開く",
      chooseBelow: "以下からプラットフォームを選択してください。",
      downloadFor: (p) => `${p} 版をダウンロード`,
      noNative: (p) => `${p} 向けネイティブアプリは現在未対応です。ブラウザ版をご利用ください。`,
      otherMac: (arch) => `${arch} 版 Mac`,
      appleSiliconDetail: "Apple Silicon（M1 以降）搭載 Mac 向け。",
      intelDetail: "Intel 搭載 Mac 向け。",
      windowsDetail: "64ビット Windows 向け。",
      androidDetail: "Android 用 APK。",
      releaseChannelSr: "リリースチャンネル：",
      releaseChannelMenu: "リリースチャンネル",
      stableLabel: "安定版",
      stableDetail: "十分に検証された標準リリースです。",
      previewLabel: "プレビュー版",
      previewDetail: "最新ビルドを先行利用できます（挙動が変わる場合があります）。",
      allPlatforms: (label) => `全プラットフォーム · ${label}`,
      previewSuffix: " プレビュー",
      macNote: "デスクトップアプリ",
      windowsNote: "デスクトップアプリ（x64）",
      windowsBuild: "インストーラー",
      androidNote: "モバイルアプリ",
      webNote: "iPhone、iPad、Linux、その他ブラウザ",
      webBuild: "開く",
      desktopNotes: "デスクトップ版リリースノート",
      androidNotes: "Android 版リリースノート",
      macZipArm: "macOS ZIP（Apple Silicon）",
      macZipIntel: "macOS ZIP（Intel）",
    },
    support: {
      metaTitle: "サポート — xMatrix",
      metaDescription: "xMatrix のアカウント、サブスクリプション、連携アプリ、接続済みエージェントに関するご質問や不具合報告はこちら。",
      title: "サポート",
      intro: "xMatrix についてお困りですか？アカウント・料金のご相談や不具合報告は MadeByRobot, LLC チームまでご連絡ください。",
      contactHeading: "お問い合わせ",
      contactBefore: "メール送信先：",
      contactAfter: "（xMatrix にログインしていなくてもお問い合わせいただけます）。",
      bugDetails: "不具合をご報告いただく際は、お使いの端末・OS・xMatrix バージョン、実行しようとした操作、実際に起きた事象をお知らせください。スクリーンショットや再現手順があると助かります。パスワードや認証コード、非公開ワークスペースの内容は含めないでください。",
      setupHeading: "セットアップと日々の使い方",
      setupBefore: "詳しくは",
      setupLink: "ユーザーガイド",
      setupAfter: "をご覧ください。エージェントや外部アプリの接続方法、会話とページの使い方を解説しています。解決しない場合は上記メールアドレスまでご連絡ください。",
      subsHeading: "サブスクリプションとお支払い",
      subsBody: "Apple 経由でご購入いただいたプランの管理・解約は、端末の「設定 → Apple Account → サブスクリプション」から行えます。xMatrix の請求設定画面にある「購入を復元」から既存プランを再確認できます。表示に不備がある場合はメールでご連絡ください。",
    },
    docs: {
      guideLabel: "ガイド",
      onThisPage: "このページの内容",
      previous: "前へ",
      next: "次へ",
      viewOnGithub: "GitHub で英語原文を見る",
      docsBreadcrumb: "ドキュメント",
    },
    alternatives: {
      breadcrumbLabel: (name) => `${name} 代替ツール`,
      verifiedPrefix: "確認日",
      startFreeCta: "xMatrix を無料で始める",
      downloadCta: "デスクトップ・モバイル版を入手",
      readDocsCta: "ドキュメントを読む",
      meetEyebrow: "xMatrix を見る",
      meetHeading: "コーディングエージェントが最新に保つリビングページ。",
      whyHeading: (name) => `チームが ${name} の代替を探す理由`,
      gapSuffix: (name) => `${name} の課題`,
      xmatrixAnswerLabel: "xMatrix のアプローチ",
      atAGlanceHeading: (name) => `xMatrix vs ${name} 比較一覧`,
      dimensionCol: "比較項目",
      stayVsSwitchHeading: (name) => `${name} を使い続けるべき場合・xMatrix に移るべき場合`,
      stayIf: (name) => `${name} のままが向いているケース`,
      switchIf: "xMatrix への移行が向いているケース",
      movingHeading: (name) => `${name} から xMatrix へ移る3ステップ`,
      stepLabel: (index) => `ステップ ${index}`,
      faqHeading: "よくある質問",
      finalHeading: "今お使いのコーディングエージェントのまま、xMatrix を無料で試す。",
      finalBody: "Claude Code、Codex、Cursor、Gemini、Antigravity の既存サブスクリプションをそのまま利用可能。3名まで無料・エージェント無制限、Pro は月額 $10/人（年払い $8/月）。",
      startFreeShort: "無料で始める",
      downloadShort: "ダウンロード",
      moreComparisons: "その他のツール比較",
      linkLabel: (name) => `${name} 代替`,
    },
  },
  ko: {
    download: {
      metaTitle: "xMatrix 다운로드 — macOS, Windows, Android 지원",
      metaDescription: "macOS(Apple Silicon / Intel), Windows 데스크톱 앱 또는 Android APK를 다운로드해 어디서나 AI 코딩 에이전트와 협업하세요.",
      getXMatrix: "xMatrix 받기",
      useOnWeb: "웹에서 xMatrix 사용하기",
      openWebApp: "웹 앱 열기",
      chooseBelow: "아래에서 플랫폼을 선택하세요.",
      downloadFor: (p) => `${p}용 다운로드`,
      noNative: (p) => `아직 네이티브 ${p} 앱이 없습니다. 브라우저에서 웹 앱을 이용하세요.`,
      otherMac: (arch) => `${arch} Mac`,
      appleSiliconDetail: "Apple Silicon(M1 이상) Mac용.",
      intelDetail: "Intel Mac용.",
      windowsDetail: "64비트 Windows용.",
      androidDetail: "Android APK.",
      releaseChannelSr: "릴리스 채널: ",
      releaseChannelMenu: "릴리스 채널",
      stableLabel: "안정판",
      stableDetail: "충분히 검증된 기본 릴리스입니다.",
      previewLabel: "프리뷰",
      previewDetail: "최신 기능을 먼저 써볼 수 있는 선행 빌드입니다.",
      allPlatforms: (label) => `전체 플랫폼 · ${label}`,
      previewSuffix: " 프리뷰",
      macNote: "데스크톱 앱",
      windowsNote: "데스크톱 앱, x64",
      windowsBuild: "설치 파일",
      androidNote: "모바일 앱",
      webNote: "iPhone, iPad, Linux 및 모든 브라우저",
      webBuild: "열기",
      desktopNotes: "데스크톱 릴리스 노트",
      androidNotes: "Android 릴리스 노트",
      macZipArm: "macOS ZIP (Apple Silicon)",
      macZipIntel: "macOS ZIP (Intel)",
    },
    support: {
      metaTitle: "지원 — xMatrix",
      metaDescription: "xMatrix 계정, 구독, 연동 앱 및 코딩 에이전트 관련 문의와 문제 신고 안내.",
      title: "지원",
      intro: "xMatrix 사용 중 도움이 필요하신가요? 계정, 구독 문의 또는 앱 문제 제보는 MadeByRobot, LLC 팀으로 연락해 주세요.",
      contactHeading: "문의하기",
      contactBefore: "이메일: ",
      contactAfter: " (xMatrix에 로그인하지 않아도 문의할 수 있습니다).",
      bugDetails: "문제 제보 시 기기, 운영체제, xMatrix 버전, 시도한 작업과 실제 발생 현상을 함께 적어 주세요. 스크린샷이나 재현 단계가 큰 도움이 됩니다. 비밀번호, 인증 코드, 비공개 워크스페이스 내용은 포함하지 마세요.",
      setupHeading: "설정 및 일상 사용",
      setupBefore: "자세한 설정과 사용법은 ",
      setupLink: "사용자 가이드",
      setupAfter: "에서 확인할 수 있습니다. 가이드에 답이 없다면 위 이메일로 편하게 문의해 주세요.",
      subsHeading: "구독 및 결제",
      subsBody: "Apple을 통해 결제한 구독은 기기의 '설정 → Apple 계정 → 구독'에서 관리하거나 해지할 수 있습니다. xMatrix 결제 설정 화면의 '구매 복원'으로 기존 결제를 확인할 수 있으며, 플랜이 정상 반영되지 않으면 이메일로 알려 주세요.",
    },
    docs: {
      guideLabel: "가이드",
      onThisPage: "이 페이지 목차",
      previous: "이전",
      next: "다음",
      viewOnGithub: "GitHub에서 영문 원문 보기",
      docsBreadcrumb: "문서",
    },
    alternatives: {
      breadcrumbLabel: (name) => `${name} 대안`,
      verifiedPrefix: "확인일",
      startFreeCta: "xMatrix 무료로 시작하기",
      downloadCta: "데스크톱·모바일 다운로드",
      readDocsCta: "문서 읽기",
      meetEyebrow: "xMatrix 미리보기",
      meetHeading: "코딩 에이전트가 최신 상태로 유지하는 살아있는 페이지.",
      whyHeading: (name) => `팀들이 ${name} 대안을 찾는 이유`,
      gapSuffix: (name) => `${name} 한계`,
      xmatrixAnswerLabel: "xMatrix의 해결 방식",
      atAGlanceHeading: (name) => `xMatrix vs ${name} 한눈에 비교`,
      dimensionCol: "비교 항목",
      stayVsSwitchHeading: (name) => `${name}에 남을 때 vs xMatrix로 옮길 때`,
      stayIf: (name) => `${name} 유지가 맞는 경우…`,
      switchIf: "xMatrix 전환이 맞는 경우…",
      movingHeading: (name) => `${name}에서 xMatrix로 3단계 전환`,
      stepLabel: (index) => `${index}단계`,
      faqHeading: "자주 묻는 질문",
      finalHeading: "기존 코딩 에이전트 그대로 xMatrix를 무료로 시작하세요.",
      finalBody: "Claude Code, Codex, Cursor, Gemini, Antigravity 구독을 그대로 유지합니다. 최대 3명·무제한 에이전트 무료, Pro는 인당 월 $10(연간 월 $8).",
      startFreeShort: "무료 시작",
      downloadShort: "다운로드",
      moreComparisons: "다른 도구 비교 더 보기",
      linkLabel: (name) => `${name} 대안`,
    },
  },
  es: {
    download: {
      metaTitle: "Descargar xMatrix para macOS, Windows y Android",
      metaDescription: "Descarga la app de escritorio de xMatrix para macOS (Apple Silicon e Intel) y Windows, o el APK de Android, para coordinar tus agentes de código desde cualquier lugar.",
      getXMatrix: "Obtén xMatrix",
      useOnWeb: "Usa xMatrix en la web",
      openWebApp: "Abrir app web",
      chooseBelow: "Elige tu plataforma abajo.",
      downloadFor: (p) => `Descargar para ${p}`,
      noNative: (p) => `Aún no hay app nativa para ${p}. Usa la app web desde tu navegador.`,
      otherMac: (arch) => `Mac ${arch}`,
      appleSiliconDetail: "Para Mac con Apple silicon (M1 o posterior).",
      intelDetail: "Para Mac con procesador Intel.",
      windowsDetail: "Para Windows de 64 bits.",
      androidDetail: "APK de Android.",
      releaseChannelSr: "Canal de lanzamiento: ",
      releaseChannelMenu: "Canal de lanzamiento",
      stableLabel: "Estable",
      stableDetail: "Versiones probadas. La opción ideal para la mayoría.",
      previewLabel: "Vista previa",
      previewDetail: "La compilación más reciente, antes que Estable. Puede tener detalles por pulir.",
      allPlatforms: (label) => `Todas las plataformas · ${label}`,
      previewSuffix: " vista previa",
      macNote: "App de escritorio",
      windowsNote: "App de escritorio, x64",
      windowsBuild: "Instalador",
      androidNote: "App móvil",
      webNote: "iPhone, iPad, Linux y cualquier navegador",
      webBuild: "Abrir",
      desktopNotes: "Notas de versión de escritorio",
      androidNotes: "Notas de versión de Android",
      macZipArm: "macOS ZIP, Apple Silicon",
      macZipIntel: "macOS ZIP, Intel",
    },
    support: {
      metaTitle: "Soporte — xMatrix",
      metaDescription: "Haz una pregunta, reporta un problema o recibe ayuda con tu cuenta, suscripción, conectores y agentes de xMatrix.",
      title: "Soporte",
      intro: "¿Necesitas ayuda con xMatrix? Escribe al equipo de MadeByRobot, LLC para consultas de cuenta, suscripción o reportes de fallos.",
      contactHeading: "Contáctanos",
      contactBefore: "Escríbenos a ",
      contactAfter: ". No necesitas iniciar sesión en xMatrix para contactarnos.",
      bugDetails: "Si reportas un error, incluye tu dispositivo, sistema operativo, versión de xMatrix, qué estabas intentando hacer y qué ocurrió. Una captura o los pasos para reproducirlo ayudan mucho. No incluyas contraseñas, códigos de verificación ni contenido privado del espacio.",
      setupHeading: "Configuración y uso diario",
      setupBefore: "La ",
      setupLink: "guía de usuario",
      setupAfter: " explica cómo configurar xMatrix, conectar agentes y servicios, y trabajar con Conversaciones y Páginas. Si no responde tu duda, escríbenos al correo anterior.",
      subsHeading: "Suscripciones y compras",
      subsBody: "Para compras realizadas a través de Apple, gestiónalas o cancélalas en Ajustes de tu dispositivo → Cuenta de Apple → Suscripciones. En xMatrix puedes usar «Restaurar compras» en la configuración de facturación. Escríbenos si tu plan no se refleja bien.",
    },
    docs: {
      guideLabel: "Guía",
      onThisPage: "En esta página",
      previous: "Anterior",
      next: "Siguiente",
      viewOnGithub: "Ver original en inglés en GitHub",
      docsBreadcrumb: "Documentación",
    },
    alternatives: {
      breadcrumbLabel: (name) => `Alternativas a ${name}`,
      verifiedPrefix: "Verificado",
      startFreeCta: "Empezar gratis con xMatrix",
      downloadCta: "Descargar escritorio y móvil",
      readDocsCta: "Leer documentación",
      meetEyebrow: "Conoce xMatrix",
      meetHeading: "Páginas vivas mantenidas por tus agentes de código.",
      whyHeading: (name) => `Por qué los equipos buscan una alternativa a ${name}`,
      gapSuffix: (name) => `Límite de ${name}`,
      xmatrixAnswerLabel: "Cómo lo resuelve xMatrix",
      atAGlanceHeading: (name) => `xMatrix vs. ${name} de un vistazo`,
      dimensionCol: "Criterio",
      stayVsSwitchHeading: (name) => `Cuándo quedarse en ${name} y cuándo pasar a xMatrix`,
      stayIf: (name) => `Quédate en ${name} si…`,
      switchIf: "Cámbiate a xMatrix si…",
      movingHeading: (name) => `Pasar de ${name} a xMatrix en tres pasos`,
      stepLabel: (index) => `Paso ${index}`,
      faqHeading: "Preguntas frecuentes",
      finalHeading: "Prueba xMatrix gratis con los agentes de código que ya usas.",
      finalBody: "Mantén tus suscripciones de Claude Code, Codex, Cursor, Gemini o Antigravity. Hasta 3 personas y agentes ilimitados gratis; Pro cuesta $10/asiento/mes ($8/mes anual).",
      startFreeShort: "Empezar gratis",
      downloadShort: "Descargar",
      moreComparisons: "Más comparativas de agentes",
      linkLabel: (name) => `Alternativas a ${name}`,
    },
  },
};
