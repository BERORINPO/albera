using System.Buffers.Binary;
using System.Text;

namespace Albera.WslBridge;

internal sealed class AgentFailure(string reason) : Exception(reason)
{
    public string Reason { get; } = reason;
}

/// <summary>The agent's answer: its status byte and the rest. Status 0 is ok.</summary>
internal sealed record AgentReply(byte Status, byte[] Body);

// Talks to albera-agent over the process's pipes (frames as in agent.c). The agent is inside the job's reach, so every length it sends is checked against the bridge's own cap BEFORE a buffer is
// made, every wait has a deadline, and any breach ends the link with an AgentFailure (the caller then ends the run). Nothing here trusts what the agent says about its own limits.
internal sealed class AgentLink(IAgentProcess process)
{
    public const byte OpRun = 1, OpRead = 2, OpWrite = 3, OpBundle = 4;

    /// <summary>`git -C path bundle create - --all` in the sandbox, as the job user (agent.c do_bundle). The job supplies nothing: the path is the bridge's own.</summary>

    public static byte[] RunRequest(uint seconds, string command) => Request(OpRun, U32(seconds), Encoding.UTF8.GetBytes(command));
    public static byte[] BundleRequest(uint seconds, string path) => Request(OpBundle, U32(seconds), Encoding.UTF8.GetBytes(path));
    public static byte[] ReadRequest(string path) => Request(OpRead, Encoding.UTF8.GetBytes(path));
    public static byte[] WriteRequest(string path, ReadOnlySpan<byte> data)
    {
        byte[] name = Encoding.UTF8.GetBytes(path);
        return Request(OpWrite, U32((uint)name.Length), name, data.ToArray());
    }

    private static byte[] U32(uint value) { byte[] bytes = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(bytes, value); return bytes; }

    private static byte[] Request(byte op, params byte[][] parts)
    {
        int size = 1 + parts.Sum(part => part.Length);
        byte[] bytes = new byte[4 + size];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)size);
        bytes[4] = op;
        int at = 5;
        foreach (byte[] part in parts) { part.CopyTo(bytes, at); at += part.Length; }
        return bytes;
    }

    /// <summary>Sends one request and waits for its answer, at most <paramref name="timeout"/> and at most <paramref name="maxBody"/> bytes of body.</summary>
    public async Task<AgentReply> CallAsync(byte[] request, int maxBody, TimeSpan timeout, string oversizeReason = Reason.AgentLimit)
    {
        using CancellationTokenSource deadline = new(timeout);
        using CancellationTokenRegistration killOnDeadline = deadline.Token.Register(process.Kill); // a blocked pipe call may not honour the token, but it ends when the process does
        try
        {
            await process.ToAgent.WriteAsync(request, deadline.Token);
            await process.ToAgent.FlushAsync(deadline.Token);
            byte[] header = await ReadExactlyAsync(4, deadline.Token);
            uint length = BinaryPrimitives.ReadUInt32BigEndian(header);
            if (length == 0 || length > (uint)maxBody + 1) throw new AgentFailure(oversizeReason); // refused from the header: the body is never read, so never a part of one
            byte[] payload = await ReadExactlyAsync((int)length, deadline.Token);
            return new AgentReply(payload[0], payload[1..]);
        }
        catch (OperationCanceledException) { process.Kill(); throw new AgentFailure(Reason.AgentTimeout); }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { throw new AgentFailure(deadline.IsCancellationRequested ? Reason.AgentTimeout : Reason.AgentGone); } // the deadline kills the process, so the pipe error that follows is still a timeout
    }

    private async Task<byte[]> ReadExactlyAsync(int count, CancellationToken cancel)
    {
        byte[] buffer = new byte[count];
        int got = 0;
        while (got < count)
        {
            int n = await process.FromAgent.ReadAsync(buffer.AsMemory(got), cancel);
            if (n <= 0) throw new AgentFailure(cancel.IsCancellationRequested ? Reason.AgentTimeout : Reason.AgentGone);
            got += n;
        }
        return buffer;
    }
}
