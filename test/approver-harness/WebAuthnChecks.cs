using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.Approver;
using Albera.BrokerContract;

// WebAuthn presence (docs/architecture/approver-webauthn.md, phase 3): the key record, the COSE and authenticator data readers, the client data and proof bytes, the signing choice, `approve` / `policy set` with a
// WebAuthn key, `enroll --webauthn` and `keys list | add | remove`. Canned channel and the software authenticator (an in-memory P-256 key); no webauthn.dll, no Hello, no prompt, no Authority. Every proof is checked
// by a verifier written in this file from the contract's text (a literal client data string, SHA-256, the rp id hash, ECDsa from the public key), not by the code under test.
internal static partial class Harness
{
    private static readonly List<string> WebAuthnTemps = [];
    private const string ExpectedRpId = "approver.albera.local";

    private static string TempFolder()
    {
        string folder = Directory.CreateTempSubdirectory("albera-webauthn-").FullName;
        WebAuthnTemps.Add(folder);
        return folder;
    }

    private static void WebAuthnCleanup()
    {
        foreach (string folder in WebAuthnTemps) { try { Directory.Delete(folder, recursive: true); } catch (IOException) { } }
    }

    // ---- fixtures ------------------------------------------------------------------------------------------------------------------------
    private static string Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record Registered(ECDsa Key, byte[] CredentialId, ApproverKeyRecord Record, string KeyJson);

    /// <summary>A WebAuthn key the software authenticator holds, and the entry of the Authority's `keys` reply that lists it.</summary>
    private static Registered Register(SoftwareAuthenticator authenticator)
    {
        ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        byte[] id = RandomNumberGenerator.GetBytes(32);
        authenticator.Add(id, key);
        ApproverKeyRecord record = ApproverKeyRecord.TryCreate(ApproverKeyRecord.WebAuthnKind, ApproverKeyRecord.Es256, key.ExportSubjectPublicKeyInfo(), id)!;
        return new Registered(key, id, record, $"{{\"keyId\":\"{record.KeyId}\",\"kind\":\"webauthn\",\"credentialId\":\"{Url(id)}\"}}");
    }

    /// <summary>A listed WebAuthn key this process holds no credential for (it lives on another device).</summary>
    private static string ListedElsewhere() => ListedElsewhere(RandomNumberGenerator.GetBytes(24));

    private static string ListedElsewhere(byte[] credentialId) =>
        $"{{\"keyId\":\"webauthn-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8))}\",\"kind\":\"webauthn\",\"credentialId\":\"{Url(credentialId)}\"}}";

    private const string HelloEntry = "{\"keyId\":\"hello-951a135537287eae\",\"kind\":\"hello-rsa\"}";
    private const string AddChallenge = "AAAAAAAAAAAAAAAAAAAAAA";

    private static string KeysReply(params string[] entries) => $"{{\"ok\":true,\"keys\":[{string.Join(',', entries)}]}}";

    private static string Verb(string request)
    {
        using JsonDocument document = JsonDocument.Parse(request);
        return document.RootElement.GetProperty("verb").GetString()!;
    }

    private static string[] Verbs(FakeChannel channel) => [.. channel.Requests.Select(Verb)];

    private static WebAuthnKit Kit(SoftwareAuthenticator authenticator, bool remote, string? folder = null) => new(authenticator, remote, new KeyRecordStore(folder ?? TempFolder()));

    /// <summary>The Authority, as far as approve needs it: the pending list, the key list, and a decide that approves (or fails presence_unavailable).</summary>
    private static FakeChannel WebAuthnChannel(string keysReply, params string[] entries) => new(request =>
        request.Contains("\"verb\":\"list\"") ? Page(entries) : request.Contains("\"verb\":\"keys\"") ? keysReply
        : request.Contains("\"decision\":\"presence_unavailable\"") ? "{\"ok\":false,\"code\":\"presence_unavailable\"}" : "{\"ok\":true,\"state\":\"approved\"}");

    private static byte[] PresenceBytes() => Encoding.UTF8.GetBytes($"albera.presence.v1\0{Id1}\0{DigestOf()}\0{Challenge}");

    /// <summary>The Authority's verification, from the contract's text: key order, base64 forms, the rp id hash, UP + UV set and AT + ED clear, and an ES256 signature over authenticatorData || SHA-256(client data).</summary>
    private static bool ProofVerifies(JsonElement proof, ECDsa key, byte[] message, byte[] credentialId)
    {
        if (proof.ValueKind != JsonValueKind.Object || !proof.EnumerateObject().Select(p => p.Name).SequenceEqual(["kind", "credentialId", "authenticatorData", "signature"])) return false;
        if (proof.GetProperty("kind").GetString() != "webauthn" || proof.GetProperty("credentialId").GetString() != Url(credentialId)) return false;
        byte[] data = Convert.FromBase64String(proof.GetProperty("authenticatorData").GetString()!), signature = Convert.FromBase64String(proof.GetProperty("signature").GetString()!);
        string clientData = $"{{\"type\":\"webauthn.get\",\"challenge\":\"{Url(SHA256.HashData(message))}\",\"origin\":\"albera://approver\",\"crossOrigin\":false}}";
        byte[] signed = [.. data, .. SHA256.HashData(Encoding.UTF8.GetBytes(clientData))];
        return data.Length == 37 && data[..32].SequenceEqual(SHA256.HashData(Encoding.UTF8.GetBytes(ExpectedRpId))) && (data[32] & 0x05) == 0x05 && (data[32] & 0xC0) == 0
            && key.VerifyData(signed, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
    }

    private static JsonElement Frame(FakeChannel channel, string verb)
    {
        using JsonDocument document = JsonDocument.Parse(channel.Requests.Single(r => Verb(r) == verb));
        return document.RootElement.Clone();
    }

    private sealed class WebRun(FakeChannel channel, IPresenceSigner hello, WebAuthnKit? kit, string stdin = "yes\n", bool interactive = true)
    {
        public readonly StringWriter Out = new(), Err = new();
        public readonly CountingReader Input = new(stdin, () => channel.Requests.Count);
        public ApproverCommands Commands => new(channel, hello, Out, Err, Input, () => DateTimeOffset.FromUnixTimeSeconds(Now), interactive, kit);
        public KeysCommand Keys => new(channel, hello, kit, Out, Err, Input, interactive);
        public int Approve() => Commands.ApproveAsync(Id1).GetAwaiter().GetResult();
    }

    /// <summary>A stdin that notes how many requests the channel had seen when the person was first asked to type.</summary>
    private sealed class CountingReader(string text, Func<int> requestsSoFar) : StringReader(text)
    {
        public int RequestsAtFirstRead = -1;
        public override string? ReadLine() { if (RequestsAtFirstRead < 0) RequestsAtFirstRead = requestsSoFar(); return base.ReadLine(); }
    }

    private static byte[] CoseEc2(byte[] x, byte[] y) => [0xA5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, (byte)x.Length, .. x, 0x22, 0x58, (byte)y.Length, .. y];

    private static byte[] CreatedData(byte[] credentialId, byte[] cose, byte flags = 0x45, byte[]? rpIdHash = null) =>
        [.. rpIdHash ?? SHA256.HashData(Encoding.UTF8.GetBytes(ExpectedRpId)), flags, 0, 0, 0, 0, .. new byte[16], (byte)(credentialId.Length >> 8), (byte)credentialId.Length, .. credentialId, .. cose];

    private static (byte[] X, byte[] Y, byte[] Spki) NewPoint()
    {
        using ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        ECParameters point = key.ExportParameters(false);
        return (point.Q.X!, point.Q.Y!, key.ExportSubjectPublicKeyInfo());
    }

    // ---- checks --------------------------------------------------------------------------------------------------------------------------
    private static void WebAuthnRecordChecks()
    {
        Check("key record: the canonical bytes are the contract's JSON in its key order, the key id is webauthn- / hello- + the first 8 bytes of SHA-256 over the SPKI, credentialId only for webauthn", () =>
        {
            (byte[] _, byte[] _, byte[] spki) = NewPoint();
            byte[] credential = [1, 2, 3, 250, 251, 252];
            ApproverKeyRecord web = ApproverKeyRecord.TryCreate("webauthn", -7, spki, credential)!;
            string id = "webauthn-" + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8));
            Assert(web.KeyId == id, web.KeyId);
            string expected = $"{{\"keyId\":\"{id}\",\"kind\":\"webauthn\",\"alg\":-7,\"publicKey\":\"{Convert.ToBase64String(spki)}\",\"credentialId\":\"{Url(credential)}\"}}";
            Assert(Encoding.UTF8.GetString(web.CanonicalBytes()) == expected && Url(credential) == "AQID-vv8", expected);
            byte[] helloSpki = Hello.ExportSubjectPublicKeyInfo();
            ApproverKeyRecord rsa = ApproverKeyRecord.TryCreate("hello-rsa", -257, helloSpki, null)!;
            Assert(rsa.KeyId == ApproverKeyId.Of(helloSpki) && Encoding.UTF8.GetString(rsa.CanonicalBytes()) == $"{{\"keyId\":\"{rsa.KeyId}\",\"kind\":\"hello-rsa\",\"alg\":-257,\"publicKey\":\"{Convert.ToBase64String(helloSpki)}\"}}", "hello-rsa has no credentialId");
        });
        Check("key record: a record the contract would refuse is never made (alg / kind / key type / RSA size / credential id length / trailing bytes)", () =>
        {
            (byte[] _, byte[] _, byte[] ec) = NewPoint();
            byte[] id = [1, 2, 3];
            using ECDsa p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            using ECDsa brainpool = ECDsa.Create(ECCurve.NamedCurves.brainpoolP256r1);
            using RSA rsa1024 = RSA.Create(1024), rsa3072 = RSA.Create(3072), rsa2048 = RSA.Create(2048), rsa8192 = RSA.Create(8192);
            Assert(ApproverKeyRecord.TryCreate("webauthn", -7, ec, id) is not null && ApproverKeyRecord.TryCreate("webauthn", -257, rsa2048.ExportSubjectPublicKeyInfo(), id) is not null && ApproverKeyRecord.TryCreate("webauthn", -257, rsa3072.ExportSubjectPublicKeyInfo(), id) is not null, "the allowed shapes");
            (string Kind, int Alg, byte[] Spki, byte[]? Id, string Why)[] refused =
            [
                ("webauthn", -7, rsa2048.ExportSubjectPublicKeyInfo(), id, "ES256 with an RSA key"), ("webauthn", -257, ec, id, "RS256 with an EC key"), ("webauthn", -7, p384.ExportSubjectPublicKeyInfo(), id, "P-384"),
                ("webauthn", -7, brainpool.ExportSubjectPublicKeyInfo(), id, "a 256-bit curve that is not P-256"), ("webauthn", -257, rsa1024.ExportSubjectPublicKeyInfo(), id, "RSA-1024"),
                ("webauthn", -257, rsa8192.ExportSubjectPublicKeyInfo(), id, "RSA above the approver's 4096 cap"), ("webauthn", -258, ec, id, "an unknown alg"), ("webauthn", -7, ec, null, "no credential id"),
                ("webauthn", -7, ec, [], "an empty credential id"), ("webauthn", -7, ec, new byte[1024], "a 1024-byte credential id"), ("hello-rsa", -257, rsa3072.ExportSubjectPublicKeyInfo(), null, "hello-rsa must be exactly 2048"),
                ("hello-rsa", -257, rsa2048.ExportSubjectPublicKeyInfo(), id, "hello-rsa with a credential id"), ("hello-rsa", -7, ec, null, "hello-rsa with ES256"), ("passkey", -7, ec, id, "an unknown kind"),
                ("webauthn", -7, [.. ec, 0], id, "a trailing byte after the SPKI"), ("webauthn", -7, [1, 2, 3], id, "garbage"),
            ];
            foreach (var (kind, alg, spki, credential, why) in refused) Assert(ApproverKeyRecord.TryCreate(kind, alg, spki, credential) is null, why);
            Assert(ApproverKeyRecord.TryCreate("webauthn", -7, ec, new byte[1023]) is not null, "1023 bytes is the longest allowed");
        });
    }

    private static void WebAuthnReaderChecks()
    {
        Check("COSE key: an ES256 and an RS256 key become the SPKI of exactly those public numbers; any other shape (duplicate or extra entry, wrong size, indefinite length, wrong alg or curve, off-curve point, truncated) is refused", () =>
        {
            (byte[] x, byte[] y, byte[] spki) = NewPoint();
            int position = 0;
            Assert(CoseKey.TryRead(CoseEc2(x, y), ref position) is { Alg: -7 } ec && ec.Spki.SequenceEqual(spki) && position == CoseEc2(x, y).Length, "ES256");
            using RSA rsa = RSA.Create(2048);
            RSAParameters numbers = rsa.ExportParameters(false);
            byte[] cose = [0xA4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x59, 0x01, 0x00, .. numbers.Modulus!, 0x21, 0x43, .. numbers.Exponent!]; // {1: 3, 3: -257, -1: n, -2: e}
            position = 0;
            Assert(CoseKey.TryRead(cose, ref position) is { Alg: -257 } rs && rs.Spki.SequenceEqual(rsa.ExportSubjectPublicKeyInfo()), "RS256");
            byte[][] bad =
            [
                [0xA5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, .. x, 0x22, 0x58, 0x1F, .. y[..31]], CoseEc2(x, y[..31]), [0xA6, .. CoseEc2(x, y)[1..], 0x04, 0x01], [0xA5, 0x01, 0x02, 0x01, 0x02, 0x20, 0x01, 0x21, 0x58, 0x20, .. x, 0x22, 0x58, 0x20, .. y],
                [0xA6, .. CoseEc2(x, y)[1..], 0x22, 0x58, 0x20, .. y], [0xA6, .. CoseEc2(x, y)[1..], 0x21, 0x58, 0x20, .. NewPoint().X], [0xBF, .. CoseEc2(x, y)[1..], 0xFF], CoseEc2(x, y).Select((b, i) => i == 5 ? (byte)0x27 : b).ToArray(), CoseEc2(x, y).Select((b, i) => i == 6 ? (byte)0x02 : b).ToArray(), CoseEc2(x, y)[..40], [], [0xA0],
                [0xA5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, .. x, 0x22, 0x58, 0x20, .. new byte[32]], [0xA5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x78, 0x20, .. x, 0x22, 0x58, 0x20, .. y], [0xA5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x5B, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
            ];
            for (int i = 0; i < bad.Length; i++)
            {
                position = 0;
                Assert(CoseKey.TryRead(bad[i], ref position) is null, $"bad COSE key #{i}");
            }
        });
        Check("authenticator data of a creation: rp id hash, UP + UV + AT, the credential id and the key are read; bytes after the key are allowed only with the extensions flag; everything else is refused", () =>
        {
            (byte[] x, byte[] y, byte[] spki) = NewPoint();
            byte[] id = RandomNumberGenerator.GetBytes(32), cose = CoseEc2(x, y);
            Assert(WebAuthnContract.TryReadCreated(CreatedData(id, cose), out byte[] gotId, out int alg, out byte[] gotSpki) && gotId.SequenceEqual(id) && alg == -7 && gotSpki.SequenceEqual(spki), "valid");
            Assert(WebAuthnContract.TryReadCreated(CreatedData(id, cose, 0x5D), out _, out _, out _), "backup flags are fine");
            Assert(WebAuthnContract.TryReadCreated([.. CreatedData(id, cose, 0xC5), 0xA0], out _, out _, out _), "extension bytes after the key with the extensions flag");
            Assert(!WebAuthnContract.TryReadCreated([.. CreatedData(id, cose), 0xA0], out _, out _, out _), "trailing bytes without the flag");
            foreach ((string why, byte[] data) in new (string, byte[])[] { ("user verified missing", CreatedData(id, cose, 0x41)), ("user present missing", CreatedData(id, cose, 0x44)), ("attested data missing", CreatedData(id, cose, 0x05)),
                ("another rp id", CreatedData(id, cose, rpIdHash: SHA256.HashData(Encoding.UTF8.GetBytes("evil.example")))), ("truncated", CreatedData(id, cose)[..60]), ("credential id longer than the data", [.. CreatedData(id, cose)[..53], 0x0F, 0xFF]),
                ("empty credential id", CreatedData([], cose)), ("no key", CreatedData(id, [])), ("short", new byte[20]) })
                Assert(!WebAuthnContract.TryReadCreated(data, out _, out _, out _), why);
        });
        Check("assertion authenticator data: exactly 37 bytes, the rp id hash, UP + UV set, AT + ED clear; the backup flags and any sign count are fine; every other flag combination, length and rp id is refused", () =>
        {
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(ExpectedRpId));
            byte[] Make(byte flags, uint count = 1, byte[]? rp = null) => [.. rp ?? hash, flags, (byte)(count >> 24), (byte)(count >> 16), (byte)(count >> 8), (byte)count];
            foreach (byte ok in new byte[] { 0x05, 0x1D, 0x0D, 0x25, 0x3D }) Assert(WebAuthnContract.IsPresenceAssertion(Make(ok)), $"flags {ok:X2}");
            Assert(WebAuthnContract.IsPresenceAssertion(Make(0x05, 0)) && WebAuthnContract.IsPresenceAssertion(Make(0x05, uint.MaxValue)), "sign count is not judged here");
            foreach (byte bad in new byte[] { 0x00, 0x01, 0x04, 0x41, 0x45, 0x81, 0x85, 0xC5, 0x04 }) Assert(!WebAuthnContract.IsPresenceAssertion(Make(bad)), $"flags {bad:X2}");
            Assert(!WebAuthnContract.IsPresenceAssertion([.. Make(0x05), 0]) && !WebAuthnContract.IsPresenceAssertion(Make(0x05)[..36]) && !WebAuthnContract.IsPresenceAssertion([]), "length");
            Assert(!WebAuthnContract.IsPresenceAssertion(Make(0x05, rp: SHA256.HashData(Encoding.UTF8.GetBytes("approver.albera.local.")))), "rp id hash");
        });
        Check("client data and key messages are the contract's bytes: webauthn.get / webauthn.create client data with base64url challenges, albera.keyremove.v1 (key id and challenge) domain-separated from every other signed message", () =>
        {
            byte[] message = PresenceBytes();
            string expected = $"{{\"type\":\"webauthn.get\",\"challenge\":\"{Url(SHA256.HashData(message))}\",\"origin\":\"albera://approver\",\"crossOrigin\":false}}";
            Assert(Encoding.UTF8.GetString(WebAuthnContract.ClientDataForAssertion(message)) == expected && !expected.Contains('=') && !expected.Contains(' '), expected);
            Assert(Encoding.UTF8.GetString(WebAuthnContract.ClientDataForCreation([1, 2, 3])).Equals("{\"type\":\"webauthn.create\",\"challenge\":\"AQID\",\"origin\":\"albera://approver\",\"crossOrigin\":false}"), "creation");
            (byte[] _, byte[] _, byte[] spki) = NewPoint();
            ApproverKeyRecord record = ApproverKeyRecord.TryCreate("webauthn", -7, spki, [1])!;
            Assert(Encoding.UTF8.GetString(KeyMessages.Remove(record.KeyId, AddChallenge)) == $"albera.keyremove.v1\0{record.KeyId}\0{AddChallenge}", "remove: the key id and the challenge, no record hash");
            string[] domains = ["albera.presence.v1", "albera.selfcheck.v1", "albera.policy.v1", "albera.keyremove.v1"];
            foreach (string a in domains) foreach (string b in domains) Assert(a == b || !(b + "\0").StartsWith(a + "\0", StringComparison.Ordinal), $"{a} vs {b}");
        });
    }

    private static void WebAuthnSignerChecks()
    {
        Check("software authenticator and WebAuthnSigner: real authenticator data (37 bytes, rp id hash, UP + UV, a rising sign count) and an ES256 signature that an independent verifier accepts over the contract's client data", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered key = Register(authenticator);
            byte[] message = PresenceBytes();
            SignResult first = new WebAuthnSigner(authenticator).Sign(message, [key.CredentialId], default);
            SignResult second = new WebAuthnSigner(authenticator).Sign(message, [key.CredentialId], default);
            Assert(first.Status == SignStatus.Signed && first.Proof is not null && first.Signature is null, "signed");
            using JsonDocument proof = JsonDocument.Parse(first.Proof!.ToJson());
            Assert(ProofVerifies(proof.RootElement, key.Key, message, key.CredentialId), "the independent verifier accepts it");
            Assert(first.Proof.AuthenticatorData.Length == 37 && first.Proof.AuthenticatorData[32] == 0x05 && first.Proof.AuthenticatorData[36] == 1 && second.Proof!.AuthenticatorData[36] == 2, "flags UP + UV, sign count 1 then 2");
            Assert(Encoding.UTF8.GetString(authenticator.AssertionClientData[0]) == $"{{\"type\":\"webauthn.get\",\"challenge\":\"{Url(SHA256.HashData(message))}\",\"origin\":\"albera://approver\",\"crossOrigin\":false}}", "the authenticator was handed exactly the contract's client data");
            byte[] other = [.. message, 1];
            using JsonDocument ownJson = JsonDocument.Parse(first.Proof.ToJson());
            Assert(!ProofVerifies(ownJson.RootElement, key.Key, other, key.CredentialId), "nor for the independent verifier");
        });
        Check("WebAuthnSigner: an assertion is sent only if it is for a credential that was asked for, passes the Authority's authenticator data rule and has a signature; a dismissed prompt is no proof; anything else sends nothing", () =>
        {
            byte[] message = PresenceBytes();
            SignResult With(SoftwareAuthenticator authenticator, bool registered = true)
            {
                Registered key = Register(authenticator);
                return new WebAuthnSigner(authenticator).Sign(message, [registered ? key.CredentialId : [7, 7, 7]], default);
            }
            Assert(With(new SoftwareAuthenticator { Flags = 0x1D }).Status == SignStatus.Signed, "backup flags are fine");
            Assert(With(new SoftwareAuthenticator { Cancel = true }).Status == SignStatus.Unavailable, "dismissed");
            foreach ((string why, SoftwareAuthenticator authenticator) in new (string, SoftwareAuthenticator)[] { ("unavailable", new() { NotReady = true }), ("user verified missing", new() { Flags = 0x01 }), ("user present missing", new() { Flags = 0x04 }),
                ("attested flag", new() { Flags = 0x45 }), ("extensions flag", new() { Flags = 0x85 }), ("another rp id", new() { RpId = "evil.example" }), ("a credential that was not asked for", new() { WrongCredential = true }) })
                Assert(With(authenticator).Status == SignStatus.NotReady, why);
            Assert(With(new SoftwareAuthenticator(), registered: false).Status == SignStatus.NotReady, "no matching credential on this device");
            Assert(new WebAuthnSigner(new ThrowingAuthenticator()).Sign(message, [[1]], default).Status == SignStatus.NotReady, "an exception from the platform API sends nothing");
        });
        Check("WebAuthnCreator: a creation becomes a key record only if the authenticator data satisfies the contract; cancelled is reported as cancelled; a mismatch between the credential id and the data is refused", () =>
        {
            SoftwareAuthenticator authenticator = new();
            CreationResult made = WebAuthnCreator.Create(authenticator, default);
            Assert(made.Status == WebAuthnStatus.Ok && made.Record is { Kind: "webauthn", Alg: -7 } record && record.CredentialId!.Length == 32 && record.KeyId.StartsWith("webauthn-", StringComparison.Ordinal), "ok");
            Assert(WebAuthnCreator.Create(authenticator, default).Record!.KeyId != made.Record!.KeyId, "every creation is a new credential");
            Assert(WebAuthnCreator.Create(new SoftwareAuthenticator { Cancel = true }, default) is { Status: WebAuthnStatus.Cancelled, Record: null }, "cancelled");
            Assert(WebAuthnCreator.Create(new SoftwareAuthenticator { NotReady = true }, default) is { Status: WebAuthnStatus.NotReady, Record: null }, "unavailable");
            Assert(WebAuthnCreator.Create(new SoftwareAuthenticator { Flags = 0x01 }, default) is { Status: WebAuthnStatus.NotReady, Record: null }, "user verified missing at creation");
            Assert(WebAuthnCreator.Create(new SoftwareAuthenticator { RpId = "evil.example" }, default) is { Status: WebAuthnStatus.NotReady, Record: null }, "another rp id at creation");
            Assert(WebAuthnCreator.Create(new LyingAuthenticator(), default) is { Status: WebAuthnStatus.NotReady, Record: null }, "the credential id and the id inside the data disagree");
            Assert(WebAuthnCreator.Create(new ThrowingAuthenticator(), default) is { Status: WebAuthnStatus.NotReady, Record: null }, "exception");
        });
    }

    private sealed class ThrowingAuthenticator : IWebAuthnAuthenticator
    {
        public CreatedCredential MakeCredential(IntPtr window, byte[] userId, byte[] clientDataJson) => throw new DllNotFoundException();
        public AssertionResult GetAssertion(IntPtr window, byte[] clientDataJson, IReadOnlyList<byte[]> allowCredentialIds) => throw new DllNotFoundException();
    }

    private sealed class LyingAuthenticator : IWebAuthnAuthenticator
    {
        public CreatedCredential MakeCredential(IntPtr window, byte[] userId, byte[] clientDataJson)
        {
            (byte[] x, byte[] y, byte[] _) = NewPoint();
            return new CreatedCredential(WebAuthnStatus.Ok, [1, 2, 3], CreatedData([9, 9, 9], CoseEc2(x, y)));
        }

        public AssertionResult GetAssertion(IntPtr window, byte[] clientDataJson, IReadOnlyList<byte[]> allowCredentialIds) => throw new NotSupportedException();
    }

    private static void WebAuthnRouteChecks()
    {
        Check("command line: enroll --webauthn [--accept-unattested], keys list and keys remove <keyId> parse; there is NO keys add; the opt-in is accepted nowhere else; anything around them is a usage error", () =>
        {
            Assert(CommandLine.TryParse(["enroll", "--webauthn"]) == new CommandLine("enroll", null, "webauthn") && CommandLine.TryParse(["enroll", "--webauthn", "--accept-unattested"]) == new CommandLine("enroll", null, "webauthn", AcceptUnattested: true), "enroll --webauthn");
            Assert(CommandLine.TryParse(["keys", "list"]) == new CommandLine("keys", null, "list"), "keys list");
            Assert(CommandLine.TryParse(["keys", "remove", "webauthn-0123456789abcdef"]) == new CommandLine("keys", null, "remove", KeyId: "webauthn-0123456789abcdef") && CommandLine.TryParse(["keys", "remove", "hello-key-yosuke-01"]) is { KeyId: "hello-key-yosuke-01" }, "keys remove <id>");
            string[][] rejected =
            [
                ["enroll", "--webauthn", "--replace"], ["enroll", "--replace", "--webauthn"], ["enroll", "--accept-unattested", "--webauthn"], ["enroll", "--webauthn", "--show"], ["enroll", "--webauthn", "--check"], ["enroll", "--webauthn", "--accept-unattested", "--accept-unattested"],
                ["keys"], ["keys", "list", "--accept-unattested"], ["keys", "remove"], ["keys", "remove", "bad id"], ["keys", "remove", "webauthn-0123456789abcdef\n"], ["keys", "remove", ""], ["keys", "remove", "a", "b"],
                ["keys", "add"], ["keys", "add", "--accept-unattested"], ["keys", "add", "--yes"], ["keys", "remove", "webauthn-0123456789abcdef", "--accept-unattested"], ["keys", "delete", "webauthn-0123456789abcdef"], ["key", "list"], ["--webauthn"], ["list", "--webauthn"],
            ];
            foreach (string[] bad in rejected) Assert(CommandLine.TryParse(bad) is null, string.Join(' ', bad));
        });
        Check("signing choice: any registered WebAuthn key wins (with all their credential ids); Hello only on a local session; a remote session with no WebAuthn key cannot sign", () =>
        {
            byte[] a = [1], b = [2];
            RegisteredKey web1 = new("webauthn-0000000000000001", "webauthn", a), web2 = new("webauthn-0000000000000002", "webauthn", b), hello = new("hello-951a135537287eae", "hello-rsa", null);
            foreach (bool remote in new[] { false, true })
            {
                SigningRoute route = SigningRoute.Choose([hello, web1, web2], remote);
                Assert(route.Kind == RouteKind.WebAuthn && route.CredentialIds.Count == 2 && route.CredentialIds[0].SequenceEqual(a) && route.CredentialIds[1].SequenceEqual(b), $"webauthn, remote {remote}");
            }
            Assert(SigningRoute.Choose([hello], remoteSession: false).Kind == RouteKind.Hello && SigningRoute.Choose([], remoteSession: false).Kind == RouteKind.Hello, "Hello on a local session");
            Assert(SigningRoute.Choose([hello], remoteSession: true).Kind == RouteKind.RemoteNoKey && SigningRoute.Choose([], remoteSession: true).Kind == RouteKind.RemoteNoKey, "nothing can sign over Remote Desktop with Hello only");
        });
        Check("the Authority's keys reply is accepted only in the contract's exact shape (entries, kinds, ids, credential ids, duplicates, at most 16, nothing extra)", () =>
        {
            string W(string id = "webauthn-0123456789abcdef", string cred = "AQID") => $"{{\"keyId\":\"{id}\",\"kind\":\"webauthn\",\"credentialId\":\"{cred}\"}}";
            IReadOnlyList<RegisteredKey> Parse(string reply) => new KeyDirectory(new FakeChannel(_ => reply)).ListAsync().GetAwaiter().GetResult();
            IReadOnlyList<RegisteredKey> good = Parse(KeysReply(HelloEntry, W()));
            Assert(good.Count == 2 && good[0].Kind == "hello-rsa" && good[0].CredentialId is null && good[1].IsWebAuthn && good[1].CredentialId!.SequenceEqual(new byte[] { 1, 2, 3 }), "parsed");
            Assert(Parse("{\"ok\":true,\"keys\":[]}").Count == 0 && Parse(KeysReply([.. Enumerable.Range(0, 16).Select(i => W($"webauthn-{i:x16}", Url([(byte)i, 1])))])).Count == 16, "empty and 16");
            string[] bad =
            [
                KeysReply(W(), W("webauthn-0123456789abcdee")), KeysReply(W(), W(cred: "AQID")), KeysReply(HelloEntry, HelloEntry), "{\"ok\":true,\"keys\":[],\"extra\":1}", "{\"ok\":true}", "{\"ok\":true,\"keys\":{}}", "{\"ok\":true,\"keys\":[1]}",
                KeysReply("{\"keyId\":\"webauthn-0123456789abcdef\",\"kind\":\"webauthn\"}"), KeysReply("{\"keyId\":\"webauthn-0123456789abcdef\",\"kind\":\"webauthn\",\"credentialId\":\"AQID\",\"x\":1}"),
                KeysReply("{\"keyId\":\"hello-951a135537287eae\",\"kind\":\"hello-rsa\",\"credentialId\":\"AQID\"}"), KeysReply("{\"keyId\":\"hello-951a135537287eae\",\"kind\":\"passkey\"}"), KeysReply(W("hello-0123456789abcdef")),
                KeysReply(W("webauthn-0123456789ABCDEF")), KeysReply(W("webauthn-0123")), KeysReply(W(cred: "AQID=")), KeysReply(W(cred: "")), KeysReply(W(cred: Url(new byte[1024]))), KeysReply("{\"keyId\":\"bad id\",\"kind\":\"hello-rsa\"}"),
                KeysReply([.. Enumerable.Range(0, 17).Select(i => W($"webauthn-{i:x16}", Url([(byte)i, 1])))]), "not json", "[]",
            ];
            for (int i = 0; i < bad.Length; i++)
            {
                try { Parse(bad[i]); Assert(false, $"reply #{i} was accepted: {bad[i]}"); }
                catch (ChannelException ex) { Assert(ex.Code == ChannelCodes.InvalidResponse && ex.Sent, $"reply #{i}: {ex.Code}"); }
            }
            Assert(Parse(KeysReply(HelloEntry.Replace("hello-951a135537287eae", "hello-key-yosuke-01"))).Single().KeyId == "hello-key-yosuke-01", "a chosen Hello key id in the Authority's grammar (the legacy config pair) is fine");
            try { new KeyDirectory(new FakeChannel(_ => "{\"ok\":false,\"code\":\"last_key\"}")).ListAsync().GetAwaiter().GetResult(); Assert(false, "refusal"); }
            catch (AuthorityRefusal refusal) { Assert(refusal.Code == "last_key", refusal.Code); }
            try { new KeyDirectory(new FakeChannel(_ => "{\"ok\":false,\"code\":\"made_up\"}")).ListAsync().GetAwaiter().GetResult(); Assert(false, "unknown code"); }
            catch (ChannelException ex) { Assert(ex.Code == ChannelCodes.InvalidResponse, ex.Code); }
        });
    }

    private static void WebAuthnApproveChecks()
    {
        Check("approve with a registered WebAuthn key: keys is asked after the digest check and BEFORE the typed yes, the authenticator gets exactly the registered credential ids, and decide carries a proof the independent verifier accepts", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered key = Register(authenticator);
            byte[] elsewhere = RandomNumberGenerator.GetBytes(24);
            FakeChannel channel = WebAuthnChannel(KeysReply(HelloEntry, key.KeyJson, ListedElsewhere(elsewhere)), Entry());
            RecordingSigner hello = Signing();
            WebRun run = new(channel, hello, Kit(authenticator, remote: false));
            Assert(run.Approve() == ExitCodes.Ok && run.Err.ToString() == "", run.Err.ToString());
            Assert(Verbs(channel).SequenceEqual(["list", "keys", "decide"]) && run.Input.RequestsAtFirstRead == 2, $"list, keys, then the person is asked, then decide ({string.Join(',', Verbs(channel))}, asked after {run.Input.RequestsAtFirstRead})");
            Assert(hello.Messages.Count == 0, "the Hello signer is not asked");
            Assert(authenticator.AllowLists.Single().Select(Url).SequenceEqual([Url(key.CredentialId), Url(elsewhere)]), "allowCredentials = the registered WebAuthn credential ids");
            JsonElement decide = Frame(channel, "decide");
            Assert(decide.EnumerateObject().Select(p => p.Name).SequenceEqual(["v", "verb", "approvalId", "decision", "presence"]) && decide.GetProperty("decision").GetString() == "approve", "frame shape");
            Assert(ProofVerifies(decide.GetProperty("presence"), key.Key, PresenceBytes(), key.CredentialId), "the proof verifies over the presence message the app recomputed");
            string text = run.Out.ToString();
            Assert(text.IndexOf("digest check: OK", StringComparison.Ordinal) < text.IndexOf("Type yes", StringComparison.Ordinal) && text.IndexOf("Type yes", StringComparison.Ordinal) < text.IndexOf("Windows will ask you to verify with a registered WebAuthn key", StringComparison.Ordinal)
                && !text.Contains("Windows Hello will ask"), text);
        });
        Check("approve: with no WebAuthn key registered the Hello signer signs on a local session, exactly as before (a quoted base64 signature); an Authority from before WebAuthn (it does not know keys) is treated the same", () =>
        {
            foreach (string keysReply in new[] { KeysReply(HelloEntry), "{\"ok\":true,\"keys\":[]}", "{\"ok\":false,\"code\":\"request_invalid\"}" })
            {
                FakeChannel channel = WebAuthnChannel(keysReply, Entry());
                RecordingSigner hello = Signing();
                SoftwareAuthenticator authenticator = new();
                WebRun run = new(channel, hello, Kit(authenticator, remote: false));
                Assert(run.Approve() == ExitCodes.Ok, run.Err.ToString());
                Assert(hello.Messages.Count == 1 && authenticator.AllowLists.Count == 0, "Hello signed, the authenticator was not asked");
                JsonElement decide = Frame(channel, "decide");
                Assert(decide.GetProperty("presence").ValueKind == JsonValueKind.String && decide.GetProperty("presence").GetString() == Convert.ToBase64String(Sign(PresenceBytes())), "the old wire form");
                Assert(run.Out.ToString().Contains("Windows Hello will ask you to verify now. It shows only the app name: the request above is what you approve.\n"), "the old notice");
            }
        });
        Check("approve over Remote Desktop with no WebAuthn key: remote_session (69) with the hint, BEFORE the typed yes; nothing is asked, signed or sent", () =>
        {
            foreach (string keysReply in new[] { KeysReply(HelloEntry), "{\"ok\":false,\"code\":\"request_invalid\"}" })
            {
                FakeChannel channel = WebAuthnChannel(keysReply, Entry());
                RecordingSigner hello = Signing();
                SoftwareAuthenticator authenticator = new();
                WebRun run = new(channel, hello, Kit(authenticator, remote: true));
                Assert(run.Approve() == ExitCodes.SignerUnavailable, run.Err.ToString());
                string[] lines = run.Err.ToString().TrimEnd().Split('\n');
                Assert(lines[0] == "error: remote_session" && lines.Length == 2 && lines[1].Contains("Windows Hello does not work over Remote Desktop") && lines[1].Contains("enroll --webauthn") && lines[1].Contains("set-approver") && !lines[1].Contains("keys add"), run.Err.ToString());
                Assert(run.Input.RequestsAtFirstRead == -1 && !run.Out.ToString().Contains("Type yes"), "the person is never asked to type yes");
                Assert(hello.Messages.Count == 0 && authenticator.AllowLists.Count == 0 && channel.Decides == 0, "nothing signed, nothing asked, nothing sent");
            }
        });
        Check("approve over Remote Desktop with a WebAuthn key registered signs with it (the remote session only rules Hello out)", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered key = Register(authenticator);
            FakeChannel channel = WebAuthnChannel(KeysReply(HelloEntry, key.KeyJson), Entry());
            WebRun run = new(channel, Signing(), Kit(authenticator, remote: true));
            Assert(run.Approve() == ExitCodes.Ok, run.Err.ToString());
            Assert(ProofVerifies(Frame(channel, "decide").GetProperty("presence"), key.Key, PresenceBytes(), key.CredentialId), "proof");
        });
        Check("approve with a WebAuthn key: a dismissed prompt sends decide presence_unavailable (no presence field, the Authority fails it); an unusable or misbehaving authenticator sends nothing and exits 69", () =>
        {
            SoftwareAuthenticator cancelled = new() { Cancel = true };
            Registered key = Register(cancelled);
            FakeChannel channel = WebAuthnChannel(KeysReply(key.KeyJson), Entry());
            WebRun run = new(channel, Signing(), Kit(cancelled, remote: false));
            Assert(run.Approve() == ExitCodes.AuthorityRejected && run.Err.ToString() == "error: authority:presence_unavailable\n", run.Err.ToString());
            JsonElement decide = Frame(channel, "decide");
            Assert(decide.GetProperty("decision").GetString() == "presence_unavailable" && !decide.TryGetProperty("presence", out _), "no proof field");
            foreach ((string why, SoftwareAuthenticator authenticator) in new (string, SoftwareAuthenticator)[] { ("unavailable", new() { NotReady = true }), ("user verified missing", new() { Flags = 0x01 }), ("another rp id", new() { RpId = "evil.example" }), ("wrong credential", new() { WrongCredential = true }) })
            {
                Registered registered = Register(authenticator);
                FakeChannel quiet = WebAuthnChannel(KeysReply(registered.KeyJson), Entry());
                WebRun failing = new(quiet, Signing(), Kit(authenticator, remote: false));
                Assert(failing.Approve() == ExitCodes.SignerUnavailable && quiet.Decides == 0, $"{why}: {failing.Err}");
                string[] lines = failing.Err.ToString().TrimEnd().Split('\n');
                Assert(lines[0] == "error: presence_signer_unavailable" && lines.Length == 2 && lines[1].Contains("WebAuthn") && lines[1].Contains("Nothing was sent") && !lines[1].Contains("enroll"), $"{why}: {failing.Err}");
            }
        });
        Check("approve: the key list that cannot be read stops the approval before the typed yes (nothing is asked), and a digest mismatch is refused before the key list is even requested", () =>
        {
            SoftwareAuthenticator authenticator = new();
            FakeChannel down = new(request => request.Contains("\"verb\":\"list\"") ? Page([Entry()]) : "{\"ok\":false,\"code\":\"authority_unavailable\"}");
            WebRun failing = new(down, Signing(), Kit(authenticator, remote: false));
            Assert(failing.Approve() == ExitCodes.AuthorityRejected && failing.Err.ToString() == "error: authority:authority_unavailable\n" && failing.Input.RequestsAtFirstRead == -1 && authenticator.AllowLists.Count == 0, failing.Err.ToString());
            FakeChannel mismatch = WebAuthnChannel(KeysReply(HelloEntry), Entry(digest: "sha256:" + new string('0', 64)));
            WebRun refused = new(mismatch, Signing(), Kit(authenticator, remote: true));
            Assert(refused.Approve() == ExitCodes.Refused && refused.Err.ToString() == "error: digest_mismatch\n" && Verbs(mismatch).SequenceEqual(["list"]), $"{refused.Err} {string.Join(',', Verbs(mismatch))}");
        });
    }

    private static void WebAuthnPolicyChecks()
    {
        FakeChannel PolicyWithKeys(string keysReply) => new(request => request.Contains("\"verb\":\"keys\"") ? keysReply
            : request.Contains("\"verb\":\"policy_set\"") ? $"{{\"ok\":true,\"policyVersion\":\"{SentPolicy(request).Hash()}\"}}" : PolicyReply(PolicyJson(0, "careful")));
        Check("policy set (loosening) with a WebAuthn key: keys is asked before the typed yes, and policy_set carries a proof over the policy message; a change that only adds prompts never asks for keys", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered key = Register(authenticator);
            FakeChannel channel = PolicyWithKeys(KeysReply(HelloEntry, key.KeyJson));
            StringWriter output = new(), errors = new();
            CountingReader input = new("yes\n", () => channel.Requests.Count);
            PolicyCommand command = new(channel, Signing(), output, errors, input, true, Kit(authenticator, remote: false));
            Assert(command.SetAsync("standard", []).GetAwaiter().GetResult() == ExitCodes.Ok, errors.ToString());
            Assert(Verbs(channel).SequenceEqual(["policy", "keys", "policy_set"]) && input.RequestsAtFirstRead == 2, string.Join(',', Verbs(channel)));
            byte[] message = PolicyChange.Message(TierPolicy.TryCreate(1, "standard", [])!, Kid, Audience);
            Assert(ProofVerifies(Frame(channel, "policy_set").GetProperty("presence"), key.Key, message, key.CredentialId), "proof over albera.policy.v1 ...");
            Assert(output.ToString().Contains("Windows will ask you to verify with a registered WebAuthn key now") && output.ToString().Contains("the change above is what you approve"), output.ToString());
            FakeChannel adding = PolicyWithKeys(KeysReply(key.KeyJson));
            StringWriter addingOut = new();
            Assert(new PolicyCommand(adding, Signing(), addingOut, new StringWriter(), new StringReader(""), false, Kit(authenticator, remote: true)).SetAsync("careful", ["task.cancel"]).GetAwaiter().GetResult() == ExitCodes.Ok
                && !Verbs(adding).Contains("keys"), "adding prompts needs no key");
        });
        Check("policy set (loosening) over Remote Desktop with no WebAuthn key: remote_session before the typed yes; Hello on a local session is unchanged", () =>
        {
            SoftwareAuthenticator authenticator = new();
            FakeChannel channel = PolicyWithKeys(KeysReply(HelloEntry));
            StringWriter errors = new();
            CountingReader input = new("yes\n", () => channel.Requests.Count);
            RecordingSigner hello = new(SignResult.Signed(Sign(PolicyChange.Message(TierPolicy.TryCreate(1, "standard", [])!, Kid, Audience))));
            Assert(new PolicyCommand(channel, hello, new StringWriter(), errors, input, true, Kit(authenticator, remote: true)).SetAsync("standard", []).GetAwaiter().GetResult() == ExitCodes.SignerUnavailable
                && errors.ToString().StartsWith("error: remote_session\n") && input.RequestsAtFirstRead == -1 && hello.Messages.Count == 0 && !Verbs(channel).Contains("policy_set"), errors.ToString());
            FakeChannel local = PolicyWithKeys(KeysReply(HelloEntry));
            RecordingSigner helloLocal = new(SignResult.Signed(Sign(PolicyChange.Message(TierPolicy.TryCreate(1, "standard", [])!, Kid, Audience))));
            Assert(new PolicyCommand(local, helloLocal, new StringWriter(), new StringWriter(), new StringReader("yes\n"), true, Kit(authenticator, remote: false)).SetAsync("standard", []).GetAwaiter().GetResult() == ExitCodes.Ok
                && helloLocal.Messages.Count == 1 && Frame(local, "policy_set").GetProperty("presence").ValueKind == JsonValueKind.String, "Hello on a local session");
        });
    }

}
