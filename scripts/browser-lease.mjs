import { spawn } from "node:child_process";
import path from "node:path";
import {
  DEFAULT_BROWSER_LEASE_TTL_MS,
  acquireBrowserLease,
  browserLeasePath,
  isBrowserLeaseActive,
  readBrowserLease,
  releaseBrowserLease,
} from "./browser-lease-lib.mjs";

function printStatus() {
  const lease = readBrowserLease();
  if (!isBrowserLeaseActive(lease)) {
    console.log(JSON.stringify({ active: false, path: browserLeasePath }, null, 2));
    return;
  }
  const { token: _secret, ...publicLease } = lease;
  console.log(JSON.stringify({ active: true, path: browserLeasePath, ...publicLease, remainingMs: Number(lease.expiresAt) - Date.now() }, null, 2));
}

function usage() {
  console.error([
    "Usage:",
    "  node scripts/browser-lease.mjs status",
    "  node scripts/browser-lease.mjs client <owner> <scope> <command> [args-json]",
    "  node scripts/browser-lease.mjs run <owner> <scope> [ttlSeconds] -- <command> [args...]",
  ].join("\n"));
}

const [mode, owner, scope, maybeTtl, sep, ...rest] = process.argv.slice(2);

function launchWithLease(lease, cmd, args) {
  let child;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseBrowserLease(lease.token);
  };
  try {
    child = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        BROWSERPILOT_BROWSER_LEASE_TOKEN: lease.token,
        BROWSERPILOT_AGENT_ID: lease.owner,
      },
    });
  } catch (error) {
    release();
    throw error;
  }
  process.on("exit", release);
  process.on("SIGINT", () => { release(); child.kill("SIGINT"); });
  process.on("SIGTERM", () => { release(); child.kill("SIGTERM"); });
  child.on("exit", (code, signal) => {
    release();
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  child.on("error", (error) => {
    release();
    console.error(error.message);
    process.exitCode = 1;
  });
}

try {
  if (mode === "status") {
    printStatus();
    process.exit(0);
  }
  if (mode === "client") {
    const commandName = maybeTtl;
    if (!commandName) {
      usage();
      process.exit(2);
    }
    const lease = acquireBrowserLease(owner || "client", scope || "unspecified");
    const clientArgs = [
      path.join(process.cwd(), "native-host", "client.mjs"),
      commandName,
      sep || "{}",
      "--no-launch",
    ];
    launchWithLease(lease, process.execPath, clientArgs);
  } else if (mode === "run") {
    const ttlMs = maybeTtl && maybeTtl !== "--" ? Number(maybeTtl) * 1000 : DEFAULT_BROWSER_LEASE_TTL_MS;
    const commandArgs = maybeTtl === "--" ? [sep, ...rest] : sep === "--" ? rest : [];
    if (!commandArgs.length || !commandArgs[0]) {
      usage();
      process.exit(2);
    }
    const lease = acquireBrowserLease(owner || "runner", scope || "unspecified", ttlMs);
    const [cmd, ...args] = commandArgs;
    if (process.platform === "win32" && /^npm(?:\.cmd)?$/i.test(cmd) && args[0] === "run" && args[1] === "client") {
      const separator = args.indexOf("--");
      const forwarded = separator >= 0 ? args.slice(separator + 1) : args.slice(2);
      launchWithLease(lease, process.execPath, [path.join(process.cwd(), "native-host", "client.mjs"), ...forwarded]);
    } else if (process.platform === "win32" && /^(npm|npx|pnpm|yarn)(?:\.cmd)?$/i.test(cmd)) {
      releaseBrowserLease(lease.token);
      throw new Error("Windows 下 browser:lease run 仅支持 npm run client；其他浏览器命令请使用 browser:lease client 模式");
    } else {
      launchWithLease(lease, cmd, args);
    }
  } else {
    usage();
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
