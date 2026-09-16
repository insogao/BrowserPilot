// 单测 profile.js 的解析函数。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { argValue, exeFromCmd, browserFromCmd, posixBrowserFromCmd, posixExeFromCmd } from "./profile.js";

const cases = [
  {
    name: "chrome renderer with profile",
    cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data" --profile-directory="Profile 1" --type=renderer',
    expect: { browser: "chrome", udd: "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data", profile: "Profile 1", exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  {
    name: "edge with profile",
    cmd: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir="C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data" --profile-directory=Default',
    expect: { browser: "edge", udd: "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data", profile: "Default", exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
  },
  {
    name: "chrome no user-data-dir",
    cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory="Profile 3"',
    expect: { browser: "chrome", udd: undefined, profile: "Profile 3", exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  {
    name: "chrome unquoted user-data-dir stops at next flag",
    cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Temp\\Chrome --remote-debugging-port=9222',
    expect: { browser: "chrome", udd: "C:\\Temp\\Chrome", profile: undefined, exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  {
    name: "whole-argument-quoted user-data-dir keeps spaces, stops at closing quote",
    cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=C:\\Users\\John Doe\\AppData\\Local\\Google\\Chrome\\User Data" --profile-directory="Profile 4"',
    expect: { browser: "chrome", udd: "C:\\Users\\John Doe\\AppData\\Local\\Google\\Chrome\\User Data", profile: "Profile 4", exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  {
    name: "embedded user-data-dir-like token is not matched",
    cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --not-user-data-dir=C:\\Fake --remote-debugging-port=9222',
    expect: { browser: "chrome", udd: undefined, profile: undefined, exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
  {
    name: "user-data-dir prefix flag is not matched",
    cmd: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir-extra=C:\\Fake',
    expect: { browser: "chrome", udd: undefined, profile: undefined, exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  },
];

let pass = 0;
for (const c of cases) {
  const browser = browserFromCmd(c.cmd);
  const udd = argValue(c.cmd, "--user-data-dir=");
  const profile = argValue(c.cmd, "--profile-directory=");
  const exe = exeFromCmd(c.cmd);
  const ok =
    browser === c.expect.browser &&
    udd === c.expect.udd &&
    profile === c.expect.profile &&
    exe === c.expect.exe;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${c.name}`);
  console.log(`   browser=${browser} udd=${udd} profile=${profile} exe=${exe}`);
}
console.log(`${pass}/${cases.length} passed`);

// macOS/Linux 解析用例：用临时 .app 树提供存在性 fixture，不依赖本机安装的浏览器。
// exe 断言只在 darwin 生效（posixExeFromCmd 是 leading-/ 的 mac 解析器）；其他平台
// 仅校验纯字符串解析，不要求 fixture 命中该解析器（Windows 真机行为未验证）。
const assertExe = process.platform === "darwin";
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browserpilot-profile-"));
let posixPass = 0;
let posixTotal = 0;
try {
  function makeBin(appName, binName = appName) {
    const dir = path.join(fixtureRoot, `${appName}.app`, "Contents", "MacOS");
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, binName);
    fs.writeFileSync(bin, "");
    return bin;
  }
  const chromeExe = makeBin("Google Chrome");
  const chromiumExe = makeBin("Chromium");
  const edgeExe = makeBin("Microsoft Edge");
  const braveExe = makeBin("Brave Browser");
  const cftExe = makeBin("Backlight", "Google Chrome for Testing");
  const cftBundleExe = makeBin("Google Chrome for Testing");

  const posixCases = [
    {
      name: "mac chrome with profile flag",
      cmd: `${chromeExe} --profile-directory="Profile 2" --type=renderer`,
      expect: { browser: "chrome", udd: undefined, profile: "Profile 2", exe: chromeExe },
    },
    {
      name: "mac chrome with positional arg before flags",
      cmd: `${chromeExe} 30 --profile-directory=Default`,
      expect: { browser: "chrome", udd: undefined, profile: "Default", exe: chromeExe },
    },
    {
      name: "mac chrome quoted user-data-dir with spaces stops at closing quote",
      cmd: `${chromeExe} --user-data-dir="/Users/me/Library/Application Support/Google/Chrome" --profile-directory="Default"`,
      expect: { browser: "chrome", udd: "/Users/me/Library/Application Support/Google/Chrome", profile: "Default", exe: chromeExe },
    },
    {
      name: "mac whole-argument-quoted user-data-dir with spaces",
      cmd: `${chromeExe} "--user-data-dir=/Users/me/Chrome Profile" --profile-directory=Default`,
      expect: { browser: "chrome", udd: "/Users/me/Chrome Profile", profile: "Default", exe: chromeExe },
    },
    {
      name: "backlight-shaped chrome for testing with unquoted flags",
      cmd: `${cftExe} --user-data-dir=/tmp/bp-backlight-profile --remote-debugging-port=51731 --load-extension=/path/dist`,
      expect: { browser: "chrome", udd: "/tmp/bp-backlight-profile", profile: "Default", exe: cftExe },
      excludes: ["--remote-debugging-port", "--load-extension"],
    },
    {
      name: "chrome for testing inside its own app bundle",
      cmd: `${cftBundleExe} --user-data-dir=/tmp/cft-profile --remote-debugging-port=1`,
      expect: { browser: "chrome", udd: "/tmp/cft-profile", profile: "Default", exe: cftBundleExe },
    },
    {
      name: "mac chromium",
      cmd: `${chromiumExe} --profile-directory=Default`,
      expect: { browser: "chromium", udd: undefined, profile: "Default", exe: chromiumExe },
    },
    {
      name: "mac edge unquoted user-data-dir",
      cmd: `${edgeExe} --user-data-dir=/tmp/edge-profile --profile-directory=Default`,
      expect: { browser: "edge", udd: "/tmp/edge-profile", profile: "Default", exe: edgeExe },
    },
    {
      name: "mac brave",
      cmd: `${braveExe} --user-data-dir=/tmp/brave-profile`,
      expect: { browser: "brave", udd: "/tmp/brave-profile", profile: "Default", exe: braveExe },
    },
    {
      name: "mac command is not a browser",
      cmd: "/usr/libexec/syslogd",
      expect: { browser: undefined, udd: undefined, profile: undefined, exe: undefined },
    },
  ];

  posixTotal = posixCases.length;
  for (const c of posixCases) {
    const browser = posixBrowserFromCmd(c.cmd);
    const udd = argValue(c.cmd, "--user-data-dir=");
    // detectProfile 只在识别出浏览器时把缺失的 profileDir 归一为 Default。
    const profile = browser ? argValue(c.cmd, "--profile-directory=") || "Default" : undefined;
    const exe = posixExeFromCmd(c.cmd);
    const excludesOk = (c.excludes || []).every((s) => !String(udd).includes(s));
    const ok =
      browser === c.expect.browser &&
      udd === c.expect.udd &&
      profile === c.expect.profile &&
      excludesOk &&
      (!assertExe || exe === c.expect.exe);
    if (ok) posixPass++;
    console.log(`${ok ? "PASS" : "FAIL"} | ${c.name}`);
    console.log(`   browser=${browser} udd=${udd} profile=${profile} exe=${exe}`);
  }
  console.log(`${posixPass}/${posixCases.length} posix passed`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
process.exit(pass === cases.length && posixPass === posixTotal ? 0 : 1);
