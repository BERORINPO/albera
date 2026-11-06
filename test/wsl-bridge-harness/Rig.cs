using System.Buffers.Binary;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Albera.BrokerContract;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

/// <summary>One bridge with fakes: a throwaway Broker key, a fake host, a fake repository, a ledger file in a temp folder and a clock the check moves by hand.</summary>
internal sealed class Rig : IDisposable
{
    public const string Computer = "pc-wsl", Repository = "repo-alpha", KeyId = "broker-test";
    public static readonly string Head = new('a', 40);
    public static readonly List<string> AllLogs = [], AllReasons = [];
    public const string SecretMark = "SECRET-REPO";

    public readonly string Dir = Path.Combine(Path.GetTempPath(), "albera-wsl-bridge-" + Guid.NewGuid().ToString("N")[..12]);
    public readonly ECDsa Signer;
    public readonly BrokerKey Key;
    public readonly FakeHost Host = new();
    public readonly FakeRepositories Repos = new();
    public readonly List<string> Log = [];
    public readonly BridgeConfig Config;
    public Limits Limits;
    public long Now = 1_800_000_000;
    /// <summary>The real reader over a real file: as a host test, this user stands in for the administrators (the same seam as the bridge's trust-sid).</summary>
    public readonly PathGuard Guard = PathGuard.AdminOnly([new SecurityIdentifier(CurrentSid())]);
    public OperationLedger Ledger = null!;
    public Bridge Bridge = null!;
    private readonly byte[] _spki;

    public Rig(Func<Limits, Limits>? limits = null, ECDsa? signer = null, string? keyId = null, long? now = null)
    {
        MakeTrustedFolder();
        Directory.CreateDirectory(Path.Combine(Dir, "dist"));
        Directory.CreateDirectory(Path.Combine(Dir, "state"));
        Directory.CreateDirectory(Path.Combine(Dir, "floor"));
        SetFloor("1\n");
        File.WriteAllText(Path.Combine(Dir, "image.tar"), "the image");
        Signer = signer ?? ECDsa.Create(ECCurve.NamedCurves.nistP256);
        _spki = Signer.ExportSubjectPublicKeyInfo();
        Key = BrokerKey.TryCreate(keyId ?? KeyId, _spki)!;
        if (now is { } fixedNow) Now = fixedNow;
        Limits = Limits.Default with { MaxPutBytes = 1024, MaxGetBytes = 1024, MaxOutputBytes = 256, MaxBundleBytes = 4096, MaxCommandBytes = 128, AgentGrace = TimeSpan.FromMilliseconds(300), ExpiryGrace = TimeSpan.FromMilliseconds(300), EndWait = TimeSpan.FromMilliseconds(500), BeginCall = TimeSpan.FromSeconds(10) };
        if (limits is not null) Limits = limits(Limits);
        string imageHash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(Dir, "image.tar"))));
        Config = new BridgeConfig("ALBERA_Test", "S-1-5-21-1-2-3-1001", Computer, keyId ?? KeyId, _spki, FloorFile, Path.Combine(Dir, "image.tar"), imageHash, Path.Combine(Dir, "dist"), Path.Combine(Dir, "state"),
            Path.Combine(Dir, "git.exe"), new Floor(new Version(2, 4, 0), new Version(6, 6, 0), Now + 1_000_000), new Dictionary<string, string> { [Repository] = Path.Combine(Dir, SecretMark) });
        Repos.Head = Head;
        Restart();
    }

    public string FloorFile => Path.Combine(Dir, "floor", "lease-floor");

    // %TEMP% hands down ACEs the guard rightly refuses, so the rig's folder gets what an installer would give it (makeTrustedTempDirectory does the same for the gates).
    private void MakeTrustedFolder()
    {
        DirectoryInfo folder = Directory.CreateDirectory(Dir);
        DirectorySecurity strict = new();
        strict.SetAccessRuleProtection(true, false);
        foreach (string sid in new[] { CurrentSid(), "S-1-5-18" })
            strict.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        folder.SetAccessControl(strict);
    }

    /// <summary>What the revocation runbook does: the file is rewritten, and the bridge keeps running.</summary>
    public void SetFloor(string text) => File.WriteAllText(FloorFile, text);

    public long? ReadFloor() => new LeaseFloorFile(FloorFile, Guard).Read();

    /// <summary>A new Bridge and a new ledger over the same file: what a restart of the process does.</summary>
    public void Restart()
    {
        Ledger?.Dispose();
        Ledger = OperationLedger.TryOpen(Path.Combine(Dir, "state", "operations.log"), () => Now)!;
        Bridge = new Bridge(Config, Host, Repos, Ledger, Key, () => Now, Limits, ReadFloor, line => { lock (Log) Log.Add(line); lock (AllLogs) AllLogs.Add(line); });
    }

    // ---- leases -------------------------------------------------------------------------------------------------------------------------------------------------------------

    public Dictionary<string, object> Body(string operation = "op-1") => new()
    {
        ["v"] = 1L, ["operationId"] = operation, ["actionDigest"] = "sha256:" + new string('0', 64), ["leaseGeneration"] = 1L, ["computerId"] = Computer, ["isolation"] = "wsl2",
        ["repositoryId"] = Repository, ["baseOid"] = Head, ["maxCalls"] = 5L, ["issuedAt"] = Now, ["expiresAt"] = Now + 600,
    };

    /// <summary>The signed lease as JSON bytes. <paramref name="tweak"/> changes the body before it is signed; <paramref name="by"/> signs with another key.</summary>
    public byte[] Lease(string operation = "op-1", Action<Dictionary<string, object>>? tweak = null, ECDsa? by = null)
    {
        Dictionary<string, object> body = Body(operation);
        tweak?.Invoke(body);
        (Wsl2RunLeaseVerdict verdict, string? digest, byte[]? preimage) = Wsl2RunLease.Compute(body);
        if (!verdict.Ok) throw new InvalidOperationException("the test lease is not valid: " + verdict.Field);
        byte[] signature = (by ?? Signer).SignData(preimage!, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        using MemoryStream stream = new();
        using (Utf8JsonWriter json = new(stream))
        {
            json.WriteStartObject();
            json.WriteString("digest", digest);
            json.WriteString("keyId", KeyId);
            json.WriteStartObject("lease");
            foreach ((string name, object value) in body.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                if (value is long number) json.WriteNumber(name, number); else json.WriteString(name, (string)value);
            json.WriteEndObject();
            json.WriteString("signature", Base64Url(signature));
            json.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // ---- requests -----------------------------------------------------------------------------------------------------------------------------------------------------------

    public Reply Send(Verb verb, string id, byte[]? body = null)
    {
        Reply reply = Bridge.HandleAsync(new Request(verb, id, body ?? [])).GetAwaiter().GetResult();
        if (!reply.Ok) lock (AllReasons) AllReasons.Add(reply.Reason);
        return reply;
    }

    public byte[] LeaseOfGeneration(long generation, string operation = "op-1") => Lease(operation, body => body["leaseGeneration"] = generation);
    public bool Logged(string line) { lock (Log) return Log.Contains(line); }

    public Reply Begin(string operation = "op-1", byte[]? lease = null) => Send(Verb.Begin, operation, lease ?? Lease(operation));
    public Reply Exec(string command = "echo hi", uint seconds = 5, string id = "op-1") => Send(Verb.Exec, id, U32(seconds).Concat(Encoding.UTF8.GetBytes(command)).ToArray());
    public Reply Put(string path, byte[] data, string id = "op-1") => Send(Verb.Put, id, U32((uint)Encoding.UTF8.GetByteCount(path)).Concat(Encoding.UTF8.GetBytes(path)).Concat(data).ToArray());
    public Reply Get(string path, string id = "op-1") => Send(Verb.Get, id, Encoding.UTF8.GetBytes(path));

    public static byte[] U32(uint value) { byte[] bytes = new byte[4]; BinaryPrimitives.WriteUInt32BigEndian(bytes, value); return bytes; }

    public Reply BeginOk(string operation = "op-1", byte[]? lease = null)
    {
        Reply reply = Begin(operation, lease);
        if (!reply.Ok) throw new InvalidOperationException("begin was refused: " + reply.Reason);
        return reply;
    }

    public void Dispose()
    {
        try { Bridge.StopAllAsync().GetAwaiter().GetResult(); } catch (Exception ex) when (ex is IOException or ObjectDisposedException) { }
        Ledger.Dispose();
        Key.Dispose();
        Signer.Dispose();
        try { Directory.Delete(Dir, recursive: true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    public static string CurrentSid() { using WindowsIdentity identity = WindowsIdentity.GetCurrent(); return identity.User!.Value; }
}
