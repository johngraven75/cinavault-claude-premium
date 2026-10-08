// Always-visible assistant orb plus the slide-in chat panel it opens.
//
// The dock owns chat state and the head's state machine so they survive the
// panel closing. The panel (and with it three.js) is lazy-loaded the first
// time the orb is pressed, keeping the 3D bundle out of app start-up.
import { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { JSX } from "react";
import { AnimatePresence, useReducedMotion } from "framer-motion";
import { Bot } from "lucide-react";
import { OrbitalSpinner } from "../holo/CinematicLoaders";
import {
  getAgentStatus,
  sendAgentMessage,
  runAgentAction,
  errorText,
  type AgentAction,
  type AgentImageInput,
  type AgentStatus,
} from "../../services/aiAgent";
import {
  HEAD_MODE_LABELS,
  nextHeadMode,
  orbState,
  speechDuration,
  type HeadEvent,
  type HeadMode,
} from "../../services/aiAgentState";
import type { SpeechCue } from "./AgentHead";

const AgentPanel = lazy(() => import("./AgentPanel"));

export type ActionState = "pending" | "running" | "done" | "failed";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  imagePreview?: string;
  actions?: Array<AgentAction & { state: ActionState; result?: string }>;
}

let entrySeq = 0;
const nextId = () => `m${++entrySeq}`;

export default function AgentDock(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, dispatch] = useReducer((m: HeadMode, e: HeadEvent) => nextHeadMode(m, e), "idle");
  const speechRef = useRef<SpeechCue | null>(null);
  const speechTimer = useRef<number | null>(null);
  const reducedMotion = useReducedMotion() ?? false;

  const refreshStatus = useCallback(() => {
    getAgentStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, keySource: null, model: "", models: [] }));
  }, []);

  useEffect(() => {
    refreshStatus();
    return () => {
      if (speechTimer.current) window.clearTimeout(speechTimer.current);
    };
  }, [refreshStatus]);

  const speak = useCallback((text: string) => {
    if (speechTimer.current) window.clearTimeout(speechTimer.current);
    speechRef.current = { text, startedAt: performance.now() };
    dispatch({ type: "reply" });
    speechTimer.current = window.setTimeout(() => {
      speechRef.current = null;
      dispatch({ type: "speechDone" });
    }, speechDuration(text) * 1000 + 250);
  }, []);

  const send = useCallback(
    async (text: string, image: (AgentImageInput & { preview: string }) | null) => {
      if (busy) return;
      setBusy(true);
      setEntries((list) => [...list, { id: nextId(), role: "user", text, imagePreview: image?.preview }]);
      dispatch({ type: "activity", phase: "thinking" });
      try {
        const reply = await sendAgentMessage(
          text,
          image ? { mediaType: image.mediaType, data: image.data } : null,
          (phase) => dispatch({ type: "activity", phase }),
        );
        setEntries((list) => [
          ...list,
          {
            id: nextId(),
            role: "assistant",
            text: reply.text,
            actions: reply.actions.map((action) => ({ ...action, state: "pending" as const })),
          },
        ]);
        speak(reply.text);
      } catch (error) {
        dispatch({ type: "error" });
        setEntries((list) => [...list, { id: nextId(), role: "error", text: errorText(error) }]);
        refreshStatus();
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshStatus, speak],
  );

  const approve = useCallback(async (entryId: string, actionId: string) => {
    const update = (state: ActionState, result?: string) =>
      setEntries((list) =>
        list.map((entry) =>
          entry.id !== entryId
            ? entry
            : {
                ...entry,
                actions: entry.actions?.map((a) => (a.id === actionId ? { ...a, state, result } : a)),
              },
        ),
      );
    update("running");
    dispatch({ type: "activity", phase: "acting" });
    try {
      update("done", await runAgentAction(actionId));
    } catch (error) {
      update("failed", errorText(error));
    } finally {
      dispatch({ type: "activity", phase: "idle" });
    }
  }, []);

  const toggle = () => {
    setEverOpened(true);
    setOpen((v) => !v);
  };

  const orb = orbState(status?.configured ?? false, mode);
  const orbLabel =
    orb === "setup" ? "Set up the Vault assistant" : `Vault assistant: ${HEAD_MODE_LABELS[mode]}`;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? "Close the Vault assistant" : orbLabel}
        aria-expanded={open}
        title={orbLabel}
        className={`cv-agent-orb cv-agent-orb--${orb} fixed bottom-5 right-5 z-[70] grid h-14 w-14 place-items-center rounded-full border border-cyan-200/40 bg-[radial-gradient(circle_at_35%_30%,rgba(125,211,252,0.95),rgba(14,116,144,0.9)_45%,rgba(30,16,60,0.95))] text-white shadow-[0_0_28px_rgba(34,211,238,0.45)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-200`}
      >
        <span className="cv-agent-orb__ring" aria-hidden="true" />
        <Bot size={24} aria-hidden="true" />
      </button>

      {everOpened && (
        <Suspense
          fallback={
            open ? (
              <div className="fixed bottom-24 right-6 z-[70]">
                <OrbitalSpinner label="Loading the assistant" />
              </div>
            ) : null
          }
        >
          <AnimatePresence>
            {open && (
              <AgentPanel
                key="agent-panel"
                status={status}
                entries={entries}
                busy={busy}
                mode={mode}
                speechRef={speechRef}
                reducedMotion={reducedMotion}
                onClose={() => setOpen(false)}
                onSend={send}
                onApprove={approve}
                onStatus={setStatus}
                onClear={() => setEntries([])}
                onTyping={(typing) => dispatch({ type: typing ? "typing" : "typingStopped" })}
              />
            )}
          </AnimatePresence>
        </Suspense>
      )}
    </>
  );
}
