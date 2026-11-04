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

    private static byte[] AddMessage(ApproverKey key, string challenge) => Encoding.UTF8.GetBytes($"albera.keyadd.v1\0{key.KeyId}\0{RecordDigest(key)}\0{challenge}");

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

        public KeyFixture(IEnumerable<ApproverKey>? initial = null, PolicyStore? policy = null)
        {
            Fixture? holder = null;
            Keys = ApproverKeySet.InMemory(initial ?? [HelloKeyRecord()], () => holder!.Now);
            Fx = holder = new Fixture(presence: Keys, policy: policy);
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

        public JsonElement KeyAdd(string challenge, ApproverKey key, string byJson, string newKeyJson) =>
            Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"key_add\",\"key\":{KeyJson(key)},\"challenge\":\"{challenge}\",\"by\":{byJson},\"newKey\":{newKeyJson}}}");

        public JsonElement KeyRemove(string challenge, string keyId, string byJson) =>
            Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{keyId}\",\"challenge\":\"{challenge}\",\"by\":{byJson}}}");

        /// <summary>A complete, correct add: challenge, the Hello key (or <paramref name="signer"/>) authorizes, the new key proves possession.</summary>
        public JsonElement AddKey(Authenticator added, Authenticator? signer = null, uint count = 1)
        {
            string challenge = ChallengeValue("add", added.Key.KeyId);
            byte[] message = AddMessage(added.Key, challenge);
            return KeyAdd(challenge, added.Key, signer is null ? HelloWire(message) : signer.Wire(message, count), added.Wire(message, count));
        }

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
        ApproverKeyAddChecks();
        ApproverKeyRemoveChecks();
        ApproverKeyStoreChecks();
        ApproverKeyConfigChecks();
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
        Check("webauthn rule 4: the sign count must grow when both the stored and the new count are non-zero; 0 is never refused and never lowers it; counts are per key; a bad signature moves nothing", () =>
        {
            using Authenticator a = new(), b = new();
            ApproverKeySet keys = ApproverKeySet.InMemory([a.Key, b.Key], () => Start);
            byte[] message = Encoding.UTF8.GetBytes("m");
            PresenceResult With(Authenticator who, uint count) => keys.Verify(message, who.Proof(message, count));
            Assert(With(a, 5) == PresenceResult.Verified, "first count 5");
            Assert(With(a, 6) == PresenceResult.Verified, "6 after 5");
            Assert(With(a, 6) == PresenceResult.Mismatch, "6 again (a replay or a clone)");
            Assert(With(a, 5) == PresenceResult.Mismatch, "5 after 6");
            Assert(With(a, 0) == PresenceResult.Verified, "0 is an authenticator without a counter");
            Assert(With(a, 6) == PresenceResult.Mismatch, "0 did not lower the stored count");
            Assert(With(a, 7) == PresenceResult.Verified, "7 after 6");
            Assert(With(b, 1) == PresenceResult.Verified, "the count is per key: b starts at 1 although a is at 7");
            WebAuthnAssertion bad = a.Assertion(message, 100);
            Assert(keys.Verify(message, WebAuthnProof.Encode(bad with { Signature = [.. bad.Signature[..^1], (byte)(bad.Signature[^1] ^ 1)] })) == PresenceResult.Mismatch, "a damaged signature with a big count");
            Assert(With(a, 8) == PresenceResult.Verified, "the damaged signature did not move the stored count to 100");
            ApproverKeySet zeroes = ApproverKeySet.InMemory([a.Key], () => Start);
            Assert(zeroes.Verify(message, a.Proof(message, 0)) == PresenceResult.Verified && zeroes.Verify(message, a.Proof(message, 0)) == PresenceResult.Verified, "0 and 0 repeat freely");
            Assert(zeroes.Verify(message, a.Proof(message, 3)) == PresenceResult.Verified && zeroes.Verify(message, a.Proof(message, 0)) == PresenceResult.Verified, "a first non-zero count after 0, then 0 again");
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
            Assert(Encoding.UTF8.GetString(KeyMessages.Add(es.Key, "AAAAAAAAAAAAAAAAAAAAAA")) == Encoding.UTF8.GetString(AddMessage(es.Key, "AAAAAAAAAAAAAAAAAAAAAA")), "add message");
            Assert(Encoding.UTF8.GetString(KeyMessages.Remove(es.Key, "AAAAAAAAAAAAAAAAAAAAAA")) == Encoding.UTF8.GetString(RemoveMessage(es.Key, "AAAAAAAAAAAAAAAAAAAAAA")), "remove message");
            Assert(Encoding.UTF8.GetString(AddMessage(es.Key, "c")).Split('\0') is ["albera.keyadd.v1", { } id, { Length: 64 }, "c"] && id == es.Key.KeyId, "four parts separated by 0x00");
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
        Check("keys verb: the reply for the longest list the Authority accepts still fits one 2 KiB frame; a key that would make it longer is too_many_keys", () =>
        {
            KeyFixture k = new();
            List<Authenticator> made = [];
            try
            {
                string last = "ok";
                for (int i = 0; i < ApproverKeyRules.MaxKeys && last == "ok"; i++) { made.Add(new Authenticator(credentialIdBytes: 120)); last = Code(k.AddKey(made[^1])); }
                Assert(last == "too_many_keys" && k.Keys.Keys.Count < ApproverKeyRules.MaxKeys, $"120-byte credential ids stop at {k.Keys.Keys.Count} keys");
                byte[] frame = k.Fx.Protocol.Handle(PipeRole.Approver, Encoding.UTF8.GetBytes("{\"v\":1,\"verb\":\"keys\"}"));
                Assert(frame.Length <= AuthorityProtocol.MaxFrameBytes && Code(Parse(frame)) == "ok", $"{frame.Length} bytes");
            }
            finally { foreach (Authenticator a in made) a.Dispose(); }
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
    }

    // ---- key_challenge / key_add ---------------------------------------------------------------------------------------------------------------
    private static void ApproverKeyAddChecks()
    {
        Check("key_challenge: 128 random bits, valid 120 s, for add of an unknown key or remove of a registered one; the refusals are key_exists, key_unknown, last_key and request_invalid", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new([HelloKeyRecord(), a.Key]);
            JsonElement reply = k.ChallengeFor("add", "webauthn-0123456789abcdef");
            Assert(Code(reply) == "ok" && reply.GetProperty("expiresAt").GetInt64() == Start + 120 && System.Text.RegularExpressions.Regex.IsMatch(reply.GetProperty("challenge").GetString()!, "^[A-Za-z0-9_-]{21}[AQgw]$"), $"{reply}");
            Assert(reply.EnumerateObject().Count() == 3, "ok, challenge, expiresAt");
            Assert(k.ChallengeValue("add", "webauthn-0123456789abcdef") != reply.GetProperty("challenge").GetString(), "fresh each time");
            Assert(Code(k.ChallengeFor("remove", a.Key.KeyId)) == "ok", "remove of a registered key");
            Assert(Code(k.ChallengeFor("add", a.Key.KeyId)) == "key_exists", "add of a registered key");
            Assert(Code(k.ChallengeFor("remove", "webauthn-0123456789abcdef")) == "key_unknown", "remove of an unknown key");
            foreach ((string op, string keyId) in new[] { ("add", "bad id"), ("add", ""), ("rename", a.Key.KeyId), ("", a.Key.KeyId) })
                Assert(Code(k.ChallengeFor(op, keyId)) == "request_invalid", $"{op} {keyId}");
            foreach (string bad in new[] { "{\"v\":1,\"verb\":\"key_challenge\"}", "{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"add\"}", "{\"v\":1,\"verb\":\"key_challenge\",\"op\":1,\"keyId\":\"x\"}", "{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"add\",\"keyId\":\"x\",\"extra\":1}" })
                Assert(Code(k.Fx.Call(PipeRole.Approver, bad)) == "request_invalid", bad);
            Assert(Code(k.Fx.Call(PipeRole.Submit, "{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"add\",\"keyId\":\"webauthn-0123456789abcdef\"}")) == "request_invalid", "not a verb of the submit pipe");
            KeyFixture one = new();
            Assert(Code(one.ChallengeFor("remove", "hello-key-yosuke-01")) == "last_key", "the last key");
        });
        Check("key_challenge: one challenge is outstanding at a time (a new one replaces the old) and the old one is challenge_unknown", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new();
            string first = k.ChallengeValue("add", a.Key.KeyId), second = k.ChallengeValue("add", a.Key.KeyId);
            Assert(Code(k.KeyAdd(first, a.Key, HelloWire(AddMessage(a.Key, first)), a.Wire(AddMessage(a.Key, first)))) == "challenge_unknown", "the replaced challenge");
            Assert(Code(k.KeyAdd(second, a.Key, HelloWire(AddMessage(a.Key, second)), a.Wire(AddMessage(a.Key, second)))) == "ok", "the newest works (a refused call with another value did not use it up)");
        });
        Check("key_add: a Hello signature authorizes, the new key proves possession, the key is registered, listed by `keys`, and can approve (the receipt names it)", () =>
        {
            using Authenticator added = new();
            KeyFixture k = new();
            JsonElement reply = k.AddKey(added);
            Assert(Code(reply) == "ok" && reply.GetProperty("keys").GetArrayLength() == 2 && reply.EnumerateObject().Count() == 2, $"{reply}");
            Assert(reply.GetProperty("keys").EnumerateArray().Any(x => x.GetProperty("keyId").GetString() == added.Key.KeyId && x.GetProperty("credentialId").GetString() == B64Url(added.CredentialId)), "the new key is in the reply");
            Assert(k.KeyIds.SequenceEqual(["hello-key-yosuke-01", added.Key.KeyId]), "two keys, in the order they were registered");
            string id = k.Pending();
            Assert(Code(k.Decide(id, added.Wire(k.MessageOf(id), 1))) == "presence_mismatch", "(its possession proof had count 1: the authenticator's next count must be larger)");
            id = k.Pending("b");
            Assert(Code(k.Decide(id, added.Wire(k.MessageOf(id), 2))) == "ok" && ApproverKeyIdOf(k, id) == added.Key.KeyId, "the new key approves");
        });
        Check("key_add: a registered webauthn key (ES256 or RS256) can authorize the next key, with RS256 on both sides in one frame", () =>
        {
            using Authenticator first = new(), second = new(rsaKey: true), third = new(rsaKey: true);
            KeyFixture k = new([first.Key]);
            Assert(Code(k.AddKey(second, first)) == "ok", "ES256 authorizes an RS256 key");
            string challenge = k.ChallengeValue("add", third.Key.KeyId);
            byte[] message = AddMessage(third.Key, challenge);
            string frame = $"{{\"v\":1,\"verb\":\"key_add\",\"key\":{KeyJson(third.Key)},\"challenge\":\"{challenge}\",\"by\":{second.Wire(message, 2)},\"newKey\":{third.Wire(message)}}}";
            Assert(Encoding.UTF8.GetByteCount(frame) <= AuthorityProtocol.MaxFrameBytes, $"RS256 signer and RS256 new key: {Encoding.UTF8.GetByteCount(frame)} bytes must fit one frame");
            Assert(Code(k.Fx.Call(PipeRole.Approver, frame)) == "ok" && k.Keys.Keys.Count == 3, "RS256 authorizes an RS256 key");
        });
        Check("key_add: no challenge, an unknown or replaced one, an expired one, a reused one and one issued for another key or for remove are each refused and register nothing", () =>
        {
            using Authenticator added = new(), other = new();
            KeyFixture k = new();
            string Try(string challenge) => Code(k.KeyAdd(challenge, added.Key, HelloWire(AddMessage(added.Key, challenge)), added.Wire(AddMessage(added.Key, challenge))));
            Assert(Try("AAAAAAAAAAAAAAAAAAAAAA") == "challenge_unknown", "never issued");
            Assert(Try("") == "challenge_unknown", "an empty challenge is refused");
            Assert(Code(k.Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"key_add\",\"key\":{KeyJson(added.Key)},\"challenge\":\"{new string('A', 65)}\",\"by\":\"AAAA\",\"newKey\":\"AAAA\"}}")) == "request_invalid", "over-long challenge text");
            string expired = k.ChallengeValue("add", added.Key.KeyId);
            k.Fx.Now += ApproverKeySet.ChallengeTtlSeconds - 1;
            k.Fx.Now += 1;
            Assert(Try(expired) == "challenge_expired", "expired at 120 s");
            Assert(Try(expired) == "challenge_unknown", "an expired challenge is gone");
            string forOther = k.ChallengeValue("add", other.Key.KeyId);
            Assert(Try(forOther) == "challenge_unknown", "issued for another key id");
            Assert(Try(forOther) == "challenge_unknown", "(and used up by that attempt)");
            string good = k.ChallengeValue("add", added.Key.KeyId);
            Assert(Try(good) == "ok", "a valid challenge works");
            Assert(Try(good) == "challenge_unknown", "and only once");
            Assert(k.Keys.Keys.Count == 2, "exactly one key was added");
        });
        Check("key_add: a challenge issued for remove is not accepted by key_add, and a presented challenge is used up even when the proofs are wrong", () =>
        {
            using Authenticator added = new(), second = new();
            KeyFixture k = new([HelloKeyRecord(), second.Key]);
            string forRemove = k.ChallengeValue("remove", second.Key.KeyId);
            Assert(Code(k.KeyAdd(forRemove, added.Key, HelloWire(AddMessage(added.Key, forRemove)), added.Wire(AddMessage(added.Key, forRemove)))) == "challenge_unknown", "remove challenge in key_add");
            string challenge = k.ChallengeValue("add", added.Key.KeyId);
            Assert(Code(k.KeyAdd(challenge, added.Key, "\"AAAA\"", added.Wire(AddMessage(added.Key, challenge)))) == "presence_mismatch", "a wrong `by`");
            Assert(Code(k.KeyAdd(challenge, added.Key, HelloWire(AddMessage(added.Key, challenge)), added.Wire(AddMessage(added.Key, challenge)))) == "challenge_unknown", "the challenge was used up by the failed attempt");
            Assert(k.Keys.Keys.Count == 2, "nothing was added");
        });
        Check("key_add: a `by` from a key that is not registered, over another record or another challenge, a missing or foreign `newKey` proof are presence_mismatch and add nothing", () =>
        {
            using Authenticator added = new(), unregistered = new(), impostor = new();
            using RSA strangerHello = RSA.Create(2048);
            KeyFixture k = new();
            string Try(Func<string, byte[], (string by, string newKey)> proofs)
            {
                string challenge = k.ChallengeValue("add", added.Key.KeyId);
                byte[] message = AddMessage(added.Key, challenge);
                (string by, string newKey) = proofs(challenge, message);
                return Code(k.KeyAdd(challenge, added.Key, by, newKey));
            }
            Assert(Try((c, m) => (unregistered.Wire(m), added.Wire(m))) == "presence_mismatch", "an unregistered webauthn signer");
            Assert(Try((c, m) => ("\"" + Convert.ToBase64String(strangerHello.SignData(m, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) + "\"", added.Wire(m))) == "presence_mismatch", "an unregistered Hello signer");
            Assert(Try((c, m) => (HelloWire(AddMessage(impostor.Key, c)), added.Wire(m))) == "presence_mismatch", "a `by` for another key record");
            Assert(Try((c, m) => (HelloWire(Encoding.UTF8.GetBytes($"albera.keyadd.v1\0{added.Key.KeyId}\0{RecordDigest(added.Key)}\0AAAAAAAAAAAAAAAAAAAAAA")), added.Wire(m))) == "presence_mismatch", "a `by` for another challenge");
            Assert(Try((c, m) => (HelloWire(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(m).Replace("keyadd", "keyremove", StringComparison.Ordinal))), added.Wire(m))) == "presence_mismatch", "a `by` under the remove domain");
            Assert(Try((c, m) => (HelloWire(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(m).Replace(RecordDigest(added.Key), "sha256:" + RecordDigest(added.Key), StringComparison.Ordinal))), added.Wire(m))) == "presence_mismatch", "a `by` over a digest with a prefix");
            Assert(Try((c, m) => (HelloWire(m), "\"AAAA\"")) == "presence_mismatch", "no real `newKey` proof");
            Assert(Try((c, m) => (HelloWire(m), unregistered.Wire(m))) == "presence_mismatch", "possession proven by another key");
            Assert(Try((c, m) => (HelloWire(m), HelloWire(m))) == "presence_mismatch", "possession proven with the signer's own signature");
            Assert(Try((c, m) => (HelloWire(m), added.Wire(Encoding.UTF8.GetBytes("something else")))) == "presence_mismatch", "possession over another message");
            Assert(k.Keys.Keys.Count == 1, "nothing was added by any of them");
            Assert(Try((c, m) => (HelloWire(m), added.Wire(m))) == "ok", "control: the right pair adds it");
        });
        Check("key_add: a key that is already registered (same id, same public key or same credential id) is key_exists; a record that is not exactly the documented shape is request_invalid", () =>
        {
            using Authenticator added = new(), twin = new();
            KeyFixture k = new();
            Assert(Code(k.AddKey(added)) == "ok", "first");
            Assert(Code(k.ChallengeFor("add", added.Key.KeyId)) == "key_exists", "a registered id gets no challenge");
            ApproverKey sameCredential = ApproverKeyRules.TryCreate(twin.Key.KeyId, "webauthn", -7, twin.Spki, added.CredentialId, true)!;
            string challenge = k.ChallengeValue("add", sameCredential.KeyId);
            byte[] message = AddMessage(sameCredential, challenge);
            Assert(Code(k.KeyAdd(challenge, sameCredential, HelloWire(message), twin.Wire(message))) == "key_exists", "the credential id of a registered key");
            string good = k.ChallengeValue("add", twin.Key.KeyId);
            byte[] goodMessage = AddMessage(twin.Key, good);
            string by = HelloWire(goodMessage), newKey = twin.Wire(goodMessage);
            string Frame(string key, string extra = "") => $"{{\"v\":1,\"verb\":\"key_add\",\"key\":{key},\"challenge\":\"{good}\",\"by\":{by},\"newKey\":{newKey}{extra}}}";
            string keyJson = KeyJson(twin.Key);
            foreach (string bad in new[]
            {
                Frame(keyJson, ",\"x\":1"), Frame(keyJson.Replace("\"kind\":\"webauthn\"", "\"kind\":\"webauthn\",\"note\":\"x\"", StringComparison.Ordinal)), Frame(keyJson.Replace(twin.Key.KeyId, "webauthn-0123456789abcdef", StringComparison.Ordinal)),
                Frame(keyJson.Replace("\"alg\":-7", "\"alg\":-257", StringComparison.Ordinal)), Frame(keyJson.Replace("\"alg\":-7", "\"alg\":\"ES256\"", StringComparison.Ordinal)), Frame(keyJson.Replace(",\"credentialId\":", ",\"credentialIdX\":", StringComparison.Ordinal)),
                Frame("\"key\""), Frame("[]"), Frame(keyJson.Replace("\"publicKey\":\"", "\"publicKey\":\" ", StringComparison.Ordinal)), Frame(keyJson.Replace("\"kind\":\"webauthn\"", "\"kind\":\"hello-rsa\"", StringComparison.Ordinal)),
            }) Assert(Code(k.Fx.Call(PipeRole.Approver, bad)) == "request_invalid", $"accepted: {bad[..Math.Min(bad.Length, 160)]}");
            Assert(Code(k.Fx.Call(PipeRole.Approver, Frame(keyJson))) == "ok", "control: the untouched frame still works (the bad ones did not use the challenge up)");
        });
        Check("key_add: at most sixteen keys (too_many_keys)", () =>
        {
            KeyFixture k = new();
            List<Authenticator> made = [];
            try
            {
                for (int i = 0; i < ApproverKeyRules.MaxKeys - 1; i++) { made.Add(new Authenticator()); Assert(Code(k.AddKey(made[^1])) == "ok", $"key {i + 2}"); }
                Assert(k.Keys.Keys.Count == ApproverKeyRules.MaxKeys, "sixteen keys");
                using Authenticator seventeenth = new();
                Assert(Code(k.ChallengeFor("add", seventeenth.Key.KeyId)) == "too_many_keys", "no challenge for a seventeenth key");
                JsonElement keys = k.KeysReply();
                Assert(Code(keys) == "ok" && keys.GetProperty("keys").GetArrayLength() == 16, "all sixteen are listed (32-byte credential ids fit a frame)");
                Assert(Encoding.UTF8.GetByteCount(keys.GetRawText()) <= AuthorityProtocol.MaxFrameBytes, "within one frame");
            }
            finally { foreach (Authenticator a in made) a.Dispose(); }
        });
        Check("key_add: only the approver pipe has the key verbs, and a key verb with the wrong keys is request_invalid", () =>
        {
            using Authenticator added = new();
            KeyFixture k = new();
            string challenge = k.ChallengeValue("add", added.Key.KeyId);
            byte[] message = AddMessage(added.Key, challenge);
            string frame = $"{{\"v\":1,\"verb\":\"key_add\",\"key\":{KeyJson(added.Key)},\"challenge\":\"{challenge}\",\"by\":{HelloWire(message)},\"newKey\":{added.Wire(message)}}}";
            Assert(Code(k.Fx.Call(PipeRole.Submit, frame)) == "request_invalid", "key_add on the submit pipe");
            Assert(Code(k.Fx.Call(PipeRole.Submit, "{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"y\",\"challenge\":\"x\",\"by\":\"AAAA\"}")) == "request_invalid", "key_remove on the submit pipe");
            Assert(k.Keys.Keys.Count == 1, "nothing changed");
            Assert(Code(k.Fx.Call(PipeRole.Approver, frame.Replace(",\"newKey\":", ",\"possession\":", StringComparison.Ordinal))) == "request_invalid", "newKey missing");
            Assert(Code(k.Fx.Call(PipeRole.Approver, frame.Replace(",\"by\":", ",\"presence\":", StringComparison.Ordinal))) == "request_invalid", "by missing (the field is `by`, not `presence`)");
            Assert(Code(k.Fx.Call(PipeRole.Approver, frame)) == "ok", "control");
        });
    }

    // ---- key_remove -----------------------------------------------------------------------------------------------------------------------------
    private static void ApproverKeyRemoveChecks()
    {
        Check("key_remove: any registered key (the key being removed included) authorizes the removal; the removed key can no longer approve; its sign count is forgotten", () =>
        {
            using Authenticator a = new(), b = new(), c = new();
            KeyFixture k = new([HelloKeyRecord(), a.Key, b.Key, c.Key]);
            string first = k.Pending("a");
            Assert(Code(k.Decide(first, a.Wire(k.MessageOf(first), 20))) == "ok", "a approves at count 20");
            string byB = k.ChallengeValue("remove", a.Key.KeyId);
            JsonElement removed = k.KeyRemove(byB, a.Key.KeyId, b.Wire(RemoveMessage(a.Key, byB)));
            Assert(Code(removed) == "ok" && removed.GetProperty("keys").GetArrayLength() == 3 && removed.EnumerateObject().Count() == 2, $"b removes a: {removed}");
            string second = k.Pending("b");
            Assert(Code(k.Decide(second, a.Wire(k.MessageOf(second), 21))) == "presence_mismatch", "a is gone");
            string bySelf = k.ChallengeValue("remove", c.Key.KeyId);
            JsonElement reply = k.KeyRemove(bySelf, c.Key.KeyId, c.Wire(RemoveMessage(c.Key, bySelf)));
            Assert(Code(reply) == "ok" && reply.GetProperty("keys").GetArrayLength() == 2, $"a key may sign its own removal: {reply}");
            string byHello = k.ChallengeValue("remove", b.Key.KeyId);
            Assert(Code(k.KeyRemove(byHello, b.Key.KeyId, HelloWire(RemoveMessage(b.Key, byHello)))) == "ok", "the Hello key removes b");
            Assert(k.KeyIds.SequenceEqual(["hello-key-yosuke-01"]), "one key left");
        });
        Check("key_remove: the last key is last_key (no challenge, and a forced call); an unknown key is key_unknown; an unregistered signer, a signature over another key, another domain or challenge are refused", () =>
        {
            using Authenticator a = new(), unregistered = new();
            KeyFixture k = new([a.Key]);
            Assert(Code(k.ChallengeFor("remove", a.Key.KeyId)) == "last_key", "no challenge to remove the last key");
            KeyFixture two = new([HelloKeyRecord(), a.Key]);
            string challenge = two.ChallengeValue("remove", a.Key.KeyId);
            Assert(Code(two.KeyRemove(challenge, a.Key.KeyId, unregistered.Wire(RemoveMessage(a.Key, challenge)))) == "presence_mismatch", "an unregistered signer");
            challenge = two.ChallengeValue("remove", a.Key.KeyId);
            Assert(Code(two.KeyRemove(challenge, a.Key.KeyId, HelloWire(RemoveMessage(HelloKeyRecord(), challenge)))) == "presence_mismatch", "a signature over another key's removal");
            challenge = two.ChallengeValue("remove", a.Key.KeyId);
            Assert(Code(two.KeyRemove(challenge, a.Key.KeyId, HelloWire(AddMessage(a.Key, challenge)))) == "presence_mismatch", "a keyadd signature does not remove");
            challenge = two.ChallengeValue("remove", a.Key.KeyId);
            Assert(Code(two.KeyRemove(challenge, "webauthn-0123456789abcdef", HelloWire(RemoveMessage(a.Key, challenge)))) == "challenge_unknown", "a challenge that is for another key");
            challenge = two.ChallengeValue("remove", a.Key.KeyId);
            Assert(Code(two.KeyRemove(challenge, "hello-key-unknown", HelloWire(RemoveMessage(a.Key, challenge)))) == "challenge_unknown", "(bound to the key id it was issued for)");
            challenge = two.ChallengeValue("remove", a.Key.KeyId);
            string used = HelloWire(RemoveMessage(a.Key, challenge));
            Assert(Code(two.KeyRemove(challenge, a.Key.KeyId, used)) == "ok", "control");
            Assert(Code(two.KeyRemove(challenge, a.Key.KeyId, used)) == "challenge_unknown", "the same call again: the challenge is used up");
            Assert(Code(two.ChallengeFor("remove", a.Key.KeyId)) == "key_unknown", "and a is gone");
            Assert(two.KeyIds.SequenceEqual(["hello-key-yosuke-01"]), "the Hello key is the last one");
            Assert(Code(two.ChallengeFor("remove", "hello-key-yosuke-01")) == "last_key", "and cannot be removed");
            string forced = two.Keys.IssueChallenge(KeyOp.Add, "webauthn-0123456789abcdef").Challenge;
            Assert(two.Keys.Remove("hello-key-yosuke-01", forced, []).Code == "challenge_unknown", "a forced call without the right challenge");
            Assert(Code(two.Fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"hello-key-yosuke-01\",\"challenge\":\"AAAAAAAAAAAAAAAAAAAAAA\",\"by\":\"AAAA\"}")) == "challenge_unknown", "a forced call over the pipe");
            Assert(two.Keys.Keys.Count == 1, "the last key is still there");
        });
        Check("key_remove: an expired challenge is challenge_expired; a malformed call is request_invalid; the key stays", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new([HelloKeyRecord(), a.Key]);
            string challenge = k.ChallengeValue("remove", a.Key.KeyId);
            string by = HelloWire(RemoveMessage(a.Key, challenge));
            k.Fx.Now += ApproverKeySet.ChallengeTtlSeconds;
            Assert(Code(k.KeyRemove(challenge, a.Key.KeyId, by)) == "challenge_expired", "expired");
            challenge = k.ChallengeValue("remove", a.Key.KeyId);
            foreach (string bad in new[]
            {
                $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{a.Key.KeyId}\",\"challenge\":\"{challenge}\"}}", $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{a.Key.KeyId}\",\"challenge\":7,\"by\":\"AAAA\"}}",
                $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{a.Key.KeyId}\",\"challenge\":\"{challenge}\",\"by\":\"AAAA\",\"x\":1}}", $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{a.Key.KeyId}\",\"challenge\":\"{challenge}\",\"by\":[]}}",
                $"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{a.Key.KeyId}\",\"challenge\":\"{challenge}\",\"presence\":\"AAAA\"}}",
            }) Assert(Code(k.Fx.Call(PipeRole.Approver, bad)) == "request_invalid", bad);
            Assert(k.Keys.Keys.Count == 2, "still two");
            Assert(Code(k.KeyRemove(challenge, a.Key.KeyId, HelloWire(RemoveMessage(a.Key, challenge)))) == "ok", "control: malformed calls did not use the challenge up");
        });
        Check("key_remove: the config's Hello key can be removed once another key is registered (the list, not the config, is what counts); receipts then name the remaining key", () =>
        {
            using Authenticator a = new();
            KeyFixture k = new();
            Assert(Code(k.AddKey(a)) == "ok", "add a");
            string challenge = k.ChallengeValue("remove", "hello-key-yosuke-01");
            Assert(Code(k.KeyRemove(challenge, "hello-key-yosuke-01", a.Wire(RemoveMessage(HelloKeyRecord(), challenge), 2))) == "ok", "a removes the Hello key");
            string id = k.Pending();
            Assert(Code(k.Decide(id, HelloWire(k.MessageOf(id)))) == "presence_mismatch", "the Hello key no longer approves");
            string other = k.Pending("b");
            Assert(Code(k.Decide(other, a.Wire(k.MessageOf(other), 3))) == "ok" && ApproverKeyIdOf(k, other) == a.Key.KeyId, "a does");
        });
    }

    // ---- approver-keys.json ----------------------------------------------------------------------------------------------------------------------
    private static AuthorityConfig ConfigAt(string configPath, string? json = null)
    {
        File.WriteAllText(configPath, json ?? ConfigJson());
        return AuthorityConfig.TryLoad(configPath, strictSeparation: false, out string reason) ?? throw new CheckFailed($"config: {reason}");
    }

    private static void ApproverKeyStoreChecks()
    {
        Check("approver-keys.json: a missing file is created from the config's keys at the service's start (not by service-check), in the documented shape, beside the config", () =>
        {
            InFolder(configPath =>
            {
                AuthorityConfig config = ConfigAt(configPath);
                string file = ApproverKeyStore.PathFor(configPath);
                Assert(file == Path.Combine(Path.GetDirectoryName(configPath)!, "approver-keys.json"), "the file name");
                ApproverKeySet check = ApproverKeySet.Open(config, () => Start, seed: false, out string reason, out KeyListSource source) ?? throw new CheckFailed(reason);
                Assert(source == KeyListSource.Config && !File.Exists(file) && check.Keys.Single().KeyId == "hello-key-yosuke-01", "service-check: the config's key, nothing written");
                ApproverKeySet keys = ApproverKeySet.Open(config, () => Start, seed: true, out reason, out source) ?? throw new CheckFailed(reason);
                Assert(source == KeyListSource.File && File.Exists(file) && keys.Keys.Single().KeyId == "hello-key-yosuke-01", "the service: created");
                using JsonDocument written = JsonDocument.Parse(File.ReadAllText(file));
                JsonElement root = written.RootElement;
                Assert(root.EnumerateObject().Select(p => p.Name).SequenceEqual(["v", "revision", "keys", "signCounts"]) && root.GetProperty("v").GetInt32() == 1 && root.GetProperty("revision").GetInt64() == 1, $"top-level shape: {root}");
                Assert(root.GetProperty("keys").GetArrayLength() == 1 && root.GetProperty("keys")[0].GetRawText() == CanonicalText(HelloKeyRecord()), "the record is the canonical one");
                Assert(root.GetProperty("signCounts").EnumerateObject().Count() == 0, "no counts yet");
                Assert(Directory.GetFiles(Path.GetDirectoryName(configPath)!, "approver-keys.*.tmp").Length == 0, "no temp file left behind");
                Assert(ApproverKeySet.Open(config, () => Start, seed: true, out reason, out source) is { } && source == KeyListSource.File && ApproverKeyStore.Read(file, config.LegacyKey, out _, out _)!.Revision == 1, "a second start reads it and does not rewrite it");
            });
        });
        Check("approver-keys.json: a key change and every moved sign count are written (revision + 1), read back, and survive a restart; the file wins over the config afterwards", () =>
        {
            using Authenticator added = new();
            InFolder(configPath =>
            {
                AuthorityConfig config = ConfigAt(configPath);
                string file = ApproverKeyStore.PathFor(configPath);
                ApproverKeySet keys = ApproverKeySet.Open(config, () => Start, seed: true, out string reason, out _) ?? throw new CheckFailed(reason);
                string challenge = keys.IssueChallenge(KeyOp.Add, added.Key.KeyId).Challenge;
                byte[] message = AddMessage(added.Key, challenge);
                Assert(keys.Add(added.Key, challenge, Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), added.Proof(message, 7)).Code is null, "added");
                using (JsonDocument one = JsonDocument.Parse(File.ReadAllText(file)))
                {
                    JsonElement root = one.RootElement;
                    Assert(root.GetProperty("revision").GetInt64() == 2 && root.GetProperty("keys").GetArrayLength() == 2, "revision 2, two keys");
                    Assert(root.GetProperty("keys")[1].GetRawText() == CanonicalText(added.Key), "the new record, canonical");
                    Assert(root.GetProperty("signCounts").GetProperty(added.Key.KeyId).GetUInt32() == 7 && root.GetProperty("signCounts").EnumerateObject().Count() == 1, "the new key's count was seeded from its possession proof");
                }
                byte[] next = Encoding.UTF8.GetBytes("later");
                Assert(keys.Verify(next, added.Proof(next, 9)) == PresenceResult.Verified, "an approval at count 9");
                Assert(JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("signCounts").GetProperty(added.Key.KeyId).GetUInt32() == 9 && JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("revision").GetInt64() == 3, "the count moved: written, revision 3");
                Assert(keys.Verify(next, Hello.SignData(next, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) == PresenceResult.Verified && JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("revision").GetInt64() == 3, "a Hello approval moves no count and writes nothing");
                // a restart: the file is the list
                ApproverKeySet restarted = ApproverKeySet.Open(config, () => Start, seed: true, out reason, out KeyListSource source) ?? throw new CheckFailed(reason);
                Assert(source == KeyListSource.File && restarted.Keys.Select(k => k.KeyId).SequenceEqual(["hello-key-yosuke-01", added.Key.KeyId]), "the file is the list");
                Assert(restarted.Verify(next, added.Proof(next, 9)) == PresenceResult.Mismatch, "the stored sign count (9) survived the restart: 9 again is refused");
                Assert(restarted.Verify(next, added.Proof(next, 10)) == PresenceResult.Verified, "10 is fine");
                string removal = restarted.IssueChallenge(KeyOp.Remove, "hello-key-yosuke-01").Challenge;
                Assert(restarted.Remove("hello-key-yosuke-01", removal, added.Proof(RemoveMessage(HelloKeyRecord(), removal), 11)).Code is null, "removed");
                ApproverKeySet third = ApproverKeySet.Open(config, () => Start, seed: true, out reason, out source) ?? throw new CheckFailed(reason);
                Assert(third.Keys.Single().KeyId == added.Key.KeyId && ApproverKeyStore.Read(file, config.LegacyKey, out _, out _)!.Revision == 5, "the removal survived too, and the config's Hello key did not come back");
                Assert(Directory.GetFiles(Path.GetDirectoryName(configPath)!, "approver-keys.*.tmp").Length == 0, "no temp file left behind");
                // set-approver writes a new config and deletes the file: the next start seeds it again.
                using RSA other = RSA.Create(2048);
                File.WriteAllText(configPath, ConfigJson(new() { ["approverKeyId"] = "hello-other", ["approverPublicKey"] = Convert.ToBase64String(other.ExportSubjectPublicKeyInfo()) }));
                AuthorityConfig changed = AuthorityConfig.TryLoad(configPath, strictSeparation: false, out reason) ?? throw new CheckFailed(reason);
                Assert(ApproverKeySet.Open(changed, () => Start, seed: true, out reason, out _) is { } stillThere && stillThere.Keys.Single().KeyId == added.Key.KeyId, "a config change alone does not touch the list (the file is the list)");
                File.Delete(file);
                Assert(ApproverKeySet.Open(changed, () => Start, seed: true, out reason, out _) is { } reseeded && reseeded.Keys.Single().KeyId == "hello-other", "with the file deleted the next start seeds it from the new config");
            });
        });
        Check("approver-keys.json: a file that is not exactly the documented shape is refused with a fixed reason word and never read as the config's keys (untrusted, too large, bad JSON, extra key, duplicate name, unknown kind, id not derived, same key twice, 17 keys, a count for no key)", () =>
        {
            using Authenticator a = new(), b = new();
            InFolder(configPath =>
            {
                AuthorityConfig config = ConfigAt(configPath);
                string file = ApproverKeyStore.PathFor(configPath);
                string Entry(Authenticator who) => CanonicalText(who.Key);
                string Doc(string keys, string counts = "", string extra = "", string revision = "1") => $"{{\"v\":1,\"revision\":{revision},\"keys\":[{keys}],\"signCounts\":{{{counts}}}{extra}}}";
                (string name, string content, string reason)[] cases =
                [
                    ("not json", "keys", "approver_keys_invalid"), ("an extra top-level key", Doc(Entry(a), extra: ",\"x\":1"), "approver_keys_invalid"), ("a missing top-level key", Doc(Entry(a)).Replace(",\"signCounts\":{}", "", StringComparison.Ordinal), "approver_keys_invalid"),
                    ("a repeated top-level name", Doc(Entry(a), extra: ",\"revision\":2"), "approver_keys_invalid"), ("no keys", Doc(""), "approver_keys_invalid"),
                    ("an unknown kind", Doc(Entry(a).Replace("\"kind\":\"webauthn\"", "\"kind\":\"tpm\"", StringComparison.Ordinal)), "approver_keys_invalid"),
                    ("an id that is not derived", Doc(Entry(a).Replace(a.Key.KeyId, "webauthn-0123456789abcdef", StringComparison.Ordinal)), "approver_keys_invalid"),
                    ("an algorithm that does not fit the key", Doc(Entry(a).Replace("\"alg\":-7", "\"alg\":-257", StringComparison.Ordinal)), "approver_keys_invalid"),
                    ("an algorithm as text", Doc(Entry(a).Replace("\"alg\":-7", "\"alg\":\"ES256\"", StringComparison.Ordinal)), "approver_keys_invalid"),
                    ("a repeated name in a record", Doc(Entry(a).Replace("\"kind\":", "\"kind\":\"webauthn\",\"kind\":", StringComparison.Ordinal)), "approver_keys_invalid"),
                    ("the same key twice", Doc(Entry(a) + "," + Entry(a)), "approver_keys_invalid"),
                    ("the same credential twice", Doc(Entry(a) + "," + Entry(b).Replace(B64Url(b.CredentialId), B64Url(a.CredentialId), StringComparison.Ordinal)), "approver_keys_invalid"),
                    ("seventeen keys", Doc(string.Join(',', Enumerable.Range(0, 17).Select(_ => { using Authenticator n = new(); return Entry(n); }))), "approver_keys_invalid"),
                    ("a count for a key that is not registered", Doc(Entry(a), $"\"{b.Key.KeyId}\":3"), "approver_keys_invalid"), ("a negative count", Doc(Entry(a), $"\"{a.Key.KeyId}\":-1"), "approver_keys_invalid"),
                    ("a count over 32 bits", Doc(Entry(a), $"\"{a.Key.KeyId}\":4294967296"), "approver_keys_invalid"), ("a count as text", Doc(Entry(a), $"\"{a.Key.KeyId}\":\"3\""), "approver_keys_invalid"),
                    ("revision 0", Doc(Entry(a), revision: "0"), "approver_keys_invalid"), ("a version 2 file", Doc(Entry(a)).Replace("\"v\":1", "\"v\":2", StringComparison.Ordinal), "approver_keys_invalid"),
                    ("a Hello key with an id that is not derived and is not the config's", Doc("{\"keyId\":\"hello-chosen\",\"kind\":\"hello-rsa\",\"alg\":-257,\"publicKey\":\"" + Convert.ToBase64String(Hello.ExportSubjectPublicKeyInfo()) + "\"}"), "approver_keys_invalid"),
                    ("too large", Doc(Entry(a)) + new string(' ', 33000), "approver_keys_too_large"),
                ];
                foreach ((string name, string content, string expected) in cases)
                {
                    File.WriteAllText(file, content);
                    Assert(ApproverKeySet.Open(config, () => Start, seed: true, out string reason, out _) is null && reason == expected, $"{name}: got {reason}");
                    Assert(ApproverKeySet.Open(config, () => Start, seed: false, out reason, out _) is null && reason == expected, $"{name} (service-check): got {reason}");
                }
                File.WriteAllText(file, Doc(Entry(a) + "," + Entry(b), $"\"{a.Key.KeyId}\":4294967295"));
                Assert(ApproverKeySet.Open(config, () => Start, seed: true, out string ok, out KeyListSource source) is { } loaded && source == KeyListSource.File && loaded.Keys.Count == 2, $"control: a good file loads ({ok})");
                File.WriteAllText(file, Doc("{\"keyId\":\"hello-key-yosuke-01\",\"kind\":\"hello-rsa\",\"alg\":-257,\"publicKey\":\"" + Convert.ToBase64String(Hello.ExportSubjectPublicKeyInfo()) + "\"}"));
                Assert(ApproverKeySet.Open(config, () => Start, seed: true, out ok, out _) is { }, $"the config's own non-derived Hello id is kept ({ok})");
                ServicePathGuard.ServiceSidForTest = null; // no per-service SID in this token: the production rule trusts nothing
                Assert(ApproverKeySet.Open(config, () => Start, seed: true, out string untrusted, out _) is null && untrusted == "approver_keys_untrusted", $"untrusted: {untrusted}");
                ServicePathGuard.ServiceSidForTest = System.Security.Principal.WindowsIdentity.GetCurrent().User;
            });
        });
        Check("approver-keys.json: when the file cannot be written the start refuses (approver_keys_unwritable), a key change or a moved sign count is authority_unavailable / presence_unavailable, and memory and file stay as they were", () =>
        {
            using Authenticator added = new();
            InFolder(configPath =>
            {
                AuthorityConfig config = ConfigAt(configPath);
                string file = ApproverKeyStore.PathFor(configPath);
                System.Security.Principal.SecurityIdentifier stranger = new("S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555"); // not the owner of what the process creates
                System.Security.Principal.SecurityIdentifier? self = System.Security.Principal.WindowsIdentity.GetCurrent().User;
                ServicePathGuard.ServiceSidForTest = stranger;
                Assert(ApproverKeySet.Open(config, () => Start, seed: true, out string reason, out _) is null && reason == "approver_keys_unwritable" && !File.Exists(file), $"seeding: {reason}");
                ServicePathGuard.ServiceSidForTest = self;
                ApproverKeySet keys = ApproverKeySet.Open(config, () => Start, seed: true, out reason, out _) ?? throw new CheckFailed(reason);
                string before = File.ReadAllText(file);
                string challenge = keys.IssueChallenge(KeyOp.Add, added.Key.KeyId).Challenge;
                byte[] message = AddMessage(added.Key, challenge);
                byte[] signature = Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                ServicePathGuard.ServiceSidForTest = stranger;
                Assert(keys.Add(added.Key, challenge, signature, added.Proof(message)).Code == "authority_unavailable", "the new file is not trusted");
                ServicePathGuard.ServiceSidForTest = self;
                Assert(keys.Keys.Single().KeyId == "hello-key-yosuke-01" && File.ReadAllText(file) == before, "unchanged");
                Assert(Directory.GetFiles(Path.GetDirectoryName(configPath)!, "approver-keys.*.tmp").Length == 0, "no temp file left");
                byte[] probe = Encoding.UTF8.GetBytes("probe");
                Assert(keys.Verify(probe, Hello.SignData(probe, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) == PresenceResult.Verified, "the old list still verifies (a refused write is not a fault)");
                // a sign count that cannot be kept is no approval, and is not remembered either
                challenge = keys.IssueChallenge(KeyOp.Add, added.Key.KeyId).Challenge;
                message = AddMessage(added.Key, challenge);
                Assert(keys.Add(added.Key, challenge, Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), added.Proof(message, 3)).Code is null, "added once the file can be written");
                ServicePathGuard.ServiceSidForTest = stranger;
                Assert(keys.Verify(probe, added.Proof(probe, 5)) == PresenceResult.Unavailable, "count 5 cannot be written: presence_unavailable");
                ServicePathGuard.ServiceSidForTest = self;
                Assert(keys.Verify(probe, added.Proof(probe, 5)) == PresenceResult.Verified, "memory did not move: 5 is still fine once the file can be written");
            });
        });
    }

    // ---- the config's keys --------------------------------------------------------------------------------------------------------------------
    private static string ListConfigJson(IEnumerable<ApproverKey> keys, Dictionary<string, string>? changes = null, JsonObject? pairBack = null)
    {
        JsonObject root = JsonNode.Parse(ConfigJson(changes, drop: ["approverKeyId", "approverPublicKey"]))!.AsObject();
        JsonArray list = [];
        foreach (ApproverKey key in keys) list.Add(JsonNode.Parse(CanonicalText(key)));
        root["approverKeys"] = list;
        if (pairBack is not null) foreach ((string name, JsonNode? value) in pairBack) root[name] = value?.DeepClone();
        return root.ToJsonString();
    }

    private static void ApproverKeyConfigChecks()
    {
        Check("config: approverKeys is 1 to 16 key records; the first key answers to approverKeyId / approverPublicKey; the older pair is still one hello-rsa record with the id it was given", () =>
        {
            using Authenticator es = new(), rs = new(rsaKey: true);
            AuthorityConfig pair = AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(ConfigJson()), true, out string reason) ?? throw new CheckFailed(reason);
            Assert(pair.ApproverKeys!.Count == 1 && pair.ApproverKeys[0] is { Kind: ApproverKeyKind.HelloRsa, Alg: -257, KeyId: "hello-key-yosuke-01" } && pair.LegacyKey is not null, "the pair is one hello-rsa record");
            Assert(pair.ApproverKeyId == "hello-key-yosuke-01" && pair.ApproverPublicKey.SequenceEqual(Hello.ExportSubjectPublicKeyInfo()), "and still answers to the old members");
            AuthorityConfig list = AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(ListConfigJson([es.Key, rs.Key])), true, out reason) ?? throw new CheckFailed(reason);
            Assert(list.ApproverKeys!.Select(k => k.KeyId).SequenceEqual([es.Key.KeyId, rs.Key.KeyId]) && list.ApproverKeyId == es.Key.KeyId && list.ApproverPublicKey.SequenceEqual(es.Spki) && list.LegacyKey is null, "a list of two");
            ApproverKey derivedHello = ApproverKeyRules.TryCreate("hello-" + Convert.ToHexStringLower(SHA256.HashData(Hello.ExportSubjectPublicKeyInfo()).AsSpan(0, 8)), "hello-rsa", -257, Hello.ExportSubjectPublicKeyInfo(), null, true)!;
            Assert(AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(ListConfigJson([derivedHello, es.Key])), true, out reason) is { } mixed && mixed.ApproverKeys![0].Kind == ApproverKeyKind.HelloRsa, $"a hello-rsa record in the list ({reason})");
            Assert(ConfigReason(ListConfigJson([HelloKeyRecord()])) == "config_approver_keys", "a list record must carry the derived id, even a Hello key");
        });
        Check("config: the pair and approverKeys together are config_approver_keys, and so is every problem in the list; neither is config_keys", () =>
        {
            using Authenticator es = new(), twin = new();
            Assert(ConfigReason(ListConfigJson([es.Key], pairBack: new JsonObject { ["approverKeyId"] = "hello-key-yosuke-01", ["approverPublicKey"] = Convert.ToBase64String(Hello.ExportSubjectPublicKeyInfo()) })) == "config_approver_keys", "both");
            Assert(ConfigReason(ListConfigJson([es.Key], pairBack: new JsonObject { ["approverKeyId"] = "hello-key-yosuke-01" })) == "config_approver_keys", "the list and half the pair");
            Assert(ConfigReason(ConfigJson(drop: ["approverKeyId", "approverPublicKey"])) == "config_keys", "neither");
            Assert(ConfigReason(ConfigJson(drop: ["approverPublicKey"])) == "config_keys" && ConfigReason(ConfigJson(drop: ["approverKeyId"])) == "config_keys", "half the pair, no list");
            Assert(ConfigReason(ListConfigJson([])) == "config_approver_keys", "an empty list");
            Assert(ConfigReason(ListConfigJson([es.Key, es.Key])) == "config_approver_keys", "the same key twice");
            Assert(ConfigReason(ListConfigJson([es.Key]).Replace("\"kind\":\"webauthn\"", "\"kind\":\"tpm\"", StringComparison.Ordinal)) == "config_approver_keys", "an unknown kind");
            Assert(ConfigReason(ListConfigJson([es.Key]).Replace("\"alg\":-7", "\"alg\":-257", StringComparison.Ordinal)) == "config_approver_keys", "an algorithm that does not fit");
            Assert(ConfigReason(ListConfigJson([es.Key]).Replace(es.Key.KeyId, "webauthn-0123456789abcdef", StringComparison.Ordinal)) == "config_approver_keys", "an id that is not derived");
            Assert(ConfigReason(ListConfigJson([es.Key]).Replace("\"approverKeys\":[", "\"approverKeys\":[7,", StringComparison.Ordinal)) == "config_approver_keys", "a record that is not an object");
            Assert(ConfigReason(ListConfigJson([es.Key]).Replace("\"approverKeys\":[{", "\"approverKeys\":[{\"extra\":\"x\",", StringComparison.Ordinal)) == "config_approver_keys", "an extra field in a record");
            Assert(ConfigReason(ListConfigJson([es.Key]).Replace("\"approverKeys\":[{", "\"approverKeys\":[{\"keyId\":\"x\",", StringComparison.Ordinal)) == "config_approver_keys", "a repeated name in a record");
            JsonObject notArray = JsonNode.Parse(ListConfigJson([es.Key]))!.AsObject();
            notArray["approverKeys"] = "text";
            Assert(ConfigReason(notArray.ToJsonString()) == "config_keys", "approverKeys as a string");
            Authenticator[] many = [.. Enumerable.Range(0, 17).Select(_ => new Authenticator())];
            try { Assert(ConfigReason(ListConfigJson(many.Select(m => m.Key))) == "config_approver_keys", "seventeen keys"); }
            finally { foreach (Authenticator m in many) m.Dispose(); }
            Assert(ConfigReason(ListConfigJson([es.Key]), strict: false) is null && ConfigReason(ListConfigJson([es.Key]).Replace("\"kid\"", "\"kidx\"", StringComparison.Ordinal)) == "config_keys", "(the rest of the config is read as before)");
        });
        Check("config: sixteen keys with ordinary credential ids are accepted (the file is larger than 4 KiB)", () =>
        {
            Authenticator[] many = [.. Enumerable.Range(0, 16).Select(i => new Authenticator(rsaKey: i % 2 == 0))];
            try
            {
                string json = ListConfigJson(many.Select(m => m.Key));
                Assert(Encoding.UTF8.GetByteCount(json) > 4096, $"{Encoding.UTF8.GetByteCount(json)} bytes");
                Assert(AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(json), true, out string reason) is { ApproverKeys.Count: 16 }, $"parsed ({reason})");
            }
            finally { foreach (Authenticator m in many) m.Dispose(); }
        });
    }
}
