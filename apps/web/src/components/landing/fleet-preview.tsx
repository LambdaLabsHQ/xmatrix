"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { FleetMatrix, type FleetMatrixCell, type FleetMatrixColumn, type FleetMatrixRow } from "@/components/dashboard/fleet-matrix";
import {
  FLEET_MATRIX_MACHINE_FACTS_CLASS, FLEET_MATRIX_MACHINE_HEADING_CLASS, FLEET_MATRIX_MACHINE_NAME_CLASS,
} from "@/components/dashboard/fleet-matrix-frames";
import { MobileAvatarMatrix, type MobileMatrixRow } from "@/components/dashboard/fleet-mobile";
import { MachineGlyph } from "@/components/dashboard/machine-glyph";
import type { MachineOs } from "@/components/dashboard/machine-os";
import { useMedia } from "@/components/landing/use-media";

/* The app's own Agents matrix (a machine to a row, an agent to a column), fed
   a sample Space instead of the Hub. It plays one short story while it is in
   view: work comes in, Claude on the Mac Studio reaches its five-hour limit,
   and Codex beside it picks the work up. Nothing here fetches. */

const noop = () => {};
const HARNESSES = ["claude", "codex", "cursor", "gemini", "grok", "kimi", "copilot", "opencode"] as const;
type Harness = (typeof HARNESSES)[number];
const COLUMNS: FleetMatrixColumn[] = HARNESSES.map((harness) => ({ harness, summary: "", onOpen: noop }));

const usage = (percent: number) => [{ key: "5h", label: "5h", percent, detail: `5h window ${percent}% used` }];
const ready: FleetMatrixCell = { kind: "agent", state: "running", label: "Ready", detail: "Ready", working: 0, usage: [] };
const working = (count: number, percent?: number): FleetMatrixCell => ({
  kind: "agent", state: "running", label: `${count} working`, detail: `${count} working`, working: count,
  usage: percent === undefined ? [] : usage(percent),
});
const limit: FleetMatrixCell = { kind: "agent", state: "attention", label: "5h limit", detail: "5h limit reached", working: 0, usage: usage(100) };
const on: FleetMatrixCell = { kind: "agent", state: "offline", label: "On", detail: "On, its machine is offline", working: 0, usage: [] };
const off: FleetMatrixCell = { kind: "off" };
const absent: FleetMatrixCell = { kind: "absent" };

type Machine = { key: string; name: string; os: MachineOs; online: boolean; cells: Record<Harness, FleetMatrixCell> };

/** The Space at one step of the story. */
function machines(step: number): Machine[] {
  const handedOver = step >= 3;
  return [
    { key: "studio", name: "Mac Studio", os: "macos", online: true, cells: {
      claude: handedOver ? limit : working(2, [78, 88, 96][step] ?? 96), codex: working(handedOver ? 3 : 1, 34),
      cursor: ready, gemini: step >= 4 ? working(1) : ready, grok: off, kimi: ready, copilot: ready, opencode: absent } },
    { key: "linux", name: "Linux server", os: "linux", online: true, cells: {
      claude: working(1, 41), codex: working(step >= 1 ? 2 : 1), cursor: absent, gemini: ready, grok: ready, kimi: absent,
      copilot: absent, opencode: step >= 2 ? working(1) : ready } },
    { key: "windows", name: "Windows build", os: "windows", online: true, cells: {
      claude: ready, codex: ready, cursor: step >= 5 ? ready : working(1), gemini: absent, grok: absent, kimi: absent,
      copilot: ready, opencode: absent } },
    { key: "macbook", name: "MacBook Pro", os: "macos", online: false, cells: {
      claude: on, codex: on, cursor: on, gemini: absent, grok: absent, kimi: on, copilot: absent, opencode: absent } },
  ];
}
const STEPS = 6;

const workingOn = (machine: { cells: Record<string, FleetMatrixCell> }) =>
  Object.values(machine.cells).reduce((sum, cell) => sum + (cell.kind === "agent" ? cell.working : 0), 0);
const stateLine = (machine: { online: boolean; cells: Record<string, FleetMatrixCell> }) => {
  const count = workingOn(machine);
  return !machine.online ? "Offline · seen 2h ago" : count === 0 ? "Idle" : `${count} working`;
};

export interface SampleFleetMachine {
  key: string;
  name: string;
  os: MachineOs;
  online: boolean;
  cells: Record<string, FleetMatrixCell>;
}

/** Builds real FleetMatrix & MobileAvatarMatrix props for sample Spaces on the homepage. */
export function buildSampleFleetView(space: readonly SampleFleetMachine[]) {
  const rows: FleetMatrixRow[] = space.map((machine) => ({
    key: machine.key,
    name: machine.name,
    dimmed: !machine.online,
    cells: machine.cells,
    heading: (
      <span className={FLEET_MATRIX_MACHINE_HEADING_CLASS}>
        <span className="app-tool-state-icon shrink-0" data-state={machine.online ? "running" : "offline"}>
          <MachineGlyph os={machine.os} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={FLEET_MATRIX_MACHINE_NAME_CLASS}>{machine.name}</span>
          <span className={FLEET_MATRIX_MACHINE_FACTS_CLASS}>{stateLine(machine)}</span>
        </span>
      </span>
    ),
  }));
  const mobileRows: MobileMatrixRow[] = space.map((machine) => ({
    key: machine.key,
    name: machine.name,
    os: machine.os,
    own: true,
    online: machine.online,
    dimmed: !machine.online,
    exception: machine.cells.claude?.kind === "agent" && machine.cells.claude.state === "attention" ? "claude 5h limit" : null,
    loadAlerts: [],
    quietNote: machine.online ? null : "Offline · 2h ago",
    cells: machine.cells,
  }));
  const attention = space.filter((machine) =>
    Object.values(machine.cells).some((cell) => cell.kind === "agent" && cell.state === "attention"),
  ).length;
  const workingCount = space.reduce((sum, machine) => sum + workingOn(machine), 0);
  return { rows, mobileRows, attention, workingCount };
}

/** The Agents matrix of a sample Space, moving while it is in view. */
export function FleetPreview() {
  // The table needs a desktop's width for its eight columns; below that the matrix is the phone's, a face to a cell.
  const desktop = useMedia("(min-width: 1024px)");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!host) return undefined;
    // Without motion the matrix rests where the story ends: the work handed over.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(4);
      return undefined;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry?.isIntersecting) timer = setInterval(() => setStep((current) => (current + 1) % STEPS), 2200);
    }, { threshold: 0.35 });
    observer.observe(host);
    return () => { clearInterval(timer); observer.disconnect(); };
  }, [host]);

  const space = useMemo(() => machines(step), [step]);
  const { rows, mobileRows, attention, workingCount } = buildSampleFleetView(space);

  return (
    // On the page's paper, not the app's: the table's sticky column takes the same paper.
    <div ref={setHost} className="site-matrix xmatrix-app" inert
      style={{ "--app-panel-paper": "var(--site-stage-paper)", background: "transparent", color: "var(--site-ink)" } as CSSProperties}>
      {desktop
        ? <FleetMatrix columns={COLUMNS} rows={rows} selected={null} onSelect={noop} editors={[]} />
        : <MobileAvatarMatrix columns={COLUMNS} rows={mobileRows} ownMachineCount={space.length} attentionCount={attention}
            workingCount={workingCount} selected={null} onSelect={noop} editors={[]} />}
    </div>
  );
}
