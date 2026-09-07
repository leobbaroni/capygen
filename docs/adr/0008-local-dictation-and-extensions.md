# ADR-0008: Local dictation and isolated extension pages

Date: 2026-09-07. Status: Astra proposal; Opus review and implementation pending.

## Dictation

Use installed Windows System.Speech recognition through an app-owned helper process.
A read-only probe on this machine loaded the framework assembly and enumerated:
```json
{"Id":"MS-2057-80-DESK","Name":"MS-2057-80-DESK","Culture":"en-GB"}
```
No microphone was opened and no audio was recorded. This proves an installed recognizer,
not dictation accuracy or microphone access. The probe used PowerShell -NoProfile and
InstalledRecognizers(); no installation or personal backend configuration was involved.
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
