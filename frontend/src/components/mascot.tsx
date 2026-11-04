"use client";

import Image from "next/image";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";

export const MASCOT_TILE = "/brand/donads-mascot-tile.png";
export const MASCOT_HEAD = "/brand/donads-mascot-head.png";
const MASCOT_TIMING = {
  cycleMs: 1_950,
} as const;

export function Mascot({ size = 96 }: { size?: number }) {
  return (
    <Image
      src={MASCOT_HEAD}
      alt="DONADS robot mascot"
      width={size}
      height={Math.round(size * 0.762)}
      priority
      sizes={`${size}px`}
      className="h-auto object-contain drop-shadow-sm"
    />
  );
}

export function MascotMark({ size = 32 }: { size?: number }) {
  return (
    <Image
      src={MASCOT_TILE}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      sizes={`${size}px`}
      className="rounded-[28%] object-cover"
    />
  );
}

export function SpecialistMark({
  icon: Icon,
  size = 40,
}: {
  icon: LucideIcon;
  size?: number;
}) {
  const badgeSize = Math.max(16, Math.round(size * 0.45));
  const iconSize = Math.max(9, Math.round(badgeSize * 0.56));
  return (
    <span
      className="relative block shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <MascotMark size={size} />
      <span
        className="absolute -bottom-1 -right-1 grid place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground shadow-sm"
        style={{ width: badgeSize, height: badgeSize }}
      >
        <Icon style={{ width: iconSize, height: iconSize }} strokeWidth={2} />
      </span>
    </span>
  );
}

/*
  Mascot loading storyboard (absolute time from loop start)
     0ms  idle + blink
   312ms  look around
   546ms  prepare + crouch
   800ms  jump
  1053ms  mid-air
  1404ms  spin + process
  1638ms  descend
  1833ms  settle
  1950ms  back to idle
*/
type MascotFrame = {
  lift: number;
  scaleX: number;
  scaleY: number;
  yaw: number;
  tilt: number;
  blink: number;
  happy: number;
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));
const lerp = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;
const smooth = (value: number) => {
  const x = clamp(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const range = (from: number, to: number, value: number) =>
  clamp((value - from) / (to - from));

function mascotFrame(progress: number): MascotFrame {
  let lift = 0;
  let scaleY = 1;
  let yaw = -0.12;
  let tilt = 0;
  const blink = progress > 0.04 && progress < 0.12
    ? Math.sin(range(0.04, 0.12, progress) * Math.PI)
    : 0;

  if (progress < 0.16) {
    scaleY = 1 + Math.sin(range(0, 0.16, progress) * Math.PI * 2) * 0.015;
  } else if (progress < 0.3) {
    const amount = smooth(range(0.16, 0.3, progress));
    yaw = lerp(-0.12, -0.38, amount);
    tilt = lerp(0, -0.05, amount);
  } else if (progress < 0.42) {
    const amount = smooth(range(0.3, 0.42, progress));
    scaleY = lerp(1, 0.86, amount);
    yaw = lerp(-0.38, -0.18, amount);
  } else if (progress < 0.55) {
    const amount = smooth(range(0.42, 0.55, progress));
    lift = lerp(0, -50, amount);
    scaleY = lerp(0.86, 1, amount) + Math.sin(amount * Math.PI) * 0.1;
  } else if (progress < 0.75) {
    const amount = smooth(range(0.55, 0.75, progress));
    lift = -50 - Math.sin(amount * Math.PI) * 7;
    yaw = lerp(-0.18, Math.PI * 2 - 0.12, amount);
    tilt = Math.sin(amount * Math.PI * 2) * 0.06;
    scaleY = 1 - Math.sin(amount * Math.PI) * 0.035;
  } else if (progress < 0.86) {
    const amount = smooth(range(0.75, 0.86, progress));
    lift = lerp(-50, 0, amount);
    yaw = -0.12;
    scaleY = 1 + Math.sin(amount * Math.PI) * 0.05;
  } else {
    const amount = range(0.86, 1, progress);
    scaleY = 1 - Math.exp(-4 * amount) * Math.sin(amount * Math.PI * 2) * 0.11;
  }

  const scaleX = 1 / Math.pow(scaleY, 0.78);
  const happy = progress >= 0.56 && progress < 0.89
    ? progress < 0.65
      ? smooth(range(0.56, 0.65, progress))
      : progress < 0.8
        ? 1
        : 1 - smooth(range(0.8, 0.89, progress))
    : 0;
  return { lift, scaleX, scaleY, yaw, tilt, blink, happy };
}

function drawMascot(
  context: CanvasRenderingContext2D,
  size: number,
  frame: MascotFrame,
) {
  context.clearRect(0, 0, size, size);
  const centerX = size / 2;
  const groundY = size * 0.79;
  const radius = size * 0.245;
  const radiusX = radius * frame.scaleX;
  const radiusY = radius * frame.scaleY;
  const centerY = groundY - radiusY + frame.lift;
  const facing = Math.cos(frame.yaw);
  const visorX = Math.sin(frame.yaw) * radiusX * 0.23;

  context.save();
  context.translate(centerX, centerY);
  context.rotate(frame.tilt);

  const antennaX = Math.sin(frame.yaw) * radiusX * 0.2 - frame.tilt * radius;
  const antennaY = -radiusY * 1.16;
  context.fillStyle = "#16171d";
  context.beginPath();
  context.moveTo(antennaX - radius * 0.15, -radiusY * 0.8);
  context.quadraticCurveTo(antennaX, antennaY - radius * 0.15, antennaX + radius * 0.15, -radiusY * 0.8);
  context.closePath();
  context.fill();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(antennaX, antennaY - radius * 0.08, radius * 0.2, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#ffffff";
  context.beginPath();
  context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.fill();

  if (facing > -0.2) {
    const visorWidth = radiusX * 1.45 * clamp((facing + 0.25) / 1.25, 0.18, 1);
    const visorHeight = radiusY * 0.78;
    context.save();
    context.translate(visorX, radiusY * 0.02);
    context.fillStyle = "#b6bac6";
    context.beginPath();
    context.ellipse(0, 0, visorWidth * 0.54, visorHeight * 0.55, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#0c0d12";
    context.beginPath();
    context.ellipse(0, 0, visorWidth * 0.5, visorHeight * 0.5, 0, 0, Math.PI * 2);
    context.fill();

    const eyeGap = visorWidth * 0.2;
    for (const direction of [-1, 1]) {
      const eyeX = direction * eyeGap;
      if (frame.happy < 0.98) {
        context.save();
        context.globalAlpha = 1 - frame.happy;
        context.fillStyle = "#ffffff";
        context.beginPath();
        context.roundRect(
          eyeX - radius * 0.075,
          -radius * 0.2 * (1 - frame.blink),
          radius * 0.15,
          radius * 0.4 * Math.max(0.08, 1 - frame.blink),
          radius * 0.075,
        );
        context.fill();
        context.restore();
      }
      if (frame.happy > 0.02) {
        context.save();
        context.globalAlpha = frame.happy;
        context.strokeStyle = "#ffffff";
        context.lineWidth = radius * 0.11;
        context.lineCap = "round";
        context.beginPath();
        context.arc(eyeX, radius * 0.11, radius * 0.16, Math.PI * 1.08, Math.PI * 1.92);
        context.stroke();
        context.restore();
      }
    }
    context.restore();
  }
  context.restore();
}

export function MascotLoader({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const size = compact ? 96 : 165;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      drawMascot(context, size, mascotFrame(0));
      return;
    }
    let animationFrame = 0;
    const startedAt = performance.now();
    const animate = (now: number) => {
      const progress = ((now - startedAt) % MASCOT_TIMING.cycleMs) / MASCOT_TIMING.cycleMs;
      drawMascot(context, size, mascotFrame(progress));
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [compact]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={compact
        ? "flex items-center gap-3 rounded-xl border border-border bg-card p-3"
        : "fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#1a1a1a] px-4 text-center text-white"}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={compact ? "size-24 shrink-0" : "size-[165px]"}
      />
      <div className={compact ? "min-w-0 flex-1" : "w-full max-w-xs"}>
        <p className={compact ? "text-sm font-medium" : "mt-2 text-sm font-normal tracking-wide text-white/70"}>{label}</p>
        {compact ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full w-2/3 rounded-full bg-primary motion-safe:animate-pulse motion-reduce:w-1/3" /></div> : null}
      </div>
    </div>
  );
}
