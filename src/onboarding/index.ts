// onboarding 说明页：暂无交互，仅静态说明。预留打开选项页时刷新 host 连接的钩子。
chrome.runtime.sendMessage({ kind: "get_status" }).catch(() => {});
