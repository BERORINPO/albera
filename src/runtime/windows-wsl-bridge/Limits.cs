namespace Albera.WslBridge;

// Sizes and times the bridge enforces itself. A job can take over the agent (ADR-012, "The WSL bridge"), so nothing here is read from the agent's own limits: the agent's answers are cut off by
// these numbers before they are buffered. The honest agent stays inside them (its output cap is 1 MiB, its frames 256 MiB).
internal sealed record Limits(int MaxPutBytes, int MaxGetBytes, int MaxOutputBytes, int MaxBundleBytes, int MaxCommandBytes, int MaxPathBytes, int MaxRuns,
    int MaxExecSeconds, TimeSpan AgentGrace, TimeSpan ExpiryGrace, TimeSpan EndWait, TimeSpan ReadFrame, TimeSpan BeginCall)
{
    private const int MiB = 1024 * 1024;

    public static readonly Limits Default = new(MaxPutBytes: 16 * MiB, MaxGetBytes: 16 * MiB, MaxOutputBytes: MiB, MaxBundleBytes: 64 * MiB, MaxCommandBytes: 64 * 1024, MaxPathBytes: 512,
        MaxRuns: 2, MaxExecSeconds: 3600, AgentGrace: TimeSpan.FromSeconds(30), ExpiryGrace: TimeSpan.FromSeconds(3), EndWait: TimeSpan.FromSeconds(5), ReadFrame: TimeSpan.FromSeconds(10), BeginCall: TimeSpan.FromSeconds(120));

    /// <summary>The largest request frame: a put of the largest size, its path and the header fields.</summary>
    public int MaxRequestFrame => MaxPutBytes + MaxPathBytes + 1024;
}
