import { useEffect, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";

type EngineId = "youdao" | "baidu" | "caiyun" | "google";

interface TranslateConfig {
  enabled: EngineId[];
  caiyunTokenMask: string;
  hasCaiyunToken: boolean;
}

const ENGINES: { id: EngineId; name: string; descKey: string }[] = [
  { id: "youdao", name: "有道词典", descKey: "translate.engine.youdao" },
  { id: "baidu", name: "百度翻译", descKey: "translate.engine.baidu" },
  { id: "caiyun", name: "彩云小译", descKey: "translate.engine.caiyun" },
  { id: "google", name: "Google 翻译", descKey: "translate.engine.google" },
];

/**
 * Translate engine selection for the Alt+drag lookup bubble. Toggles save
 * immediately; the caiyun token saves on blur/Enter, with the server's masked
 * value as placeholder so re-saving never clobbers it (see translateConfig.ts).
 */
export function TranslateSettings() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<TranslateConfig | null>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    fetch(apiPath("/api/translate/config"))
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const save = (patch: Partial<{ enabled: EngineId[]; caiyunToken: string }>) => {
    fetch(apiPath("/api/translate/config"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((r) => r.json())
      .then((next: TranslateConfig) => {
        setCfg(next);
        setToken("");
      })
      .catch(() => { });
  };

  const toggle = (id: EngineId) => {
    if (!cfg) return;
    const enabled = cfg.enabled.includes(id)
      ? cfg.enabled.filter((e) => e !== id)
      : [...cfg.enabled, id];
    setCfg({ ...cfg, enabled });
    save({ enabled });
  };

  if (!cfg) return null;

  return (
    <>
      <div className="settings-section-title">{t("translate.engines.title")}</div>
      <div className="translate-settings">
        {ENGINES.map(({ id, name, descKey }) => (
          <div className="translate-engine-row" key={id}>
            <div className="translate-engine-main">
              <span className="translate-engine-name">{name}</span>
              <span className="translate-engine-desc">{t(descKey)}</span>
              {id === "caiyun" && cfg.enabled.includes("caiyun") && (
                <input
                  className="translate-engine-token"
                  type="text"
                  value={token}
                  placeholder={cfg.caiyunTokenMask || t("translate.caiyun.token.placeholder")}
                  onChange={(e) => setToken(e.target.value)}
                  onBlur={() => token && save({ caiyunToken: token })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && token) save({ caiyunToken: token });
                  }}
                />
              )}
            </div>
            <div className="agent-enable-toggle" aria-label={`${name} enabled state`}>
              <button
                className={cfg.enabled.includes(id) ? "active" : ""}
                onClick={() => !cfg.enabled.includes(id) && toggle(id)}
              >
                {t("agents.enabled")}
              </button>
              <button
                className={!cfg.enabled.includes(id) ? "active" : ""}
                onClick={() => cfg.enabled.includes(id) && toggle(id)}
              >
                {t("agents.disabled")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
