// 随扩展发布的模板包加载（registry/bundle.json → dist/templates.bundle.json）。
// 设计：模板包打进扩展，开箱即为「内置模板」，不需要先安装/先搜索；GitHub Registry 只用于发现更新与新增。
import { Template, validateTemplate } from "../shared/template-schema";

const BUNDLE_FILE = "templates.bundle.json";

let loaded: Record<string, Template> | null = null;
let loading: Promise<Record<string, Template>> | null = null;

export async function loadBundledTemplates(): Promise<Record<string, Template>> {
  if (loaded) return loaded;
  loading ??= (async () => {
    const map: Record<string, Template> = {};
    try {
      const response = await fetch(chrome.runtime.getURL(BUNDLE_FILE), { cache: "no-store" });
      if (!response.ok) {
        console.warn("[browserpilot] bundled templates unavailable: HTTP " + response.status);
        return map;
      }
      const parsed = await response.json() as { schemaVersion?: unknown; templates?: unknown };
      const list = Array.isArray(parsed?.templates) ? parsed.templates : [];
      for (const raw of list) {
        try {
          const template = validateTemplate(raw);
          map[template.id] = template;
        } catch (e) {
          console.warn("[browserpilot] bundled template skipped:", (raw as { id?: unknown })?.id, e);
        }
      }
    } catch (e) {
      console.warn("[browserpilot] bundled templates load failed:", e);
    }
    loaded = map;
    return map;
  })();
  return loading;
}
