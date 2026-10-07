import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  HEAD_RIG,
  apiKeyHint,
  blinkAmount,
  computeHeadPose,
  isBusyMode,
  mouthAt,
  mouthOpenForChar,
  nextHeadMode,
  orbState,
  speechDuration,
  splitDataUrl,
  validateAgentImage,
  MAX_SPEECH_SECONDS,
} from "../src/services/aiAgentState.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("typing makes an idle head listen, and stopping returns it to idle", () => {
  assert.equal(nextHeadMode("idle", { type: "typing" }), "listening");
  assert.equal(nextHeadMode("listening", { type: "typingStopped" }), "idle");
});

test("work in flight is not interrupted by typing", () => {
  for (const mode of ["thinking", "searching", "acting", "speaking"]) {
    assert.equal(nextHeadMode(mode, { type: "typing" }), mode);
    assert.equal(nextHeadMode(mode, { type: "typingStopped" }), mode);
  }
});

test("back-end activity drives thinking, searching and acting", () => {
  assert.equal(nextHeadMode("listening", { type: "activity", phase: "thinking" }), "thinking");
  assert.equal(nextHeadMode("thinking", { type: "activity", phase: "searching" }), "searching");
  assert.equal(nextHeadMode("searching", { type: "activity", phase: "acting" }), "acting");
  assert.equal(nextHeadMode("acting", { type: "activity", phase: "idle" }), "idle");
});

test("an idle activity event never cuts speech short", () => {
  assert.equal(nextHeadMode("speaking", { type: "activity", phase: "idle" }), "speaking");
  assert.equal(nextHeadMode("listening", { type: "activity", phase: "idle" }), "listening");
});

test("a reply speaks, speech ends in idle, errors reset", () => {
  assert.equal(nextHeadMode("thinking", { type: "reply" }), "speaking");
  assert.equal(nextHeadMode("speaking", { type: "speechDone" }), "idle");
  assert.equal(nextHeadMode("thinking", { type: "speechDone" }), "thinking");
  assert.equal(nextHeadMode("searching", { type: "error" }), "idle");
});

test("busy modes are exactly the ones the back end reports while working", () => {
  assert.deepEqual(
    ["idle", "listening", "thinking", "searching", "acting", "speaking"].filter(isBusyMode),
    ["thinking", "searching", "acting"],
  );
});

test("the head blinks regularly and briefly", () => {
  let closedFrames = 0;
  let blinks = 0;
  let wasClosed = false;
  const fps = 60;
  for (let frame = 0; frame < 60 * fps; frame += 1) {
    const amount = blinkAmount(frame / fps);
    assert.ok(amount >= 0 && amount <= 1);
    const closed = amount > 0.5;
    if (closed) closedFrames += 1;
    if (closed && !wasClosed) blinks += 1;
    wasClosed = closed;
  }
  // 60 s at one blink per 2.6–5.6 s.
  assert.ok(blinks >= 10 && blinks <= 30, `blinks=${blinks}`);
  assert.ok(closedFrames / (60 * fps) < 0.05, "eyes are mostly open");
  assert.equal(blinkAmount(Number.NaN), 0);
  assert.equal(blinkAmount(-1), 0);
});

test("every mode yields a finite pose and idle keeps the jaw shut", () => {
  for (const mode of ["idle", "listening", "thinking", "searching", "acting", "speaking"]) {
    for (const t of [0, 1.3, 7.9, 120]) {
      const pose = computeHeadPose(mode, t, 0.8);
      for (const [key, value] of Object.entries(pose)) {
        assert.ok(Number.isFinite(value), `${mode}.${key} at ${t}`);
      }
      assert.ok(Math.abs(pose.yaw) < 0.5 && Math.abs(pose.pitch) < 0.3);
    }
  }
  assert.equal(computeHeadPose("idle", 3, 1).mouthOpen, 0);
  assert.equal(computeHeadPose("speaking", 3, 0.7).mouthOpen, 0.7);
});

test("thinking looks up and tilts; searching glances both ways", () => {
  const thinking = computeHeadPose("thinking", 2);
  assert.ok(thinking.eyeY > 0.4 && thinking.roll > 0.1);
  const yaws = Array.from({ length: 120 }, (_, i) => computeHeadPose("searching", i / 20).yaw);
  assert.ok(Math.min(...yaws) < -0.25 && Math.max(...yaws) > 0.25);
});

test("the head breathes in every mode", () => {
  const breaths = Array.from({ length: 50 }, (_, i) => computeHeadPose("idle", i / 10).breath);
  assert.ok(Math.max(...breaths) > 0.005 && Math.min(...breaths) < -0.005);
});

test("visemes open on vowels and close on m, b and p", () => {
  assert.equal(mouthOpenForChar("A"), 1);
  assert.ok(mouthOpenForChar("e") > 0.5);
  assert.equal(mouthOpenForChar("m"), 0);
  assert.ok(mouthOpenForChar(" ") < 0.1);
});

test("lip sync follows the text and stops when speech ends", () => {
  const text = "Hello, I found three films.";
  const duration = speechDuration(text);
  assert.ok(duration > 1 && duration < 2);
  const samples = Array.from({ length: 40 }, (_, i) => mouthAt(text, (i / 40) * duration));
  assert.ok(Math.max(...samples) > 0.5 && Math.min(...samples) < 0.2);
  assert.equal(mouthAt(text, duration + 0.1), 0);
  assert.equal(mouthAt("", 0.5), 0);
  assert.equal(mouthAt(text, -1), 0);
});

test("long replies are spoken within the cap", () => {
  const long = "a".repeat(5000);
  assert.equal(speechDuration(long), MAX_SPEECH_SECONDS);
  assert.ok(mouthAt(long, MAX_SPEECH_SECONDS - 0.5) > 0);
});

test("only small JPEG, PNG, GIF and WebP images are attached", () => {
  assert.equal(validateAgentImage({ type: "image/png", size: 1000 }), null);
  assert.match(validateAgentImage({ type: "image/svg+xml", size: 10 }), /JPEG/);
  assert.match(validateAgentImage({ type: "image/jpeg", size: 6 * 1024 * 1024 }), /5 MB/);
});

test("data URLs split into media type and bare base64", () => {
  assert.deepEqual(splitDataUrl("data:image/png;base64,iVBORw0KGgo="), { mediaType: "image/png", data: "iVBORw0KGgo=" });
  assert.equal(splitDataUrl("data:text/html,<script>"), null);
  assert.equal(splitDataUrl("https://example.com/a.png"), null);
});

test("the key form hints at malformed keys without blocking an empty field", () => {
  assert.equal(apiKeyHint(""), null);
  assert.match(apiKeyHint("abc"), /sk-ant-/);
  assert.match(apiKeyHint("sk-ant-123"), /incomplete/);
  assert.equal(apiKeyHint(`sk-ant-api03-${"x".repeat(40)}`), null);
});

test("the orb shows setup, busy, speaking and ready states", () => {
  assert.equal(orbState(false, "thinking"), "setup");
  assert.equal(orbState(true, "searching"), "busy");
  assert.equal(orbState(true, "speaking"), "speaking");
  assert.equal(orbState(true, "listening"), "ready");
});

test("the rig names the joints a lip-synced model needs", () => {
  for (const joint of ["jaw", "eye_L", "eye_R", "lid_L", "lid_R", "head", "neck"]) {
    assert.ok(HEAD_RIG.includes(joint), joint);
  }
  const head = read("src/components/agent/AgentHead.tsx");
  for (const joint of HEAD_RIG) {
    assert.match(head, new RegExp(`name(=\\{[^}]*)?=?"${joint}"|"${joint}"`), `AgentHead names ${joint}`);
  }
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("the Anthropic key and endpoint never appear in front-end code", () => {
  const srcDir = new URL("../src", import.meta.url).pathname;
  for (const file of walk(srcDir).filter((f) => /\.(ts|tsx|js|jsx|json)$/.test(f))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /ANTHROPIC_API_KEY\s*[:=]|process\.env\.ANTHROPIC|import\.meta\.env\.\w*ANTHROPIC/, file);
    assert.doesNotMatch(source, /api\.anthropic\.com/, file);
    assert.doesNotMatch(source, /sk-ant-[A-Za-z0-9_-]{20,}/, file);
    assert.doesNotMatch(source, /from ["']@anthropic-ai\/sdk["']/, file);
  }
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies["@anthropic-ai/sdk"], undefined, "the SDK must not ship in the WebView bundle");
});

test("the Rust proxy owns the key and only reads it from env or keychain", () => {
  const rust = read("src-tauri/src/ai_agent.rs");
  assert.match(rust, /const KEY_ENV: &str = "ANTHROPIC_API_KEY"/);
  assert.match(rust, /secure_credentials::get\(KEYCHAIN_ID\)/);
  assert.doesNotMatch(rust, /AgentStatus \{[^}]*api_key/s, "status must not echo the key");
  const lib = read("src-tauri/src/lib.rs");
  for (const command of ["agent_status", "agent_set_api_key", "agent_chat", "agent_run_action", "agent_reset"]) {
    assert.match(lib, new RegExp(`ai_agent::${command},`), command);
  }
});

test("the key field is masked and the 3D panel is lazy-loaded and motion-safe", () => {
  const panel = read("src/components/agent/AgentPanel.tsx");
  assert.match(panel, /type="password"/);
  const dock = read("src/components/agent/AgentDock.tsx");
  assert.match(dock, /lazy\(\(\) => import\("\.\/AgentPanel"\)\)/);
  const head = read("src/components/agent/AgentHead.tsx");
  assert.match(head, /frameloop=\{reducedMotion \? "demand" : "always"\}/);
  assert.doesNotMatch(head, /https?:\/\//, "the head is procedural and fetches nothing");
  assert.match(read("src/App.tsx"), /<AgentDock \/>/);
});
