# Native Windows paper operation

`Run-Omni-Native.cmd start` starts a hidden, current-user Node supervisor for the local Omni web app, its paper worker, PHANTOM and the PHANTOM monitor. It reuses the existing dedicated PostgreSQL cluster. Docker launchers remain available and unchanged; do not start both stacks on the same ports.

This setup uses new Windows paper books and local research data. It does not copy, replace or migrate your Mac's database. It does not fund wallets or perform real swaps. It is a local development server, not a certified production deployment.

## Prerequisites

- Windows and Node.js 24 or newer. The command file can use the bundled Codex Node runtime when Node is absent from PATH.
- Installed root and `packages/phantom` dependencies. Startup does not install or download software.
- The already initialized cluster at the sibling `../postgres-validation-runtime/cluster`, with PostgreSQL at `../postgres-validation-runtime/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe`.
- Existing private `.env.native` at the repository root, pointing to the isolated loopback database on port 55432, and existing private `packages/phantom/.env`. Keep their current-user-only permissions. Credentials remain in the server process environment and are never placed in shortcut arguments or state files.
- All execution-mode settings must be `PAPER`. Startup refuses non-paper settings.

Missing prerequisites produce an error. The launcher never initializes or replaces a cluster, drops data, changes the Mac, requests administrator access, changes execution policy, reboots or signs out.

## Commands

```bat
Run-Omni-Native.cmd start
Run-Omni-Native.cmd status
Run-Omni-Native.cmd autostart-enable
Run-Omni-Native.cmd autostart-disable
```

`start` requires authenticated PostgreSQL readiness, a loopback Omni paper API, three initialized paper books with a fresh worker heartbeat, a PHANTOM paper API matching the checkout's source fingerprint, and the PHANTOM monitor. Provider degradation remains visible; a responding process is not proof of complete data coverage or profitability.

Open [Omni](http://127.0.0.1:8080) or the [PHANTOM monitor](http://127.0.0.1:8791). PostgreSQL binds only loopback port 55432; PHANTOM's local API uses 8790. The web server uses Vite development mode for the current Omni bridge and HMR, and its worker health listener is disabled with `PORT=0`.

The launcher records process IDs, creation times and command hashes under ignored `data/native/`. It trusts a managed process only when those values and its absolute workspace command match. A conflicting port or unowned worker is left untouched and startup reports that a handoff is needed. Previously started terminal processes should be stopped through their original terminals by their owner before the first native handoff. Do not kill a process merely because it uses one of these ports.

The supervisor retries crashed services with a bounded delay, and uses one process-verified launcher lease. A matching owned process with degraded provider data is not repeatedly killed. Unknown processes are never terminated. Keep the PC awake and connected; closing Codex does not stop independently launched native services. Windows sleep, shutdown and sign-out still stop local work.

## Optional sign-in startup

`autostart-enable` first checks the concrete running stack, then creates one uniquely named shortcut in the **current user's Startup folder**. Its hidden WScript helper invokes the saved absolute Node executable and launcher paths. No passwords, API keys, policy bypasses, scheduled tasks, administrator registration or system-wide startup settings are added.

`autostart-disable` verifies that the shortcut belongs to this workspace before removing it. It leaves running services and stored data alone. Startup runs only after this user signs in, not before sign-in. Moving the repository or removing the bundled Node runtime requires disabling the old shortcut and enabling it again from the new location.

## Logs and troubleshooting

Redacted, rotated logs and non-secret process metadata live under ignored `data/native/`. Each log retains at most the active file and two approximately 1 MiB archives. URLs and configured secret values are redacted before writing. Avoid sharing raw environment files or database directories.

If a source fingerprint differs, review the running copy and use its original owner/session to stop it before launching the updated copy. If worker readiness is pending after a handoff, allow the old writer lease to expire and a fresh tick to finish. Never bypass the database lease or the risk governor to make a readiness check pass.

## Verification on this Windows installation

On 2026-10-26, all eight launcher regression tests passed, including real Node child-process checks for both TypeScript loaders. Native readiness verified every service, its identity and loopback binding. A controlled stop of the positively identified project PostgreSQL cluster, with every book flat, verified that the supervisor started the existing cluster again and recovered the web and paper worker without initializing or replacing data. Paper cash, balances and the existing paper-only payout policy were retained.

Current-user sign-in startup was enabled after those readiness checks. Invoking the actual installed shortcut reused the same supervisor and service process IDs. An actual future sign-in, reboot and full machine recovery remain untested; no logout or reboot was performed. The monitor's upstream interruption and recovery were also inspected through the native Windows browser, including explicit last-snapshot labeling and separate SOL and USDC paper accounts.

Run the focused launcher checks with `node --test scripts/native-windows.test.mjs`. These checks establish the tested local startup path, not production execution certification or strategy profitability.
