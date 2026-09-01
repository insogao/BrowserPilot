// 单测 profile.js 的解析函数。
import { argValue, exeFromCmd, browserFromCmd } from "./profile.js";

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
process.exit(pass === cases.length ? 0 : 1);
