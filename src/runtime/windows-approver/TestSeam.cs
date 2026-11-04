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
//   --test-attestation <status>    what the fake Windows reports for a key `enroll` just made: Success (default) | NotSupported | TemporaryFailure | UnknownError | Empty (Success, empty buffers)
//   --test-webauthn <mode>         wire WebAuthn with the software authenticator (SoftwareAuthenticator below) instead of webauthn.dll: on | cancel (the prompt is dismissed) | unavailable (the platform gives nothing)
//   --test-webauthn-key <base64 pkcs8>   \ with --test-webauthn: one credential the software authenticator already holds (a P-256 key and its credential id)
//   --test-webauthn-credential <b64url>  /
//   --test-keys-dir <dir>          with --test-webauthn: where the key record files go (required: a test never writes to the real %LOCALAPPDATA%)
//   --test-remote-session yes|no   with --test-webauthn: whether this counts as a Remote Desktop session (default no, whatever the machine is)
// A fake signer is installed only together with --test-fake-key; without it a test-faults build has a signer that is never ready (approve exits 69). Without --test-webauthn there is no WebAuthn kit: the commands behave as before WebAuthn.
internal sealed class FakePresenceSigner(RSA key, bool unavailable) : IPresenceSigner
{
    public SignResult Sign(byte[] message) =>
        unavailable ? SignResult.Unavailable : SignResult.Signed(key.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
}

internal sealed class NotReadyPresenceSigner : IPresenceSigner
{
    public SignResult Sign(byte[] message) => SignResult.NotReady;
}

// `attestation` is the status the fake "Windows" reports for a key that Create just made; "Empty" is Success with empty buffers; NotSupported has empty buffers. Like the real store, a key whose attestation is
// not accepted by AttestationPolicy is removed again (a replaced key stays lost) and Create returns NotAttested.
internal sealed class FakeKeyStore(RSA? initialKey, bool unavailable = false, string attestation = "Success") : IHelloKeyStore
{
    private RSA? key = initialKey;

    public KeyLookup Open() => unavailable ? KeyLookup.Of(KeyState.Unavailable) : key is null ? KeyLookup.Of(KeyState.Missing) : KeyLookup.Present(key.ExportSubjectPublicKeyInfo());

    public KeyLookup Create(bool replace, bool acceptUnattested)
    {
        if (unavailable) return KeyLookup.Of(KeyState.Unavailable);
        if (key is not null && !replace) return KeyLookup.Of(KeyState.AlreadyExists);
        string status = attestation == "Empty" ? "Success" : attestation;
        (int chain, int statement) = attestation is "Empty" or "NotSupported" ? (0, 0) : (1234, 567); // like this PC: NotSupported comes with empty buffers
        if (!AttestationPolicy.Accepts(status, chain, statement, acceptUnattested))
        {
            key = null;
            return KeyLookup.NotAttested($"{AttestationPolicy.Summary(status, chain, statement, acceptUnattested)}; the key was removed", AttestationPolicy.IsOptInResult(status, chain, statement));
        }
        key = RSA.Create();
        return KeyLookup.Present(key.ExportSubjectPublicKeyInfo(), AttestationPolicy.Summary(status, chain, statement, acceptUnattested));
    }
}

// A software WebAuthn authenticator: in-memory P-256 credentials that produce real authenticator data (rp id hash of approver.albera.local, user present + user verified, a big-endian sign count that rises per credential)
// and a real ES256 signature (DER) over authenticatorData || SHA-256(client data), so the Authority's verifier accepts exactly what the platform authenticator would give. Its knobs let a test make it misbehave:
// Cancel (the person dismisses the prompt), NotReady (the platform has nothing), Flags (default 0x05; 0x1D adds the backup flags a synced passkey sets), RpId (a different relying party), WrongCredential
// (answers with a credential that was not asked for). It never prompts and holds no state outside the process.
internal sealed class SoftwareAuthenticator : IWebAuthnAuthenticator
{
    private readonly Dictionary<string, (ECDsa Key, uint Count)> credentials = [];

    public bool Cancel { get; init; }

    public bool NotReady { get; init; }

    public byte Flags { get; init; } = 0x05;

    public string RpId { get; init; } = WebAuthnContract.RpId;

    public bool WrongCredential { get; init; }

    /// <summary>The client data of every assertion asked for, in order.</summary>
    public List<byte[]> AssertionClientData { get; } = [];

    /// <summary>The credential ids named in every assertion request, in order.</summary>
    public List<IReadOnlyList<byte[]>> AllowLists { get; } = [];

    /// <summary>The parent window of the last prompt (create or assert).</summary>
    public IntPtr LastWindow { get; private set; }

    public int Created { get; private set; }

    public void Add(byte[] credentialId, ECDsa key) => credentials[Convert.ToBase64String(credentialId)] = (key, 0);

    public CreatedCredential MakeCredential(IntPtr window, byte[] userId, byte[] clientDataJson)
    {
        LastWindow = window;
        if (Cancel) return new CreatedCredential(WebAuthnStatus.Cancelled, null, null, "software: cancelled");
        if (NotReady) return new CreatedCredential(WebAuthnStatus.NotReady, null, null, "software: unavailable");
        ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        byte[] id = RandomNumberGenerator.GetBytes(32);
        credentials[Convert.ToBase64String(id)] = (key, 0);
        Created++;
        ECParameters point = key.ExportParameters(false);
        byte[] cose = [0xA5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, .. point.Q.X!, 0x22, 0x58, 0x20, .. point.Q.Y!]; // {1: 2, 3: -7, -1: 1, -2: x, -3: y}
        byte[] data = [.. RpIdHash(), (byte)(Flags | 0x40), 0, 0, 0, 0, .. new byte[16], (byte)(id.Length >> 8), (byte)id.Length, .. id, .. cose];
        return new CreatedCredential(WebAuthnStatus.Ok, id, data);
    }

    public AssertionResult GetAssertion(IntPtr window, byte[] clientDataJson, IReadOnlyList<byte[]> allowCredentialIds)
    {
        LastWindow = window;
        AssertionClientData.Add(clientDataJson);
        AllowLists.Add(allowCredentialIds);
        if (Cancel) return new AssertionResult(WebAuthnStatus.Cancelled, null, null, null, "software: cancelled");
        if (NotReady) return new AssertionResult(WebAuthnStatus.NotReady, null, null, null, "software: unavailable");
        byte[]? id = allowCredentialIds.FirstOrDefault(c => credentials.ContainsKey(Convert.ToBase64String(c)));
        if (id is null) return new AssertionResult(WebAuthnStatus.NotReady, null, null, null, "software: no such credential");
        (ECDsa key, uint count) = credentials[Convert.ToBase64String(id)];
        credentials[Convert.ToBase64String(id)] = (key, ++count);
        byte[] data = [.. RpIdHash(), Flags, (byte)(count >> 24), (byte)(count >> 16), (byte)(count >> 8), (byte)count];
        byte[] signature = key.SignData([.. data, .. SHA256.HashData(clientDataJson)], HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);        return new AssertionResult(WebAuthnStatus.Ok, WrongCredential ? RandomNumberGenerator.GetBytes(32) : id, data, signature);
    }

    private byte[] RpIdHash() => SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(RpId));
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
        string[] known = ["--test-pipe-root", "--test-owner-sid", "--test-pid", "--test-fake-key", "--test-key-state", "--test-presence", "--test-interactive", "--test-timeout-ms", "--test-attestation",
            "--test-webauthn", "--test-webauthn-key", "--test-webauthn-credential", "--test-keys-dir", "--test-remote-session"];
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

        string attestation = options.GetValueOrDefault("--test-attestation", "Success");

        IPresenceSigner signer = wiring.Signer;
        IHelloKeyStore keyStore = wiring.KeyStore;
        if (options.TryGetValue("--test-fake-key", out string? pkcs8))
        {
            RSA key = RSA.Create();
            key.ImportPkcs8PrivateKey(Convert.FromBase64String(pkcs8), out _);
            signer = new FakePresenceSigner(key, options.GetValueOrDefault("--test-presence") == "unavailable");
            keyStore = new FakeKeyStore(key, attestation: attestation);
        }
        else if (state == "missing") keyStore = new FakeKeyStore(null, attestation: attestation);
        if (!TryWebAuthn(options, out WebAuthnKit? webAuthn)) return false;
        wiring = wiring with { Expectation = expectation, Signer = signer, KeyStore = keyStore, TimeoutMs = timeoutMs, Interactive = interactive, WebAuthn = webAuthn };
        return true;
    }

    // The WebAuthn options only make sense together: a software authenticator needs a record folder (never the real one) and may hold one credential; a remote-session flag or a credential without --test-webauthn is a usage error.
    private static bool TryWebAuthn(Dictionary<string, string> options, out WebAuthnKit? kit)
    {
        kit = null;
        string[] dependent = ["--test-webauthn-key", "--test-webauthn-credential", "--test-keys-dir", "--test-remote-session"];
        if (!options.TryGetValue("--test-webauthn", out string? mode)) return !dependent.Any(options.ContainsKey);
        if (mode is not ("on" or "cancel" or "unavailable") || !options.TryGetValue("--test-keys-dir", out string? folder) || folder.Length == 0) return false;
        bool remote = false;
        if (options.TryGetValue("--test-remote-session", out string? answer)) { if (answer is not ("yes" or "no")) return false; remote = answer == "yes"; }
        if (options.ContainsKey("--test-webauthn-key") != options.ContainsKey("--test-webauthn-credential")) return false;
        SoftwareAuthenticator authenticator = new() { Cancel = mode == "cancel", NotReady = mode == "unavailable" };
        if (options.TryGetValue("--test-webauthn-key", out string? pkcs8))
        {
            if (B64.TryFromUrl(options["--test-webauthn-credential"]) is not { Length: > 0 } credentialId) return false;
            ECDsa key = ECDsa.Create();
            key.ImportPkcs8PrivateKey(Convert.FromBase64String(pkcs8), out _);
            authenticator.Add(credentialId, key);
        }
        kit = new WebAuthnKit(authenticator, () => remote, new KeyRecordStore(folder));
        return true;
    }
}
#endif
