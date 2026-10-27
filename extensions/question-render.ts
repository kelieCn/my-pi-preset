/**
 * Make a batched `question` call readable in the transcript.
 *
 * pi-code's `question` tool takes one question (`question` + `options`) or a batch
 * (`questions: [...]`), and only the single shape renders. For a batch:
 *
 *   - Its `renderCall` reads `args.question`, which does not exist, so the call line is empty — and
 *     pi-compact-tools, which summarizes a custom call from its scalar arguments, finds nothing
 *     either, leaving the space right of the tool name blank.
 *   - `execute` returns `{ ...collected[0], questions }`, but its `renderResult` reads
 *     `details.answer`, so one answer out of three is drawn and `details.questions` is never read.
 *
 * Both are fixed by shaping the data rather than the drawing, in two event handlers:
 *
 *   - `tool_call` adds a `question` string to the arguments. pi-code prefers `questions` when both
 *     are present (`questionList`), so execution is unchanged, and both renderers now find a
 *     summary. compact-tools draws it right of the tool name, in its own style.
 *   - `tool_result` replaces the result text with one `问：… 答：…` line per question and drops
 *     `details`. Without details, pi-code's result renderer prints the text verbatim, which
 *     compact-tools embeds as the expanded body of its row.
 *
 * Shaping data instead of wrapping renderers keeps this out of the row-rendering contest:
 * compact-tools' `session_start` reconciliation replaces the renderer wrapper on every existing
 * transcript row with its own (`unwrap` only recognizes wrappers it made), which silently undoes a
 * `registerToolRenderer` wrapper after `/reload`. Values in the data survive that, and are
 * persisted, so a row keeps rendering correctly in later sessions and in exports.
 *
 * The cost of dropping `details`: the structured answers are no longer in the session record, only
 * the formatted text. Calls made before this extension existed keep their old rendering, since their
 * data was already written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi-code truncates a header to this width for its label slot; matched here. */
const HEADER_MAX = 12;
/** How much of a question's text stands in for a missing header. */
const QUESTION_MAX = 16;

interface QuestionDetails {
  question: string;
  header?: string;
  options: string[];
  answer: string | null;
  wasCustom?: boolean;
  multiSelect?: boolean;
  timedOut?: boolean;
}

function clip(text: string, max: number): string {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The short label a question is identified by: its header, or the question itself. */
function tag(entry: { header?: string; question?: string }): string {
  return entry.header ? clip(entry.header, HEADER_MAX) : clip(entry.question ?? "", QUESTION_MAX);
}

function batchOf(value: unknown): Array<{ header?: string; question?: string }> | undefined {
  const list = (value as { questions?: unknown } | undefined)?.questions;
  return Array.isArray(list) && list.length > 0 ? (list as Array<{ header?: string; question?: string }>) : undefined;
}

/** What the answer to one question was, in the words of the state it ended in. */
function answerText(detail: QuestionDetails): string {
  if (detail.answer === null) return "(已取消)";
  if (detail.timedOut) return detail.answer ? `(超时自动继续，已选 ${detail.answer})` : "(超时自动继续)";
  if (detail.wasCustom) return `${detail.answer}（手写）`;
  if (detail.multiSelect) return detail.answer || "(未选)";
  const index = detail.options.indexOf(detail.answer) + 1;
  return index > 0 ? `${index}. ${detail.answer}` : detail.answer;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "question") return;
    const input = event.input as Record<string, unknown>;
    const list = batchOf(input);
    // Leave a single question, and anything that already has a summary, alone.
    if (!list || typeof input.question === "string") return;
    input.question = list.map(tag).join(" / ");
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "question") return;
    const list = (event.details as { questions?: QuestionDetails[] } | undefined)?.questions;
    if (!list?.length) return;
    const text = list.map((detail, i) => `问：${i + 1}. ${detail.question}  答：${answerText(detail)}`).join("\n");
    // Returning no `details` clears them, which is what makes pi-code print this text as-is.
    return { content: [{ type: "text" as const, text }] };
  });
}
