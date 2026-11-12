// Every text key the app names literally – t("…") or tr("…") in packages/ui and apps/web – exists
// in both languages, and both languages have the same keys. Keys built at runtime ("kind." + k,
// `triage.${…}`) are not checked; core's own t() adds a prefix (setup.ts), so core is left out.
import { expect, test } from "bun:test";
import de from "@obtion/core/locales/de.json";
import en from "@obtion/core/locales/en.json";
import { Glob } from "bun";

const root = new URL("../../", import.meta.url).pathname;

async function literalKeys(): Promise<Map<string, string>> {
	const keys = new Map<string, string>();
	for (const dir of ["packages/ui/src", "apps/web/src"]) {
		for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root + dir })) {
			const text = await Bun.file(`${root}${dir}/${file}`).text();
			for (const m of text.matchAll(/(?<![\w.$])tr?\("([^"\\]+)"\s*[,)]/g))
				if (!keys.has(m[1]!)) keys.set(m[1]!, `${dir}/${file}`);
		}
	}
	return keys;
}

test("every literal t()/tr() key exists in de and en", async () => {
	const keys = await literalKeys();
	expect(keys.size).toBeGreaterThan(100);
	const missing = [...keys].flatMap(([k, file]) => [
		...(k in de ? [] : [`de: ${k} (${file})`]),
		...(k in en ? [] : [`en: ${k} (${file})`]),
	]);
	expect(missing).toEqual([]);
});

test("de and en have the same keys", () => {
	expect(Object.keys(de).filter((k) => !(k in en))).toEqual([]);
	expect(Object.keys(en).filter((k) => !(k in de))).toEqual([]);
});
