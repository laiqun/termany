import { useEffect, useState } from "react";

const STORAGE_KEY = "termany.language";
const LANGUAGE_CHANGED_EVENT = "termany:language-changed";

export type Language = "en" | "zh-CN";

const dictionaries: Record<Language, Record<string, string>> = {
  en: {
    "settings.appearance": "Appearance",
    "settings.models": "Models",
    "settings.agents": "Agents",
    "settings.keyboard": "Keyboard",
    "settings.about": "About",
    "settings.language.title": "LANGUAGE",
    "settings.language.label": "Interface language",
    "settings.language.en": "English",
    "settings.language.zh": "Chinese (Simplified)",
    "agents.settings": "Agent settings...",
    "agents.title": "AGENTS",
    "agents.refresh": "Detect",
    "agents.add": "Add agent",
    "agents.noEnabled": "No enabled agents",
    "agents.enabled": "Enabled",
    "agents.disabled": "Disabled",
    "agents.name": "Name",
    "agents.command": "Command",
    "agents.args": "Arguments",
    "agents.iconUrl": "Icon URL",
    "agents.commandMissing": "No command set",
    "agents.help": "Override the binary path or name, and edit the default launch arguments.",
    "agents.addTitle": "Add custom agent",
    "agents.editCustomTitle": "Edit custom agent",
    "agents.cancel": "Cancel",
    "agents.done": "Done",
    "agents.remove": "Remove",
    "agents.detectFailed": "Detection failed",
  },
  "zh-CN": {
    "settings.appearance": "外观",
    "settings.models": "模型",
    "settings.agents": "智能体",
    "settings.keyboard": "快捷键",
    "settings.about": "关于",
    "settings.language.title": "语言",
    "settings.language.label": "界面语言",
    "settings.language.en": "英文",
    "settings.language.zh": "简体中文",
    "agents.settings": "智能体设置...",
    "agents.title": "智能体",
    "agents.refresh": "检测",
    "agents.add": "添加智能体",
    "agents.noEnabled": "没有启用的智能体",
    "agents.enabled": "启用",
    "agents.disabled": "已禁用",
    "agents.name": "名称",
    "agents.command": "命令",
    "agents.args": "参数",
    "agents.iconUrl": "图标 URL",
    "agents.commandMissing": "未设置命令",
    "agents.help": "覆盖二进制路径或名称，并编辑默认启动参数。",
    "agents.addTitle": "添加自定义智能体",
    "agents.editCustomTitle": "编辑自定义智能体",
    "agents.cancel": "取消",
    "agents.done": "完成",
    "agents.remove": "移除",
    "agents.detectFailed": "检测失败",
  },
};

function normalizeLanguage(value: string | null | undefined): Language {
  return value === "zh-CN" || value?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function getLanguage(): Language {
  try {
    return normalizeLanguage(localStorage.getItem(STORAGE_KEY) ?? "en");
  } catch {
    return "en";
  }
}

export function setLanguage(language: Language) {
  localStorage.setItem(STORAGE_KEY, language);
  window.dispatchEvent(new Event(LANGUAGE_CHANGED_EVENT));
}

export function translate(language: Language, key: string) {
  return dictionaries[language][key] ?? dictionaries.en[key] ?? key;
}

export function useI18n() {
  const [language, setCurrentLanguage] = useState(getLanguage);

  useEffect(() => {
    const onChange = () => setCurrentLanguage(getLanguage());
    window.addEventListener(LANGUAGE_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return {
    language,
    setLanguage,
    t: (key: string) => translate(language, key),
  };
}
