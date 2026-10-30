#if ALBERA_APPROVER_TEST_FAULTS
using System.Security.Cryptography;

namespace Albera.Approver;

// Test-only (compiled in only with -p:AlberaApproverTestFaults=true; the published build pins that off, so none of this exists there). A test-faults build does not even
// contain the Windows Hello code (WindowsHello.cs is removed from it), so no test can reach the real KeyCredentialManager. This file replaces Hello with an in-memory RSA key
// and lets a test say whose pipe to expect (a test has no service). Options, all before or after the command:
//   --test-pipe-root <root>        the Authority's pipe root (default ALBERA\ApprovalAuthority)
//   --test-owner-sid <sid>         the SID that must own the pipe     \ both, or the production service check is used
//   --test-pid <pid>               the PID that must serve the pipe   /
//   --test-fake-key <base64 pkcs8> RSA-2048 private key the fake "Hello" signs with (RSA PKCS#1 v1.5 / SHA-256) and `enroll` shows the public half of, held in memory only
//   --test-key-state missing       the fake key store starts with no key (enroll creates a new in-memory one)
//   --test-presence unavailable    the fake reports that Hello gave no proof
//   --test-interactive yes         treat stdin as a console a person types in (a test pipes stdin)
//   --test-timeout-ms <n>          per-call timeout
// A fake signer is installed only together with --test-fake-key; without it a test-faults build has a signer that is never ready (approve exits 69).
internal sealed class FakePresenceSigner(RSA key, bool unavailable) : IPresenceSigner
{
    public SignResult Sign(byte[] message) =>
        unavailable ? SignResult.Unavailable : SignResult.Signed(key.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
}

internal sealed class NotReadyPresenceSigner : IPresenceSigner
{
    public SignResult Sign(byte[] message) => SignResult.NotReady;
}

internal sealed class FakeKeyStore(RSA? initialKey, bool unavailable = false) : IHelloKeyStore
{
    private RSA? key = initialKey;

    public KeyLookup Open() => unavailable ? KeyLookup.Of(KeyState.Unavailable) : key is null ? KeyLookup.Of(KeyState.Missing) : KeyLookup.Present(key.ExportSubjectPublicKeyInfo());

    public KeyLookup Create(bool replace)
    {
        if (unavailable) return KeyLookup.Of(KeyState.Unavailable);
        if (key is not null && !replace) return KeyLookup.Of(KeyState.AlreadyExists);
        key = RSA.Create();
        return KeyLookup.Present(key.ExportSubjectPublicKeyInfo());
    }
}

internal static class TestSeam
{
    public static bool TryApply(ref string[] args, ref Wiring wiring)
    {
        Dictionary<string, string> options = new(StringComparer.Ordinal);
        List<string> rest = [];
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--test-", StringComparison.Ordinal)) { rest.Add(args[i]); continue; }
            if (i + 1 >= args.Length || !options.TryAdd(args[i], args[i + 1])) return false;
            i++;
        }
        args = [.. rest];
        string[] known = ["--test-pipe-root", "--test-owner-sid", "--test-pid", "--test-fake-key", "--test-key-state", "--test-presence", "--test-interactive", "--test-timeout-ms"];
        if (options.Keys.Any(k => !known.Contains(k))) return false;

        ServerExpectation expectation = wiring.Expectation;
        string root = options.GetValueOrDefault("--test-pipe-root", ServerExpectation.ProductionPipeRoot);
        if (options.ContainsKey("--test-owner-sid") != options.ContainsKey("--test-pid")) return false;
        if (options.TryGetValue("--test-owner-sid", out string? owner) && uint.TryParse(options["--test-pid"], out uint pid)) expectation = new ServerExpectation(root, null, owner, pid);
        else if (options.ContainsKey("--test-pid")) return false;
        else expectation = expectation with { PipeRoot = root };
        int timeoutMs = wiring.TimeoutMs;
        if (options.TryGetValue("--test-timeout-ms", out string? timeout) && !int.TryParse(timeout, out timeoutMs)) return false;
        bool interactive = wiring.Interactive;
        if (options.TryGetValue("--test-interactive", out string? yes)) { if (yes != "yes") return false; interactive = true; }
        if (options.TryGetValue("--test-key-state", out string? state) && state != "missing") return false;

        IPresenceSigner signer = wiring.Signer;
        IHelloKeyStore keyStore = wiring.KeyStore;
        if (options.TryGetValue("--test-fake-key", out string? pkcs8))
        {
            RSA key = RSA.Create();
            key.ImportPkcs8PrivateKey(Convert.FromBase64String(pkcs8), out _);
            signer = new FakePresenceSigner(key, options.GetValueOrDefault("--test-presence") == "unavailable");
            keyStore = new FakeKeyStore(key);
        }
        else if (state == "missing") keyStore = new FakeKeyStore(null);
        wiring = wiring with { Expectation = expectation, Signer = signer, KeyStore = keyStore, TimeoutMs = timeoutMs, Interactive = interactive };
        return true;
    }
}
#endif
