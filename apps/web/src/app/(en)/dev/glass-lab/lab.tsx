"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUp, BookOpen, MessagesSquare, Paperclip } from "lucide-react";
import { SearchGlyph } from "@/components/ui/search-glyph";

import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { BranchBadge } from "@/components/dashboard/status-tag";
import { RailButton } from "@/components/dashboard/workspace-shell-chrome";
import { StatusChipBadge, type StatusChip } from "@/components/dashboard/workspace-shell-recovered";
import {
  liquidGlassLensVersion,
  liquidGlassMaterialStyle,
  type LiquidGlassMaterial,
} from "@/components/ui/liquid-glass-material";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";

/* Every control is one field of LiquidGlassMaterial, starting from the
   recipe's own defaults (liquid-glass.css), and tunes the glass on the rail
   and the plank together; the paper bench keeps the defaults for comparison.
   Wood is only the background: the app sets no material on it, so a change
   that should ship goes into the recipe, not a wood preset. Query parameters
   seed the controls
   (?veil=0.4&blur=2&saturation=1.5&refraction=18&bezel=8&edgeLight=0.65&shadow=3,10,0.14),
   so a variant can be linked or screenshotted. */

type Controls = {
  veilAlpha: number;
  blur: number;
  saturation: number;
  refraction: number;
  bezel: number;
  edgeLight: number;
  shadowY: number;
  shadowBlur: number;
  shadowOpacity: number;
};

const DEFAULTS: Controls = {
  veilAlpha: 0.4,
  blur: 2,
  saturation: 1.5,
  refraction: 18,
  bezel: 8,
  edgeLight: 0.65,
  shadowY: 3,
  shadowBlur: 10,
  shadowOpacity: 0.14,
};

const SLIDERS: Array<{ key: keyof Controls; label: string; min: number; max: number; step: number }> = [
  { key: "veilAlpha", label: "白纱不透明度", min: 0, max: 0.9, step: 0.01 },
  { key: "blur", label: "模糊 px", min: 0, max: 8, step: 0.25 },
  { key: "saturation", label: "饱和度", min: 0.6, max: 2, step: 0.05 },
  { key: "refraction", label: "折射偏移 px", min: 0, max: 32, step: 1 },
  { key: "bezel", label: "折射带宽 px", min: 1, max: 16, step: 1 },
  { key: "edgeLight", label: "边缘光", min: 0, max: 1, step: 0.05 },
  { key: "shadowY", label: "阴影下移 px", min: 0, max: 12, step: 0.5 },
  { key: "shadowBlur", label: "阴影模糊 px", min: 0, max: 30, step: 0.5 },
  { key: "shadowOpacity", label: "阴影浓度", min: 0, max: 0.4, step: 0.01 },
];

function seed(params: URLSearchParams): Controls {
  const read = (name: string, fallback: number) => {
    const value = Number.parseFloat(params.get(name) ?? "");
    return Number.isFinite(value) ? value : fallback;
  };
  const shadow = (params.get("shadow") ?? "").split(",").map(Number);
  const hasShadow = shadow.length === 3 && shadow.every(Number.isFinite);
  return {
    veilAlpha: read("veil", DEFAULTS.veilAlpha),
    blur: read("blur", DEFAULTS.blur),
    saturation: read("saturation", DEFAULTS.saturation),
    refraction: read("refraction", DEFAULTS.refraction),
    bezel: read("bezel", DEFAULTS.bezel),
    edgeLight: read("edgeLight", DEFAULTS.edgeLight),
    shadowY: hasShadow ? shadow[0] : DEFAULTS.shadowY,
    shadowBlur: hasShadow ? shadow[1] : DEFAULTS.shadowBlur,
    shadowOpacity: hasShadow ? shadow[2] : DEFAULTS.shadowOpacity,
  };
}

function materialOf(controls: Controls): LiquidGlassMaterial {
  return {
    veil: `oklch(0.97 0 0 / ${controls.veilAlpha})`,
    blur: controls.blur,
    saturation: controls.saturation,
    refraction: controls.refraction,
    bezel: controls.bezel,
    edgeLight: controls.edgeLight,
    shadow: { y: controls.shadowY, blur: controls.shadowBlur, opacity: controls.shadowOpacity },
  };
}

type Agent = { name: string; status: string; tags: StatusChip[]; branch: string };

const AGENTS: Agent[] = [
  {
    name: "codex:15",
    status: "处理中",
    branch: "fix/cloudflare-do-idle-timeout",
    tags: [
      { id: "owner", label: "Owner", value: "Yiming Hu" },
      { id: "machine", label: "Machine", value: "Workstation" },
      { id: "workspace", label: "Workspace", value: ".xmatrix-management/repos/xmatrix" },
      { id: "model", label: "Model", value: "gpt-6.1-sol" },
      { id: "effort", label: "Effort", value: "medium" },
      { id: "quota", label: "1w", percent: 65 },
    ],
  },
  {
    name: "claude:1",
    status: "Watching review",
    branch: "feat/liquid-glass-lens",
    tags: [
      { id: "owner", label: "Owner", value: "Yiming Hu" },
      { id: "machine", label: "Machine", value: "MacBook Pro" },
      { id: "repo", label: "Repository", value: "LambdaLabsHQ/xmatrix" },
      { id: "model", label: "Model", value: "claude-opus-5-5" },
      { id: "effort", label: "Effort", value: "high" },
      { id: "quota", label: "5h", percent: 92 },
    ],
  },
  {
    name: "cursor:3",
    status: "Idle",
    branch: "main",
    tags: [
      { id: "owner", label: "Owner", value: "Daniel" },
      { id: "machine", label: "Machine", value: "Linux box" },
      { id: "workspace", label: "Workspace", value: "apps/web" },
      { id: "model", label: "Model", value: "grok-5" },
      { id: "effort", label: "Effort", value: "low" },
      { id: "quota", label: "1d", percent: 30 },
    ],
  },
];

function AgentRows() {
  return (
    <div className="flex flex-col gap-5">
      {AGENTS.map((agent) => (
        <div key={agent.name} className="flex items-start gap-3">
          <IdentityAvatar kind="agent" label={agent.name} initials={agent.name.slice(0, 1).toUpperCase()} size="md" shape="circle" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-base font-black">@{agent.name}</span>
              <span className="shrink-0 text-xs font-bold">{agent.status}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {agent.tags.slice(0, 3).map((chip) => <StatusChipBadge key={chip.id} chip={chip} />)}
              <BranchBadge branch={agent.branch} />
              {agent.tags.slice(3).map((chip) => <StatusChipBadge key={chip.id} chip={chip} />)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function GlassLab() {
  const params = useSearchParams();
  const [controls, setControls] = useState<Controls>(() => seed(new URLSearchParams(params.toString())));
  const material = materialOf(controls);
  const woodStyle = liquidGlassMaterialStyle(material);
  /* The lens draws its maps when a surface mounts; remount when they change. */
  const lensKey = liquidGlassLensVersion(material);

  return (
    <main className="xmatrix-app min-h-dvh bg-background px-8 py-6 text-foreground">
      <h1 className="text-xl font-black">Liquid glass lab</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        一组参数（LiquidGlassMaterial）同时调木板、木轨上的玻璃；纸面一栏保持默认参数作对照。
      </p>
      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-8">
          <section key={`wood-${lensKey}`} className="flex items-start gap-6">
            <aside
              className="app-rail relative flex w-16 shrink-0 flex-col items-center gap-3 overflow-hidden rounded-[28px] bg-sidebar py-4"
              style={woodStyle}
            >
              <IdentityAvatar kind="human" label="E2" initials="E2" size="md" shape="circle" />
              <RailButton icon={SearchGlyph} label="Search" />
              <RailButton icon={BookOpen} label="Pages" />
              <RailButton active icon={MessagesSquare} label="Conversations" />
            </aside>
            <div className="app-details min-w-0 flex-1" style={woodStyle}>
              <WoodPanel className="app-detail-plank p-5">
                <h2 className="mb-4 text-base font-black">Agents</h2>
                <AgentRows />
              </WoodPanel>
            </div>
          </section>
          <section className="rounded-3xl bg-card p-5">
            <h2 className="mb-4 text-base font-black">纸面（输入框参数）</h2>
            <AgentRows />
            <div className="mt-6 flex items-center gap-3">
              <LiquidGlassPill as="button" type="button" className="flex size-[3.25rem] shrink-0 items-center justify-center">
                <Paperclip className="size-5" />
              </LiquidGlassPill>
              <LiquidGlassPill className="flex h-[3.25rem] min-w-0 flex-1 items-center px-5 text-muted-foreground">
                输入消息
              </LiquidGlassPill>
              <LiquidGlassPill as="button" type="button" className="flex size-[3.25rem] shrink-0 items-center justify-center">
                <ArrowUp className="size-5" />
              </LiquidGlassPill>
            </div>
          </section>
        </div>
        <aside className="flex flex-col gap-4 text-sm">
          {SLIDERS.map((slider) => (
            <label key={slider.key} className="flex flex-col gap-1">
              <span className="flex justify-between font-bold">
                {slider.label}
                <span className="tabular-nums text-muted-foreground">{controls[slider.key]}</span>
              </span>
              <input
                type="range"
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={controls[slider.key]}
                onChange={(event) =>
                  setControls((current) => ({ ...current, [slider.key]: Number(event.target.value) }))
                }
              />
            </label>
          ))}
          <button
            type="button"
            className="self-start text-sm font-bold underline"
            onClick={() => setControls(DEFAULTS)}
          >
            回到默认参数
          </button>
          <pre className="overflow-x-auto rounded-xl bg-muted p-3 text-xs">
            {JSON.stringify(material, null, 2)}
          </pre>
        </aside>
      </div>
    </main>
  );
}
