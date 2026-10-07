import Image from "next/image";
import {
  ArrowUp,
  AtSign,
  BookOpen,
  Clock,
  Cpu,
  Gauge,
  HardDrive,
  Hash,
  Monitor,
  MessagesSquare,
  Paperclip,
  Plug,
  Search,
  Settings,
  User,
  Users,
} from "lucide-react";
import { LiquidGlassPill, MaterialChip, WoodPanel } from "@/components/ui/material-surfaces";

/* A rendered (not screenshotted) xMatrix channel for the homepage: the same
   wood rail, paper list and paper conversation the app draws, with fixed
   sample content. Messages arrive once, in order; reduced motion shows them
   all at once (site.css `.site-preview-reveal`). */

const railIcons = [Search, BookOpen, MessagesSquare, Gauge, HardDrive, Clock, Cpu, Plug, Users];

const conversations = [
  { name: "Landing page refresh", preview: "Alex Rivera: Looks great. Ship it.", time: "09:07", active: true },
  { name: "Billing webhook retries", preview: "codex: Retries now back off exponentially.", time: "09:03" },
  { name: "iOS 2.4 release", preview: "Maya Chen: TestFlight build 2.4 (318) is up.", time: "08:51" },
  { name: "Onboarding copy review", preview: "claude: Tightened the three intro sentences.", time: "08:28" },
  { name: "Flaky e2e on CI", preview: "codex: Root cause: a race in the socket close.", time: "07:34" },
];

type Author = { name: string; kind: "person"; initials: string } | { name: string; kind: "agent"; logo: string };

const alex: Author = { name: "Alex Rivera", kind: "person", initials: "AR" };
const claude: Author = { name: "claude", kind: "agent", logo: "/agent-vendors/claude.svg" };
const codex: Author = { name: "codex", kind: "agent", logo: "/agent-vendors/openai.svg" };

const messages: Array<{ author: Author; time: string; body: React.ReactNode }> = [
  {
    author: alex,
    time: "8:55 AM",
    body: (
      <>
        <Mention>@claude</Mention> rework the hero so it shows the product, not a diagram.{" "}
        <Mention>@codex</Mention> check the mobile breakpoints once it lands.
      </>
    ),
  },
  {
    author: claude,
    time: "8:56 AM",
    body: "On it. The hero now renders a live channel instead of an image, so it stays sharp at every size.",
  },
  {
    author: codex,
    time: "9:05 AM",
    body: "Checked 375, 768 and 1280. Below 768 it shows only the conversation, so nothing gets cropped.",
  },
  { author: alex, time: "9:07 AM", body: "Looks great. Ship it." },
];

function Mention({ children }: { children: React.ReactNode }) {
  return <span className="site-preview-mention">{children}</span>;
}

function Avatar({ author }: { author: Author }) {
  return (
    <span className="site-preview-avatar" aria-hidden>
      {author.kind === "agent" ? (
        <Image src={author.logo} alt="" width={22} height={22} unoptimized className="size-[22px]" />
      ) : (
        <span className="text-[13px] font-bold">{author.initials}</span>
      )}
    </span>
  );
}

export function AppPreview() {
  return (
    <div
      className="site-app-preview"
      role="img"
      aria-label="xMatrix showing a conversation where Alex Rivera asks Claude and Codex to rework a landing page"
    >
      <WoodPanel className="site-preview-rail hidden md:flex">
        <LiquidGlassPill className="flex size-10 items-center justify-center text-sm font-bold">A</LiquidGlassPill>
        <div className="mt-4 flex flex-col items-center gap-1.5">
          {railIcons.map((Icon, index) =>
            Icon === MessagesSquare ? (
              <LiquidGlassPill key={index} className="flex size-10 items-center justify-center">
                <Icon className="size-[18px]" />
              </LiquidGlassPill>
            ) : (
              <span key={index} className="flex size-10 items-center justify-center">
                <Icon className="size-[18px]" />
              </span>
            )
          )}
        </div>
        <Settings className="mt-auto mb-2 size-[18px]" />
      </WoodPanel>

      <div className="site-preview-list hidden md:block">
        <p className="px-5 pt-5 pb-3 text-lg font-semibold tracking-tight">Acme</p>
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.name} className="site-preview-row" data-active={conversation.active ? "true" : undefined}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1 font-semibold">
                  <Hash className="size-3.5 shrink-0 opacity-45" />
                  <span className="truncate">{conversation.name}</span>
                </span>
                <span className="shrink-0 text-xs opacity-55">{conversation.time}</span>
              </div>
              <p className="mt-0.5 truncate text-[13px] opacity-65">{conversation.preview}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="site-preview-conversation">
        <p className="flex items-center gap-1 text-lg font-semibold tracking-tight">
          <Hash className="size-4 opacity-45" />
          Landing page refresh
        </p>
        <ol className="mt-5 flex flex-col gap-5">
          {messages.map((message, index) => (
            <li
              key={index}
              className="site-preview-reveal flex gap-3"
              style={{ animationDelay: `${0.35 + index * 0.55}s` }}
            >
              <Avatar author={message.author} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold">{message.author.name}</span>
                  <span className="text-xs opacity-55">{message.time}</span>
                  {message.author.kind === "agent" && (
                    <>
                      <MaterialChip className="gap-1 px-2 text-[11px] font-medium">
                        <User className="size-3" />
                        Alex Rivera
                      </MaterialChip>
                      <MaterialChip className="gap-1 px-2 text-[11px] font-medium">
                        <Monitor className="size-3" />
                        Mac Studio
                      </MaterialChip>
                    </>
                  )}
                </div>
                <p className="mt-1 text-[15px] leading-6">{message.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <LiquidGlassPill className="mt-6 flex h-12 items-center gap-3 md:mt-auto pr-1.5 pl-4 text-[15px]">
          <Paperclip className="size-4 shrink-0 opacity-55" />
          <span className="min-w-0 flex-1 truncate opacity-55">Next up: a dark-mode pass on the same section</span>
          <AtSign className="size-4 shrink-0 opacity-55" />
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#171714] text-white">
            <ArrowUp className="size-4" />
          </span>
        </LiquidGlassPill>
      </div>
    </div>
  );
}
