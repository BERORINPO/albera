using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Albera.ApprovalAuthority;
using Albera.BrokerContract;

// WebAuthn presence and the approver key list (docs/architecture/approver-webauthn.md, phase 2 of the "Wire contract"). In-process, with REAL keys: throw-away ECDSA P-256 and RSA keys sign
// synthetic authenticatorData the way an authenticator does, and the production verifier checks them. The client data, the canonical key record, its digest and the add / remove messages are built
// here from the document, NOT with the production helpers, so a drift between the two shows up as a failure. The only files are in a temp folder this process creates.
internal static partial class Harness
{
    private const string RpId = "approver.albera.local";

    private static string B64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>The client data from the document, built independently of WebAuthn.ClientData.</summary>
    private static byte[] ClientDataFor(byte[] message, string type = "webauthn.get", string origin = "albera://approver", string crossOrigin = "false", byte[]? challengeFrom = null) =>
        Encoding.UTF8.GetBytes($"{{\"type\":\"{type}\",\"challenge\":\"{B64Url(SHA256.HashData(challengeFrom ?? message))}\",\"origin\":\"{origin}\",\"crossOrigin\":{crossOrigin}}}");

    /// <summary>What an authenticator does: sign authenticatorData || SHA-256(clientData) with a key it keeps. ES256 (DER) or RS256 (PKCS#1 v1.5).</summary>
    private sealed class Authenticator : IDisposable
    {
        private readonly ECDsa? ec;
        private readonly RSA? rsa;
        public readonly byte[] CredentialId;
        public readonly byte[] Spki;
        public readonly ApproverKey Key;

        public Authenticator(bool rsaKey = false, int credentialIdBytes = 32)
        {
            CredentialId = RandomNumberGenerator.GetBytes(credentialIdBytes);
            if (rsaKey) { rsa = RSA.Create(2048); Spki = rsa.ExportSubjectPublicKeyInfo(); }
            else { ec = ECDsa.Create(ECCurve.NamedCurves.nistP256); Spki = ec.ExportSubjectPublicKeyInfo(); }
            Key = ApproverKeyRules.TryCreate("webauthn-" + Convert.ToHexStringLower(SHA256.HashData(Spki).AsSpan(0, 8)), "webauthn", rsaKey ? -257 : -7, Spki, CredentialId, requireDerivedId: true)
                ?? throw new CheckFailed("the test key was rejected");
        }

        public byte[] Sign(byte[] data) => ec is not null ? ec.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence) : rsa!.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        public static byte[] AuthData(uint count = 1, byte flags = 0x05, string rpId = RpId) =>
            [.. SHA256.HashData(Encoding.UTF8.GetBytes(rpId)), flags, (byte)(count >> 24), (byte)(count >> 16), (byte)(count >> 8), (byte)count];

        /// <summary>A correct assertion over <paramref name="message"/> unless a part is overridden.</summary>
        public WebAuthnAssertion Assertion(byte[] message, uint count = 1, byte flags = 0x05, byte[]? authData = null, byte[]? clientData = null)
        {
            byte[] data = authData ?? AuthData(count, flags);
            return new(CredentialId, data, Sign([.. data, .. SHA256.HashData(clientData ?? ClientDataFor(message))]));
        }

        public byte[] Proof(byte[] message, uint count = 1) => WebAuthnProof.Encode(Assertion(message, count));

        public string Wire(byte[] message, uint count = 1) => WireOf(Assertion(message, count));

        public void Dispose() { ec?.Dispose(); rsa?.Dispose(); }
    }

    private static string WireOf(WebAuthnAssertion a) =>
        $"{{\"kind\":\"webauthn\",\"credentialId\":\"{B64Url(a.CredentialId)}\",\"authenticatorData\":\"{Convert.ToBase64String(a.AuthenticatorData)}\",\"signature\":\"{Convert.ToBase64String(a.Signature)}\"}}";

    /// <summary>The key record of the document, as JSON text, built here.</summary>
    private static string KeyJson(ApproverKey key) => CanonicalText(key);

    /// <summary>The canonical bytes of the document: this JSON, keys in this order, no spaces, credentialId left out for hello-rsa.</summary>
    private static string CanonicalText(ApproverKey key) =>
        $"{{\"keyId\":\"{key.KeyId}\",\"kind\":\"{key.KindName}\",\"alg\":{key.Alg},\"publicKey\":\"{Convert.ToBase64String(key.PublicKey)}\"" + (key.CredentialId is null ? "}" : $",\"credentialId\":\"{B64Url(key.CredentialId)}\"}}");

    private static string RecordDigest(ApproverKey key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(CanonicalText(key))));

    private static byte[] RemoveMessage(ApproverKey key, string challenge) => Encoding.UTF8.GetBytes($"albera.keyremove.v1\0{key.KeyId}\0{RecordDigest(key)}\0{challenge}");

    /// <summary>The Hello key of the harness as an older config pins it: its own id, not the derived one.</summary>
    private static ApproverKey HelloKeyRecord() =>
        ApproverKeyRules.TryCreate("hello-key-yosuke-01", "hello-rsa", -257, Hello.ExportSubjectPublicKeyInfo(), null, requireDerivedId: false) ?? throw new CheckFailed("the Hello key was rejected");

    private static string HelloWire(byte[] message) => "\"" + Convert.ToBase64String(Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) + "\"";

    /// <summary>The Authority core with an in-memory approver key set (the Hello key unless said otherwise), the key set's clock being the fixture's.</summary>
    private sealed class KeyFixture
    {
        public readonly Fixture Fx;
        public readonly ApproverKeySet Keys;

        /// <param name="policyFor">builds the policy store from the key set's verifier for stored proofs (a file-backed store needs the keys to check the proof it reads)</param>
        public KeyFixture(IEnumerable<ApproverKey>? initial = null, PolicyStore? policy = null, Func<IHumanPresenceVerifier, PolicyStore>? policyFor = null)
        {
            Fixture? holder = null;
            Keys = ApproverKeySet.InMemory(initial ?? [HelloKeyRecord()], () => holder!.Now);
            Fx = holder = new Fixture(presence: Keys, policy: policy ?? policyFor?.Invoke(Keys.ForStoredProofs));
        }

        public JsonElement Decide(string approvalId, string presenceJson) =>
            Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{approvalId}\",\"decision\":\"approve\",\"presence\":{presenceJson}}}");

        public string Pending(string op = "op-1") => ApprovalIdOf(Fx.Submit(SubmitJson(op: op, idem: op == "op-1" ? "idem-1" : op)));

        public byte[] MessageOf(string approvalId)
        {
            PendingEntry entry = Fx.Store.Get(approvalId)!;
            return PresenceMessage.Build(entry.ApprovalId, entry.ActionDigest, entry.Challenge);
        }

        public JsonElement KeysReply() => Fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"keys\"}");

        public JsonElement ChallengeFor(string op, string keyId) => Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"{op}\",\"keyId\":\"{keyId}\"}}");

        public string ChallengeValue(string op, string keyId)
        {
            JsonElement reply = ChallengeFor(op, keyId);
            Assert(Code(reply) == "ok", $"key_challenge {op}: {reply}");
            return reply.GetProperty("challenge").GetString()!;
        }

        public JsonElement KeyRemove(string challenge, string keyId, string byJson) =>
            Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{keyId}\",\"challenge\":\"{challenge}\",\"by\":{byJson}}}");

        public string[] KeyIds => [.. Keys.Keys.Select(k => k.KeyId)];
    }

    private static string ApproverKeyIdOf(KeyFixture k, string approvalId) =>
        JsonDocument.Parse(k.Fx.Store.Get(approvalId)!.Receipt!).RootElement.GetProperty("approverKeyId").GetString()!;

    private static void ApproverKeyChecks()
    {
        WebAuthnVerifierChecks();
        WebAuthnProofShapeChecks();
        KeyRecordChecks();
        ApproverKeyDecideChecks();
        ApproverKeyChallengeChecks();
        ApproverKeyRemoveChecks();
        ApproverKeyStoreChecks();
        ApproverKeyConfigChecks();
        PolicyResetOnKeyRemoveChecks();
    }

    // ---- the verifier: rules 1 to 4 -----------------------------------------------------------------------------------------------------------
    private static void WebAuthnVerifierChecks()
    {
        Check("webauthn: the client data the Authority rebuilds is exactly the document's bytes, whatever the message", () =>
        {
            foreach (byte[] message in new[] { Encoding.UTF8.GetBytes("m"), PresenceMessage.Build("00000000-0000-4000-8000-000000000000", "sha256:" + new string('a', 64), "_-7dzLuqmYh3ZlVEMyIRAA") })
                Assert(WebAuthn.ClientData(message).AsSpan().SequenceEqual(ClientDataFor(message)), "client data differs from the document");
            Assert(Encoding.UTF8.GetString(WebAuthn.ClientData([1])).StartsWith("{\"type\":\"webauthn.get\",\"challenge\":\"", StringComparison.Ordinal), "starts as documented");
            Assert(WebAuthn.RpId == RpId && WebAuthn.Origin == "albera://approver", "rp id and origin constants");
        });
        Check("webauthn: an ES256 and an RS256 assertion over the message verify, and the key set reports which key signed", () =>
        {
            using Authenticator es = new(), rs = new(rsaKey: true);
            ApproverKeySet keys = ApproverKeySet.InMemory([es.Key, rs.Key, HelloKeyRecord()], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("presence message");
            Assert(keys.Verify(message, es.Proof(message), out string? esId) == PresenceResult.Verified && esId == es.Key.KeyId, "ES256");
            Assert(keys.Verify(message, rs.Proof(message), out string? rsId) == PresenceResult.Verified && rsId == rs.Key.KeyId, "RS256");
            Assert(keys.Verify(message, Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), out string? helloId) == PresenceResult.Verified && helloId == "hello-key-yosuke-01", "the Hello key keeps working in the raw form");
        });
        Check("webauthn: the Authority tries each registered Hello key for a raw signature and names the one that verified", () =>
        {
            using RSA second = RSA.Create(2048);
            byte[] spki = second.ExportSubjectPublicKeyInfo();
            ApproverKey secondKey = ApproverKeyRules.TryCreate("hello-" + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8)), "hello-rsa", -257, spki, null, requireDerivedId: true)!;
            ApproverKeySet keys = ApproverKeySet.InMemory([HelloKeyRecord(), secondKey], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m");
            Assert(keys.Verify(message, second.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), out string? id) == PresenceResult.Verified && id == secondKey.KeyId, "the second Hello key");
            Assert(keys.Verify(message, Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), out id) == PresenceResult.Verified && id == "hello-key-yosuke-01", "the first");
        });
        Check("webauthn rule 1: a credential id that is not registered, or a signature under another key's credential id, is a Mismatch", () =>
        {
            using Authenticator registered = new(), stranger = new(), other = new();
            ApproverKeySet keys = ApproverKeySet.InMemory([registered.Key, other.Key], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m");
            Assert(keys.Verify(message, stranger.Proof(message)) == PresenceResult.Mismatch, "unregistered credential");
            WebAuthnAssertion theirs = stranger.Assertion(message);
            Assert(keys.Verify(message, WebAuthnProof.Encode(theirs with { CredentialId = registered.CredentialId })) == PresenceResult.Mismatch, "a stranger's signature under a registered credential id");
            WebAuthnAssertion mine = registered.Assertion(message);
            Assert(keys.Verify(message, WebAuthnProof.Encode(mine with { CredentialId = other.CredentialId })) == PresenceResult.Mismatch, "a registered key's signature under another registered credential id");
            Assert(keys.Verify(message, WebAuthnProof.Encode(mine with { CredentialId = [.. registered.CredentialId, 0] })) == PresenceResult.Mismatch, "a credential id with a trailing byte");
        });
        Check("webauthn rule 2: authenticatorData of 36 or 38 bytes, another rp id, user presence or user verification missing, attested data or extensions set are each a Mismatch (the signature is valid for the bad data)", () =>
        {
            using Authenticator a = new();
            ApproverKeySet keys = ApproverKeySet.InMemory([a.Key], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m");
            byte[] good = Authenticator.AuthData();
            Assert(keys.Verify(message, WebAuthnProof.Encode(a.Assertion(message))) == PresenceResult.Verified, "control: the good data verifies");
            (string name, byte[] data)[] bad =
            [
                ("36 bytes", good[..36]), ("38 bytes", [.. good, 0]), ("an extension block after 37", [.. Authenticator.AuthData(2, 0x85), 0xA0]),
                ("another rp id", Authenticator.AuthData(3, rpId: "approver.albera.example")), ("user present clear", Authenticator.AuthData(4, flags: 0x04)),
                ("user verified clear", Authenticator.AuthData(5, flags: 0x01)), ("neither flag", Authenticator.AuthData(6, flags: 0x00)),
                ("attested data set", Authenticator.AuthData(7, flags: 0x45)), ("extensions set", Authenticator.AuthData(8, flags: 0x85)),
            ];
            foreach ((string name, byte[] data) in bad)
                Assert(keys.Verify(message, WebAuthnProof.Encode(a.Assertion(message, authData: data))) == PresenceResult.Mismatch, name);
            Assert(keys.Verify(message, WebAuthnProof.Encode(a.Assertion(message, 9, flags: 0x1D))) == PresenceResult.Verified, "backup eligible / backup state bits (0x08, 0x10) are fine beside UP and UV");
        });
        Check("webauthn rule 3: a signature over other client data (type, origin, crossOrigin, another message's challenge, a space), over other authenticatorData, by another key or damaged is a Mismatch", () =>
        {
            using Authenticator es = new(), rs = new(rsaKey: true), wrong = new();
            byte[] message = Encoding.UTF8.GetBytes("m"), other = Encoding.UTF8.GetBytes("n");
            foreach (Authenticator a in new[] { es, rs })
            {
                ApproverKeySet keys = ApproverKeySet.InMemory([a.Key], () => Start);
                (string name, byte[] clientData)[] bad =
                [
                    ("type webauthn.create", ClientDataFor(message, type: "webauthn.create")), ("another origin", ClientDataFor(message, origin: "albera://approver/")),
                    ("crossOrigin true", ClientDataFor(message, crossOrigin: "true")), ("another message's challenge", ClientDataFor(message, challengeFrom: other)),
                    ("a space", Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(ClientDataFor(message)).Replace("\"type\":", "\"type\": ", StringComparison.Ordinal))),
                ];
                foreach ((string name, byte[] clientData) in bad) Assert(keys.Verify(message, WebAuthnProof.Encode(a.Assertion(message, clientData: clientData))) == PresenceResult.Mismatch, $"{a.Key.Alg}: {name}");
                Assert(keys.Verify(other, a.Proof(message)) == PresenceResult.Mismatch, $"{a.Key.Alg}: a signature for another message");
                WebAuthnAssertion good = a.Assertion(message);
                byte[] flipped = [.. good.Signature];
                flipped[^1] ^= 1;
                Assert(keys.Verify(message, WebAuthnProof.Encode(good with { Signature = flipped })) == PresenceResult.Mismatch, $"{a.Key.Alg}: a damaged signature");
                Assert(keys.Verify(message, WebAuthnProof.Encode(good with { Signature = good.Signature[..^1] })) == PresenceResult.Mismatch, $"{a.Key.Alg}: a truncated signature");
                Assert(keys.Verify(message, WebAuthnProof.Encode(good with { Signature = [] })) == PresenceResult.Mismatch, $"{a.Key.Alg}: no signature");
                Assert(keys.Verify(message, WebAuthnProof.Encode(good with { AuthenticatorData = Authenticator.AuthData(2) })) == PresenceResult.Mismatch, $"{a.Key.Alg}: authenticatorData changed after signing");
                WebAuthnAssertion byOther = wrong.Assertion(message);
                Assert(keys.Verify(message, WebAuthnProof.Encode(byOther with { CredentialId = a.CredentialId })) == PresenceResult.Mismatch, $"{a.Key.Alg}: another key's signature");
            }
            // The algorithm is the one the key was registered with: an RSA signature never satisfies an ES256 key, nor a DER-less (P1363) one.
            ApproverKeySet esKeys = ApproverKeySet.InMemory([es.Key], () => Start);
            WebAuthnAssertion p1363 = es.Assertion(message);
            using ECDsa raw = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            byte[] rawData = [.. p1363.AuthenticatorData, .. SHA256.HashData(ClientDataFor(message))];
            Assert(esKeys.Verify(message, WebAuthnProof.Encode(p1363 with { Signature = raw.SignData(rawData, HashAlgorithmName.SHA256) })) == PresenceResult.Mismatch, "a signature by another EC key (P1363 form)");
            Assert(esKeys.Verify(message, WebAuthnProof.Encode(p1363 with { Signature = rs.Sign(rawData) })) == PresenceResult.Mismatch, "an RSA signature for an ES256 key");
        });
        Check("webauthn rule 3: an RS256 key accepts PKCS#1 v1.5 / SHA-256 only (not PSS, not SHA-384)", () =>
        {
            using RSA rsa = RSA.Create(2048);
            byte[] credentialId = RandomNumberGenerator.GetBytes(32), spki = rsa.ExportSubjectPublicKeyInfo();
            ApproverKey key = ApproverKeyRules.TryCreate("webauthn-" + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8)), "webauthn", -257, spki, credentialId, true)!;
            ApproverKeySet keys = ApproverKeySet.InMemory([key], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m"), data = [.. Authenticator.AuthData(), .. SHA256.HashData(ClientDataFor(message))];
            Assert(keys.Verify(message, WebAuthnProof.Encode(new(credentialId, Authenticator.AuthData(), rsa.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)))) == PresenceResult.Verified, "control");
            Assert(keys.Verify(message, WebAuthnProof.Encode(new(credentialId, Authenticator.AuthData(), rsa.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pss)))) == PresenceResult.Mismatch, "PSS");
            Assert(keys.Verify(message, WebAuthnProof.Encode(new(credentialId, Authenticator.AuthData(), rsa.SignData(data, HashAlgorithmName.SHA384, RSASignaturePadding.Pkcs1)))) == PresenceResult.Mismatch, "SHA-384");
        });
        Check("webauthn rule 4: once a count above 0 is stored the next must be larger, a 0 included; while the stored count is 0 anything goes; counts are per key; a bad signature moves nothing", () =>
        {
            using Authenticator a = new(), b = new();
            ApproverKeySet keys = ApproverKeySet.InMemory([a.Key, b.Key], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m");
            PresenceResult With(Authenticator who, uint count) => keys.Verify(message, who.Proof(message, count));
            Assert(With(a, 5) == PresenceResult.Verified, "first count 5");
            Assert(With(a, 6) == PresenceResult.Verified, "6 after 5");
            Assert(With(a, 6) == PresenceResult.Mismatch, "6 again (a replay or a clone)");
            Assert(With(a, 5) == PresenceResult.Mismatch, "5 after 6");
            Assert(With(a, 0) == PresenceResult.Mismatch, "a 0 after a stored count above 0 is a mismatch (a cloned authenticator can look like that)");
            Assert(With(a, 6) == PresenceResult.Mismatch, "and that 0 did not move the stored count");
            Assert(With(a, 7) == PresenceResult.Verified, "7 after 6");
            Assert(With(b, 1) == PresenceResult.Verified, "the count is per key: b starts at 1 although a is at 7");
            WebAuthnAssertion bad = a.Assertion(message, 100);
            Assert(keys.Verify(message, WebAuthnProof.Encode(bad with { Signature = [.. bad.Signature[..^1], (byte)(bad.Signature[^1] ^ 1)] })) == PresenceResult.Mismatch, "a damaged signature with a big count");
            Assert(With(a, 8) == PresenceResult.Verified, "the damaged signature did not move the stored count to 100");
            ApproverKeySet zeroes = ApproverKeySet.InMemory([a.Key], () => Start);
            Assert(zeroes.Verify(message, a.Proof(message, 0)) == PresenceResult.Verified && zeroes.Verify(message, a.Proof(message, 0)) == PresenceResult.Verified, "0 and 0 repeat freely");
            Assert(zeroes.Verify(message, a.Proof(message, 3)) == PresenceResult.Verified, "a first non-zero count after 0 is fine");
            Assert(zeroes.Verify(message, a.Proof(message, 0)) == PresenceResult.Mismatch && zeroes.Verify(message, a.Proof(message, 3)) == PresenceResult.Mismatch && zeroes.Verify(message, a.Proof(message, 4)) == PresenceResult.Verified, "and from then on a 0 or a repeat is a mismatch");
            ApproverKeySet fresh = ApproverKeySet.InMemory([a.Key], () => Start);
            Assert(fresh.Verify(message, a.Proof(message, 0)) == PresenceResult.Verified && fresh.Verify(message, a.Proof(message, 1)) == PresenceResult.Verified && fresh.Verify(message, a.Proof(message, 0)) == PresenceResult.Mismatch, "0, then 1, then 0 again");
            ApproverKeySet hello = ApproverKeySet.InMemory([HelloKeyRecord()], () => Start);
            byte[] raw = Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            Assert(hello.Verify(message, raw) == PresenceResult.Verified && hello.Verify(message, raw) == PresenceResult.Verified, "a Hello key has no counter: the same signature verifies again (the message is what binds it)");
        });
        Check("webauthn: a proof that is checked again later (the one stored beside policy.json) neither needs a larger sign count nor moves it", () =>
        {
            using Authenticator a = new();
            ApproverKeySet keys = ApproverKeySet.InMemory([a.Key], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m"), proof = a.Proof(message, 4);
            Assert(keys.Verify(message, proof) == PresenceResult.Verified, "first, fresh");
            Assert(keys.ForStoredProofs.Verify(message, proof) == PresenceResult.Verified && keys.ForStoredProofs.Verify(message, proof) == PresenceResult.Verified, "again and again as a stored proof");
            Assert(keys.Verify(message, a.Proof(message, 5)) == PresenceResult.Verified, "the stored checks did not move the count");
        });
    }

    // ---- malformed input: Mismatch or a refusal, never an exception ------------------------------------------------------------------------------
    private static void WebAuthnProofShapeChecks()
    {
        Check("webauthn: a malformed proof (no magic, cut at every length, trailing bytes, lengths that lie, random bytes) is a Mismatch and never throws", () =>
        {
            using Authenticator a = new(), rs = new(rsaKey: true);
            ApproverKeySet keys = ApproverKeySet.InMemory([a.Key, rs.Key, HelloKeyRecord()], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m"), proof = a.Proof(message);
            for (int length = 0; length < proof.Length; length++) Assert(keys.Verify(message, proof[..length]) == PresenceResult.Mismatch, $"cut at {length}");
            Assert(keys.Verify(message, [.. proof, 0]) == PresenceResult.Mismatch, "a trailing byte");
            byte[] lie = [.. proof];
            lie[6] = 255; // credential id length, high byte
            Assert(keys.Verify(message, lie) == PresenceResult.Mismatch, "credential id length lies");
            Assert(keys.Verify(message, RandomNumberGenerator.GetBytes(256)) == PresenceResult.Mismatch, "random 256 bytes");
            Assert(keys.Verify(message, RandomNumberGenerator.GetBytes(37)) == PresenceResult.Mismatch, "random 37 bytes");
            Assert(keys.Verify(message, "ALBWA1"u8.ToArray()) == PresenceResult.Mismatch, "the magic alone");
            Assert(keys.Verify(message, [.. "ALBWA1"u8.ToArray(), .. RandomNumberGenerator.GetBytes(300)]) == PresenceResult.Mismatch, "the magic and noise");
            Assert(keys.Verify([], []) == PresenceResult.Mismatch, "empty message, empty proof");
        });
        Check("webauthn: a webauthn proof never satisfies a Hello key and a raw RSA signature never satisfies a webauthn key", () =>
        {
            using Authenticator a = new(), rs = new(rsaKey: true);
            byte[] message = Encoding.UTF8.GetBytes("m");
            ApproverKeySet helloOnly = ApproverKeySet.InMemory([HelloKeyRecord()], () => Start);
            Assert(helloOnly.Verify(message, a.Proof(message)) == PresenceResult.Mismatch && helloOnly.Verify(message, rs.Proof(message)) == PresenceResult.Mismatch, "webauthn proofs against a Hello-only list");
            ApproverKeySet webOnly = ApproverKeySet.InMemory([a.Key, rs.Key], () => Start);
            Assert(webOnly.Verify(message, Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) == PresenceResult.Mismatch, "the Hello signature against a webauthn-only list");
            using RSA same = RSA.Create(2048);
            Assert(webOnly.Verify(message, same.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) == PresenceResult.Mismatch, "a raw signature by an unknown RSA key");
        });
        Check("webauthn wire: the proof object is exactly four keys with canonical base64; a shape error is request_invalid, a bad assertion is presence_mismatch", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new([a.Key]);
            string id = k.Pending();
            byte[] message = k.MessageOf(id);
            WebAuthnAssertion good = a.Assertion(message);
            string credential = B64Url(good.CredentialId), data = Convert.ToBase64String(good.AuthenticatorData), signature = Convert.ToBase64String(good.Signature);
            string Obj(string kind = "webauthn", string? cred = null, string? auth = null, string? sig = null, string extra = "") =>
                $"{{\"kind\":\"{kind}\",\"credentialId\":\"{cred ?? credential}\",\"authenticatorData\":\"{auth ?? data}\",\"signature\":\"{sig ?? signature}\"{extra}}}";
            string[] shapeErrors =
            [
                Obj(kind: "hello"), Obj(extra: ",\"clientData\":\"e30\""), "{\"kind\":\"webauthn\",\"credentialId\":\"" + credential + "\",\"authenticatorData\":\"" + data + "\"}", Obj(cred: credential + "="),
                Obj(cred: credential.Replace('-', '+').Replace('_', '/') + "*"), Obj(cred: ""), Obj(auth: data + "\n"), Obj(auth: data.TrimEnd('=')), Obj(sig: " " + signature), Obj(sig: ""), Obj(cred: new string('A', 1400)),
                Obj(sig: Convert.ToBase64String(new byte[600])), "[]", "7", "true", "null", "{}",
            ];
            foreach (string shape in shapeErrors) Assert(Code(k.Decide(id, shape)) == "request_invalid", $"accepted: {shape[..Math.Min(shape.Length, 120)]}");
            Assert(k.Fx.Store.Get(id)!.State == EntryState.Pending, "a shape error leaves the request pending");
            Assert(Code(k.Decide(id, Obj(auth: Convert.ToBase64String(good.AuthenticatorData[..30])))) == "presence_mismatch", "a short authenticatorData is a bad assertion, not a bad shape");
        });
        Check("webauthn wire: a credential id of up to 1023 bytes is carried and matched (the packed proof keeps a 16-bit length)", () =>
        {
            using Authenticator a = new(credentialIdBytes: 1023);
            KeyFixture k = new([a.Key]);
            string id = k.Pending();
            string wire = a.Wire(k.MessageOf(id));
            Assert(Encoding.UTF8.GetByteCount(wire) < AuthorityProtocol.MaxFrameBytes - 200, $"{wire.Length} characters leave room for the rest of a decide frame");
            Assert(Code(k.Decide(id, wire)) == "ok" && ApproverKeyIdOf(k, id) == a.Key.KeyId, "approved by the key with the 1023-byte credential id");
        });
    }

    // ---- key records ---------------------------------------------------------------------------------------------------------------------------
    private static void KeyRecordChecks()
    {
        Check("keys: a key record needs a supported algorithm and key, a credential id of 1..1023 bytes and the derived id (webauthn-<16 hex>)", () =>
        {
            using Authenticator es = new(), rs = new(rsaKey: true);
            using ECDsa p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            using RSA small = RSA.Create(1024), big = RSA.Create(4096);
            byte[] credential = RandomNumberGenerator.GetBytes(32);
            ApproverKey? Make(byte[] spki, long alg = -7, string kind = "webauthn", byte[]? cred = null, string? id = null, bool derived = true) =>
                ApproverKeyRules.TryCreate(id ?? ((kind == "webauthn" ? "webauthn-" : "hello-") + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8))), kind, alg, spki, cred ?? (kind == "webauthn" ? credential : null), derived);
            Assert(Make(es.Spki) is { Kind: ApproverKeyKind.WebAuthn, Alg: -7 } && Make(rs.Spki, -257) is { Alg: -257 }, "control");
            Assert(Make(big.ExportSubjectPublicKeyInfo(), -257) is not null, "RSA-4096 is allowed");
            Assert(Make(p384.ExportSubjectPublicKeyInfo()) is null, "P-384");
            Assert(Make(small.ExportSubjectPublicKeyInfo(), -257) is null, "RSA-1024");
            Assert(Make(rs.Spki, -7) is null && Make(es.Spki, -257) is null, "algorithm and key type must agree");
            Assert(Make(es.Spki, -35) is null && Make(es.Spki, 0) is null && Make(es.Spki, 7) is null, "unknown algorithm");
            Assert(Make([.. es.Spki, 0]) is null && Make(es.Spki[..^1]) is null, "trailing or missing byte in the SPKI");
            Assert(Make(es.Spki, cred: []) is null && Make(es.Spki, cred: new byte[1024]) is null && Make(es.Spki, cred: new byte[1023]) is not null && Make(es.Spki, cred: new byte[1]) is not null, "credential id length 1..1023");
            Assert(Make(es.Spki, id: "webauthn-0123456789abcdef") is null && Make(es.Spki, id: "my-key") is null, "a webauthn id is derived, never chosen");
            Assert(Make(es.Spki, id: "webauthn-0123456789abcdef", derived: false) is not null, "(an id that is only checked for grammar)");
            Assert(Make(es.Spki, kind: "other") is null, "unknown kind");
            Assert(ApproverKeyRules.TryCreate("hello-x", "hello-rsa", -257, Hello.ExportSubjectPublicKeyInfo(), credential, false) is null, "a Hello key has no credential id");
            Assert(ApproverKeyRules.TryCreate("hello-x", "hello-rsa", -7, Hello.ExportSubjectPublicKeyInfo(), null, false) is null, "a Hello key is RS256");
            Assert(ApproverKeyRules.TryCreate("hello-x", "hello-rsa", -257, rs.Spki, null, false) is not null, "(a 2048-bit RSA key is a Hello key)");
            Assert(ApproverKeyRules.TryCreate("hello-x", "hello-rsa", -257, big.ExportSubjectPublicKeyInfo(), null, false) is null, "a Hello key is exactly RSA-2048");
            Assert(ApproverKeyRules.TryCreate("bad id", "hello-rsa", -257, Hello.ExportSubjectPublicKeyInfo(), null, false) is null, "id grammar");
        });
        Check("keys: the canonical bytes of a record are the document's JSON (keys in order, no spaces, credentialId only for webauthn) and the digest is lower-case hex SHA-256 of them", () =>
        {
            using Authenticator es = new();
            ApproverKey hello = ApproverKeyRules.TryCreate("hello-" + Convert.ToHexStringLower(SHA256.HashData(Hello.ExportSubjectPublicKeyInfo()).AsSpan(0, 8)), "hello-rsa", -257, Hello.ExportSubjectPublicKeyInfo(), null, true)!;
            Assert(Encoding.UTF8.GetString(ApproverKeyRules.Canonical(es.Key)) == $"{{\"keyId\":\"{es.Key.KeyId}\",\"kind\":\"webauthn\",\"alg\":-7,\"publicKey\":\"{Convert.ToBase64String(es.Spki)}\",\"credentialId\":\"{B64Url(es.CredentialId)}\"}}", "webauthn");
            Assert(Encoding.UTF8.GetString(ApproverKeyRules.Canonical(hello)) == $"{{\"keyId\":\"{hello.KeyId}\",\"kind\":\"hello-rsa\",\"alg\":-257,\"publicKey\":\"{Convert.ToBase64String(hello.PublicKey)}\"}}", "hello-rsa");
            Assert(ApproverKeyRules.Digest(es.Key) == RecordDigest(es.Key) && System.Text.RegularExpressions.Regex.IsMatch(ApproverKeyRules.Digest(es.Key), "^[0-9a-f]{64}$"), "digest");
            Assert(Encoding.UTF8.GetString(KeyMessages.Remove(es.Key, "AAAAAAAAAAAAAAAAAAAAAA")) == Encoding.UTF8.GetString(RemoveMessage(es.Key, "AAAAAAAAAAAAAAAAAAAAAA")), "remove message");
            Assert(Encoding.UTF8.GetString(RemoveMessage(es.Key, "c")).Split('\0') is ["albera.keyremove.v1", { } id, { Length: 64 }, "c"] && id == es.Key.KeyId, "four parts separated by 0x00");
        });
        Check("keys: base64 is canonical (no whitespace, no non-zero stray bits, padding as written by the encoder) and url base64 has no padding or +/", () =>
        {
            Assert(Base64Text.TryDecode("AQID", 3, out byte[] ok) && ok.SequenceEqual(new byte[] { 1, 2, 3 }), "control");
            foreach (string bad in new[] { "", "AQI", "AQI=\n", " AQID", "AQID ", "AQ\nID", "AQF=", "AR==", "AQ=D", "AQID====", "AQ-D", "AQ_D", "AQID!" })
                Assert(!Base64Text.TryDecode(bad, 16, out _), $"standard accepted {bad.Replace("\n", "\\n")}");
            Assert(!Base64Text.TryDecode("AQID", 2, out _), "over the byte limit");
            Assert(Base64Text.TryDecodeUrl("AQI", 2, out byte[] two) && two.SequenceEqual(new byte[] { 1, 2 }) && Base64Text.TryDecodeUrl("-_8", 2, out byte[] ff) && ff.SequenceEqual(new byte[] { 0xFB, 0xFF }), "url control");
            foreach (string bad in new[] { "", "A", "AQI=", "AQ+/", "AR", "AQ I", "-_8=" })
                Assert(!Base64Text.TryDecodeUrl(bad, 16, out _), $"url accepted {bad}");
        });
        Check("keys verb: replies with each key's keyId, kind and (webauthn only) credentialId, nothing else; list is unchanged and takes no keys flag", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new([HelloKeyRecord(), a.Key]);
            JsonElement reply = k.KeysReply();
            Assert(Code(reply) == "ok" && reply.EnumerateObject().Count() == 2, $"{reply}");
            JsonElement[] keys = [.. reply.GetProperty("keys").EnumerateArray()];
            Assert(keys.Length == 2, "two keys");
            JsonElement hello = keys.Single(x => x.GetProperty("kind").GetString() == "hello-rsa"), web = keys.Single(x => x.GetProperty("kind").GetString() == "webauthn");
            Assert(hello.GetProperty("keyId").GetString() == "hello-key-yosuke-01" && hello.EnumerateObject().Count() == 2, "the Hello key: id and kind");
            Assert(web.GetProperty("keyId").GetString() == a.Key.KeyId && web.GetProperty("credentialId").GetString() == B64Url(a.CredentialId) && web.EnumerateObject().Count() == 3, "the webauthn key: id, kind, credential id");
            Assert(!reply.GetRawText().Contains(Convert.ToBase64String(a.Spki), StringComparison.Ordinal), "no public key in the reply");
            Assert(!k.Fx.List().TryGetProperty("keys", out _) && Code(k.Fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"list\",\"keys\":true}")) == "request_invalid", "list keeps its shape and does not take a keys flag");
            Assert(Code(k.Fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"keys\",\"x\":1}")) == "request_invalid" && Code(k.Fx.Call(PipeRole.Submit, "{\"v\":1,\"verb\":\"keys\"}")) == "request_invalid", "no extra key, not on the submit pipe");
        });
        Check("keys verb: the reply for the longest list the Authority accepts fits one 2 KiB frame; a list that would not fit is refused where it is read (config_approver_keys, approver_keys_invalid)", () =>
        {
            Authenticator[] ordinary = [.. Enumerable.Range(0, ApproverKeyRules.MaxKeys).Select(_ => new Authenticator())];
            List<Authenticator> heavy = [];
            try
            {
                KeyFixture k = new(ordinary.Select(x => x.Key));
                byte[] frame = k.Fx.Protocol.Handle(PipeRole.Approver, Encoding.UTF8.GetBytes("{\"v\":1,\"verb\":\"keys\"}"));
                Assert(frame.Length <= AuthorityProtocol.MaxFrameBytes && Parse(frame).GetProperty("keys").GetArrayLength() == 16, $"sixteen keys with 32-byte credential ids: {frame.Length} bytes");
                Assert(ApproverKeyRules.Fits(ordinary.Select(x => x.Key).ToList()), "and they fit");
                for (int i = 0; i < ApproverKeyRules.MaxKeys; i++)
                {
                    heavy.Add(new Authenticator(credentialIdBytes: 120));
                    if (!ApproverKeyRules.Fits(heavy.Select(x => x.Key).ToList())) break;
                }
                IReadOnlyList<ApproverKey> tooMany = [.. heavy.Select(x => x.Key)];
                IReadOnlyList<ApproverKey> largest = [.. tooMany.Take(tooMany.Count - 1)];
                Assert(largest.Count is > 0 and < 16 && !ApproverKeyRules.Fits(tooMany), $"120-byte credential ids stop at {largest.Count} keys");
                byte[] longest = new KeyFixture(largest).Fx.Protocol.Handle(PipeRole.Approver, Encoding.UTF8.GetBytes("{\"v\":1,\"verb\":\"keys\"}"));
                Assert(longest.Length <= AuthorityProtocol.MaxFrameBytes, $"the longest list that fits: {longest.Length} bytes");
                Assert(ConfigReason(ListConfigJson(tooMany)) == "config_approver_keys", "a config list that does not fit");
            }
            finally { foreach (Authenticator a in ordinary.Concat(heavy)) a.Dispose(); }
        });
    }

    // ---- decide with a webauthn proof ----------------------------------------------------------------------------------------------------------
    private static void ApproverKeyDecideChecks()
    {
        Check("decide: any one registered key approves (ES256, RS256, Hello) and the receipt's approverKeyId names the key that signed", () =>
        {
            using Authenticator es = new(), rs = new(rsaKey: true);
            KeyFixture k = new([HelloKeyRecord(), es.Key, rs.Key]);
            string byEs = k.Pending(), byRs = k.Pending("b"), byHello = k.Pending("c");
            Assert(Code(k.Decide(byEs, es.Wire(k.MessageOf(byEs)))) == "ok", "ES256");
            Assert(Code(k.Decide(byRs, rs.Wire(k.MessageOf(byRs)))) == "ok", "RS256");
            Assert(Code(k.Decide(byHello, HelloWire(k.MessageOf(byHello)))) == "ok", "Hello, raw form");
            Assert(ApproverKeyIdOf(k, byEs) == es.Key.KeyId && ApproverKeyIdOf(k, byRs) == rs.Key.KeyId && ApproverKeyIdOf(k, byHello) == "hello-key-yosuke-01", "each receipt names its signer");
            (byte[] receipt, byte[] signature) = ReceiptOf(k.Fx.Status(byEs));
            using ECDsa signerKey = ECDsa.Create();
            signerKey.ImportSubjectPublicKeyInfo(k.Fx.Signer.PublicKeySpki, out _);
            ReceiptVerdict verdict = Verify(k.Fx, receipt);
            Assert(verdict.Ok, $"the contract rejects the receipt: {verdict.Code}/{verdict.Field}");
            Assert(signerKey.VerifyData(receipt, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation), "the Authority's signature verifies");
        });
        Check("decide: an unregistered credential, a replay on another request, a wrong rp id and an old assertion are presence_mismatch and final; nothing is signed", () =>
        {
            using Authenticator a = new(), stranger = new();
            KeyFixture k = new([a.Key]);
            string first = k.Pending("a"), second = k.Pending("b"), third = k.Pending("c"), fourth = k.Pending("d");
            Assert(Code(k.Decide(first, stranger.Wire(k.MessageOf(first)))) == "presence_mismatch", "unregistered credential");
            Assert(k.Fx.Store.Get(first)!.State == EntryState.PresenceMismatch && k.Fx.Store.Get(first)!.Receipt is null, "final, no receipt");
            Assert(Code(k.Decide(second, a.Wire(k.MessageOf(first)))) == "presence_mismatch", "an assertion made for another request");
            Assert(Code(k.Decide(third, WireOf(a.Assertion(k.MessageOf(third), authData: Authenticator.AuthData(rpId: "approver.example"))))) == "presence_mismatch", "another rp id");
            Assert(Code(k.Decide(fourth, a.Wire(k.MessageOf(fourth)))) == "ok", "control: the right assertion approves");
            Assert(k.Fx.Store.Get(second)!.Receipt is null && k.Fx.Store.Get(third)!.Receipt is null, "no receipt for the refused ones");
        });
        Check("decide: the same assertion cannot approve twice (the request is no longer pending) and a lower sign count after a higher one is presence_mismatch", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new([a.Key]);
            string first = k.Pending("a"), second = k.Pending("b"), third = k.Pending("c");
            string proof = a.Wire(k.MessageOf(first), 10);
            Assert(Code(k.Decide(first, proof)) == "ok", "first use");
            Assert(Code(k.Decide(first, proof)) == "request_invalid", "second use of the same assertion on the same request");
            Assert(Code(k.Decide(second, a.Wire(k.MessageOf(second), 10))) == "presence_mismatch", "the count did not grow");
            Assert(Code(k.Decide(third, a.Wire(k.MessageOf(third), 11))) == "ok", "the count grew");
        });
        Check("decide: the single pinned key (no key set) is unchanged: receipts name the config's id, and there are no key verbs and an empty `keys`", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(Code(fx.ApproveSigned(id)) == "ok", "approve with the pinned key");
            Assert(JsonDocument.Parse(fx.Store.Get(id)!.Receipt!).RootElement.GetProperty("approverKeyId").GetString() == "hello-key-yosuke-01", "the config's id");
            Assert(Code(fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"add\",\"keyId\":\"webauthn-0123456789abcdef\"}")) == "request_invalid", "no key set, no key verbs");
            JsonElement keys = fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"keys\"}");
            Assert(Code(keys) == "ok" && keys.GetProperty("keys").GetArrayLength() == 0, "an empty key list");
        });
        Check("policy_set: a registered webauthn key authorizes a policy change (the proof object, bound to this Authority's kid and audience), the stored proof is read back, and a restart reads it", () =>
        {
            using Authenticator a = new(), rs = new(rsaKey: true);
            InFolder(config =>
            {
                File.WriteAllText(config, ConfigJson());
                ApproverKeySet keys = ApproverKeySet.InMemory([a.Key, rs.Key], () => Start);
                PolicyStore policy = PolicyStore.TryLoad(config, DefaultIdentity, keys.ForStoredProofs, out string reason, out _) ?? throw new CheckFailed($"policy: {reason}");
                Fixture fx = new(presence: keys, policy: policy);
                string standard = PolicyJson(1, "standard");
                byte[] message = PolicyChange.Message(PolicyOf(standard), "authority-key-2026-10", "albera-host-broker");
                string SetWith(string proofJson) => Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{standard},\"presence\":{proofJson}}}"));
                Assert(SetWith(a.Wire(PolicyChange.Message(PolicyOf(standard), "authority-key-other", "albera-host-broker"))) == "presence_mismatch", "another kid");
                Assert(SetWith(a.Wire(PresenceMessage.Build("00000000-0000-4000-8000-000000000000", "sha256:" + new string('a', 64), "_-7dzLuqmYh3ZlVEMyIRAA"))) == "presence_mismatch", "a presence message is not a policy message");
                Assert(SetWith(a.Wire(message, 3)) == "ok", "the right assertion");
                Assert(fx.Core.Policy() is { Tier: "standard", Revision: 1 }, "applied");
                Assert(File.Exists(PolicyStore.PathFor(config)) && File.ReadAllText(PolicyStore.PathFor(config)).Contains("\"authorized\"", StringComparison.Ordinal), "written with the proof that authorized it");
                PolicyStore? reloaded = PolicyStore.TryLoad(config, DefaultIdentity, keys.ForStoredProofs, out string again, out bool fromFile);
                Assert(reloaded is { } && fromFile && reloaded.Current.Tier == "standard", $"a restart reads the stored proof: {again}");
                ApproverKeySet without = ApproverKeySet.InMemory([rs.Key], () => Start);
                Assert(PolicyStore.TryLoad(config, DefaultIdentity, without.ForStoredProofs, out again, out _) is null && again == "policy_unsigned", "with the signing key removed from the list the file is unsigned (exit 79)");
                string next = PolicyJson(2, "standard", "environment.stop");
                Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{next}}}")) == "ok", "adding a prompt needs no signature");
            });
        });
        Check("policy_set: an RS256 proof (the biggest one a policy file stores) round-trips through policy.json, even with a 200-byte credential id; one that could not be stored is request_invalid", () =>
        {
            using Authenticator rs = new(rsaKey: true, credentialIdBytes: 200), huge = new(rsaKey: true, credentialIdBytes: 1023);
            InFolder(config =>
            {
                File.WriteAllText(config, ConfigJson());
                ApproverKeySet keys = ApproverKeySet.InMemory([rs.Key, huge.Key], () => Start);
                PolicyStore policy = PolicyStore.TryLoad(config, DefaultIdentity, keys.ForStoredProofs, out string reason, out _) ?? throw new CheckFailed(reason);
                Fixture fx = new(presence: keys, policy: policy);
                string standard = PolicyJson(1, "standard", "task.cancel", "environment.stop", "workspace.inspect", "environment.inspect");
                byte[] message = PolicyChange.Message(PolicyOf(standard), "authority-key-2026-10", "albera-host-broker");
                string Set(string proofJson) => Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{standard},\"presence\":{proofJson}}}"));
                Assert(Set(huge.Wire(message)) == "request_invalid", "a 1023-byte credential id plus an RSA signature is more than the policy file can keep");
                Assert(fx.Core.Policy() is { Revision: 0 }, "unchanged");
                Assert(Set(rs.Wire(message)) == "ok", "set");
                Assert(PolicyStore.TryLoad(config, DefaultIdentity, keys.ForStoredProofs, out reason, out bool fromFile) is { } && fromFile, $"reload: {reason}");
            });
        });
        Check("decide: a base64 string is only ever a raw RSA signature for the Hello keys: bytes that start with the webauthn marker are request_invalid and never read as an assertion (decide, policy_set, key_remove); the same assertion as an object is what approves", () =>
        {
            using Authenticator a = new(), b = new();
            KeyFixture k = new([HelloKeyRecord(), a.Key, b.Key]);
            byte[] marker = "ALBWA1"u8.ToArray();
            string AsString(byte[] bytes) => "\"" + Convert.ToBase64String(bytes) + "\"";
            string id = k.Pending();
            byte[] message = k.MessageOf(id);
            // a valid assertion in the internal packed form, sent as the legacy STRING: it must not be verified as a webauthn proof
            Assert(Code(k.Decide(id, AsString(a.Proof(message, 3)))) == "request_invalid", "a valid packed assertion as a string");
            foreach (byte[] bytes in new[] { marker, [.. marker, .. new byte[250]], [.. marker, .. RandomNumberGenerator.GetBytes(400)], [.. marker, .. a.Proof(message, 3)] })
                Assert(Code(k.Decide(id, AsString(bytes))) == "request_invalid", $"{bytes.Length} bytes starting with the marker");
            Assert(k.Fx.Store.Get(id)!.State == EntryState.Pending && k.Fx.Store.Get(id)!.Receipt is null, "a shape error leaves the request pending: nothing was decided");
            Assert(Code(k.Decide(id, a.Wire(message, 3))) == "ok", "the same assertion as an object approves (so the string was refused for being a string)");
            // the same in policy_set ...
            string standard = PolicyJson(1, "standard");
            byte[] policyMessage = PolicyChange.Message(PolicyOf(standard), "authority-key-2026-10", "albera-host-broker");
            Assert(Code(k.Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{standard},\"presence\":{AsString(b.Proof(policyMessage, 2))}}}")) == "request_invalid" && k.Fx.Core.Policy() is { Revision: 0 }, "policy_set");
            Assert(Code(k.Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{standard},\"presence\":{b.Wire(policyMessage, 2)}}}")) == "ok", "(and as an object it is accepted)");
            // ... and in key_remove, where a refused string leaves the challenge alone
            string challenge = k.ChallengeValue("remove", b.Key.KeyId);
            Assert(Code(k.KeyRemove(challenge, b.Key.KeyId, AsString(a.Proof(RemoveMessage(b.Key, challenge), 4)))) == "request_invalid" && k.Keys.Keys.Count == 3, "key_remove");
            Assert(Code(k.KeyRemove(challenge, b.Key.KeyId, a.Wire(RemoveMessage(b.Key, challenge), 4))) == "ok", "the object removes, with the same challenge: the refused string did not use it up");
            // a real 256-byte RSA signature is still what the Hello key signs
            string next = k.Pending("b");
            Assert(Code(k.Decide(next, HelloWire(k.MessageOf(next)))) == "ok", "control: the legacy string form works for a Hello key");
        });
        Check("one key list: the view the policy store keeps for stored proofs is the list the core changes, so a key_remove is seen by both (the production wiring passes one instance to each)", () =>
        {
            using Authenticator a = new(), b = new();
            KeyFixture k = new([HelloKeyRecord(), a.Key, b.Key]);
            IHumanPresenceVerifier policyStoresView = k.Keys.ForStoredProofs;
            byte[] message = Encoding.UTF8.GetBytes("a proof stored beside policy.json");
            byte[] proof = a.Proof(message, 1);
            Assert(policyStoresView.Verify(message, proof) == PresenceResult.Verified, "before the removal a's proof verifies through the policy store's view");
            string challenge = k.ChallengeValue("remove", a.Key.KeyId);
            Assert(Code(k.KeyRemove(challenge, a.Key.KeyId, b.Wire(RemoveMessage(a.Key, challenge), 1))) == "ok", "a is removed through the core");
            Assert(policyStoresView.Verify(message, proof) == PresenceResult.Mismatch, "after it the same view no longer vouches for a's proof");
            Assert(policyStoresView.Verify(message, b.Proof(message, 2)) == PresenceResult.Verified, "and still vouches for b's");
        });
    }
}
