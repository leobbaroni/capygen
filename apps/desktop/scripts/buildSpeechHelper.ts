/** Build-time only. No compiler/runtime downloads and no runtime source compilation. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanEnv } from "@capygen/engine";

export async function buildSpeechHelper(outDir: string): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Local speech helper requires a Windows x64 build and the installed .NET Framework C# compiler.");
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const framework = path.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319");
  const compiler = path.join(framework, "csc.exe");
  const speech = path.join(systemRoot, "Microsoft.NET", "assembly", "GAC_MSIL", "System.Speech", "v4.0_4.0.0.0__31bf3856ad364e35", "System.Speech.dll");
  if (!fs.existsSync(compiler) || !fs.existsSync(speech)) {
    throw new Error("Missing build prerequisite: installed .NET Framework x64 C# compiler and System.Speech assembly. Nothing was downloaded.");
  }
  const source = fileURLToPath(new URL("../src/workspace/speech/SpeechHelper.cs", import.meta.url));
  const directory = path.join(outDir, "speech");
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, "capygen-speech.exe");
  await promisify(execFile)(compiler, [
    "/nologo", "/langversion:5", "/platform:x64", "/target:exe", "/optimize+",
    `/reference:${speech}`, "/reference:System.Web.Extensions.dll", `/out:${output}`, source,
    fileURLToPath(new URL("../src/workspace/speech/AudioCapture.cs", import.meta.url)),
  ], { windowsHide: true, env: cleanEnv(process.env), timeout: 30_000, maxBuffer: 64 * 1024 });
  fs.copyFileSync(fileURLToPath(new URL("../src/workspace/speech/install-whisper.ps1", import.meta.url)), path.join(directory, "install-whisper.ps1"));
  for (const name of ["LICENSE-whisper.cpp.txt", "LICENSE-whisper-model.txt"]) {
    fs.copyFileSync(fileURLToPath(new URL(`../src/workspace/speech/${name}`, import.meta.url)), path.join(directory, name));
  }
  return output;
}
