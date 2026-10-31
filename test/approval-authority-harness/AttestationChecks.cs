using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.ApprovalAuthority;
using Albera.BrokerContract;

// Broker network attestation checks (issue #115 step 3b): at the standard tier environment.start and environment.create are signed without a person ONLY for a valid Broker attestation
// that says "none" and is bound to exactly this request; everything else queues for a person as without it. In-process; the keys are throw-away ECDSA keys made by each check and
// no key file exists. The signed vector file is embedded by the harness project and run against the production PinnedAttestationKey.
internal static partial class Harness
{
    private const string AttestKeyId = "broker-attest-test-1";
    private const string AttestVm = "11111111-2222-4333-8444-555555555555";
    private const string OtherVm = "99999999-8888-4777-8666-555555555555";
    private static readonly string[] Attested = ["environment.start"];
    /// <summary>The args of an attested start as the Control Plane fills them in from its own inspect: the generation and the VM the approval is for.</summary>
    private const string GoodArgs = "{\"expectedGeneration\":3,\"vmId\":\"" + AttestVm + "\",\"vmName\":\"alpha\"}";

    private sealed class AttestKey : IDisposable
    {
        public readonly ECDsa Key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        public string KeyId { get; }
        public AttestKey(string keyId = AttestKeyId) { KeyId = keyId; }
        public byte[] Spki => Key.ExportSubjectPublicKeyInfo();
        public PinnedAttestationKey Pinned() => PinnedAttestationKey.TryCreate(KeyId, Spki) ?? throw new CheckFailed("the test key does not pin");
        public void Dispose() => Key.Dispose();
    }

    private static Dictionary<string, object> AttestBody(string network = "none", string computerId = "pc-01", long generation = 3, string projectId = "proj-alpha", string leaseId = "lease-1",
        long leaseGeneration = 7, long observedAt = Start - 5, long expiresAt = Start + 55, string vmId = AttestVm) => new()
    {
        ["v"] = 1L, ["network"] = network, ["computerId"] = computerId, ["vmId"] = vmId, ["generation"] = generation, ["projectId"] = projectId, ["leaseId"] = leaseId,
        ["leaseGeneration"] = leaseGeneration, ["observedAt"] = observedAt, ["expiresAt"] = expiresAt,
    };

    /// <summary>The envelope JSON for a body, signed by <paramref name="key"/> (null = a throw-away other key), plus its digest.</summary>
    private static (string Json, string Digest) AttestEnvelope(Dictionary<string, object> body, AttestKey key, string? keyId = null, bool flipSignature = false)
    {
        (AttestationVerdict verdict, string? digest, byte[]? preimage) = NetworkAttestation.Compute(body);
        if (!verdict.Ok) throw new CheckFailed($"test body is not valid: {verdict.Code}/{verdict.Field}");
        byte[] signature = key.Key.SignData(preimage!, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        if (flipSignature) signature[10] ^= 0x01;
        string json = JsonSerializer.Serialize(new Dictionary<string, object> { ["attestation"] = body, ["digest"] = digest!, ["keyId"] = keyId ?? key.KeyId, ["signature"] = Base64Url.EncodeToString(signature) });
        return (json, digest!);
    }

    private static string AttestedSubmit(string envelope, string action = "environment.start", string op = "op-1", string args = GoodArgs) =>
        SubmitJson(op: op, idem: op, action: action, args: args, purpose: PurposeOf(action), extra: $",\"attestation\":{envelope}");

    private static Fixture StandardWith(AttestKey? key, List<string> audit, string policyJson = "") =>
        new(policy: PolicyStore.InMemory(PolicyOf(policyJson.Length == 0 ? PolicyJson(1, "standard") : policyJson)), audit: audit.Add, attestation: key?.Pinned());

    private static IReadOnlyDictionary<string, object> ReceiptFields(Fixture fx, string approvalId)
    {
        ReceiptVerdict parsed = ReceiptV3.Parse(ReceiptOf(fx.Status(approvalId)).Receipt);
        return parsed.Ok ? parsed.Receipt! : throw new CheckFailed($"not a v3 receipt: {parsed.Code}/{parsed.Field}");
    }

    private static bool IsPending(Fixture fx, JsonElement reply) => Code(reply) == "ok" && StateOf(reply) == "pending" && fx.Store.Get(reply.GetProperty("approvalId").GetString()!)!.Receipt is null;

    private static void AttestationChecks()
    {
        AttestationAcceptChecks();
        AttestationRefuseChecks();
        AttestationScopeChecks();
        AttestationConfigAndVectorChecks();
    }

    private static void AttestationAcceptChecks()
    {
        Check("attestation: standard + a valid 'none' attestation signs start at once (v3, basis policy, the attestation digest bound in) and nobody is asked", () =>
        {
            using AttestKey key = new();
            foreach (string action in Attested)
            {
                List<string> audit = [];
                Fixture fx = StandardWith(key, audit);
                (string envelope, string digest) = AttestEnvelope(AttestBody(), key);
                JsonElement reply = fx.Submit(AttestedSubmit(envelope, action));
                Assert(Code(reply) == "ok" && StateOf(reply) == "approved", $"{action}: {reply}");
                string id = reply.GetProperty("approvalId").GetString()!;
                (byte[] receipt, byte[] signature) = ReceiptOf(fx.Status(id));
                using ECDsa signerKey = ECDsa.Create();
                signerKey.ImportSubjectPublicKeyInfo(fx.Signer.PublicKeySpki, out _);
                Assert(signerKey.VerifyData(receipt, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation), $"{action}: the Authority signed it");
                IReadOnlyDictionary<string, object> r = ReceiptFields(fx, id);
                Assert((long)r["v"] == 3 && (string)r["basis"] == "policy" && (string)r["action"] == action && (string)r["attestationDigest"] == digest, $"{action}: v3, policy basis, digest bound in");
                Assert((string)r["policyVersion"] == PolicyOf(PolicyJson(1, "standard")).Hash(), $"{action}: policyVersion is the hash of the policy in force");
                Assert(fx.List().GetProperty("pending").GetArrayLength() == 0, $"{action}: nothing reached the approver's list");
                Assert(audit.Contains($"POLICY_SIGNED={action} {id} ATTESTED={digest}"), $"{action}: audit line: {string.Join(" | ", audit)}");
                // ... and it is exactly what the Broker's validator takes.
                ValidatedAction dto = ActionDigest.Validate(PurposeOf(action), StrictJson.Parse(Encoding.UTF8.GetBytes($"{{\"action\":\"{action}\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{GoodArgs}}}"), 3));
                PendingRequest request = new(PurposeOf(action), "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", dto);
                Assert(ReceiptBuilder.Check(receipt, request, fx.Identity, fx.Signer.Issuer, fx.Now).Ok, $"{action}: contract verdict");
            }
        });
        Check("attestation: the receipt never outlives the attestation (exp = its expiresAt when that is sooner than 120 s), and 10 s is the least worth signing", () =>
        {
            using AttestKey key = new();
            Fixture fx = StandardWith(key, []);
            JsonElement ok = fx.Submit(AttestedSubmit(AttestEnvelope(AttestBody(expiresAt: Start + 55), key).Json, op: "a"));
            Assert((long)ReceiptFields(fx, ApprovalIdOf(ok))["exp"] == Start + 55 && ok.GetProperty("expiresAt").GetInt64() == Start + 55, "exp = the attestation's expiresAt");
            JsonElement longLived = fx.Submit(AttestedSubmit(AttestEnvelope(AttestBody(expiresAt: Start + 295), key).Json, op: "b"));
            Assert((long)ReceiptFields(fx, ApprovalIdOf(longLived))["exp"] == Start + 120, "a long attestation does not stretch the receipt past the normal 120 s");
            JsonElement edge = fx.Submit(AttestedSubmit(AttestEnvelope(AttestBody(expiresAt: Start + 10), key).Json, op: "c"));
            Assert(StateOf(edge) == "approved" && (long)ReceiptFields(fx, ApprovalIdOf(edge))["exp"] == Start + 10, "exactly 10 s left is signed");
            JsonElement tooLate = fx.Submit(AttestedSubmit(AttestEnvelope(AttestBody(expiresAt: Start + 9), key).Json, op: "d"));
            Assert(IsPending(fx, tooLate), "9 s left: a person is asked instead of a receipt that cannot be claimed in time");
        });
        Check("attestation: the same operationId + idempotencyKey is one request whichever submit came first (a queued request stays queued, an approved one is returned)", () =>
        {
            using AttestKey key = new();
            Fixture fx = StandardWith(key, []);
            string envelope = AttestEnvelope(AttestBody(), key).Json;
            string queued = ApprovalIdOf(fx.Submit(SubmitJson(op: "q", idem: "q", args: GoodArgs)));
            JsonElement again = fx.Submit(AttestedSubmit(envelope, op: "q", args: GoodArgs));
            Assert(ApprovalIdOf(again) == queued && StateOf(again) == "pending", "the request that already waits for a person is not turned into a receipt by a later attestation");
            string signedFirst = ApprovalIdOf(fx.Submit(AttestedSubmit(envelope, op: "s", args: GoodArgs)));
            JsonElement plain = fx.Submit(SubmitJson(op: "s", idem: "s", args: GoodArgs));
            Assert(ApprovalIdOf(plain) == signedFirst && StateOf(plain) == "approved", "a resubmit without the attestation returns the first, approved request");
            Assert(fx.Store.Count == 2, "two entries, not four");
        });
    }

    private static void AttestationRefuseChecks()
    {
        Check("attestation: no attestation, no pinned key, careful tier, an override or a missing expectedGeneration arg: start waits for a person", () =>
        {
            using AttestKey key = new();
            string envelope = AttestEnvelope(AttestBody(), key).Json;
            foreach (string action in Attested)
            {
                List<string> audit = [];
                Fixture omitted = StandardWith(key, audit);
                Assert(IsPending(omitted, omitted.Submit(SubmitJson(action: action, args: GoodArgs, purpose: PurposeOf(action)))), $"{action}: no attestation");
                Assert(audit.Count == 0, $"{action}: omitting an attestation is silent: {string.Join("|", audit)}");
                Fixture none = StandardWith(null, audit);
                Assert(IsPending(none, none.Submit(AttestedSubmit(envelope, action))), $"{action}: the Authority pins no key");
                Assert(audit.SequenceEqual(["ATTESTATION_REFUSED=no_key_pinned"]), $"{action}: audit {string.Join("|", audit)}");
                Fixture careful = new(policy: PolicyStore.InMemory(PolicyOf(PolicyJson(1, "careful"))), attestation: key.Pinned());
                Assert(IsPending(careful, careful.Submit(AttestedSubmit(envelope, action))), $"{action}: careful tier");
                Fixture overridden = StandardWith(key, [], PolicyJson(2, "standard", action));
                Assert(IsPending(overridden, overridden.Submit(AttestedSubmit(envelope, action))), $"{action}: an override forces a prompt even with a valid attestation");
                audit.Clear();
                Fixture noGeneration = StandardWith(key, audit);
                Assert(IsPending(noGeneration, noGeneration.Submit(AttestedSubmit(envelope, action, args: "{\"vmName\":\"alpha\"}"))), $"{action}: no expectedGeneration to bind");
                Assert(audit.SequenceEqual(["ATTESTATION_REFUSED=generation_missing"]), $"{action}: audit {string.Join("|", audit)}");
                int n = 0;
                foreach (string args in new[] { "{\"expectedGeneration\":0}", "{\"expectedGeneration\":\"3\"}", "{\"expectedGeneration\":true}", "{\"expectedGeneration\":-3}" })
                    Assert(IsPending(noGeneration, noGeneration.Submit(AttestedSubmit(envelope, action, op: $"g{n++}", args: args))), $"{action}: {args}");
            }
            Fixture oneOverride = StandardWith(key, [], PolicyJson(3, "standard", "environment.start"));
            Assert(IsPending(oneOverride, oneOverride.Submit(AttestedSubmit(envelope, "environment.start"))), "an override on start forces a prompt");
            Fixture noOverride = StandardWith(key, []);
            Assert(StateOf(noOverride.Submit(AttestedSubmit(envelope, "environment.start"))) == "approved" && IsPending(noOverride, noOverride.Submit(AttestedSubmit(envelope, "environment.create", op: "op-2"))), "control: start is attested, create never is");
        });
        Check("attestation: a forged, stale, mismatched or 'present' / 'unknown' attestation is not an error: the request just waits for a person (with a fixed-word audit reason)", () =>
        {
            using AttestKey key = new();
            using AttestKey stranger = new();
            (string Reason, string Envelope)[] cases =
            [
                ("signature:signature", AttestEnvelope(AttestBody(), stranger).Json),
                ("signature:signature", AttestEnvelope(AttestBody(), key, keyId: "broker-attest-test-2").Json),
                ("signature:signature", AttestEnvelope(AttestBody(), key, flipSignature: true).Json),
                ("digest:digest", AttestEnvelope(AttestBody(), key).Json.Replace("\"network\":\"none\"", "\"network\":\"present\"", StringComparison.Ordinal)),
                ("network_present", AttestEnvelope(AttestBody("present"), key).Json),
                ("network_unknown", AttestEnvelope(AttestBody("unknown"), key).Json),
                ("expired:expiresAt", AttestEnvelope(AttestBody(observedAt: Start - 100, expiresAt: Start), key).Json),
                ("expired:expiresAt", AttestEnvelope(AttestBody(observedAt: Start - 100, expiresAt: Start - 1), key).Json),
                ("not_yet_valid:observedAt", AttestEnvelope(AttestBody(observedAt: Start + 31, expiresAt: Start + 91), key).Json),
                ("binding:computerId", AttestEnvelope(AttestBody(computerId: "pc-02"), key).Json),
                ("binding:projectId", AttestEnvelope(AttestBody(projectId: "proj-beta"), key).Json),
                ("binding:generation", AttestEnvelope(AttestBody(generation: 4), key).Json),
                ("binding:leaseId", AttestEnvelope(AttestBody(leaseId: "lease-2"), key).Json),
                ("binding:leaseGeneration", AttestEnvelope(AttestBody(leaseGeneration: 8), key).Json),
                ("malformed:$extra", AttestEnvelope(AttestBody(), key).Json.Replace("\"digest\"", "\"extra\":\"x\",\"digest\"", StringComparison.Ordinal)),
                ("malformed:$extra", "{}"),
                ("malformed", "5"),
                ("malformed", "\"none\""),
            ];
            foreach (string action in Attested)
            {
                foreach ((string reason, string envelope) in cases)
                {
                    List<string> audit = [];
                    Fixture fx = StandardWith(key, audit);
                    JsonElement reply = fx.Submit(AttestedSubmit(envelope, action));
                    Assert(IsPending(fx, reply), $"{action} {reason}: {reply}");
                    Assert(audit.Count == 1 && audit[0] == $"ATTESTATION_REFUSED={reason}", $"{action} {reason}: audit {string.Join("|", audit)}");
                    Assert(!fx.List().GetRawText().Contains("attestation", StringComparison.Ordinal), $"{action} {reason}: the approver's list does not carry the claim");
                }
            }
        });
        Check("attestation: a wrong TYPE for `attestation` is not an invalid request (the request waits for a person); null, a duplicate or an unknown sibling key, and nesting past the frame's depth are, as ever", () =>
        {
            using AttestKey key = new();
            Fixture fx = StandardWith(key, []);
            string Submit(string extra, string op) => Code(fx.Submit(SubmitJson(op: op, idem: op, args: GoodArgs, extra: extra)));
            Assert(Submit(",\"attestation\":null", "n") == "request_invalid", "null is not JSON the strict reader takes");
            Assert(Submit(",\"attestations\":{}", "u") == "request_invalid", "an unknown key is invalid as ever");
            Assert(Submit(",\"attestation\":{},\"attestation\":{}", "d") == "request_invalid", "a duplicate key is invalid as ever");
            Assert(Submit(",\"attestation\":{\"a\":{\"b\":{}}}", "deep") == "request_invalid", "nesting past depth 3 is invalid as ever");
            int n = 0;
            foreach (string value in new[] { "5", "true", "\"x\"", "{}", "{\"a\":{}}" }) Assert(Submit($",\"attestation\":{value}", $"t{n++}") == "ok", value);
            Assert(fx.Store.Count == n && fx.Store.ListPending(0).Count == n && fx.Store.ListPending(0).All(e => e.Receipt is null), "all of them wait for a person, none got a receipt");
        });
    }

    private static void AttestationScopeChecks()
    {
        Check("attestation: it never lets an action skip a person that cannot (create, destroy, retire, purge, task.start, synthetic.noop), at any tier", () =>
        {
            using AttestKey key = new();
            string envelope = AttestEnvelope(AttestBody(), key).Json;
            foreach (string tier in new[] { "standard", "careful" })
            {
                Fixture fx = new(policy: PolicyStore.InMemory(PolicyOf(PolicyJson(1, tier))), attestation: key.Pinned());
                int n = 0;
                foreach (string action in new[] { "environment.create", "environment.destroy", "environment.retire", "environment.purge", "task.start", "synthetic.noop" })
                    Assert(IsPending(fx, fx.Submit(AttestedSubmit(envelope, action, op: $"x{n++}"))), $"{tier} {action}");
                Assert(IsPending(fx, fx.Submit(SubmitJson(op: "noop-g", idem: "noop-g", action: "synthetic.noop", purpose: "guest.command", args: GoodArgs, extra: $",\"attestation\":{envelope}"))), $"{tier} guest synthetic.noop");
            }
        });
        Check("attestation: the four unattested actions are signed as before and their receipts carry no attestation digest, whatever the request claims", () =>
        {
            using AttestKey key = new();
            string envelope = AttestEnvelope(AttestBody(), key).Json;
            Fixture fx = StandardWith(key, []);
            int n = 0;
            foreach (string action in Skippable)
            {
                JsonElement reply = fx.Submit(AttestedSubmit(envelope, action, op: $"s{n++}"));
                Assert(StateOf(reply) == "approved", $"{action}: {reply}");
                Assert(!ReceiptFields(fx, ApprovalIdOf(reply)).ContainsKey("attestationDigest"), $"{action}: no digest on a receipt that relied on no attestation");
            }
        });
        Check("attestation: the Authority's own receipt contract refuses a policy receipt for start / create without the digest, and one for any other action with it", () =>
        {
            using AttestKey key = new();
            (string envelope, string digest) = AttestEnvelope(AttestBody(), key);
            Fixture fx = StandardWith(key, []);
            string id = ApprovalIdOf(fx.Submit(AttestedSubmit(envelope)));
            string json = Encoding.UTF8.GetString(ReceiptOf(fx.Status(id)).Receipt);
            Assert(json.Contains(digest, StringComparison.Ordinal), "the receipt names the digest");
            string withoutDigest = json.Replace($",\"attestationDigest\":\"{digest}\"", "", StringComparison.Ordinal);
            Assert(withoutDigest != json && ReceiptV3.Parse(Encoding.UTF8.GetBytes(withoutDigest)).Ok, "the stripped receipt is still well formed ...");
            ValidatedAction dto = ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes($"{{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{GoodArgs}}}"), 3));
            PendingRequest request = new("broker.operation", "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", dto);
            ReceiptVerdict refused = ReceiptBuilder.Check(Encoding.UTF8.GetBytes(withoutDigest), request, fx.Identity, fx.Signer.Issuer, fx.Now);
            Assert(refused is { Ok: false, Code: "attestation", Field: "attestationDigest" }, $"... but the contract says {refused.Code}/{refused.Field}");
        });
    }

    private static void AttestationConfigAndVectorChecks()
    {
        Check("config: the attestation key is both keys or neither; an existing config (neither) still loads and pins nothing", () =>
        {
            using AttestKey key = new();
            string spki = Convert.ToBase64String(key.Spki);
            AuthorityConfig plain = AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(ConfigJson()), true, out string reason) ?? throw new CheckFailed($"rejected: {reason}");
            Assert(plain.AttestationKeyId is null && plain.AttestationPublicKey is null && AuthorityRuntime.AttestationKeyOf(plain) is null, "nothing pinned");
            AuthorityConfig pinned = AuthorityConfig.TryParse(Encoding.UTF8.GetBytes(ConfigJson(new() { ["attestationKeyId"] = AttestKeyId, ["attestationPublicKey"] = spki })), true, out reason) ?? throw new CheckFailed($"rejected: {reason}");
            Assert(pinned.AttestationKeyId == AttestKeyId && pinned.AttestationPublicKey!.SequenceEqual(key.Spki), "pinned");
            using PinnedAttestationKey? built = AuthorityRuntime.AttestationKeyOf(pinned);
            Assert(built is not null && built.KeyId == AttestKeyId, "the runtime builds the verifier from the config");
            Assert(ConfigReason(ConfigJson(new() { ["attestationKeyId"] = AttestKeyId })) == "config_keys", "id without key");
            Assert(ConfigReason(ConfigJson(new() { ["attestationPublicKey"] = spki })) == "config_keys", "key without id");
            Assert(ConfigReason(ConfigJson(new() { ["attestationKeyId"] = AttestKeyId, ["attestationPublicKey"] = spki, ["extra"] = "x" })) == "config_keys", "extra key next to the pair");
            Assert(ConfigReason(ConfigJson(new() { ["attestationKeyId"] = AttestKeyId, ["attestationPublicKey"] = spki }, drop: ["kid"])) == "config_keys", "the pair does not stand in for a missing key");
            Assert(ConfigReason(ConfigJson(new() { ["attestationKeyId"] = "bad id", ["attestationPublicKey"] = spki })) == "attestation_key_id", "bad key id");
        });
        Check("config: the attestation key must be a named ECDSA P-256 public key (RSA, P-384, trailing bytes, junk are attestation_public_key)", () =>
        {
            string Reason(string value) => ConfigReason(ConfigJson(new() { ["attestationKeyId"] = AttestKeyId, ["attestationPublicKey"] = value })) ?? "accepted";
            using RSA rsa = RSA.Create(2048);
            using ECDsa p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            using ECDsa p256 = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            Assert(Reason(Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo())) == "attestation_public_key", "rsa");
            Assert(Reason(Convert.ToBase64String(p384.ExportSubjectPublicKeyInfo())) == "attestation_public_key", "p-384");
            Assert(Reason(Convert.ToBase64String([.. p256.ExportSubjectPublicKeyInfo(), 0])) == "attestation_public_key", "trailing byte");
            Assert(Reason("AAAA") == "attestation_public_key" && Reason("not base64!") == "attestation_public_key" && Reason("") == "attestation_public_key", "junk");
            Assert(Reason(Convert.ToBase64String(p256.ExportSubjectPublicKeyInfo())) == "accepted", "p-256 is fine");
        });
        Check("policy change: dropping an override on start or create (which only lets an ATTESTED action skip a person) needs the Hello signature too: the rule is by effect, attested or not", () =>
        {
            Fixture fx = Under(PolicyJson(1, "standard", "environment.start", "environment.create"));
            string loosened = PolicyJson(2, "standard", "environment.create");
            Assert(Code(fx.PolicySet(loosened)) == "presence_mismatch", "no signature");
            Assert(fx.Core.Policy() is { Revision: 1 }, "nothing changed");
            Assert(Code(fx.PolicySet(loosened, PolicyProof(loosened))) == "ok" && fx.Core.Policy() is { Revision: 2 }, "signed");
            string tighter = PolicyJson(3, "standard", "environment.create", "environment.start");
            Assert(Code(fx.PolicySet(tighter)) == "ok" && fx.Core.Policy() is { Revision: 3 }, "adding the override back needs none");
            Assert(Code(fx.PolicySet(PolicyJson(4, "careful"))) == "ok", "careful needs none");
            string raised = PolicyJson(5, "standard");
            Assert(Code(fx.PolicySet(raised)) == "presence_mismatch" && Code(fx.PolicySet(raised, PolicyProof(raised))) == "ok", "careful to standard needs the signature");
        });
        Check("attestation: a VM swap does not work: an attestation for VM A never gives a receipt for a start that names VM B (same computer, project, lease and generation), and a start that names no well-formed VM is never attested", () =>
        {
            using AttestKey key = new();
            List<string> audit = [];
            Fixture fx = StandardWith(key, audit);
            string forVmA = AttestEnvelope(AttestBody(), key).Json, forVmB = AttestEnvelope(AttestBody(vmId: OtherVm), key).Json;
            string argsFor(string vm) => "{\"expectedGeneration\":3,\"vmId\":\"" + vm + "\",\"vmName\":\"alpha\"}";
            JsonElement swapped = fx.Submit(AttestedSubmit(forVmA, op: "swap", args: argsFor(OtherVm)));
            Assert(IsPending(fx, swapped), "the old attestation (VM A) for a start of VM B waits for a person");
            Assert(audit.SequenceEqual(["ATTESTATION_REFUSED=binding:vmId"]), string.Join("|", audit));
            Assert(IsPending(fx, fx.Submit(AttestedSubmit(forVmB, op: "swap-2", args: argsFor(AttestVm)))), "and the other way round");
            audit.Clear();
            JsonElement matching = fx.Submit(AttestedSubmit(forVmB, op: "match", args: argsFor(OtherVm)));
            Assert(StateOf(matching) == "approved", "an attestation for VM B starts VM B");
            Assert(Encoding.UTF8.GetString(ReceiptOf(fx.Status(ApprovalIdOf(matching))).Receipt).Contains("\"attestationDigest\"", StringComparison.Ordinal), "with its digest");
            Assert(StateOf(fx.Submit(AttestedSubmit(forVmA, op: "match-a", args: argsFor(AttestVm)))) == "approved", "and VM A is still VM A");
            audit.Clear();
            int n = 0;
            foreach (string args in new[] { "{\"expectedGeneration\":3}", "{\"expectedGeneration\":3,\"vmId\":\"\"}", "{\"expectedGeneration\":3,\"vmId\":7}", "{\"expectedGeneration\":3,\"vmId\":true}",
                "{\"expectedGeneration\":3,\"vmId\":\"vm-1\"}", "{\"expectedGeneration\":3,\"vmId\":\"ABCDEF12-2222-4333-8444-555555555555\"}", "{\"expectedGeneration\":3,\"vmId\":\"{" + AttestVm + "}\"}" })
                Assert(IsPending(fx, fx.Submit(AttestedSubmit(forVmA, op: $"nov{n++}", args: args))), args);
            Assert(audit.Count == n && audit.All(line => line == "ATTESTATION_REFUSED=vm_id_missing"), string.Join("|", audit));
        });
        Check("attestation: environment.create is never attested: a valid statement gives no receipt, with the create's own args or not (nothing to observe before the VM exists)", () =>
        {
            using AttestKey key = new();
            List<string> audit = [];
            Fixture fx = StandardWith(key, audit);
            string envelope = AttestEnvelope(AttestBody(), key).Json;
            Assert(IsPending(fx, fx.Submit(AttestedSubmit(envelope, "environment.create", op: "c1"))) && IsPending(fx, fx.Submit(AttestedSubmit(envelope, "environment.create", op: "c2", args: "{}"))), "pending");
            Assert(audit.Count == 0, "the attestation is not even looked at: " + string.Join("|", audit));
            Assert(fx.Core.Policy()!.NoPromptActions().Contains("environment.create") == false && fx.Core.Policy()!.SkippableActions().Contains("environment.create") == false, "not a skippable action at any tier");
        });
        Check("attestation: the Authority's receipt contract refuses an attested start whose action names no VM (the Broker would have nothing to compare with)", () =>
        {
            using AttestKey key = new();
            Fixture fx = StandardWith(key, []);
            string id = ApprovalIdOf(fx.Submit(AttestedSubmit(AttestEnvelope(AttestBody(), key).Json)));
            byte[] receipt = ReceiptOf(fx.Status(id)).Receipt;
            ValidatedAction withoutVm = ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{\"expectedGeneration\":3}}"), 3));
            ReceiptVerdict refused = ReceiptBuilder.Check(receipt, new PendingRequest("broker.operation", "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", withoutVm), fx.Identity, fx.Signer.Issuer, fx.Now);
            Assert(refused is { Ok: false, Code: "attestation", Field: "vmId" }, $"{refused.Code}/{refused.Field}");
        });
        Check("attestation: the pinned key verifies only its own key id and 64-byte signatures, and never throws", () =>
        {
            using AttestKey key = new();
            using PinnedAttestationKey pinned = key.Pinned();
            byte[] data = [1, 2, 3];
            byte[] signature = key.Key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            Assert(pinned.Verify(AttestKeyId, data, signature), "genuine");
            Assert(!pinned.Verify("other-id", data, signature) && !pinned.Verify(AttestKeyId.ToUpperInvariant(), data, signature), "another key id");
            Assert(!pinned.Verify(AttestKeyId, data, signature[..63]) && !pinned.Verify(AttestKeyId, data, [.. signature, 0]) && !pinned.Verify(AttestKeyId, data, []), "other lengths");
            Assert(!pinned.Verify(AttestKeyId, [1, 2, 4], signature), "other data");
            byte[] der = key.Key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
            Assert(!pinned.Verify(AttestKeyId, data, der), "a DER signature is not the wire format");
            Assert(PinnedAttestationKey.TryCreate(AttestKeyId, []) is null && PinnedAttestationKey.TryCreate(AttestKeyId, new byte[600]) is null, "empty and oversized keys");
        });
        Check("attestation: the shared signed vectors (Node-made, ephemeral key) give the same verdicts through the production PinnedAttestationKey", () =>
        {
            using Stream stream = typeof(Harness).Assembly.GetManifestResourceStream("attestation-vectors.json") ?? throw new CheckFailed("the vector file is not embedded");
            using JsonDocument document = JsonDocument.Parse(stream);
            JsonElement verify = document.RootElement.GetProperty("verifyVectors");
            using PinnedAttestationKey pinned = PinnedAttestationKey.TryCreate(verify.GetProperty("keyId").GetString()!, Convert.FromBase64String(verify.GetProperty("publicKeySpki").GetString()!)) ?? throw new CheckFailed("the vector key does not pin");
            int count = 0;
            foreach (JsonElement c in verify.GetProperty("cases").EnumerateArray())
            {
                JsonElement e = c.GetProperty("expected");
                AttestationExpected expected = new(e.GetProperty("computerId").GetString()!, e.GetProperty("vmId").GetString()!, e.GetProperty("generation").GetInt64(),
                    e.GetProperty("projectId").GetString()!, e.GetProperty("leaseId").GetString()!, e.GetProperty("leaseGeneration").GetInt64());
                long now = c.GetProperty("now").GetInt64();
                AttestationVerdict verdict = NetworkAttestation.Verify(VectorValue(c.GetProperty("signed")), () => now, pinned.Verify, expected);
                JsonElement want = c.GetProperty("result");
                string wantCode = want.GetProperty("ok").GetBoolean() ? "ok" : want.GetProperty("code").GetString()!;
                string wantField = want.TryGetProperty("field", out JsonElement f) ? f.GetString()! : "";
                Assert((verdict.Ok ? "ok" : verdict.Code) == wantCode && (verdict.Field ?? "") == wantField, $"{c.GetProperty("name").GetString()}: got {verdict.Code}/{verdict.Field}, want {wantCode}/{wantField}");
                count++;
            }
            Assert(count >= 40, $"only {count} cases");
        });
        Check("policy: the hash domain moved to v2, so a standard policy signed under the old one (which did not mean attested start / create) is refused at load", () =>
        {
            InFolder(config =>
            {
                string json = PolicyJson(1, "standard");
                string oldHash = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("albera.policy-hash.v1\01\0standard")));
                Assert(oldHash != PolicyOf(json).Hash(), "the hash changed with the meaning");
                byte[] oldProof = HelloSign(Encoding.UTF8.GetBytes($"albera.policy.v1\0authority-key-2026-10\0albera-host-broker\0{oldHash}"));
                File.WriteAllText(PolicyStore.PathFor(config), SignedFile(json, json, oldProof));
                Assert(LoadPolicy(config, out string reason, out bool fromFile) is null && fromFile && reason == "policy_unsigned", $"refused: {reason}");
                File.WriteAllText(PolicyStore.PathFor(config), SignedFile(json, json, PolicyProof(json)));
                Assert(LoadPolicy(config, out _, out _) is not null, "control: signed under the current domain it loads");
            });
        });
    }

    private static object VectorValue(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.String => e.GetString()!,
        JsonValueKind.Number => e.TryGetInt64(out long n) ? (object)n : e.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Object => e.EnumerateObject().ToDictionary(p => p.Name, p => VectorValue(p.Value), StringComparer.Ordinal),
        _ => throw new CheckFailed("vector value not supported by this harness"),
    };
}
