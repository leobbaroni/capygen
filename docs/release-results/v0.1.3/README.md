# v0.1.3 acceptance — 2026-09-09

All planned phases, including 9C and 12, are accepted. The private
[release](https://github.com/leobbaroni/capygen/releases/tag/v0.1.3) is built from
`c4e18af542f83ca94960d43760bd9fc9e9663146`. Installer verification code is at
`1502946699e47d870dd8c373715030a1fedc9d55`; it does not change the application.

| Check | Result | Evidence |
|---|---|---|
| Clean candidate gate | Types, 2920 unit tests, Windows build/audit, 56 native tests, 2 packaged tests passed | [CI 34358643906](https://github.com/leobbaroni/capygen/actions/runs/34358643906) |
| Tag publication gate | Same full gate passed, including the real Electron updater transport regression; four private assets published | [Release CI 34362025359](https://github.com/leobbaroni/capygen/actions/runs/34362025359) |
| Actual older-build update discovery | Preserved packaged 0.1.2 found private 0.1.3; no download/install invoked; temporary credential deleted | [private-update.json](private-update.json) |
| Exact published installer | SHA256 matched the published audit; install and uninstall passed on hosted Windows | [Installed CI 34364630748](https://github.com/leobbaroni/capygen/actions/runs/34364630748), [installed-smoke.json](installed-smoke.json) |
| Installed runtime | Spaces/Unicode path, 2946ms focused launch (<=3000ms), real terminal/native browser, tray/reveal, SQLite restart, isolated homes | [installed-runtime.json](installed-runtime.json) |
| Data preservation | Four owned app/backend/project file hashes unchanged after uninstall; installed EXE and registry entry removed | [installed-smoke.json](installed-smoke.json) |
| Package identity | Unsigned status, source revision, installer/portable checksums, font/notices/runtime audits | [artifact-audit.json](artifact-audit.json) |

The unit gate skipped seven tests and the native gate skipped twelve credential-dependent
tests; these are not live passes. Provider/connector coverage limits remain in
[PARITY.md](../../PARITY.md). The local Node 22 and 24 diagnostic suites each passed
2923 tests with four skipped. An intermittent CI Vitest worker RPC timeout did not recur
in either final full gate; its underlying hosted-runner cause is not claimed fixed.

Versions 0.1.0 and 0.1.1 contain the broken updater transport and must be manually replaced
from GitHub while retaining user data. Version 0.1.2 was an unpublished corrected baseline,
built before 0.1.3. The successful forward-discovery check does not imply that 0.1.1 can
repair itself. No installer was executed on the user's machine.

An earlier hosted installation check used the candidate build of the same commit and
passed at 2620ms, but its installer checksum differed. Final acceptance above uses the
exact published installer checksum instead. Two clean different-model updater reviews,
the installed-harness review, and the acceptance history are recorded in [PROJECT_LOG.md](../../../PROJECT_LOG.md).
