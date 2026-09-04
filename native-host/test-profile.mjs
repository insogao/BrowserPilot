// 单测 profile.js 的解析函数。
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

// macOS/Linux 解析用例：纯字符串，不伪造进程或 .app 包。
// exe 断言要求路径真实存在（posixExeFromCmd 的安全检查），故仅在装了真 Chrome 的 mac 上校验 exe。
const posixCases = [
  {
    name: "mac chrome with profile flag",
    cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory="Profile 2" --type=renderer',
    expect: { browser: "chrome", profile: "Profile 2", exe: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  {
    name: "mac chrome with positional arg before flags",
    cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome 30 --profile-directory=Default",
    expect: { browser: "chrome", profile: "Default", exe: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  {
    name: "mac command is not a browser",
    cmd: "/usr/libexec/syslogd",
    expect: { browser: undefined, profile: undefined, exe: undefined },
  },
];

let posixPass = 0;
for (const c of posixCases) {
  const browser = posixBrowserFromCmd(c.cmd);
  const profile = argValue(c.cmd, "--profile-directory=");
  const exe = posixExeFromCmd(c.cmd);
  const exeExpected = process.platform === "darwin" ? c.expect.exe : undefined;
  const exeActual = process.platform === "darwin" ? exe : undefined;
  const ok = browser === c.expect.browser && profile === c.expect.profile && exeActual === exeExpected;
  if (ok) posixPass++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${c.name}`);
  console.log(`   browser=${browser} profile=${profile} exe=${exe}`);
}
console.log(`${posixPass}/${posixCases.length} posix passed`);
process.exit(pass === cases.length && posixPass === posixCases.length ? 0 : 1);
