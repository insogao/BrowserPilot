// 插件化操作模版 schema（M9）。结构对齐功能文档 §4.9 / 技术路径 §4.11。
// 一个模版 = 一段编排描述：命令序列 | 脚本片段 | 提示词片段。附元信息 + 省token策略 + 适用范围。
import type { CommandName } from "./types";

export type TemplateInputType = "string" | "number" | "boolean" | "url";

export interface TemplateInput {
  name: string;
  type: TemplateInputType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface TemplateStep {
  name: CommandName;
  /** 命令参数；值可含占位符 `$name` 或 `{{name}}`，run_template 时用 params 代入。 */
  args?: Record<string, unknown>;
  /** 该步失败时的重试次数（额外次数，0=不重试）。 */
  retry?: number;
  /** 若设置，步骤成功后要求「结果 JSON 字符串」包含此子串，否则视为失败（触发 failback）。 */
  expect?: string;
  /** 仅供人类阅读的说明。 */
  note?: string;
  /** 若 params 里该参数为真值则跳过本步（例：已给 tabId 就不再新开标签）。 */
  skipWhenParam?: string;
}

export type TemplateStepsKind = "commands" | "script" | "prompt";

export interface TemplateTokenStrategy {
  /** 默认用 L0 精确观测，命中目标才升级 L1（省 token）。 */
  defaultL0?: boolean;
  /** 同一站点已取信息缓存（v1 预留，暂不实现）。 */
  useCache?: boolean;
}

export interface TemplateScope {
  sites?: string[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: "search" | "ai-chat" | "generic" | string;
  inputs: TemplateInput[];
  /** 载体类型：命令序列 / 脚本 / 提示词。 */
  steps: TemplateStepsKind;
  /** commands → TemplateStep[]；script/prompt → string。 */
  body: TemplateStep[] | string;
  tokenStrategy?: TemplateTokenStrategy;
  scope?: TemplateScope;
}

/** 校验并规整一个模版对象；不合法则抛错（带可读原因）。 */
export function validateTemplate(raw: unknown): Template {
  if (!raw || typeof raw !== "object") throw new Error("模版必须是对象");
  const t = raw as Template;
  if (!t.id || typeof t.id !== "string") throw new Error("模版缺少合法 id");
  if (typeof t.steps !== "string" || !["commands", "script", "prompt"].includes(t.steps)) {
    throw new Error("modify steps 必须是 commands/script/prompt");
  }
  if (t.steps === "commands") {
    if (!Array.isArray(t.body)) throw new Error("commands 模版的 body 必须是步骤数组");
    for (const s of t.body) {
      if (!s || typeof s.name !== "string") throw new Error("commands 步骤缺少 name");
    }
  } else if (typeof t.body !== "string") {
    throw new Error(t.steps + " 模版的 body 必须是字符串");
  }
  if (!Array.isArray(t.inputs)) t.inputs = [];
  return t;
}

/** 是否属于「以某标签页为操作对象」的命令（需要注入 tabId）。 */
export const TAB_SCOPED = new Set<string>([
  "snapshot", "readText", "getElementInfo", "screenshot",
  "click", "dblclick", "hover", "drag", "wheel", "down", "up",
  "press", "type", "fill", "selectOption", "check", "uncheck", "setChecked",
  "js", "waitForURL", "waitForSelector", "waitForTimeout", "pageInfo",
  "start_mask", "stop_mask", "switch_tab", "close_tab",
]);

/** 找出 args 里所有占位符（$name / {{name}}），返回参数名列表。 */
export function collectPlaceholders(args: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}|\$([A-Za-z0-9_]+)/g)) {
        names.add(m[1] || m[2]);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(args);
  return names;
}
