/**
 * Frame user messages with a labelled top rule and a plain bottom rule.
 *
 * Pi has no public hook for rendering user messages (`registerMessageRenderer` only covers custom
 * messages), so this wraps `UserMessageComponent.prototype.render`. The wrapper does exactly two
 * things per render: call the original, and prepend/append one line. No caching, no scanning of the
 * rendered text, no walking of the Markdown tree, so it cannot become the slow part of a render pass.
 *
 * Left and right borders are deliberately omitted: a leading `│` ends up in the clipboard whenever
 * the message is copied out of the terminal.
 *
 * The filled background behind the text is dropped too, and the message text is pinned to the muted
 * near-white of the reference design. Themes have no say in either: the active theme's
 * `userMessageBg` and `userMessageText` are rewritten on the fly, which is what a theme declaring
 * those tokens as `""` and `"#d4d7d9"` would do.
 *
 * `customMessageBg` is filled in the same way, for the opposite reason. Skill blocks and custom
 * messages are drawn as a `Box` painted with that token, and a theme that leaves it at `""` (as
 * github-dark-pro does) gives them the terminal's own background, so an expanded skill block runs
 * into the surrounding prose. The theme's own panel color separates it again.
 *
 * Everything happens when the extension loads, with no `session_start` handler: `/reload` builds a
 * new runtime without starting a new session, so a patch installed from a session event would leave
 * the previous load's wrapper in place and the new code dead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  foregroundAnsi,
  parseColor,
  stripTerminalSequences,
  type TerminalColorMode,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Holds the unwrapped render so a `/reload` re-wraps the original instead of stacking wrappers. */
const ORIGINAL_RENDER = Symbol.for("user-message-frame.originalRender");
/** Where pi keeps the active theme so every module loader, jiti included, sees the same instance. */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

const LABEL = " User ";
/**
 * The rules and the label take the theme's `dim`, the same muted gray the reference screenshot uses
 * (`#6e7681` under github-dark-pro). Bright white was too loud next to the message text.
 */
const RULE_TOKEN = "dim";
const RESET = "\x1b[0m";
/** The escape sequence a theme token set to `""` renders as: the terminal's own background. */
const DEFAULT_BG = "\x1b[49m";
/** Message text, measured off the reference screenshot. */
const TEXT_COLOR = parseColor("#d4d7d9");
/** Panel behind skill blocks and custom messages: github-dark-pro's own card color. */
const CUSTOM_BG_COLOR = parseColor("#161b22");
/** Leading OSC sequences, such as the OSC 133 prompt zones pi marks user messages with. */
const OSC_PREFIX = /^(?:\x1b\][^\x07]*\x07)+/;

/** Themes already adjusted; a theme switch brings a new object, which is adjusted in turn. */
const adjusted = new WeakSet<object>();

function activeTheme(): ThemeLike | undefined {
  return (globalThis as Record<symbol, ThemeLike | undefined>)[THEME_KEY];
}

/** The parts of pi's `Theme` this extension touches. */
interface ThemeLike {
  fgAnsi?: Map<string, string>;
  bgAnsi?: Map<string, string>;
  getFgAnsi?: (token: string) => string;
  getColorMode?: () => TerminalColorMode;
}

/**
 * Repoint the message tokens this extension owns. `fgAnsi` and `bgAnsi` hold the precomputed escape
 * sequence per token, so one Map write each covers every later render.
 */
function adjustTheme(theme: ThemeLike | undefined): void {
  if (!theme || adjusted.has(theme)) return;
  adjusted.add(theme);
  // Goes through the theme's own color mode, so a 256-color terminal gets the nearest index.
  const mode = theme.getColorMode?.() ?? "truecolor";
  if (theme.bgAnsi instanceof Map) {
    theme.bgAnsi.set("userMessageBg", DEFAULT_BG);
    theme.bgAnsi.set("customMessageBg", backgroundAnsi(CUSTOM_BG_COLOR, mode));
  }
  if (theme.fgAnsi instanceof Map) {
    theme.fgAnsi.set("userMessageText", foregroundAnsi(TEXT_COLOR, mode));
  }
}

function isBlank(line: string): boolean {
  return stripTerminalSequences(line).trim().length === 0;
}

function rule(width: number, label: boolean, osc: string, theme: ThemeLike | undefined): string {
  const fg = theme?.getFgAnsi?.(RULE_TOKEN) ?? "";
  const labelled = label && width >= visibleWidth(LABEL) + 4;
  const body = labelled
    ? `─${LABEL}${"─".repeat(width - 1 - visibleWidth(LABEL))}`
    : "─".repeat(width);
  return `${osc}${fg}${body}${fg ? RESET : ""}`;
}

function patchRender(): void {
  const proto = UserMessageComponent.prototype as unknown as Record<string | symbol, unknown>;
  const original = (proto[ORIGINAL_RENDER] ?? proto.render) as
    | ((width: number) => string[])
    | undefined;
  if (typeof original !== "function") return;
  proto[ORIGINAL_RENDER] = original;
  proto.render = function framedRender(this: unknown, width: number): string[] {
    const theme = activeTheme();
    adjustTheme(theme);
    const lines = original.call(this, width);
    if (!Array.isArray(lines) || lines.length === 0) return lines;
    const w = Math.max(1, Math.floor(width));
    // The original pads with a blank row above and below the text. The rules take those rows, so
    // the frame hugs the message the way a border would; the prompt-zone markers pi puts on the
    // outermost rows move onto the rules with them.
    let body = lines;
    let topOsc = "";
    let bottomOsc = "";
    const first = body[0];
    if (body.length > 1 && first !== undefined && isBlank(first)) {
      topOsc = OSC_PREFIX.exec(first)?.[0] ?? "";
      body = body.slice(1);
    }
    const last = body[body.length - 1];
    if (body.length > 1 && last !== undefined && isBlank(last)) {
      bottomOsc = OSC_PREFIX.exec(last)?.[0] ?? "";
      body = body.slice(0, -1);
    }
    return [rule(w, true, topOsc, theme), ...body, rule(w, false, bottomOsc, theme)];
  };
}

export default function (pi: ExtensionAPI) {
  patchRender();
  // A skill block can be the first thing painted in a session, before any user message pulled the
  // token overrides in through the render path below.
  pi.on("session_start", () => {
    adjustTheme(activeTheme());
  });
}
