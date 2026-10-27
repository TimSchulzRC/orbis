import { useState } from "react";
import { type Lang, detectLang, translate } from "../../shared/i18n";
import type { FileMeta } from "../../shared/model";
import { runSetup } from "../../shared/setup";
import { type ExampleFile, exampleFiles, fileFacts, writeExamples } from "../../shared/examples";
import { repo } from "../repo";
import { files } from "../files";
import { setLang } from "../i18n";
import { Button, Seg } from "../ui/bits";

/** First setup: choose the language (the shipped types are created in it), with or without the examples. */
export function Setup() {
  const [lang, setL] = useState<Lang>(detectLang());
  const [examples, setExamples] = useState(true);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setLang(lang);
    // the files first (stored here, uploaded later), then everything in one go
    const metas: Partial<Record<ExampleFile["key"], FileMeta>> = {};
    if (examples)
      for (const f of exampleFiles(lang)) {
        const meta = await files.prepare(new Blob([f.bytes], { type: f.mime }), f.name);
        metas[f.key] = { ...fileFacts(f, meta.hash), ...meta };
      }
    runSetup(repo.writer, lang, `web:${repo.device}`);
    if (examples) writeExamples(repo.writer, lang, metas);
  };
  const t = (k: string) => translate(lang, k);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <img src="/icon.svg" alt="" className="mb-4 size-10" />
        <h1 className="text-2xl font-semibold tracking-tight">{t("setup.welcome")}</h1>
        <p className="mt-2 text-sm text-muted">{t("setup.intro")}</p>
        <div className="mt-6 flex items-center justify-between">
          <span className="text-sm font-medium">{t("settings.language")}</span>
          <Seg
            label={t("settings.language")}
            value={lang}
            onChange={setL}
            options={[
              { value: "de", label: "Deutsch" },
              { value: "en", label: "English" },
            ]}
          />
        </div>
        <p className="mt-4 text-xs text-muted">{t("setup.types")}</p>
        <label className="mt-5 flex cursor-pointer gap-3 rounded-xl border border-line p-3 hover:bg-hover">
          <input type="checkbox" checked={examples} onChange={(e) => setExamples(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--focus)]" />
          <span>
            <span className="block text-sm font-medium">{t("setup.examples")}</span>
            <span className="block text-xs text-muted">{t("setup.examplesHint")}</span>
          </span>
        </label>
        <Button variant="primary" className="mt-6 w-full" disabled={busy} onClick={() => void start()}>
          {t("setup.start")}
        </Button>
      </div>
    </div>
  );
}
