#!/usr/bin/env node
// Current-user startup only. No administrator rights, credentials, or public ports.
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if (!["enable", "disable", "status"].includes(action)) {
  console.log("Usage: node scripts/windows-autostart.mjs enable|disable|status");
  process.exit(action ? 1 : 0);
}
if (process.platform !== "win32")
  throw Error("This startup installer runs on the Windows PC only.");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "scripts", "windows-background.mjs");
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const argument = '"' + runner + '"';
const command = `
$ErrorActionPreference='Stop'
$startup=[Environment]::GetFolderPath('Startup')
$path=Join-Path $startup 'OmniPaperBot.lnk'
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $path) {
  $existing=$shell.CreateShortcut($path)
  if($existing.TargetPath -ne ${quote(process.execPath)} -or $existing.Arguments -ne ${quote(argument)}) {throw 'Omni startup belongs to another installation. Disable it there first.'}
}
${
  action === "enable"
    ? `
$shortcut=$shell.CreateShortcut($path)
$shortcut.TargetPath=${quote(process.execPath)}
$shortcut.Arguments=${quote(argument)}
$shortcut.WorkingDirectory=${quote(root)}
$shortcut.Description='Omni local paper collector. No real-money execution.'
$shortcut.WindowStyle=7
$shortcut.Save()
Write-Output 'Omni current-user startup enabled. The collector starts after Windows sign-in.'
`
    : action === "disable"
      ? `
if(Test-Path -LiteralPath $path) {Remove-Item -LiteralPath $path}
Write-Output 'Omni startup disabled. Running containers are unchanged; use Pause-Collection to stop the paper worker.'
`
      : `
if(Test-Path -LiteralPath $path) {Write-Output 'Omni startup: enabled for this Windows user'} else {Write-Output 'Omni startup: disabled'}
`
}
`;
const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (action === "enable") {
  const child = spawn(process.execPath, [runner], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log(
    "Starting the paper installation in the background. Progress: logs/omni-autostart.log",
  );
}
