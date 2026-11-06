// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: US-English keys, the nine StarHermit locales) and
// its `starhermit.*` account strings, in the interface language the runtime
// reports (preferences().language: the player's choice in Options › Language,
// else the account's preferred language or the device's). The runtime's Options
// replaced the game's own Language setting (sh-language.js) and the DOM
// re-labelling: every string is drawn through T() each frame, so a change shows
// on the next frame without touching the round.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

type Vars = Record<string, string | number | (() => string)>;
const resolve = (vars?: Vars): Record<string, string | number> | undefined =>
  vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "function" ? v() : v]));
/** A string by its US-English key in the player's language; `{name}` placeholders from vars (functions resolve now).
 * Anything without a message (digits, an already translated line) passes through. */
export function T(key: string, vars?: Vars): string {
  const v = resolve(vars);
  if (strings.has(key)) return strings.t(key, v);
  return v ? key.replace(/\{(\w+)\}/g, (m, k: string) => (v[k] != null ? String(v[k]) : m)) : key;
}
/** Marks a key for the translation check; translated later with T(). */
export const N = (key: string): string => key;
/** [key, vars] pairs translated at draw time (so they follow a language change). */
export type Msg = [string, Vars?];
export const M = (m: Msg | string): string => (typeof m === "string" ? T(m) : T(m[0], m[1]));
/** The engine's account strings (sign in, invite, leaderboard line, …). */
export function S(name: string, vars?: Record<string, string | number>): string { return strings.t(`starhermit.${name}`, vars); }
