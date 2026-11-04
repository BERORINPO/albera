using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Albera.ApprovalAuthority;
using Albera.BrokerContract;

// The key verbs, the key store and the config's keys (docs/architecture/approver-webauthn.md, "Wire contract"). The helpers (Authenticator, KeyFixture, the messages) are in ApproverKeyChecks.cs.
internal static partial class Harness
{
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

    // ---- removing the key that signed the standing policy -----------------------------------------------------------------------------------
    /// <summary>A config folder, the Hello key plus <paramref name="holders"/> registered, a file-backed policy store and a core over them, and the standard policy (revision 1) authorized by <paramref name="signer"/> (null: the Hello key).</summary>
    private static void WithSignedPolicy(Authenticator? signer, Authenticator[] holders, Action<KeyFixture, string, PolicyStore> body)
    {
        InFolder(config =>
        {
            File.WriteAllText(config, ConfigJson());
            PolicyStore? policy = null;
            KeyFixture k = new([HelloKeyRecord(), .. holders.Select(h => h.Key)], policyFor: stored => policy = PolicyStore.TryLoad(config, DefaultIdentity, stored, out string reason, out _) ?? throw new CheckFailed(reason));
            string standard = PolicyJson(1, "standard");
            byte[] message = PolicyChange.Message(PolicyOf(standard), "authority-key-2026-10", "albera-host-broker");
            string proof = signer is null ? HelloWire(message) : signer.Wire(message, 2);
            Assert(Code(k.Fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{standard},\"presence\":{proof}}}")) == "ok", "the policy is authorized");
            Assert(k.Fx.Core.Policy() is { Tier: "standard", Revision: 1 } && File.ReadAllText(PolicyStore.PathFor(config)).Contains("\"authorized\"", StringComparison.Ordinal), "standard is in force, written with its proof");
            body(k, config, policy!);
        });
    }

    private static string PolicyFileText(string config) => File.ReadAllText(PolicyStore.PathFor(config));

    private static void PolicyResetOnKeyRemoveChecks()
    {
        Check("key_remove: removing the key that signed the policy in force resets the policy to careful (revision + 1) in the same operation, says policyReset, and the next start succeeds", () =>
        {
            using Authenticator a = new(), b = new();
            WithSignedPolicy(a, [a, b], (k, config, policy) =>
            {
                string signedFile = PolicyFileText(config);
                string challenge = k.ChallengeValue("remove", a.Key.KeyId);
                JsonElement reply = k.KeyRemove(challenge, a.Key.KeyId, b.Wire(RemoveMessage(a.Key, challenge)));
                Assert(Code(reply) == "ok" && reply.GetProperty("policyReset").GetBoolean() && reply.EnumerateObject().Select(p => p.Name).SequenceEqual(["ok", "keys", "policyReset"]), $"{reply}");
                Assert(reply.GetProperty("keys").EnumerateArray().Select(x => x.GetProperty("keyId").GetString()).SequenceEqual(["hello-key-yosuke-01", b.Key.KeyId]), "and it is the key list as ever");
                Assert(k.Fx.Core.Policy() is { Tier: "careful", Revision: 2 }, "careful, revision 2 (a revision is never reused)");
                string after = PolicyFileText(config);
                Assert(!after.Contains("authorized", StringComparison.Ordinal) && after.Contains("\"tier\":\"careful\"", StringComparison.Ordinal) && after.Contains("\"rev\":2", StringComparison.Ordinal), after);
                // the next start: the keys that remain, the file as written
                ApproverKeySet remaining = ApproverKeySet.InMemory(k.Keys.Keys, () => Start);
                PolicyStore? reloaded = PolicyStore.TryLoad(config, DefaultIdentity, remaining.ForStoredProofs, out string reason, out bool fromFile);
                Assert(reloaded is { } && fromFile && reloaded.Current is { Tier: "careful", Revision: 2 }, $"restart: {reason}");
                // what the old file would have done to that start: nobody left can vouch for it
                File.WriteAllText(PolicyStore.PathFor(config), signedFile);
                Assert(PolicyStore.TryLoad(config, DefaultIdentity, remaining.ForStoredProofs, out reason, out _) is null && reason == "policy_unsigned", "the signed file with the signer gone is exit 79: this is what the reset prevents");
                File.WriteAllText(PolicyStore.PathFor(config), after);
                // an action that was signed without a person now waits for one
                Assert(StateOf(SubmitAction(k.Fx, "environment.stop")) == "pending", "environment.stop needs a person again");
                // an old signed message cannot be replayed on the reset revision; the next change continues from it
                byte[] again = PolicyChange.Message(PolicyOf(PolicyJson(1, "standard")), "authority-key-2026-10", "albera-host-broker");
                Assert(Code(k.Fx.PolicySet(PolicyJson(1, "standard"), Hello.SignData(again, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))) == "request_invalid", "revision 1 again is refused");
                byte[] next = PolicyChange.Message(PolicyOf(PolicyJson(3, "standard")), "authority-key-2026-10", "albera-host-broker");
                Assert(Code(k.Fx.PolicySet(PolicyJson(3, "standard"), b.Proof(next, 5))) == "ok", "revision 3 signed by a remaining key");
            });
        });
        Check("key_remove: removing a key that did not sign the policy leaves the policy and its file untouched, and no policyReset", () =>
        {
            using Authenticator a = new(), b = new();
            WithSignedPolicy(a, [a, b], (k, config, policy) =>
            {
                string before = PolicyFileText(config);
                string challenge = k.ChallengeValue("remove", b.Key.KeyId);
                JsonElement reply = k.KeyRemove(challenge, b.Key.KeyId, a.Wire(RemoveMessage(b.Key, challenge), 3));
                Assert(Code(reply) == "ok" && !reply.TryGetProperty("policyReset", out _) && reply.EnumerateObject().Count() == 2, $"{reply}");
                Assert(k.Fx.Core.Policy() is { Tier: "standard", Revision: 1 } && PolicyFileText(config) == before, "policy and file as they were");
                Assert(PolicyStore.TryLoad(config, DefaultIdentity, ApproverKeySet.InMemory(k.Keys.Keys, () => Start).ForStoredProofs, out string reason, out bool fromFile) is { } && fromFile, $"restart: {reason}");
                // removing the Hello key, which did not sign it either
                challenge = k.ChallengeValue("remove", "hello-key-yosuke-01");
                reply = k.KeyRemove(challenge, "hello-key-yosuke-01", a.Wire(RemoveMessage(HelloKeyRecord(), challenge), 4));
                Assert(Code(reply) == "ok" && !reply.TryGetProperty("policyReset", out _) && PolicyFileText(config) == before, $"{reply}");
            });
            // a policy that skips nobody has no proof to lose: whichever key goes, it stays as it is
            InFolder(config =>
            {
                File.WriteAllText(config, ConfigJson());
                KeyFixture k = new([HelloKeyRecord(), a.Key], policyFor: stored => PolicyStore.TryLoad(config, DefaultIdentity, stored, out string reason, out _) ?? throw new CheckFailed(reason));
                Assert(Code(k.Fx.PolicySet(PolicyJson(1, "careful", "environment.stop"))) == "ok", "a careful policy with a prompt needs no signature");
                string before = PolicyFileText(config);
                string challenge = k.ChallengeValue("remove", a.Key.KeyId);
                JsonElement reply = k.KeyRemove(challenge, a.Key.KeyId, HelloWire(RemoveMessage(a.Key, challenge)));
                Assert(Code(reply) == "ok" && !reply.TryGetProperty("policyReset", out _) && PolicyFileText(config) == before && k.Fx.Core.Policy() is { Tier: "careful", Revision: 1 }, $"{reply}");
            });
        });
        Check("key_remove: the Hello key can be the policy's signer too; removing it resets the policy, and removing another Hello-or-webauthn key does not", () =>
        {
            using Authenticator a = new();
            WithSignedPolicy(null, [a], (k, config, policy) =>
            {
                string challenge = k.ChallengeValue("remove", "hello-key-yosuke-01");
                JsonElement reply = k.KeyRemove(challenge, "hello-key-yosuke-01", a.Wire(RemoveMessage(HelloKeyRecord(), challenge), 3));
                Assert(Code(reply) == "ok" && reply.GetProperty("policyReset").GetBoolean() && k.Fx.Core.Policy() is { Tier: "careful", Revision: 2 }, $"{reply}");
                Assert(PolicyStore.TryLoad(config, DefaultIdentity, ApproverKeySet.InMemory(k.Keys.Keys, () => Start).ForStoredProofs, out string reason, out _) is { }, $"restart: {reason}");
            });
        });
        Check("key_remove: the policy is reset BEFORE the key is removed, so a crash between the two writes leaves a state that starts; a reset that cannot be written keeps the key", () =>
        {
            using Authenticator a = new(), b = new();
            WithSignedPolicy(a, [a, b], (k, config, policy) =>
            {
                // (1) the crash itself: the reset is written, the key is still registered
                ApproverKeySet remaining = ApproverKeySet.InMemory([HelloKeyRecord(), b.Key], () => Start);
                (string? code, TierPolicy? reset) = policy.ResetIfSignerGone(remaining.ForStoredProofs);
                Assert(code is null && reset is { Tier: "careful", Revision: 2 }, "the reset was written");
                ApproverKeySet everyone = ApproverKeySet.InMemory([HelloKeyRecord(), a.Key, b.Key], () => Start);
                Assert(PolicyStore.TryLoad(config, DefaultIdentity, everyone.ForStoredProofs, out string reason, out bool fromFile) is { } && fromFile, $"a start with all three keys still registered: {reason}");
                Assert(policy.ResetIfSignerGone(remaining.ForStoredProofs) is (null, null), "and a second call has nothing left to reset");
            });
            // (2) the reset cannot be written: the key stays, nothing else changes
            WithSignedPolicy(a, [a, b], (k, config, policy) =>
            {
                string signedFile = PolicyFileText(config);
                System.Security.Principal.SecurityIdentifier? self = System.Security.Principal.WindowsIdentity.GetCurrent().User;
                string challenge = k.ChallengeValue("remove", a.Key.KeyId);
                ServicePathGuard.ServiceSidForTest = new System.Security.Principal.SecurityIdentifier("S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555"); // the new policy file is not trusted
                JsonElement refused = k.KeyRemove(challenge, a.Key.KeyId, b.Wire(RemoveMessage(a.Key, challenge), 3));
                ServicePathGuard.ServiceSidForTest = self;
                Assert(Code(refused) == "authority_unavailable", $"{refused}");
                Assert(k.Keys.Keys.Any(x => x.KeyId == a.Key.KeyId) && k.Fx.Core.Policy() is { Tier: "standard", Revision: 1 } && PolicyFileText(config) == signedFile, "the key is still registered and the signed policy is as it was");
                Assert(Directory.GetFiles(Path.GetDirectoryName(config)!, "policy.*.tmp").Length == 0, "no temp file left");
                challenge = k.ChallengeValue("remove", a.Key.KeyId);
                JsonElement retry = k.KeyRemove(challenge, a.Key.KeyId, b.Wire(RemoveMessage(a.Key, challenge), 4));
                Assert(Code(retry) == "ok" && retry.GetProperty("policyReset").GetBoolean(), $"once the file can be written the same removal works: {retry}");
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
