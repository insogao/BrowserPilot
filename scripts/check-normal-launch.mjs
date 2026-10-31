// Static guard: normal browsing launchers must not carry automation markers.
// `--remote-debugging-port=0` makes Chromium set navigator.webdriver=true
// (content/child/runtime_features.cc), which breaks normal Google/Baidu usage.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "manual-browser.cmd");
const text = fs.readFileSync(launcher, "utf8");
const newline = String.fromCharCode(10);
const active = text
  .split(newline)
  .map((line) => line.replace(String.fromCharCode(13), ""))
  .filter((line) => !line.trim().toLowerCase().startsWith("rem "))
  .join(newline);
const forbidden = [
  ["--remote-debugging-port=0", "makes navigator.webdriver=true"],
  ["--enable-automation", "marks the browser as automation-controlled"],
  ["--headless", "normal browsing must not be headless"],
  ["--browser-cli-background-presentation", "managed automation mode is not normal browsing"],
  ["--browser-cli-user-explicit-show", "cold-start show is a test/help path, not normal launch"],
];
let failed = false;
for (const [flag, why] of forbidden) {
  if (active.includes(flag)) {
    console.error("FAIL normal launcher contains " + flag + " (" + why + ")");
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("PASS normal launcher has no webdriver/automation/headless/managed flags");
