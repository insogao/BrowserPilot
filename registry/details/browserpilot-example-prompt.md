# 示例 Prompt 模板

> 把输入主题整理为一个不执行网页动作的示例提示词。

- ID: `browserpilot-example-prompt`
- 版本: `1.1.0`
- 风险: `read`
- 适用站点: 无站点限制
- Intents: `prompt.compose`, `registry.verify`
- Capabilities: `prompt`
- 功能指纹: `sha256:2e28f76249bdb2063d674f7d818e8a66c59edbe27da005fd9782baf4ef6d53d1`

## 输入

- `topic` (string, required): 要处理的主题

## 输出

- `prompt` (string): 拼装后的提示词

## 发现信息

- Keywords: 示例, prompt, 模板, registry
- Aliases: example-prompt
- BrowserPilot: `>=0.1.0`

## 详细说明

这是 BrowserPilot Registry Protocol v1.1 的最小参考模板包，用于验证目录发现、安装、运行、升级、回滚和卸载链路。

它只返回拼装后的 prompt，不访问网页，也不产生外部副作用。

## 功能一览

- **功能**：把输入主题整理为一个不执行网页动作的示例提示词。
- **输入**：`topic`(string, 必填)
- **返回**：`prompt`
- **站点**：无站点限制 ｜ **风险**：read ｜ **版本**：v1.1.0

## 权威定义

[`template.json`](../templates/browserpilot-example-prompt/template.json)

