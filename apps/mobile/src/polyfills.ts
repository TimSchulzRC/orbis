// Before anything else: Hermes lacks what the shared code takes from the browser.
// crypto.getRandomValues makes ids (core/model.ts newId); Intl.PluralRules and
// Intl.RelativeTimeFormat format the translations' plurals and "2 hours ago" (core/i18n.ts).
import "@formatjs/intl-getcanonicallocales/polyfill.js";
import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/de.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-relativetimeformat/polyfill.js";
import "@formatjs/intl-relativetimeformat/locale-data/de.js";
import "@formatjs/intl-relativetimeformat/locale-data/en.js";
import { getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: Partial<Crypto> };
if (!g.crypto?.getRandomValues) g.crypto = { ...g.crypto, getRandomValues } as Crypto;
