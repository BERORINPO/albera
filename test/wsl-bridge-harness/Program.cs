using System.Text.Json;

namespace Albera.WslBridge.Harness;

// Runs every check in-process and prints one JSON document: { checks: [{ name, ok, detail }] }. test/runtime-wsl-bridge.test.mjs turns each check into a subtest.
// Optional argument: a probe file (a lease signed by the Node twin) for the interop check.
internal static partial class Harness
{
    private static readonly List<object> Results = [];
    private static readonly HashSet<string> Names = [];

    private sealed class CheckFailed(string message) : Exception(message);

    internal static void Assert(bool condition, string detail) { if (!condition) throw new CheckFailed(detail); }
    internal static void Same(string expected, string actual, string what) => Assert(expected == actual, $"{what}: expected '{expected}' but got '{actual}'");

    internal static void Check(string name, Action body)
    {
        if (!Names.Add(name)) throw new InvalidOperationException("duplicate check name " + name);
        try { body(); Results.Add(new { name, ok = true, detail = "" }); }
        catch (Exception ex) { Results.Add(new { name, ok = false, detail = $"{ex.GetType().Name}: {ex.Message}" }); }
    }

    /// <summary>The refusal word of a reply that must be a refusal.</summary>
    internal static string Refused(Reply reply) { Assert(!reply.Ok, "expected a refusal but the reply was ok"); return reply.Reason; }

    public static int Main(string[] args)
    {
        LeaseChecks();
        RunChecks();
        HostChecks();
        ConfigChecks();
        PipeChecks();
        if (args.Length > 0) { NodeProbe(args[0]); NodeWireProbe(args[0]); }
        ClosingChecks(); // last: reads what every earlier check logged
        Console.WriteLine(JsonSerializer.Serialize(new { checks = Results }));
        return 0;
    }
}
