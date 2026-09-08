/** Owned synthetic audio proof, never a microphone recording or automatic download. */
import { execFileSync } from "node:child_process";
import { cleanEnv } from "../packages/engine/src/env.js";
import { speechProcess, transcribeWav, whisperInstalled, whisperPaths } from "../apps/desktop/src/workspace/WhisperDictation.js";

const directory = process.argv[2];
if (!directory || !whisperInstalled(directory)) throw new Error("Pass an explicitly installed isolated Whisper runtime directory.");
const sentence = "Open the project, run the tests, and summarize the failures.";
const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$stream = New-Object System.IO.MemoryStream
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToAudioStream($stream, $format)
  $synth.Speak('${sentence}')
  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally { $synth.Dispose(); $stream.Dispose() }
`;
const pcm = Buffer.from(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { env: cleanEnv(process.env), windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }).trim(), "base64");
const wav = Buffer.alloc(44 + pcm.length);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
const start = performance.now();
try {
  const threads = process.argv[3];
  if (threads && !/^(2|4|6|8|12)$/.test(threads)) throw new Error("Choose a bounded thread count");
  const files = whisperPaths(directory);
  const text = threads ? (await speechProcess(files.executable, ["-m", files.model, "-l", "auto", "-nt", "-np", "-ng", "-sns", "-t", threads, "-f", "-", "-of", "capygen-stdout"], wav, new AbortController().signal, { timeout: 120000, maxOutput: 65536 })).toString("utf8").trim() : await transcribeWav(directory, wav, new AbortController().signal);
  const passed = ["open", "project", "run", "tests", "summarize", "failures"].every(word => text.toLowerCase().includes(word));
  console.log(JSON.stringify({ input: sentence, output: text, threads: threads ?? "default", audioSeconds: pcm.length / 32000, inferenceSeconds: (performance.now() - start) / 1000, passed, microphoneOpened: false }));
  if (!passed) process.exitCode = 1;
} finally { pcm.fill(0); wav.fill(0); }
