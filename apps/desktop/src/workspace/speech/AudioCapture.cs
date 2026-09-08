// C# 5 / Windows waveIn. Bounded mono PCM held in memory; never writes a recording.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class AudioCapture
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort format, channels;
        public uint samplesPerSecond, bytesPerSecond;
        public ushort blockAlign, bitsPerSample, extraSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WaveHeader
    {
        public IntPtr data;
        public uint length, recorded;
        public UIntPtr user;
        public uint flags, loops;
        public IntPtr next;
        public UIntPtr reserved;
    }
    [DllImport("winmm.dll")] private static extern uint waveInOpen(out IntPtr handle, uint device, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] private static extern uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInClose(IntPtr handle);

    public static void Capture()
    {
        const int chunkSize = 3200; // 100 ms at 16 kHz / signed 16-bit mono
        const int maximumBytes = 25 * 32000;
        var format = new WaveFormat { format = 1, channels = 1, samplesPerSecond = 16000, bytesPerSecond = 32000, blockAlign = 2, bitsPerSample = 16 };
        IntPtr device;
        if (waveInOpen(out device, UInt32.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0) != 0)
            throw new InvalidOperationException("microphone_unavailable");
        uint headerSize = (uint)Marshal.SizeOf(typeof(WaveHeader));
        var headers = new IntPtr[4];
        var buffers = new IntPtr[4];
        var prepared = new bool[4];
        using (var pcm = new MemoryStream())
        {
            try
            {
                for (int i = 0; i < headers.Length; i++)
                {
                    buffers[i] = Marshal.AllocHGlobal(chunkSize);
                    headers[i] = Marshal.AllocHGlobal((int)headerSize);
                    Marshal.StructureToPtr(new WaveHeader { data = buffers[i], length = chunkSize }, headers[i], false);
                    if (waveInPrepareHeader(device, headers[i], headerSize) != 0) throw new InvalidOperationException();
                    prepared[i] = true;
                    if (waveInAddBuffer(device, headers[i], headerSize) != 0) throw new InvalidOperationException();
                }
                if (waveInStart(device) != 0) throw new InvalidOperationException();
                var clock = Stopwatch.StartNew();
                long lastVoice = 0;
                int voicedSamples = 0;
                int next = 0;
                var bytes = new byte[chunkSize];
                while (clock.ElapsedMilliseconds < 25000 && pcm.Length < maximumBytes)
                {
                    var header = (WaveHeader)Marshal.PtrToStructure(headers[next], typeof(WaveHeader));
                    if ((header.flags & 1) == 0) { Thread.Sleep(10); continue; }
                    int count = Math.Min((int)header.recorded, chunkSize) & ~1;
                    count = Math.Min(count, maximumBytes - (int)pcm.Length);
                    Marshal.Copy(buffers[next], bytes, 0, count);
                    double energy = 0;
                    for (int sample = 0; sample < count; sample += 2)
                    {
                        double value = (short)(bytes[sample] | (bytes[sample + 1] << 8)) / 32768.0;
                        energy += value * value;
                    }
                    if (count > 0 && Math.Sqrt(energy / (count / 2)) > 0.008)
                    {
                        lastVoice = clock.ElapsedMilliseconds;
                        voicedSamples += count / 2;
                    }
                    pcm.Write(bytes, 0, count);
                    if ((voicedSamples >= 4000 && clock.ElapsedMilliseconds - lastVoice >= 1500) ||
                        (voicedSamples == 0 && clock.ElapsedMilliseconds >= 10000)) break;
                    if (waveInAddBuffer(device, headers[next], headerSize) != 0) throw new InvalidOperationException();
                    next = (next + 1) % headers.Length;
                }
                if (voicedSamples < 4000) throw new InvalidOperationException("no_speech");
            }
            finally
            {
                waveInReset(device);
                for (int i = 0; i < headers.Length; i++)
                {
                    if (prepared[i]) waveInUnprepareHeader(device, headers[i], headerSize);
                    if (headers[i] != IntPtr.Zero) Marshal.FreeHGlobal(headers[i]);
                    if (buffers[i] != IntPtr.Zero) Marshal.FreeHGlobal(buffers[i]);
                }
                waveInClose(device);
            }
            // The parent keeps stdin open for lifecycle ownership and reads only this WAV.
            using (var output = new BinaryWriter(Console.OpenStandardOutput()))
            {
                output.Write(new byte[] { 82, 73, 70, 70 }); output.Write((int)pcm.Length + 36);
                output.Write(new byte[] { 87, 65, 86, 69, 102, 109, 116, 32 }); output.Write(16);
                output.Write((short)1); output.Write((short)1); output.Write(16000); output.Write(32000);
                output.Write((short)2); output.Write((short)16);
                output.Write(new byte[] { 100, 97, 116, 97 }); output.Write((int)pcm.Length);
                output.Write(pcm.ToArray()); output.Flush();
            }
        }
    }
}
