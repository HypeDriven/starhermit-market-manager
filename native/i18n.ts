// Localization: the browser build's string tables (src/i18n.js: US-English
// keys, the nine StarHermit locales in src/locales/, en-US as the keys
// themselves) and the account-control strings (src/sh-strings.js), in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replaced the game's own
// Language setting (sh-language.js) and the DOM re-labelling: every string is
// drawn through T() each frame, so a change shows on the next frame without
// touching the round. The hidden words are English word-search content in
// every locale (as before); their theme names are translated.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import * as I18n from "../src/i18n.js";
import * as ShStrings from "../src/sh-strings.js";

type Vars = Record<string, string | number | (() => string)>;
const api = I18n as unknown as {
  LOCALES: string[];
  setLocale(id: string): void;
  getLang(): string;
  T(key: string, vars?: Record<string, string | number>): string;
};
const sh = ShStrings as unknown as { shStrings(langs: string[]): Record<string, string> };
export const LOCALES = api.LOCALES;

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const [lang = "", region = ""] = s.toLowerCase().split("-");
  if (lang === "en") return ["gb", "uk", "ie", "au", "nz", "za", "in"].includes(region) ? "en-GB" : "en-US";
  if (lang === "es") return region === "es" ? "es-ES" : "es-419";
  if (lang === "fr") return region === "ca" ? "fr-CA" : "fr-FR";
  return ({ de: "de-DE", pt: "pt-BR", it: "it-IT" } as Record<string, string>)[lang] ?? "en-US";
}

const resolve = (vars?: Vars): Record<string, string | number> | undefined =>
  vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "function" ? v() : v]));
/** A string by its US-English key in the player's language; `{name}` placeholders from vars (functions resolve now). */
export function T(key: string, vars?: Vars): string { return api.T(key, resolve(vars)); }
/** Marks a key for the translation check; translated later with T(). */
export const N = (key: string): string => key;
/** [key, vars] pairs translated at draw time (so they follow a language change). */
export type Msg = [string, Vars?];
export const M = (m: Msg | string): string => (typeof m === "string" ? T(m) : T(m[0], m[1]));
/** The account controls' strings (sign in, invite, leaderboard line, …). */
export function S(key: string, vars?: Record<string, string | number>): string {
  let s = sh.shStrings([api.getLang()])[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

let locale = "en-US";
function apply(tag: string): void {
  locale = pickLocale(tag);
  api.setLocale(locale);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => { if (pickLocale(p.language) !== locale) apply(p.language); });
export function currentLocale(): string { return locale; }
