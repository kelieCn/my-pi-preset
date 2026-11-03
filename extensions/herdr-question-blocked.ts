/**
 * Give herdr's official pi integration something to report as `blocked`.
 *
 * `herdr-agent-state.ts` (installed by `herdr integration install pi`) derives
 * working/idle from pi's lifecycle hooks, but its `blocked` state is only
 * reachable through a `herdr:blocked` event on `pi.events` — and nothing in pi,
 * pi-code or herdr ever emits one. A session waiting on a `question` or a
 * confirmation dialog therefore keeps reporting `working`.
 *
 * Screen detection cannot cover this either: a pane with the integration loaded
 * is marked `full_lifecycle_hook_authority` and skips the detection manifests
 * entirely, and herdr's `pi.toml` has no `blocked` rule to match.
 *
 * This sidecar file is the missing sender. It is deliberately separate from the
 * herdr-managed file, which `herdr integration install pi` overwrites.
 *
 * pi emits `ui_prompt_start` / `ui_prompt_end` around every blocking extension
 * UI prompt (`select`, `confirm`, `input`, `editor`, `custom`), and the `question`
 * tool's overlay is a `custom` prompt, so this covers questions and approval
 * dialogs through one hook instead of tracking individual tools. pi already
 * collapses nested prompts (only the outermost pair is emitted), so the depth
 * counter here is defensive rather than load-bearing.
 *
 * Contract with the official extension (`pi.events.on("herdr:blocked")`): it
 * keeps a counter, so every `{ active: true }` must be matched by exactly one
 * `{ active: false }`. An unpaired decrement would eat a real block later and
 * leave a pane stuck on `blocked`, so an `ui_prompt_end` with nothing open is
 * dropped rather than forwarded.
 *
 * pi's prompt events carry only a kind and an optional title, and the `question`
 * overlay is a titleless `custom` prompt — so the question text is captured from
 * the `question` call and used as the label instead.
 *
 * A titleless `custom` prompt is not enough on its own: pi's startup welcome
 * screen (`Press any key to continue (15s)`) is exactly that, so every launch would
 * read as blocked for 15 seconds. Such a prompt only counts while a run is active,
 * where a blocking dialog really is the agent waiting on the user; outside a run it
 * is a session-level screen. `confirm`/`select`/`input`/`editor` prompts are
 * deliberate dialogs and always count, as does any prompt carrying a title.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_CHANNEL = "herdr:blocked";
/** pi-code truncates a header to this width for its label slot; matched here. */
const HEADER_MAX = 12;
/** How much of a question's text stands in for a missing header. */
const QUESTION_MAX = 40;
/** herdr shows the label in the sidebar, so a batch must stay one short line. */
const TITLE_MAX = 60;

interface QuestionLike {
  header?: string;
  question?: string;
}

function clip(text: string, max: number): string {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The short label the sidebar shows for one question. */
function tag(entry: QuestionLike | undefined): string | undefined {
  if (!entry) return undefined;
  const header = typeof entry.header === "string" ? clip(entry.header, HEADER_MAX) : "";
  if (header) return header;
  const question = typeof entry.question === "string" ? clip(entry.question, QUESTION_MAX) : "";
  return question || undefined;
}

/** A batched `question` call carries `questions`; the single form carries both fields. */
function labelOf(input: unknown): string | undefined {
  const args = input as ({ questions?: unknown } & QuestionLike) | undefined;
  const batch = args?.questions;
  const labels = Array.isArray(batch)
    ? batch.map((entry) => tag(entry as QuestionLike)).filter((label): label is string => !!label)
    : [];
  const label = labels.length > 0 ? labels.join(" / ") : tag(args);
  return label ? clip(label, TITLE_MAX) : undefined;
}

export default function (pi: ExtensionAPI) {
  // Same gate the official extension uses: outside a herdr pane nothing listens.
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID) {
    return;
  }

  /** Open blocking prompts. pi only forwards the outermost one, so this is 0 or 1. */
  let openPrompts = 0;
  /** Whether the currently open prompt is one we reported as `blocked`. */
  let reported = false;
  /** Whether an agent run is in flight, i.e. a dialog is the agent waiting on the user. */
  let agentActive = false;
  /** Label for the `question` overlay, which reaches us as a titleless `custom` prompt. */
  let questionLabel: string | undefined;

  function publish(active: boolean, label?: string): void {
    try {
      pi.events.emit(BLOCKED_CHANNEL, active && label ? { active, label } : { active });
    } catch {
      // An emit failure must never turn into a blocked tool call or a failed turn.
    }
  }

  pi.on("tool_call", (event) => {
    if (event?.toolName !== "question") return;
    try {
      questionLabel = labelOf(event.input);
    } catch {
      // Swallowed on purpose: a throwing `tool_call` handler blocks the call.
    }
  });

  pi.on("tool_result", (event) => {
    if (event?.toolName !== "question") return;
    // The prompt normally closed already; this only drops a label whose prompt never opened.
    questionLabel = undefined;
  });

  /** Whether this prompt means "the agent is waiting on you" rather than a startup screen. */
  function worthReporting(kind: string | undefined, label: string | undefined): boolean {
    if (label || kind !== "custom") return true;
    return agentActive;
  }

  pi.on("session_start", (_event, ctx) => {
    agentActive = ctx?.isIdle?.() === false;
  });

  pi.on("agent_start", () => {
    agentActive = true;
  });

  pi.on("ui_prompt_start", (event) => {
    openPrompts += 1;
    if (openPrompts > 1) return;
    const title = typeof event?.title === "string" ? clip(event.title, TITLE_MAX) : "";
    // Between a `question` call and its result, any prompt is that question's own
    // (`custom` on the TUI, `select`/`input` elsewhere), so its text is the label.
    const label = title || questionLabel;
    reported = worthReporting(event?.kind, label);
    if (reported) publish(true, label);
  });

  pi.on("ui_prompt_end", () => {
    if (openPrompts === 0) return;
    openPrompts -= 1;
    if (openPrompts > 0) return;
    const wasReported = reported;
    reported = false;
    questionLabel = undefined;
    if (wasReported) publish(false);
  });

  /** Clear whatever we reported; nothing can still be waiting once the run settles. */
  function reset(): void {
    openPrompts = 0;
    questionLabel = undefined;
    if (!reported) return;
    reported = false;
    publish(false);
  }

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.isIdle?.() !== true) return;
    agentActive = false;
    reset();
  });

  pi.on("session_shutdown", () => {
    reset();
  });
}
