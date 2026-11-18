// Before anything else: Hermes lacks what the shared code takes from the browser.
// crypto.getRandomValues makes ids (core/model.ts newId); Intl.PluralRules and
// Intl.RelativeTimeFormat format the translations' plurals and "2 hours ago" (core/i18n.ts).
import "@formatjs/intl-getcanonicallocales/polyfill";
import "@formatjs/intl-locale/polyfill";
import "@formatjs/intl-pluralrules/polyfill";
import "@formatjs/intl-pluralrules/locale-data/de";
import "@formatjs/intl-pluralrules/locale-data/en";
import "@formatjs/intl-relativetimeformat/polyfill";
import "@formatjs/intl-relativetimeformat/locale-data/de";
import "@formatjs/intl-relativetimeformat/locale-data/en";
import { getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: Partial<Crypto> };
if (!g.crypto?.getRandomValues) g.crypto = { ...g.crypto, getRandomValues } as Crypto;
