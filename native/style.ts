// The look of the menus, HUD, drawers and dialogs: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// check boxes, selects, focus rings) take. The browser build's
// html.high-contrast palette (applied while the runtime's high-contrast
// option is on) and its html.colorblind-* accent shifts (the game's Color
// vision setting) are token sets laid over the sheet's.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** css/style.css html.high-contrast: white surfaces, near-black ink, dark lines, no shadows. */
const HIGH_CONTRAST: Tokens = { bg: "#ffffff", "bg-soft": "#ffffff", panel: "#ffffff", ink: "#111111", "ink-soft": "#333333", line: "#444444" };
/** css/style.css html.colorblind-*: accent, good and bad shifted for each colour-vision mode. */
const COLORBLIND: Record<string, Tokens> = {
  deuteranopia: { accent: "#2f6f9f", "accent-deep": "#1f557f", good: "#0072b2", bad: "#d55e00", focus: "#1f557f" },
  protanopia: { accent: "#2f6f9f", "accent-deep": "#1f557f", good: "#0072b2", bad: "#e5ae10", focus: "#1f557f" },
  tritanopia: { accent: "#c23b6b", "accent-deep": "#9e2a52", good: "#009e73", bad: "#cc79a7", focus: "#9e2a52" },
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 24, padding: 8, spacing: 8, radius: 12,
    text: "#3d2b1f", muted: "#6f5b48", panel: "#fffaf1", control: "#fbe7c6", hovered: "#ecd9b8",
    pressed: "#ecd9b8", field: "#fffaf1", accent: "#e8743b", focus: "#c85a24", outline: "#ecd9b8",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$ink-soft", radius: 4 } } },
    tooltip: { background: "$ink", text: { color: "$panel", size: 13 }, radius: 8, padding: 6 },
  });
}

let key = "";
/** The high-contrast and colour-vision tokens over the sheet's (each frame; changes only when they do). */
export function applyTokens(highContrast: boolean, colorblind: string): void {
  const k = `${highContrast}|${colorblind}`;
  if (k === key) return;
  key = k;
  ui.setTokens({ ...base, ...(COLORBLIND[colorblind] ?? {}), ...(highContrast ? HIGH_CONTRAST : {}) });
}
