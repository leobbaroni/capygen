# ADR-0008: Local dictation and isolated extension pages

Date: 2026-09-07. Status: Implemented; Phase 10 accepted 2026-09-09 after the user confirmed the revised microphone path.

## 2026-09-08 dictation revision

The user reported that Windows Speech did not understand ordinary speech. The fallback
evaluation below is activated: explicitly installed whisper.cpp b4938 / 1.9.3 with the
multilingual small-q5_1 model, pinned hashes and roughly 199 MB download. Installation uses
the native confirmation and visible-console gate. Availability never records or downloads.
The Windows Speech decision below is historical; there is no cloud fallback.

The compiled helper captures 16 kHz mono PCM16 through WinMM in memory, waits for a 1.5-second
pause after voice, and caps capture at 25 seconds. Parent EOF, main cancellation and timeouts
own subprocess lifetime. PCM travels by pipe to Whisper; no recording file or renderer audio
payload is created. The model chooses the language and text enters the draft without sending.
Lifecycle/setup/UI tests and the full automated gate pass. A generated 5.13-second instruction
transcribed exactly in 4.64 seconds at twelve threads, versus 7.68 seconds at the native default
four. The user separately confirmed real microphone transcription works. Request-scoped
progress displays a spinning Transcribing locally status with Cancel still active.

## Historical Windows Speech decision

Use installed Windows System.Speech recognition through an app-owned helper process.
A read-only probe on this machine loaded the framework assembly and enumerated:
```json
{"Id":"MS-2057-80-DESK","Name":"MS-2057-80-DESK","Culture":"en-GB"}
```
No microphone was opened by this capability probe. A subsequent owned WAV fixture used
System.Speech.Synthesis output redirected to a temporary file, then DictationGrammar with
SetInputToWaveFile. It recognized "The project is ready for review" at confidence 0.54163307;
the temporary file was deleted after disposal. Evidence: e2e-out/phase10-speech-audio-proof.log.
This proves one synthetic file-input recognition path, not human dictation accuracy or
microphone access. The probe used PowerShell -NoProfile and
InstalledRecognizers(); no installation or personal backend configuration was involved.
The log path is a transient local artifact; the result quoted above is the tracked record.
Microsoft documents [installed recognizers and recognition lifecycle](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine?view=netframework-4.8.1)
and [default audio input](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.setinputtodefaultaudiodevice?view=netframework-4.8.1).

The helper lists actual installed languages. A missing language/recognizer is an explicit
unavailable state; do not silently choose another language or download a runtime. This
choice avoids adding a Whisper executable/model to the installer. Reconsider if actual
free-dictation testing cannot satisfy the composer requirement. No cloud speech fallback.

An explicit microphone click starts one bounded recording owned by that window/composer.
Show listening status and stop/cancel controls; closing the window, navigating away or
cancelling stops the helper and ignores stale callbacks. Transcribed text enters the draft
only; it never submits a prompt. Main validates bounded structured helper output and maps
permission denied/no device/no recognizer/timeout to actionable UI states. Do not interpolate
user text/language IDs into shell commands. No audio/transcript logging or persisted recording.
Microphone access starts only after the explicit action; metadata probing never opens it.

Acceptance needs lifecycle fixtures, an owned audio-file recognition proof, and actual
Windows microphone dictation into the composer. Synthetic text events alone are insufficient.

### Review decisions

Compile an app-owned helper at build time for the initial Windows x64 target using the
installed .NET Framework compiler. Pin C# 5 (`/langversion:5`) and compile the real helper in
CI; a missing compiler is a visible build prerequisite failure, never a silent omission or
download. Package the executable so runtime does not depend on PowerShell or runtime source
compilation. Other architecture support requires its own build/runtime proof. Phase 12 owns
the helper's packaged hash and the same signing policy as the app (unsigned builds are
currently accepted); do not imply that installer signing signs its contained executable.

Use UTF-8 newline-delimited JSON with explicit input/output encoding, bounded line sizes and
fixed command names. Spawn without a shell and with `windowsHide` and the cleaned environment.
Language identifiers must come from the enumerated recognizers. The helper exits when stdin
closes, including after a parent crash; main also stops it during app shutdown. No microphone
is opened during availability discovery. Show the installed language and unavailable state
before recording, including in prerequisites.

Only display specific device/permission failures when the observed runtime result supports
them. Silence/timeouts say that no speech was recognized and point to microphone selection
and Windows desktop-app privacy settings; do not claim to distinguish a privacy block from
silence without evidence. The earlier distinct-error list is a UI goal, not a proved SAPI
capability.

Real microphone acceptance remains user-observed: a short ordinary instruction and a short
technical instruction must land as editable composer text without sending. The user judges
whether correcting the draft is preferable to retyping it. The synthesized fixture does not
meet that bar. If it fails, evaluate an explicitly installed local recognizer such as
whisper.cpp with its actual runtime/model footprint; there is no silent cloud fallback.

## Extensions

The initial contract is an offline, read-only local extension page with a versioned manifest,
identifier, display label and entry HTML under its selected directory. It is not a Node or
preload plugin. Use an isolated sandboxed view with its own partition and no capygen bridge;
no host tool execution, arbitrary navigation, popups, network, file traversal or permissions.
Reuse the existing sandbox/window lifecycle utilities where their boundary is appropriate,
without granting the MCP widget tool bridge to an extension by implication.

Manifest resolution and entry loading must stay within the selected directory (including
symlinks/junctions); escape paths are refused. Include a bundled sample with no permissions.
The page exposes only extension metadata and a Close action in the trusted host UI. A future
capability API needs a separate reviewed contract. Loading the sample and hostile-page tests
must prove isolation, denied navigation/permissions, and cleanup before Phase 10 acceptance.

Use a separate `capygen-extension` protocol and non-persistent sandbox partition. Do not
loosen BrowserViewService's browser URL rules, load file URLs, or inherit the widget host's
tool bridge. Serve a restrictive CSP header and block requests outside the extension's
authorized origin; test fetch/image requests as well as navigation, popups and permission
requests. Bound and validate manifest fields, namespace identifiers, and check realpath
confinement on every served asset. A selected directory may change after manifest discovery.

### P20 capability inventory

The reference's browser extension contract has more than a read-only page: namespaced pages
and navigation, theme, quota-bound namespaced storage, and explicitly granted session/project
services (`reference/omnigent/docs/extending/browser_extensions.md` and its services registry).
The initial isolated sample was only the first implementation slice. The subsequent capability
mapping is recorded in [phase10-extension-parity.md](../plans/phase10-extension-parity.md),
with explicit local grants, namespace storage and bounded session/project services. Native
storage/reopen/theme/network-denial and packaged assets now pass. These are local packages;
no compatibility with arbitrary Python-distributed reference plugins is claimed.
