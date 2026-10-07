// Slide-in chat panel with Vault's 3D head. Loaded lazily by AgentDock.
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, JSX, KeyboardEvent, MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import {
  Check,
  ExternalLink,
  ImagePlus,
  KeyRound,
  Loader2,
  RotateCcw,
  Send,
  Settings2,
  X,
} from "lucide-react";
import AgentHead, { type SpeechCue } from "./AgentHead";
import type { ChatEntry } from "./AgentDock";
import {
  ANTHROPIC_KEYS_URL,
  MODEL_LABELS,
  clearAgentApiKey,
  errorText,
  resetAgent,
  setAgentApiKey,
  setAgentModel,
  type AgentImageInput,
  type AgentStatus,
} from "../../services/aiAgent";
import {
  HEAD_MODE_LABELS,
  apiKeyHint,
  isBusyMode,
  splitDataUrl,
  validateAgentImage,
  type HeadMode,
} from "../../services/aiAgentState";

type PendingImage = AgentImageInput & { preview: string; name: string };

interface AgentPanelProps {
  status: AgentStatus | null;
  entries: ChatEntry[];
  busy: boolean;
  mode: HeadMode;
  speechRef: MutableRefObject<SpeechCue | null>;
  reducedMotion: boolean;
  onClose: () => void;
  onSend: (text: string, image: PendingImage | null) => void;
  onApprove: (entryId: string, actionId: string) => void;
  onStatus: (status: AgentStatus) => void;
  onClear: () => void;
  onTyping: (typing: boolean) => void;
}

// Square icon buttons. Not .cv-btn: its 18px side padding wins over px-0 and
// squeezes the icon out of small buttons.
const ICON_BTN =
  "grid shrink-0 place-items-center rounded-xl border border-white/15 bg-white/5 text-cv-text transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300";
const SEND_BTN =
  "grid shrink-0 place-items-center rounded-xl border border-cyan-200/60 bg-cyan-300 text-slate-950 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-100";

const SUGGESTIONS = [
  "What's in my library?",
  "Find something sci-fi to watch tonight",
  "Which films are missing posters?",
];

function KeySetup({ onStatus }: { onStatus: (s: AgentStatus) => void }): JSX.Element {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hint = apiKeyHint(key);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onStatus(await setAgentApiKey(key));
      setKey("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="m-4 rounded-2xl border border-cyan-200/20 bg-cyan-300/5 p-4 text-sm">
      <div className="flex items-center gap-2 font-semibold text-cv-text">
        <KeyRound size={16} aria-hidden="true" /> Connect Claude
      </div>
      <p className="mt-2 text-xs text-cv-subtext">
        Vault runs on your own Anthropic API key. It is stored in your system keychain and only used by the app's
        back end; it is never shown again or sent anywhere except Anthropic. You can also set{" "}
        <code className="text-cyan-100">ANTHROPIC_API_KEY</code> before starting CinaVault.
      </p>
      <label className="mt-3 block text-xs font-semibold text-cv-subtext" htmlFor="cv-agent-key">
        API key
      </label>
      <input
        id="cv-agent-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="sk-ant-..."
        className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-cv-text outline-none focus:border-cyan-300/60"
      />
      {(hint || error) && <p className="mt-1 text-xs text-amber-200" role="alert">{error ?? hint}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-cyan-200 underline-offset-2 hover:underline"
          onClick={() => void invoke("open_external_url", { url: ANTHROPIC_KEYS_URL })}
        >
          Get a key <ExternalLink size={12} aria-hidden="true" />
        </button>
        <button type="submit" className="cv-btn cv-btn-primary" disabled={saving || !key.trim() || Boolean(hint)}>
          {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          Save key
        </button>
      </div>
    </form>
  );
}

function Settings({ status, onStatus, onReset }: { status: AgentStatus; onStatus: (s: AgentStatus) => void; onReset: () => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const run = (task: Promise<AgentStatus>) =>
    task.then(onStatus).catch((e) => setError(errorText(e)));
  return (
    <div className="mx-4 mb-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-cv-subtext">
      <label htmlFor="cv-agent-model" className="font-semibold">Model</label>
      <select
        id="cv-agent-model"
        value={status.model}
        onChange={(e) => void run(setAgentModel(e.target.value))}
        className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-cv-text"
      >
        {status.models.map((m) => (
          <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>
        ))}
      </select>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span>
          Key: {status.keySource === "env" ? "ANTHROPIC_API_KEY environment variable" : "system keychain"}
        </span>
        <div className="flex gap-2">
          <button type="button" className="cv-btn cv-btn-secondary" onClick={onReset}>
            <RotateCcw size={12} aria-hidden="true" /> New chat
          </button>
          {status.keySource === "keychain" && (
            <button type="button" className="cv-btn cv-btn-secondary" onClick={() => void run(clearAgentApiKey())}>
              Remove key
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-1 text-amber-200" role="alert">{error}</p>}
    </div>
  );
}

export default function AgentPanel(props: AgentPanelProps): JSX.Element {
  const { status, entries, busy, mode, speechRef, reducedMotion, onClose, onSend, onApprove, onStatus, onClear, onTyping } = props;
  const [draft, setDraft] = useState("");
  const [image, setImage] = useState<PendingImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
  }, [onClose]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [entries, busy, reducedMotion]);

  const onDraft = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    onTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => onTyping(false), 1500);
  };

  const submit = (text = draft) => {
    const trimmed = text.trim();
    if ((!trimmed && !image) || busy) return;
    onSend(trimmed, image);
    setDraft("");
    setImage(null);
    onTyping(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const pickImage = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateAgentImage(file);
    setImageError(problem);
    if (problem) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parts = typeof reader.result === "string" ? splitDataUrl(reader.result) : null;
      if (!parts) {
        setImageError("That image could not be read.");
        return;
      }
      setImage({ ...parts, preview: reader.result as string, name: file.name });
    };
    reader.onerror = () => setImageError("That image could not be read.");
    reader.readAsDataURL(file);
  };

  const configured = status?.configured ?? false;

  return (
    <motion.aside
      role="dialog"
      aria-modal="false"
      aria-label="Vault assistant"
      initial={{ opacity: 0, x: 48 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 48 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="fixed bottom-24 right-5 top-20 z-[70] flex w-[min(420px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-[24px] border border-cyan-200/20 backdrop-blur-xl bg-[linear-gradient(160deg,rgba(8,16,32,0.96),rgba(20,8,36,0.96))] shadow-[0_30px_90px_rgba(14,116,144,0.35)]"
    >
      <header className="relative flex items-center gap-3 border-b border-white/10 px-4 pt-3">
        <AgentHead mode={mode} speechRef={speechRef} reducedMotion={reducedMotion} size={132} />
        <div className="min-w-0 flex-1 pb-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-cyan-200/80">AI assistant</div>
          <h2 className="text-xl font-black tracking-tight text-white">Vault</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-cv-subtext" aria-live="polite">
            <span
              className={`inline-block h-2 w-2 rounded-full ${isBusyMode(mode) ? "bg-fuchsia-300 cv-agent-dot--busy" : configured ? "bg-emerald-300" : "bg-amber-300"}`}
              aria-hidden="true"
            />
            {configured ? HEAD_MODE_LABELS[mode] : "Needs an API key"}
          </p>
        </div>
        <div className="absolute right-3 top-3 flex gap-1">
          {configured && status && (
            <button
              type="button"
              className={`${ICON_BTN} h-8 w-8`}
              aria-label="Assistant settings"
              aria-expanded={showSettings}
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings2 size={15} aria-hidden="true" />
            </button>
          )}
          <button type="button" className={`${ICON_BTN} h-8 w-8`} aria-label="Close" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {configured && status && showSettings && (
        <div className="pt-2">
          <Settings
            status={status}
            onStatus={onStatus}
            onReset={() => {
              void resetAgent().then(onClear);
              setShowSettings(false);
            }}
          />
        </div>
      )}

      {!configured ? (
        status ? <KeySetup onStatus={onStatus} /> : <p className="m-4 text-sm text-cv-subtext">Checking setup…</p>
      ) : (
        <>
          <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
            {entries.length === 0 && (
              <div className="space-y-2 text-sm text-cv-subtext">
                <p>Ask about your library, show me a poster, or tell me what to play.</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="cv-btn cv-btn-secondary text-xs" onClick={() => submit(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={
                  entry.role === "user"
                    ? "ml-8 rounded-2xl rounded-br-sm bg-cyan-400/15 px-3 py-2 text-sm text-cv-text"
                    : entry.role === "error"
                      ? "mr-8 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-100"
                      : "mr-8 rounded-2xl rounded-bl-sm border border-white/10 bg-white/5 px-3 py-2 text-sm text-cv-text"
                }
              >
                {entry.imagePreview && (
                  <img src={entry.imagePreview} alt="Attached" className="mb-2 max-h-40 rounded-lg object-contain" />
                )}
                <p className="whitespace-pre-wrap">{entry.text}</p>
                {entry.actions && entry.actions.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {entry.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={action.state !== "pending"}
                        onClick={() => onApprove(entry.id, action.id)}
                        className="cv-btn cv-btn-primary justify-start text-left text-xs"
                      >
                        {action.state === "running" ? (
                          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        ) : action.state === "done" ? (
                          <Check size={13} aria-hidden="true" />
                        ) : null}
                        <span>
                          {action.state === "done" || action.state === "failed" ? action.result : action.label}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="mr-8 flex items-center gap-2 text-xs text-cv-subtext">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {HEAD_MODE_LABELS[mode]}…
              </div>
            )}
          </div>

          <form
            className="border-t border-white/10 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {image && (
              <div className="mb-2 flex items-center gap-2 text-xs text-cv-subtext">
                <img src={image.preview} alt="" className="h-10 w-10 rounded object-cover" />
                <span className="min-w-0 flex-1 truncate">{image.name}</span>
                <button type="button" aria-label="Remove image" className={`${ICON_BTN} h-7 w-7`} onClick={() => setImage(null)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            )}
            {imageError && <p className="mb-1 text-xs text-amber-200" role="alert">{imageError}</p>}
            <div className="flex items-end gap-2">
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={pickImage} />
              <button
                type="button"
                className={`${ICON_BTN} h-10 w-10`}
                aria-label="Attach an image"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus size={16} aria-hidden="true" />
              </button>
              <label htmlFor="cv-agent-input" className="sr-only">Message Vault</label>
              <textarea
                id="cv-agent-input"
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={onDraft}
                onKeyDown={onKeyDown}
                placeholder="Ask Vault…"
                maxLength={8000}
                className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm text-cv-text outline-none focus:border-cyan-300/60"
              />
              <button
                type="submit"
                className={`${SEND_BTN} h-10 w-10`}
                aria-label="Send"
                disabled={busy || (!draft.trim() && !image)}
              >
                <Send size={16} aria-hidden="true" />
              </button>
            </div>
          </form>
        </>
      )}
    </motion.aside>
  );
}
