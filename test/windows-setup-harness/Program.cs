using System.Text.Json;
using Albera.Setup;

// Runs every unit check in-process and prints one JSON document: { checks: [{ name, ok, detail }] }.
// The Node test (test/runtime-windows-setup-unit.test.mjs) turns each check into a subtest.
// `print-gh-args <file> <bundle> <root>` prints the argument list setup gives gh as a JSON array, so the Node test can run a real gh with exactly those arguments.
// `policy <gh-output.json> <sha256>` prints what the attestation policy makes of a gh --format json output file.
internal static partial class Harness
{
    private static readonly List<object> Results = [];

    private sealed class CheckFailed(string message) : Exception(message);

    private static void Assert(bool condition, string detail) { if (!condition) throw new CheckFailed(detail); }

    private static void Equal<T>(T expected, T actual, string what)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new CheckFailed($"{what}: expected {expected}, got {actual}");
    }

    private static void Check(string name, Action body)
    {
        try { body(); Results.Add(new { name, ok = true, detail = "" }); }
        catch (Exception ex) { Results.Add(new { name, ok = false, detail = $"{ex.GetType().Name}: {ex.Message}" }); }
    }

    /// <summary>The check passes when the action throws a SetupRefusal with this code.</summary>
    private static SetupRefusal Refused(string code, Action body)
    {
        try { body(); }
        catch (SetupRefusal refusal)
        {
            Equal(code, refusal.Code, "refusal code (" + refusal.Message + ")");
            return refusal;
        }
        throw new CheckFailed($"expected a refusal {code}, nothing was refused");
    }

    private static int Main(string[] args)
    {
        if (args.Length == 4 && args[0] == "print-gh-args")
        {
            Console.Out.Write(JsonSerializer.Serialize(GhVerifier.BuildArguments(args[1], args[2], args[3])));
            return 0;
        }
        if (args.Length == 3 && args[0] == "policy")
        {
            try { Console.Out.Write(JsonSerializer.Serialize(new { ok = true, facts = AttestationPolicy.Evaluate(File.ReadAllText(args[1]), args[2]) })); }
            catch (SetupRefusal refusal) { Console.Out.Write(JsonSerializer.Serialize(new { ok = false, code = refusal.Code, message = refusal.Message })); }
            return 0;
        }
        EnvironmentChecks();
        PolicyChecks();
        BuildHashesChecks();
        CopyChecks();
        OptionsChecks();
        FlowChecks();
        Console.Out.Write(JsonSerializer.Serialize(new { checks = Results }));
        return 0;
    }
}
