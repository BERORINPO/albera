using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.ApprovalAuthority;
using Albera.BrokerContract;

// Runs every unit check in-process and prints one JSON document: { checks: [{ name, ok, detail }], digestProbes: [...] }.
// The Node test (test/runtime-approval-authority-unit.test.mjs) turns each check into a subtest and re-computes the digest probes with the Node contract.
internal static partial class Harness
{
    private const long Start = 1_800_000_000;
    private static readonly List<object> Results = [];
    private static readonly RSA Hello = RSA.Create(2048);

    private sealed class CheckFailed(string message) : Exception(message);

    private static void Assert(bool condition, string detail) { if (!condition) throw new CheckFailed(detail); }

    private static void Check(string name, Action body)
    {
        try { body(); Results.Add(new { name, ok = true, detail = "" }); }
        catch (Exception ex) { Results.Add(new { name, ok = false, detail = $"{ex.GetType().Name}: {ex.Message}" }); }
    }

    // ---- fixture -------------------------------------------------------------------------------------------------------------------------
    private sealed class Fixture
    {
        public long Now = Start;
        public readonly FakeReceiptSigner Signer = new();
        public readonly AuthorityIdentity Identity;
        public readonly PendingStore Store;
        public readonly AuthorityCore Core;
        public readonly AuthorityProtocol Protocol;

        public Fixture(int ttl = PendingStore.DefaultTtlSeconds, IHumanPresenceVerifier? presence = null, AuthorityIdentity? identity = null, PolicyStore? policy = null, Action<string>? audit = null)
        {
            Identity = identity ?? new AuthorityIdentity("authority-key-2026-10", "albera-host-broker", "policy-2026-10", "hello-key-yosuke-01");
            Store = new PendingStore(() => Now, ttl);
            Core = new AuthorityCore(Store, Signer, presence ?? RsaPresenceVerifier.TryCreate(Hello.ExportSubjectPublicKeyInfo())!, Identity, () => Now, policy, audit);
            Protocol = new AuthorityProtocol(Core);
        }

        public JsonElement Call(PipeRole role, string json) => Parse(Protocol.Handle(role, Encoding.UTF8.GetBytes(json)));
        public JsonElement Submit(string json) => Call(PipeRole.Submit, json);
        public JsonElement PolicyGet() => Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"policy\"}");
        public JsonElement PolicySet(string policyJson, byte[]? presence = null) =>
            Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{policyJson}{(presence is null ? "" : $",\"presence\":\"{Convert.ToBase64String(presence)}\"")}}}");
        public JsonElement Status(string approvalId) => Call(PipeRole.Submit, $"{{\"v\":1,\"verb\":\"status\",\"approvalId\":\"{approvalId}\"}}");
        public JsonElement List(long after = 0) => Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"list\",\"afterSeq\":{after}}}");
        public JsonElement Deny(string approvalId) => Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{approvalId}\",\"decision\":\"deny\"}}");
        public JsonElement Approve(string approvalId, byte[] proof) => Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{approvalId}\",\"decision\":\"approve\",\"presence\":\"{Convert.ToBase64String(proof)}\"}}");

        /// <summary>Approve with a signature the pinned Hello key would produce over this entry's message.</summary>
        public JsonElement ApproveSigned(string approvalId)
        {
            PendingEntry entry = Store.Get(approvalId)!;
            return Approve(approvalId, SignPresence(Hello, entry));
        }
    }

    private static JsonElement Parse(byte[] json) => JsonDocument.Parse(json).RootElement.Clone();

    private static byte[] SignPresence(RSA key, PendingEntry entry) =>
        key.SignData(PresenceMessage.Build(entry.ApprovalId, entry.ActionDigest, entry.Challenge), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

    private static string SubmitJson(string op = "op-1", string idem = "idem-1", string action = "environment.start", string args = "{}", string challenge = "_-7dzLuqmYh3ZlVEMyIRAA", string extra = "", string purpose = "broker.operation") =>
        $"{{\"v\":1,\"verb\":\"submit\",\"purpose\":\"{purpose}\",\"operationId\":\"{op}\",\"idempotencyKey\":\"{idem}\",\"leaseId\":\"lease-1\",\"leaseGeneration\":7,\"brokerEpoch\":3,\"brokerChallenge\":\"{challenge}\",\"action\":{{\"action\":\"{action}\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{args}}}{extra}}}";

    private static string Code(JsonElement reply) => reply.GetProperty("ok").GetBoolean() ? "ok" : reply.GetProperty("code").GetString()!;
    private static string ApprovalIdOf(JsonElement submitReply) { Assert(Code(submitReply) == "ok", $"submit failed: {submitReply}"); return submitReply.GetProperty("approvalId").GetString()!; }

    private static (byte[] Receipt, byte[] Signature) ReceiptOf(JsonElement status) =>
        (Convert.FromBase64String(status.GetProperty("receipt").GetString()!), Convert.FromBase64String(status.GetProperty("signature").GetString()!));

    private static ReceiptVerdict Verify(Fixture fx, byte[] receipt, string args = "{}", string challenge = "_-7dzLuqmYh3ZlVEMyIRAA")
    {
        ValidatedAction dto = ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes($"{{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{args}}}"), 3));
        PendingRequest request = new("broker.operation", "op-1", "idem-1", "lease-1", 7, 3, challenge, dto);
        return ReceiptBuilder.Check(receipt, request, fx.Identity, fx.Signer.Issuer, fx.Now);
    }

    // ---- checks --------------------------------------------------------------------------------------------------------------------------
    private static void StoreChecks()
    {
        Check("store: a submit creates one pending entry with a 120 s TTL, a lowercase UUID approvalId and a canonical 128-bit challenge", () =>
        {
            Fixture fx = new();
            JsonElement reply = fx.Submit(SubmitJson());
            string id = ApprovalIdOf(reply);
            Assert(reply.GetProperty("state").GetString() == "pending" && reply.GetProperty("expiresAt").GetInt64() == Start + 120, "pending, expiresAt = now + 120");
            PendingEntry entry = fx.Store.Get(id)!;
            Assert(System.Text.RegularExpressions.Regex.IsMatch(id, "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"), $"uuid {id}");
            Assert(System.Text.RegularExpressions.Regex.IsMatch(entry.Challenge, "^[A-Za-z0-9_-]{21}[AQgw]$"), $"challenge {entry.Challenge}");
            Assert(fx.Store.Count == 1, "one entry");
        });
        Check("store: the same operationId + idempotencyKey returns the first entry; different content under that key is request_invalid", () =>
        {
            Fixture fx = new();
            string first = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(ApprovalIdOf(fx.Submit(SubmitJson())) == first, "reused");
            Assert(fx.Store.Count == 1, "still one entry");
            Assert(Code(fx.Submit(SubmitJson(args: "{\"vmName\":\"x\"}"))) == "request_invalid", "different args under the same key");
            Assert(Code(fx.Submit(SubmitJson(challenge: "ABEiM0RVZneImaq7zN3u_w"))) == "request_invalid", "different brokerChallenge under the same key");
            Assert(fx.Store.Count == 1, "nothing new was queued");
        });
        Check("store: queue_full at the 33rd pending request; a decision frees a slot", () =>
        {
            Fixture fx = new();
            string first = "";
            for (int i = 0; i < PendingStore.MaxPending; i++)
            {
                string id = ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{i}", idem: $"idem-{i}")));
                if (i == 0) first = id;
            }
            Assert(Code(fx.Submit(SubmitJson(op: "op-33", idem: "idem-33"))) == "queue_full", "33rd request");
            Assert(Code(fx.Submit(SubmitJson(op: "op-0", idem: "idem-0"))) == "ok", "a duplicate of a queued request is not a new slot");
            Assert(Code(fx.Deny(first)) == "ok", "deny");
            Assert(Code(fx.Submit(SubmitJson(op: "op-33", idem: "idem-33"))) == "ok", "slot freed");
        });
        Check("store: at most 64 entries in total (pending plus remembered outcomes), and outcomes are dropped 120 s after the decision", () =>
        {
            Fixture fx = new();
            for (int i = 0; i < PendingStore.MaxEntries; i++) Assert(Code(fx.Deny(ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{i}", idem: $"idem-{i}"))))) == "ok", "deny");
            Assert(fx.Store.Count == PendingStore.MaxEntries && fx.List().GetProperty("pending").GetArrayLength() == 0, "64 remembered outcomes, nothing pending");
            Assert(Code(fx.Submit(SubmitJson(op: "op-x", idem: "idem-x"))) == "queue_full", "the 65th entry");
            fx.Now += PendingStore.DecidedRetentionSeconds;
            Assert(Code(fx.Submit(SubmitJson(op: "op-x", idem: "idem-x"))) == "ok" && fx.Store.Count == 1, "outcomes dropped, room again");
        });
        Check("expiry: after the TTL status says request_expired, list is empty, decide says request_expired, and the entry is forgotten 60 s later", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            fx.Now = Start + 119;
            Assert(Code(fx.Status(id)) == "ok", "still pending at ttl-1");
            fx.Now = Start + 120;
            Assert(Code(fx.Status(id)) == "request_expired", "expired at ttl");
            Assert(fx.List().GetProperty("pending").GetArrayLength() == 0, "not listed");
            Assert(Code(fx.Deny(id)) == "request_expired", "deny after expiry");
            Assert(Code(fx.Approve(id, new byte[256])) == "request_expired", "approve after expiry");
            Assert(fx.Store.Get(id)!.Receipt is null, "no receipt");
            fx.Now = Start + 120 + 60;
            Assert(Code(fx.Status(id)) == "request_invalid", "forgotten");
        });
        Check("expiry: a request that expired frees its slot", () =>
        {
            Fixture fx = new(ttl: 5);
            for (int i = 0; i < PendingStore.MaxPending; i++) ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{i}", idem: $"idem-{i}")));
            Assert(Code(fx.Submit(SubmitJson(op: "late", idem: "late"))) == "queue_full", "full");
            fx.Now += 5;
            Assert(Code(fx.Submit(SubmitJson(op: "late", idem: "late"))) == "ok", "free again");
        });
        Check("store: list is oldest first and honours afterSeq", () =>
        {
            Fixture fx = new();
            List<string> ids = [.. Enumerable.Range(0, 4).Select(i => ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{i}", idem: $"idem-{i}"))))];
            JsonElement all = fx.List();
            Assert(all.GetProperty("pending").EnumerateArray().Select(e => e.GetProperty("approvalId").GetString()).SequenceEqual(ids), "oldest first");
            long second = all.GetProperty("pending")[1].GetProperty("seq").GetInt64();
            Assert(fx.List(second).GetProperty("pending").GetArrayLength() == 2, "afterSeq skips the first two");
            fx.Deny(ids[0]);
            Assert(fx.List().GetProperty("pending").GetArrayLength() == 3, "decided entries are not listed");
        });
    }

    private static void DigestChecks()
    {
        Check("digest: the Authority computes the digest from the DTO and a wrong expectedDigest is request_invalid (nothing queued)", () =>
        {
            Fixture fx = new();
            string args = "{\"vmName\":\"alpha\",\"cpu\":2,\"fast\":true}";
            string expected = ActionDigest.Compute("broker.operation", ReceiptBuilder.DtoOf(ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes($"{{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{args}}}"), 3))));
            string tampered = "sha256:" + new string('0', 64);
            Assert(Code(fx.Submit(SubmitJson(args: args, extra: $",\"expectedDigest\":\"{tampered}\""))) == "request_invalid", "tampered digest");
            Assert(fx.Store.Count == 0, "nothing queued");
            string id = ApprovalIdOf(fx.Submit(SubmitJson(args: args, extra: $",\"expectedDigest\":\"{expected}\"")));
            Assert(fx.Store.Get(id)!.ActionDigest == expected, "the stored digest is the recomputed one");
        });
        Check("digest: the same DTO has different digests per purpose and per args; the list shows the exact action and args", () =>
        {
            Fixture fx = new();
            string a = ApprovalIdOf(fx.Submit(SubmitJson(op: "a", idem: "a", args: "{\"n\":1}")));
            string b = ApprovalIdOf(fx.Submit(SubmitJson(op: "b", idem: "b", args: "{\"n\":2}")));
            string c = ApprovalIdOf(fx.Submit(SubmitJson(op: "c", idem: "c", args: "{\"n\":1}", action: "synthetic.noop", purpose: "guest.command")));
            string[] digests = [fx.Store.Get(a)!.ActionDigest, fx.Store.Get(b)!.ActionDigest, fx.Store.Get(c)!.ActionDigest];
            Assert(digests.Distinct().Count() == 3, "three different digests");
            JsonElement first = fx.List().GetProperty("pending")[0];
            Assert(first.GetProperty("actionDigest").GetString() == digests[0] && first.GetProperty("action").GetProperty("args").GetProperty("n").GetInt64() == 1 &&
                first.GetProperty("action").GetProperty("projectId").GetString() == "proj-alpha", "list shows the DTO behind the digest");
        });
        Check("digest: a DTO the contract rejects (unknown action, extra key, bad arg, wrong purpose pairing) is request_invalid", () =>
        {
            Fixture fx = new();
            Assert(Code(fx.Submit(SubmitJson(action: "environment.explode"))) == "request_invalid", "unknown action");
            Assert(Code(fx.Submit(SubmitJson(action: "task.start"))) == "request_invalid", "guest action under broker.operation");
            Assert(Code(fx.Submit(SubmitJson(args: "{\"Bad\":1}"))) == "request_invalid", "bad arg key");
            Assert(Code(fx.Submit(SubmitJson(args: "{\"a\":\"\\u202e\"}"))) == "request_invalid", "bidi control in an arg");
            Assert(Code(fx.Submit(SubmitJson(extra: ",\"action2\":{}"))) == "request_invalid", "extra key");
            Assert(Code(fx.Submit(SubmitJson(op: "bad id"))) == "request_invalid", "operationId grammar");
            Assert(Code(fx.Submit(SubmitJson(challenge: "short"))) == "request_invalid", "brokerChallenge grammar");
            Assert(fx.Store.Count == 0, "nothing queued");
        });
    }

    private static void ReceiptChecks()
    {
        Check("approve: the receipt validates with the contract, is signed by the signer key, and carries the submit request's epoch / challenge / generation", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson(args: "{\"vmName\":\"alpha\"}")));
            Assert(Code(fx.Status(id)) == "ok" && fx.Status(id).GetProperty("state").GetString() == "pending", "pending before the decision");
            fx.Now += 10;
            JsonElement decided = fx.ApproveSigned(id);
            Assert(Code(decided) == "ok" && decided.GetProperty("state").GetString() == "approved", $"approve: {decided}");
            JsonElement status = fx.Status(id);
            (byte[] receipt, byte[] signature) = ReceiptOf(status);
            Assert(signature.Length == 64 && fx.Signer.PublicKeySpki.Length > 0, "64-byte P1363 signature");
            using ECDsa key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(fx.Signer.PublicKeySpki, out _);
            Assert(key.VerifyData(receipt, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation), "signature verifies over the receipt bytes");
            ReceiptVerdict verdict = Verify(fx, receipt, "{\"vmName\":\"alpha\"}");
            Assert(verdict.Ok, $"contract verdict {verdict.Code}/{verdict.Field}");
            IReadOnlyDictionary<string, object> r = verdict.Receipt!;
            Assert((long)r["brokerEpoch"] == 3 && (long)r["leaseGeneration"] == 7 && (string)r["brokerChallenge"] == "_-7dzLuqmYh3ZlVEMyIRAA", "epoch / generation / challenge come from the request");
            Assert((string)r["kid"] == "authority-key-2026-10" && (string)r["audience"] == "albera-host-broker" && (string)r["policyVersion"] == "policy-2026-10" && (string)r["approverKeyId"] == "hello-key-yosuke-01", "kid / audience / policy / approver key from config");
            Assert((long)r["iat"] == Start + 10 && (long)r["exp"] == Start + 130 && (string)r["approvalId"] == id, "iat = approval time, exp = iat + 120, approvalId");
            Assert((string)r["actionDigest"] == fx.Store.Get(id)!.ActionDigest, "digest is the Authority's");
        });
        Check("approve: receiptId and nonce are fresh for every receipt", () =>
        {
            Fixture fx = new();
            List<IReadOnlyDictionary<string, object>> receipts = [];
            for (int i = 0; i < 3; i++)
            {
                string id = ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{i}", idem: $"idem-{i}")));
                fx.ApproveSigned(id);
                receipts.Add(ReceiptV2.Parse(ReceiptOf(fx.Status(id)).Receipt).Receipt!);
            }
            Assert(receipts.Select(r => (string)r["receiptId"]).Distinct().Count() == 3 && receipts.Select(r => (string)r["nonce"]).Distinct().Count() == 3, "unique");
        });
        Check("approve: a receipt does not validate for a tampered DTO or a different broker challenge, and a fake-signed receipt fails production validation", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson(args: "{\"vmName\":\"alpha\"}")));
            fx.ApproveSigned(id);
            byte[] receipt = ReceiptOf(fx.Status(id)).Receipt;
            Assert(Verify(fx, receipt, "{\"vmName\":\"alpha\"}").Ok, "control");
            ReceiptVerdict tampered = Verify(fx, receipt, "{\"vmName\":\"beta\"}");
            Assert(tampered is { Ok: false, Code: "action_digest" }, $"tampered args: {tampered.Code}");
            ReceiptVerdict otherChallenge = Verify(fx, receipt, "{\"vmName\":\"alpha\"}", "ABEiM0RVZneImaq7zN3u_w");
            Assert(otherChallenge is { Ok: false, Code: "binding", Field: "brokerChallenge" }, $"other challenge: {otherChallenge.Code}");
            Assert(fx.Signer.Issuer != ReceiptV2.Issuer, "the fake signer uses a test issuer");
            ReceiptVerdict production = ReceiptV2.Validate(receipt, new ReceiptContext(() => fx.Now, "production", new Dictionary<string, object>
            {
                ["audience"] = "albera-host-broker", ["purpose"] = "broker.operation", ["operationId"] = "op-1", ["idempotencyKey"] = "idem-1", ["leaseId"] = "lease-1",
                ["leaseGeneration"] = 7L, ["brokerEpoch"] = 3L, ["brokerChallenge"] = "_-7dzLuqmYh3ZlVEMyIRAA", ["policyVersion"] = "policy-2026-10",
            }, ReceiptBuilder.DtoOf(ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{\"vmName\":\"alpha\"}}"), 3)))));
            Assert(production is { Ok: false, Code: "issuer" }, $"production verdict {production.Code}");
        });
        Check("approve: a second decision on the same request is request_invalid and keeps the first receipt", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(Code(fx.ApproveSigned(id)) == "ok", "first");
            byte[] first = ReceiptOf(fx.Status(id)).Receipt;
            Assert(Code(fx.ApproveSigned(id)) == "request_invalid" && Code(fx.Deny(id)) == "request_invalid", "second");
            Assert(ReceiptOf(fx.Status(id)).Receipt.SequenceEqual(first), "same receipt");
        });
        Check("approve: an approved request is reused (same receipt) only while its receipt is valid", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            fx.ApproveSigned(id);
            Assert(ApprovalIdOf(fx.Submit(SubmitJson())) == id, "reused while valid");
            fx.Now += 120;
            string again = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(again != id && fx.Status(again).GetProperty("state").GetString() == "pending", "a fresh pending request once the receipt is over");
        });
        Check("approve: a failing signer gives authority_unavailable to the approver and to the Control Plane, with no receipt", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            fx.Signer.Failing = true;
            Assert(Code(fx.ApproveSigned(id)) == "authority_unavailable", "decide");
            Assert(Code(fx.Status(id)) == "authority_unavailable" && fx.Store.Get(id)!.Receipt is null, "status");
        });
        Check("deny: status says human_denied and no receipt is made", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(Code(fx.Deny(id)) == "ok", "deny");
            Assert(Code(fx.Status(id)) == "human_denied" && fx.Store.Get(id)!.Receipt is null, "status");
        });
        Check("approve: the worst-case receipt (64-character ids) fits the receipt limit and a 2 KiB reply", () =>
        {
            string id64 = new('a', 64);
            Fixture fx = new(identity: new AuthorityIdentity(id64, new string('b', 64), id64, id64));
            string reply = SubmitJson(op: id64, idem: id64).Replace("lease-1", id64).Replace("proj-alpha", id64).Replace("pc-01", id64);
            string approvalId = ApprovalIdOf(fx.Submit(reply));
            Assert(Code(fx.ApproveSigned(approvalId)) == "ok", "approve");
            byte[] bytes = fx.Protocol.Handle(PipeRole.Submit, Encoding.UTF8.GetBytes($"{{\"v\":1,\"verb\":\"status\",\"approvalId\":\"{approvalId}\"}}"));
            (byte[] receipt, _) = ReceiptOf(Parse(bytes));
            Assert(receipt.Length <= ReceiptV2.MaxReceiptBytes && bytes.Length <= AuthorityProtocol.MaxFrameBytes, $"receipt {receipt.Length} bytes, reply {bytes.Length} bytes");
        });
    }

    private static void PresenceChecks()
    {
        Check("presence: a signature from another key is presence_mismatch, final for that request", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            using RSA other = RSA.Create(2048);
            Assert(Code(fx.Approve(id, SignPresence(other, fx.Store.Get(id)!))) == "presence_mismatch", "decide");
            Assert(Code(fx.Status(id)) == "presence_mismatch" && fx.Store.Get(id)!.Receipt is null, "status");
            Assert(Code(fx.ApproveSigned(id)) == "request_invalid", "no second try on the same request");
        });
        Check("presence: a valid signature over ANOTHER request's message (replay) or a changed challenge is presence_mismatch", () =>
        {
            Fixture fx = new();
            string a = ApprovalIdOf(fx.Submit(SubmitJson(op: "a", idem: "a")));
            string b = ApprovalIdOf(fx.Submit(SubmitJson(op: "b", idem: "b", args: "{\"n\":2}")));
            byte[] forA = SignPresence(Hello, fx.Store.Get(a)!);
            Assert(Code(fx.Approve(b, forA)) == "presence_mismatch", "signature made for a different approvalId and digest");
            string c = ApprovalIdOf(fx.Submit(SubmitJson(op: "c", idem: "c")));
            PendingEntry entry = fx.Store.Get(c)!;
            byte[] otherChallenge = Hello.SignData(PresenceMessage.Build(entry.ApprovalId, entry.ActionDigest, "ABEiM0RVZneImaq7zN3u_w"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            Assert(Code(fx.Approve(c, otherChallenge)) == "presence_mismatch", "signature over another challenge");
        });
        Check("presence: empty, short and over-long proofs are presence_mismatch; a missing or non-base64 proof is request_invalid", () =>
        {
            Fixture fx = new();
            foreach (byte[] proof in new[] { Array.Empty<byte>(), new byte[255], new byte[257], new byte[256] })
            {
                string id = ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{proof.Length}", idem: $"i-{proof.Length}")));
                Assert(Code(fx.Approve(id, proof)) == "presence_mismatch", $"proof of {proof.Length} bytes");
            }
            string pending = ApprovalIdOf(fx.Submit(SubmitJson(op: "x", idem: "x")));
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{pending}\",\"decision\":\"approve\"}}")) == "request_invalid", "no presence field");
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{pending}\",\"decision\":\"approve\",\"presence\":\"***\"}}")) == "request_invalid", "not base64");
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{pending}\",\"decision\":\"deny\",\"presence\":\"AA==\"}}")) == "request_invalid", "a deny carries no proof");
            Assert(fx.Store.Get(pending)!.State == EntryState.Pending, "still pending after the malformed decisions");
        });
        Check("presence: the approver can report that Hello is unavailable, which is final and reaches the Control Plane as presence_unavailable", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{id}\",\"decision\":\"presence_unavailable\"}}")) == "presence_unavailable", "decide");
            Assert(Code(fx.Status(id)) == "presence_unavailable" && fx.Store.Get(id)!.Receipt is null, "status");
        });
        Check("presence: the fake verifier drives verified / mismatch / unavailable through the same core", () =>
        {
            Fixture fx = new(presence: new FakePresenceVerifier());
            string ok = ApprovalIdOf(fx.Submit(SubmitJson(op: "a", idem: "a")));
            PendingEntry entry = fx.Store.Get(ok)!;
            Assert(Code(fx.Approve(ok, FakePresenceVerifier.ProofFor(PresenceMessage.Build(entry.ApprovalId, entry.ActionDigest, entry.Challenge)))) == "ok", "verified");
            string bad = ApprovalIdOf(fx.Submit(SubmitJson(op: "b", idem: "b")));
            Assert(Code(fx.Approve(bad, [1, 2, 3])) == "presence_mismatch", "mismatch");
            string down = ApprovalIdOf(fx.Submit(SubmitJson(op: "c", idem: "c")));
            Assert(Code(fx.Approve(down, FakePresenceVerifier.UnavailableProof)) == "presence_unavailable", "unavailable");
        });
        Check("presence: the real verifier accepts exactly an RSA-2048 PKCS#1 v1.5 / SHA-256 signature and rejects other keys, sizes and trailing bytes", () =>
        {
            byte[] message = Encoding.UTF8.GetBytes("m");
            using RsaPresenceVerifier verifier = RsaPresenceVerifier.TryCreate(Hello.ExportSubjectPublicKeyInfo())!;
            byte[] good = Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            Assert(verifier.Verify(message, good) == PresenceResult.Verified, "good");
            Assert(verifier.Verify(Encoding.UTF8.GetBytes("n"), good) == PresenceResult.Mismatch, "other message");
            Assert(verifier.Verify(message, Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pss)) == PresenceResult.Mismatch, "PSS is not PKCS#1 v1.5");
            Assert(verifier.Verify(message, Hello.SignData(message, HashAlgorithmName.SHA384, RSASignaturePadding.Pkcs1)) == PresenceResult.Mismatch, "SHA-384");
            using RSA small = RSA.Create(1024);
            Assert(RsaPresenceVerifier.TryCreate(small.ExportSubjectPublicKeyInfo()) is null, "RSA-1024 refused");
            using ECDsa ec = ECDsa.Create();
            Assert(RsaPresenceVerifier.TryCreate(ec.ExportSubjectPublicKeyInfo()) is null, "an EC key refused");
            Assert(RsaPresenceVerifier.TryCreate([.. Hello.ExportSubjectPublicKeyInfo(), 0]) is null, "trailing byte refused");
            Assert(RsaPresenceVerifier.TryCreate([1, 2, 3]) is null, "garbage refused");
        });
    }

    private static void ProtocolChecks()
    {
        Check("protocol: each pipe accepts only its own verbs (submit pipe: submit/status; approver pipe: list/decide)", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(fx.Submit(SubmitJson()));
            Assert(Code(fx.Call(PipeRole.Submit, "{\"v\":1,\"verb\":\"list\"}")) == "request_invalid", "list on the submit pipe");
            Assert(Code(fx.Call(PipeRole.Submit, $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{id}\",\"decision\":\"deny\"}}")) == "request_invalid", "decide on the submit pipe");
            Assert(fx.Store.Get(id)!.State == EntryState.Pending, "the pending request was not touched");
            Assert(Code(fx.Call(PipeRole.Approver, SubmitJson(op: "z", idem: "z"))) == "request_invalid", "submit on the approver pipe");
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"status\",\"approvalId\":\"{id}\"}}")) == "request_invalid", "status on the approver pipe");
            Assert(fx.Store.Count == 1, "nothing was queued by the approver pipe");
        });
        Check("protocol: malformed requests are request_invalid (null, array, duplicate key, extra key, wrong version, unknown verb, not an object, empty)", () =>
        {
            Fixture fx = new();
            string[] bad =
            [
                "{\"v\":1,\"verb\":\"list\",\"afterSeq\":null}", "{\"v\":1,\"verb\":\"list\",\"afterSeq\":[1]}", "{\"v\":1,\"v\":1,\"verb\":\"list\"}", "{\"v\":1,\"verb\":\"list\",\"x\":1}",
                "{\"v\":2,\"verb\":\"list\"}", "{\"v\":\"1\",\"verb\":\"list\"}", "{\"v\":1,\"verb\":\"purge\"}", "{\"v\":1}", "[]", "\"list\"", "", "{\"v\":1,\"verb\":\"list\",\"afterSeq\":-1}",
                "{\"v\":1,\"verb\":\"list\",\"afterSeq\":1.5}", "\ufeff{\"v\":1,\"verb\":\"list\"}", "{\"v\":1,\"verb\":\"list\"} x",
            ];
            foreach (string request in bad) Assert(Code(fx.Call(PipeRole.Approver, request)) == "request_invalid", $"accepted: {request}");
            Assert(Code(fx.Call(PipeRole.Submit, "{\"v\":1,\"verb\":\"status\",\"approvalId\":\"x\",\"extra\":1}")) == "request_invalid", "status with an extra key");
            Assert(Code(fx.Status("00000000-0000-4000-8000-000000000000")) == "request_invalid", "unknown approvalId");
        });
        Check("protocol: replies carry only fixed codes and never echo request text", () =>
        {
            Fixture fx = new();
            string reply = Encoding.UTF8.GetString(fx.Protocol.Handle(PipeRole.Submit, Encoding.UTF8.GetBytes("{\"v\":1,\"verb\":\"SECRET-VERB\"}")));
            Assert(reply == "{\"ok\":false,\"code\":\"request_invalid\"}", reply);
        });
        Check("protocol: list pages by frame size (entries of about 900 bytes, 2 per page, more/lastSeq continue) and no reply exceeds 2 KiB", () =>
        {
            Fixture fx = new();
            string text = new('x', 200);
            string args = $"{{\"a\":\"{text}\",\"b\":\"{text}\",\"c\":\"{text}\"}}";
            for (int i = 0; i < 5; i++) ApprovalIdOf(fx.Submit(SubmitJson(op: $"op-{i}", idem: $"idem-{i}", args: args)));
            long after = 0;
            int total = 0, pages = 0;
            while (true)
            {
                byte[] raw = fx.Protocol.Handle(PipeRole.Approver, Encoding.UTF8.GetBytes($"{{\"v\":1,\"verb\":\"list\",\"afterSeq\":{after}}}"));
                Assert(raw.Length <= AuthorityProtocol.MaxFrameBytes, $"page of {raw.Length} bytes");
                JsonElement page = Parse(raw);
                int count = page.GetProperty("pending").GetArrayLength();
                Assert(count >= 1, "every page makes progress");
                total += count;
                pages++;
                after = page.GetProperty("lastSeq").GetInt64();
                if (!page.GetProperty("more").GetBoolean()) break;
            }
            Assert(total == 5 && pages >= 2, $"{total} entries in {pages} pages");
        });
        Check("protocol: a request whose list entry could not fit one frame is request_invalid", () =>
        {
            Fixture fx = new();
            string cjk = string.Concat(Enumerable.Repeat("\u3042", 85)); // 255 UTF-8 bytes, 510 characters once escaped as \uXXXX
            string args = string.Join(',', Enumerable.Range(0, 5).Select(i => $"\"k{i}\":\"{cjk}\""));
            Assert(Code(fx.Submit(SubmitJson(args: $"{{{args}}}"))) == "request_invalid", "oversize entry");
            Assert(fx.Store.Count == 0, "not queued");
        });
        Check("protocol: unicode args are shown exactly (NFC and NFD differ) and survive the list", () =>
        {
            Fixture fx = new();
            string nfc = "\u00e9", nfd = "e\u0301";
            string a = ApprovalIdOf(fx.Submit(SubmitJson(op: "a", idem: "a", args: $"{{\"s\":\"{nfc}\"}}")));
            string b = ApprovalIdOf(fx.Submit(SubmitJson(op: "b", idem: "b", args: $"{{\"s\":\"{nfd}\"}}")));
            Assert(fx.Store.Get(a)!.ActionDigest != fx.Store.Get(b)!.ActionDigest, "different digests");
            JsonElement items = fx.List().GetProperty("pending");
            Assert(items[0].GetProperty("action").GetProperty("args").GetProperty("s").GetString() == nfc && items[1].GetProperty("action").GetProperty("args").GetProperty("s").GetString() == nfd, "exact strings");
        });
    }

    private static string ConfigJson(Dictionary<string, string>? changes = null, string[]? drop = null)
    {
        string self = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
        Dictionary<string, string> values = new()
        {
            ["pipeRoot"] = "ALBERA\\ApprovalAuthority", ["controlPlaneSid"] = "S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555", ["approverSid"] = GuestSid(self),
            ["signingKeyName"] = "AlberaApprovalAuthority-2026-10", ["signingKeyProvider"] = "tpm", ["kid"] = "authority-key-2026-10", ["approverKeyId"] = "hello-key-yosuke-01",
            ["approverPublicKey"] = Convert.ToBase64String(Hello.ExportSubjectPublicKeyInfo()), ["audience"] = "albera-host-broker", ["policyVersion"] = "policy-2026-10",
        };
        foreach ((string key, string value) in changes ?? []) values[key] = value;
        foreach (string key in drop ?? []) values.Remove(key);
        return JsonSerializer.Serialize(values);
    }

    // The machine's built-in Guest account: a resolvable USER SID that is not the signed-in user (a test has no second real account).
    private static string GuestSid(string self) => self[..self.LastIndexOf('-')] + "-501";

    private static string? ConfigReason(string json, bool strict = true)
    {
        AuthorityConfig? config = AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(json), strict, out string reason);
        return config is null ? reason : null;
    }

    private static void ConfigChecks()
    {
        string self = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
        Check("config: a complete config parses and names the two pipes", () =>
        {
            AuthorityConfig config = AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(ConfigJson()), true, out string reason) ?? throw new CheckFailed($"rejected: {reason}");
            Assert(config.SubmitPipe == "ALBERA\\ApprovalAuthority\\submit\\v1" && config.ApproverPipe == "ALBERA\\ApprovalAuthority\\approver\\v1", $"{config.SubmitPipe} {config.ApproverPipe}");
            Assert(config.SigningProvider == SigningProvider.Tpm && config.ApproverSid == GuestSid(self), "provider and approver SID");
        });
        Check("config: every rejected value maps to its fixed reason word", () =>
        {
            (Dictionary<string, string> change, string reason)[] cases =
            [
                (new() { ["pipeRoot"] = "Other\\Root" }, "pipe_root"), (new() { ["pipeRoot"] = "ALBERA\\..\\x" }, "pipe_root"), (new() { ["pipeRoot"] = "ALBERA" }, "pipe_root"),
                (new() { ["controlPlaneSid"] = "S-1-1-0" }, "control_plane_sid"), (new() { ["controlPlaneSid"] = "S-1-5-80-0" }, "control_plane_sid"), (new() { ["controlPlaneSid"] = "BA" }, "control_plane_sid"),
                (new() { ["approverSid"] = "S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555" }, "approver_sid"), (new() { ["approverSid"] = "S-1-5-32-544" }, "approver_sid"),
                (new() { ["approverSid"] = self[..self.LastIndexOf('-')] + "-513" }, "approver_sid"),
                (new() { ["signingKeyName"] = "..\\key" }, "signing_key"), (new() { ["signingKeyProvider"] = "hsm" }, "signing_provider"), (new() { ["kid"] = "bad kid" }, "kid"),
                (new() { ["approverKeyId"] = "" }, "approver_key_id"), (new() { ["approverPublicKey"] = "AAAA" }, "approver_public_key"), (new() { ["audience"] = "Albera Broker" }, "audience"),
                (new() { ["policyVersion"] = "-x" }, "policy_version"),
            ];
            foreach ((Dictionary<string, string> change, string expected) in cases)
            {
                string? reason = ConfigReason(ConfigJson(change));
                Assert(reason == expected, $"{string.Join(',', change.Select(c => $"{c.Key}={c.Value}"))}: expected {expected}, got {reason ?? "accepted"}");
            }
        });
        Check("config: the approver key must be RSA-2048 (RSA-1024 and an EC key are public_key rejections)", () =>
        {
            using RSA small = RSA.Create(1024);
            using ECDsa ec = ECDsa.Create();
            Assert(ConfigReason(ConfigJson(new() { ["approverPublicKey"] = Convert.ToBase64String(small.ExportSubjectPublicKeyInfo()) })) == "approver_public_key", "rsa-1024");
            Assert(ConfigReason(ConfigJson(new() { ["approverPublicKey"] = Convert.ToBase64String(ec.ExportSubjectPublicKeyInfo()) })) == "approver_public_key", "ec");
        });
        Check("config: unknown, missing and duplicate keys and non-string values are config_keys; bad JSON is config_syntax", () =>
        {
            Assert(ConfigReason(ConfigJson(new() { ["extra"] = "x" })) == "config_keys", "extra key");
            Assert(ConfigReason(ConfigJson(drop: ["kid"])) == "config_keys", "missing key");
            Assert(ConfigReason(ConfigJson().Replace("{", "{\"kid\":\"a\",", StringComparison.Ordinal)) == "config_keys", "duplicate key");
            Assert(ConfigReason(ConfigJson().Replace("\"audience\":\"albera-host-broker\"", "\"audience\":7", StringComparison.Ordinal)) == "config_keys", "number value");
            Assert(ConfigReason("{ not json") == "config_syntax" && ConfigReason("") == "config_syntax", "syntax");
        });
        Check("config: production refuses one SID for both pipes and the service's own SID; the test build may use them", () =>
        {
            Assert(ConfigReason(ConfigJson(new() { ["controlPlaneSid"] = GuestSid(self), ["approverSid"] = GuestSid(self) })) == "sids_not_distinct", "same SID for both pipes");
            Assert(ConfigReason(ConfigJson(new() { ["approverSid"] = self })) == "sids_not_distinct", "approver is the service itself");
            Assert(ConfigReason(ConfigJson(new() { ["controlPlaneSid"] = self, ["approverSid"] = self }), strict: false) is null, "the test build accepts it");
        });
        Check("config: a relative path, a missing file and a device path are config_path / config_unreadable", () =>
        {
            Assert(AuthorityConfig.TryLoad("config.json", true, out string a) is null && a == "config_path", a);
            Assert(AuthorityConfig.TryLoad(@"\\.\pipe\x", true, out string b) is null && b == "config_path", b);
            Assert(AuthorityConfig.TryLoad(@"C:\albera-no-such-folder-7f3a\config.json", true, out string c) is null && c is "config_unreadable" or "config_untrusted", c);
        });
    }

    private static void SignerChecks()
    {
        Check("cng: opening a machine key that does not exist is SignerUnavailable (software and TPM providers) and creates nothing", () =>
        {
            string name = "AlberaTestMissing-" + Guid.NewGuid().ToString("N");
            foreach (SigningProvider provider in new[] { SigningProvider.Software, SigningProvider.Tpm })
            {
                try { using CngMachineKeySigner _ = CngMachineKeySigner.Open(name, provider); throw new CheckFailed($"{provider} opened a key that was never created"); }
                catch (SignerUnavailableException) { }
            }
            Assert(CngKey.Exists(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey) == false, "still no such key");
        });
    }

    private static object[] DigestProbes()
    {
        (string purpose, string dto)[] cases =
        [
            ("broker.operation", "{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{}}"),
            ("broker.operation", "{\"action\":\"environment.create\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{\"vmName\":\"alpha\",\"cpu\":2,\"fast\":true,\"note\":\"\\u00e9 \\u3042\"}}"),
            ("guest.command", "{\"action\":\"task.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{\"taskId\":\"t-1\"}}"),
        ];
        return [.. cases.Select(c =>
        {
            Fixture fx = new();
            string request = SubmitJson(purpose: c.purpose).Replace("\"action\":{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{}}", $"\"action\":{c.dto}", StringComparison.Ordinal);
            string id = ApprovalIdOf(fx.Submit(request));
            return new { purpose = c.purpose, dtoJson = c.dto, digest = fx.Store.Get(id)!.ActionDigest };
        })];
    }

    public static int Main()
    {
        StoreChecks();
        DigestChecks();
        ReceiptChecks();
        PresenceChecks();
        ProtocolChecks();
        ConfigChecks();
        SignerChecks();
        KeyGuardChecks();
        PathGuardChecks();
        PolicyChecks();
        Console.WriteLine(JsonSerializer.Serialize(new { checks = Results, digestProbes = DigestProbes() }));
        return 0;
    }
}
