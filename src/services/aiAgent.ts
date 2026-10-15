// IPC contract for the Vault assistant. Mirrors the commands and payloads in
// src-tauri/src/ai_agent.rs. The Anthropic API key is write-only from here:
// it goes into agent_set_api_key and never comes back to the WebView.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentActivityPhase } from "./aiAgentState";

export interface AgentStatus {
  configured: boolean;
  keySource: "env" | "keychain" | null;
  model: string;
  models: string[];
}

export type AgentActionKind =
  | { type: "play" }
  | { type: "refreshMetadata" }
  | { type: "rename"; title: string }
  | { type: "setWatched"; watched: boolean };

export interface AgentAction {
  id: string;
  kind: AgentActionKind;
  mediaId: number;
  label: string;
}

export interface AgentReply {
  text: string;
  actions: AgentAction[];
  toolsUsed: string[];
  stopReason: string;
}

export interface AgentImageInput {
  mediaType: string;
  data: string;
}

export const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (balanced)",
  "claude-opus-5-5": "Claude Opus 5.5 (most capable)",
  "claude-haiku-4-5": "Claude Haiku 4.5 (fastest)",
};

export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";

export const getAgentStatus = () => invoke<AgentStatus>("agent_status");
export const setAgentApiKey = (key: string) => invoke<AgentStatus>("agent_set_api_key", { key });
export const clearAgentApiKey = () => invoke<AgentStatus>("agent_clear_api_key");
export const setAgentModel = (model: string) => invoke<AgentStatus>("agent_set_model", { model });
export const resetAgent = () => invoke<void>("agent_reset");
export const runAgentAction = (actionId: string) => invoke<string>("agent_run_action", { actionId });

/**
 * Sends one message. The back end streams its progress (thinking, searching,
 * acting) over a per-request channel, which drives the head's animations.
 */
export function sendAgentMessage(
  message: string,
  image: AgentImageInput | null,
  onActivity: (phase: AgentActivityPhase, tool: string | null) => void,
): Promise<AgentReply> {
  const channel = new Channel<{ phase: AgentActivityPhase; tool: string | null }>();
  channel.onmessage = (event) => onActivity(event.phase, event.tool);
  return invoke<AgentReply>("agent_chat", { message, image, onActivity: channel });
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
