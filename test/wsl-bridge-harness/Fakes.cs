using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

internal enum AgentMode { Normal, Oversize, Hang, Die, HugeRead }

/// <summary>A stand-in for albera-agent behind two anonymous pipes. It speaks the agent's frames (agent.c) and can misbehave the way a taken-over agent could.</summary>
internal sealed class FakeAgent : IAgentProcess
{
    private readonly AnonymousPipeServerStream _toAgentWriter = new(PipeDirection.Out), _fromAgentWriter = new(PipeDirection.Out);
    private readonly AnonymousPipeClientStream _toAgentReader, _fromAgentReader;
    private readonly string _head;
    public readonly List<(byte Op, byte[] Body)> Requests = [];
    public readonly Dictionary<string, byte[]> Files = [];
    public AgentMode Mode;
    public volatile bool Killed;

    public FakeAgent(string head, AgentMode mode)
    {
        _head = head;
        Mode = mode;
        _toAgentReader = new AnonymousPipeClientStream(PipeDirection.In, _toAgentWriter.ClientSafePipeHandle);
        _fromAgentReader = new AnonymousPipeClientStream(PipeDirection.In, _fromAgentWriter.ClientSafePipeHandle);
        _ = Task.Run(Loop);
    }

    public Stream ToAgent => _toAgentWriter;
    public Stream FromAgent => _fromAgentReader;
    public bool HasExited => Killed;

    public void Kill()
    {
        Killed = true;
        foreach (IDisposable stream in new IDisposable[] { _toAgentWriter, _fromAgentWriter })
            try { stream.Dispose(); } catch (Exception ex) when (ex is IOException or ObjectDisposedException) { }
    }

    public void Dispose() => Kill();

    private void Loop()
    {
        try
        {
            while (!Killed)
            {
                byte[] header = ReadExactly(4);
                byte[] body = ReadExactly((int)BinaryPrimitives.ReadUInt32BigEndian(header));
                lock (Requests) Requests.Add((body[0], body[1..]));
                if (Mode == AgentMode.Hang) { Thread.Sleep(Timeout.Infinite); }
                if (Mode == AgentMode.Die) { Kill(); return; }
                Answer(body[0], body[1..]);
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or EndOfStreamException or InvalidOperationException) { /* killed */ }
    }

    private byte[] ReadExactly(int count)
    {
        byte[] buffer = new byte[count];
        int got = 0;
        while (got < count)
        {
            int n = _toAgentReader.Read(buffer, got, count - got);
            if (n <= 0) throw new EndOfStreamException();
            got += n;
        }
        return buffer;
    }

    private void Send(byte status, params byte[][] parts)
    {
        int size = 1 + parts.Sum(part => part.Length);
        if (Mode == AgentMode.Oversize) size = int.MaxValue; // a length no honest agent would send; the bridge must refuse it before it allocates
        byte[] frame = new byte[4 + 1 + parts.Sum(part => part.Length)];
        BinaryPrimitives.WriteUInt32BigEndian(frame, (uint)size);
        frame[4] = status;
        int at = 5;
        foreach (byte[] part in parts) { part.CopyTo(frame, at); at += part.Length; }
        _fromAgentWriter.Write(frame);
        _fromAgentWriter.Flush();
    }

    private static byte[] I32(int value) { byte[] bytes = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(bytes, value); return bytes; }

    private void Answer(byte op, byte[] body)
    {
        switch (op)
        {
            case 1: // run: u32 seconds, command
                string command = Encoding.UTF8.GetString(body[4..]);
                Send(0, I32(0), [0], Encoding.ASCII.GetBytes(command.Contains("rev-parse") ? _head + "\n" : "ok"));
                break;
            case 2: // read
                string readPath = Encoding.UTF8.GetString(body);
                if (Mode == AgentMode.HugeRead) Send(0, new byte[4096]);
                else if (Files.TryGetValue(readPath, out byte[]? data)) Send(0, data);
                else Send(3);
                break;
            case 3: // write: u32 path length, path, data
                int pathLength = (int)BinaryPrimitives.ReadUInt32BigEndian(body);
                Files[Encoding.UTF8.GetString(body, 4, pathLength)] = body[(4 + pathLength)..];
                Send(0);
                break;
            default: Send(1); break;
        }
    }
}

/// <summary>Records every call the bridge makes to wsl.exe.</summary>
internal sealed class FakeHost : IWslHost
{
    public readonly List<string> Calls = [];
    public WslVersions? Versions = new(new Version(2, 6, 3, 0), new Version(6, 6, 87, 2));
    public bool ImportOk = true, UnregisterOk = true;
    public List<string> Existing = [];
    public string Head = new('a', 40);
    public AgentMode Mode = AgentMode.Normal;
    public readonly List<FakeAgent> Agents = [];

    public WslVersions? ReadVersions() { Lock("version"); return Versions; }
    public IReadOnlyList<string>? ListDistributions() { Lock("list"); return Existing.ToList(); }
    public bool Import(string name, string folder, string imagePath) { Lock("import:" + name); return ImportOk; }
    public void Terminate(string name) => Lock("terminate:" + name);
    public bool Unregister(string name) { Lock("unregister:" + name); return UnregisterOk; }

    public IAgentProcess? StartAgent(string name)
    {
        Lock("agent:" + name);
        FakeAgent agent = new(Head, Mode);
        lock (Agents) Agents.Add(agent);
        return agent;
    }

    private void Lock(string call) { lock (Calls) Calls.Add(call); }
    public int Count(string prefix) { lock (Calls) return Calls.Count(call => call.StartsWith(prefix, StringComparison.Ordinal)); }
    public FakeAgent LastAgent { get { lock (Agents) return Agents[^1]; } }
}

internal sealed class FakeRepositories : IRepositories
{
    public string? Head = new('a', 40);
    public Func<string, byte[]?>? Bundle;
    public int HeadReads;
    public string? ReadHead(string repositoryPath) { HeadReads++; return Head; }
    public byte[]? MakeBundle(string repositoryPath, int maxBytes) => Bundle is not null ? Bundle(Head ?? "") : BundleOf(Head ?? new string('a', 40));
    public static byte[] BundleOf(string oid) => Encoding.ASCII.GetBytes($"# v2 git bundle\n{oid} HEAD\n\nPACKfake");
}
