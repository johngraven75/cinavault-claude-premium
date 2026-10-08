// AI agent (Vault) — pure state, animation and validation logic.
//
// Kept free of React, Three.js and Tauri imports so it runs under node tests.
// The 3D head (components/agent/AgentHead.tsx) samples computeHeadPose every
// frame; the dock drives HeadMode through nextHeadMode from chat events and
// the back end's per-request activity channel (src-tauri/src/ai_agent.rs).

export type HeadMode = "idle" | "listening" | "thinking" | "searching" | "acting" | "speaking";

/** Phases emitted by the Rust agent loop while a request is in flight. */
export type AgentActivityPhase = "thinking" | "searching" | "acting" | "idle";

export type HeadEvent =
  | { type: "typing" }
  | { type: "typingStopped" }
  | { type: "activity"; phase: AgentActivityPhase }
  | { type: "reply" }
  | { type: "speechDone" }
  | { type: "error" };

const BUSY_MODES: readonly HeadMode[] = ["thinking", "searching", "acting"];

export function isBusyMode(mode: HeadMode): boolean {
  return BUSY_MODES.includes(mode);
}

/** The head's state machine. Work in flight outranks typing; a reply interrupts everything. */
export function nextHeadMode(current: HeadMode, event: HeadEvent): HeadMode {
  switch (event.type) {
    case "typing":
      return current === "idle" ? "listening" : current;
    case "typingStopped":
      return current === "listening" ? "idle" : current;
    case "activity":
      if (event.phase === "idle") return isBusyMode(current) ? "idle" : current;
      return event.phase;
    case "reply":
      return "speaking";
    case "speechDone":
      return current === "speaking" ? "idle" : current;
    case "error":
      return "idle";
  }
}

export const HEAD_MODE_LABELS: Record<HeadMode, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  searching: "Searching your library",
  acting: "Preparing an action",
  speaking: "Answering",
};

/** Joint names of the procedural rig, so a bundled glTF head can drop in later. */
export const HEAD_RIG = ["neck", "head", "jaw", "eye_L", "eye_R", "lid_L", "lid_R", "brow_L", "brow_R"] as const;
export type HeadJoint = (typeof HEAD_RIG)[number];

export interface HeadPose {
  /** Radians. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Gaze offset, -1..1 on each axis. */
  eyeX: number;
  eyeY: number;
  /** 0 closed .. 1 fully open jaw. */
  mouthOpen: number;
  /** 0 open eyes .. 1 fully closed lids. */
  blink: number;
  /** Uniform chest/neck scale offset from breathing. */
  breath: number;
  /** Brow raise, -1 furrowed .. 1 raised. */
  brow: number;
  /** Emissive glow intensity 0..1. */
  glow: number;
}

const BREATH_PERIOD_S = 4.6;
const BLINK_DURATION_S = 0.16;

/** Deterministic 0..1 hash so blink timing varies without Math.random in render. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Lid closure at time t: one blink every 2.6–5.6 s, occasionally a double blink. */
export function blinkAmount(t: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  let start = 0.8;
  let index = 0;
  // Walk blink slots; bounded because intervals are at least 2.6 s.
  while (start + BLINK_DURATION_S < t) {
    const interval = 2.6 + hash01(index) * 3;
    const next = start + interval;
    if (next > t) break;
    start = next;
    index += 1;
  }
  const local = t - start;
  const triangle = (u: number) => (u >= 0 && u <= BLINK_DURATION_S ? 1 - Math.abs(u / BLINK_DURATION_S * 2 - 1) : 0);
  const double = hash01(index + 1000) > 0.82 ? triangle(local - BLINK_DURATION_S * 1.6) : 0;
  return Math.max(triangle(local), double);
}

export function breathAmount(t: number): number {
  return Math.sin((t / BREATH_PERIOD_S) * Math.PI * 2) * 0.012;
}

/** Smooth step from -1 to 1 so glances settle instead of snapping. */
function glance(t: number, rate: number): number {
  const s = Math.sin(t * rate);
  return Math.max(-1, Math.min(1, s * 2.2));
}

/**
 * Target pose for a mode at time t (seconds). The renderer damps toward it,
 * so transitions between modes blend rather than jump.
 */
export function computeHeadPose(mode: HeadMode, t: number, mouthOpen = 0): HeadPose {
  const pose: HeadPose = {
    yaw: Math.sin(t * 0.31) * 0.12,
    pitch: Math.sin(t * 0.23) * 0.04,
    roll: Math.sin(t * 0.17) * 0.025,
    eyeX: Math.sin(t * 0.41) * 0.25,
    eyeY: Math.sin(t * 0.29) * 0.12,
    mouthOpen: 0,
    blink: blinkAmount(t),
    breath: breathAmount(t),
    brow: 0,
    glow: 0.35,
  };
  switch (mode) {
    case "idle":
      break;
    case "listening":
      pose.yaw *= 0.3;
      pose.pitch = 0.07 + Math.sin(t * 0.8) * 0.015;
      pose.roll = 0.05;
      pose.eyeX = 0;
      pose.eyeY = -0.05;
      pose.brow = 0.35;
      pose.glow = 0.5;
      break;
    case "thinking":
      pose.yaw = 0.16 + Math.sin(t * 0.5) * 0.04;
      pose.pitch = -0.1;
      pose.roll = 0.13;
      pose.eyeX = 0.55 + Math.sin(t * 0.9) * 0.2;
      pose.eyeY = 0.65;
      pose.brow = -0.45;
      pose.glow = 0.7 + Math.sin(t * 3) * 0.1;
      break;
    case "searching": {
      const g = glance(t, 2.1);
      pose.yaw = g * 0.32;
      pose.pitch = -0.02;
      pose.roll = -g * 0.04;
      // Eyes lead the head.
      pose.eyeX = glance(t + 0.18, 2.1) * 0.9;
      pose.eyeY = 0.05;
      pose.brow = 0.15;
      pose.glow = 0.8;
      break;
    }
    case "acting":
      pose.yaw *= 0.4;
      pose.pitch = 0.04 + Math.sin(t * 5.5) * 0.06;
      pose.eyeX = 0;
      pose.eyeY = -0.1;
      pose.brow = 0.25;
      pose.glow = 0.9;
      break;
    case "speaking":
      pose.yaw *= 0.6;
      pose.pitch += Math.sin(t * 2.4) * 0.025;
      pose.eyeX = Math.sin(t * 0.7) * 0.12;
      pose.eyeY = 0;
      pose.mouthOpen = clamp01(mouthOpen);
      pose.brow = 0.2 + mouthOpen * 0.15;
      pose.glow = 0.55 + mouthOpen * 0.3;
      break;
  }
  return pose;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

// ── Lip sync ──

const OPEN_VOWELS = new Set(["a", "o", "á", "à", "ó", "ô"]);
const MID_VOWELS = new Set(["e", "i", "u", "y", "é", "è", "í", "ú"]);
const CLOSED = new Set(["m", "b", "p"]);
const NARROW = new Set(["f", "v", "w"]);

/** Approximate jaw opening for one character (a cheap text-driven viseme). */
export function mouthOpenForChar(ch: string): number {
  const c = ch.toLowerCase();
  if (OPEN_VOWELS.has(c)) return 1;
  if (MID_VOWELS.has(c)) return 0.62;
  if (CLOSED.has(c)) return 0;
  if (NARROW.has(c)) return 0.15;
  if (/[a-z0-9]/.test(c)) return 0.32;
  return 0.04;
}

export const SPEECH_CHARS_PER_SECOND = 17;
export const MAX_SPEECH_SECONDS = 12;

/** How long the head "speaks" a reply; long replies are capped. */
export function speechDuration(text: string, cps = SPEECH_CHARS_PER_SECOND): number {
  return Math.min(text.length / cps, MAX_SPEECH_SECONDS);
}

/** Jaw opening at `elapsed` seconds into speaking `text`, interpolated between characters. */
export function mouthAt(text: string, elapsed: number, cps = SPEECH_CHARS_PER_SECOND): number {
  if (!text || !(elapsed >= 0) || elapsed >= speechDuration(text, cps)) return 0;
  // Past the cap, the remaining text is skimmed so speech still ends on time.
  const rate = Math.max(cps, text.length / MAX_SPEECH_SECONDS);
  const position = elapsed * rate;
  const i = Math.floor(position);
  const frac = position - i;
  const a = mouthOpenForChar(text[i] ?? " ");
  const b = mouthOpenForChar(text[i + 1] ?? " ");
  return a + (b - a) * frac;
}

// ── Images ──

export const AGENT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const AGENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function validateAgentImage(file: { type: string; size: number }): string | null {
  if (!(AGENT_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Choose a JPEG, PNG, GIF or WebP image.";
  }
  if (file.size > AGENT_IMAGE_MAX_BYTES) return "Images must be under 5 MB.";
  return null;
}

/** Split a data URL into the media type and bare base64 the back end expects. */
export function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

// ── API key prompt ──

/** Mirrors validate_api_key_format in ai_agent.rs so the form can hint before saving. */
export function apiKeyHint(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (!k.startsWith("sk-ant-")) return "Anthropic API keys start with sk-ant-";
  if (k.length < 40 || /\s/.test(k)) return "That key looks incomplete";
  return null;
}

export type OrbState = "setup" | "busy" | "speaking" | "ready";

export function orbState(configured: boolean, mode: HeadMode): OrbState {
  if (!configured) return "setup";
  if (isBusyMode(mode)) return "busy";
  if (mode === "speaking") return "speaking";
  return "ready";
}
