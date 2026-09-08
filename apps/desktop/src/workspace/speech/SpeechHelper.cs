// C# 5 / .NET Framework, Windows x64. One bounded command per process.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class SpeechHelper
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    private static string ReadBoundedLine()
    {
        StringBuilder line = new StringBuilder();
        for (int i = 0; i <= 4096; i++)
        {
            int c = Console.In.Read();
            if (c < 0) return line.Length == 0 ? null : line.ToString();
            if (c == '\n') return line.ToString().TrimEnd('\r');
            line.Append((char)c);
        }
        throw new InvalidOperationException("input_too_large");
    }
    private static void Emit(object result)
    {
        Console.Out.WriteLine(Json.Serialize(result));
        Console.Out.Flush();
    }
    public static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        try
        {
            string input = ReadBoundedLine();
            if (input == null) return 0;
            Dictionary<string, object> command = Json.Deserialize<Dictionary<string, object>>(input);
            object modeValue;
            if (command == null || !command.TryGetValue("command", out modeValue)) throw new InvalidOperationException();
            string mode = modeValue as string;
            // EOF means the parent closed/crashed. Exit even if device initialization
            // or a recognizer callback is stuck; the OS releases microphone handles.
            Thread parent = new Thread(delegate() {
                try { while (Console.In.Read() >= 0) { } } catch { }
                Environment.Exit(0);
            });
            parent.IsBackground = true;
            parent.Start();
            var installed = SpeechRecognitionEngine.InstalledRecognizers();
            List<string> languages = new List<string>();
            foreach (RecognizerInfo info in installed)
                if (!languages.Contains(info.Culture.Name)) languages.Add(info.Culture.Name);
            if (mode == "availability")
            {
                Emit(new { available = languages.Count > 0, languages = languages.ToArray() });
                return 0;
            }
            object languageValue;
            if (mode != "recognize" || !command.TryGetValue("language", out languageValue)) throw new InvalidOperationException();
            string language = languageValue as string;
            RecognizerInfo selected = null;
            foreach (RecognizerInfo info in installed)
                if (info.Culture.Name == language) { selected = info; break; }
            if (selected == null) { Emit(new { error = "no_recognizer" }); return 0; }
            using (ManualResetEvent completed = new ManualResetEvent(false))
            using (SpeechRecognitionEngine recognizer = new SpeechRecognitionEngine(selected))
            {
                string transcript = "";
                bool failed = false;
                recognizer.LoadGrammar(new DictationGrammar());
                recognizer.InitialSilenceTimeout = TimeSpan.FromSeconds(10);
                recognizer.BabbleTimeout = TimeSpan.FromSeconds(10);
                recognizer.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs args) {
                    if (args.Result != null) transcript = args.Result.Text;
                    failed = args.Error != null;
                    completed.Set();
                };
                recognizer.SetInputToDefaultAudioDevice();
                recognizer.RecognizeAsync(RecognizeMode.Single);
                if (!completed.WaitOne(25000))
                {
                    recognizer.RecognizeAsyncCancel();
                    Emit(new { error = "timeout" });
                }
                else if (failed) Emit(new { error = "recognition_failed" });
                else if (transcript.Length > 16000) Emit(new { error = "output_too_large" });
                else Emit(new { text = transcript });
            }
            return 0;
        }
        catch { Emit(new { error = "unavailable" }); return 0; }
    }
}
