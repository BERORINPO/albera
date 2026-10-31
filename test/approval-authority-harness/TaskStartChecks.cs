using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.ApprovalAuthority;
using Albera.BrokerContract;

// Broker task-start attestation checks (issue #115 step 4): at the standard tier task.start is signed without a person ONLY for a valid Broker TASK-START attestation (network "none" AND a
// Production checkpoint) that is bound to exactly this request, including its operationId; everything else queues for a person as without it. The network attestation of step 2 does not count
// for task.start and the task-start attestation does not count for environment.start (domain separation). In-process; the keys are throw-away ECDSA keys made by each check.
internal static partial class Harness
{
    private const string Checkpoint = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    private const string TaskArgs = "{\"expectedGeneration\":3,\"task\":\"build the project\",\"vmId\":\"" + AttestVm + "\"}";

    private static Dictionary<string, object> TaskBody(string network = "none", string checkpointType = "production", string computerId = "pc-01", long generation = 3, string projectId = "proj-alpha",
        string leaseId = "lease-1", long leaseGeneration = 7, string operationId = "op-1", long observedAt = Start - 5, long expiresAt = Start + 55, string vmId = AttestVm, string checkpointId = Checkpoint,
        string? actionDigest = null) => new()
    {
        ["v"] = 2L, ["network"] = network, ["computerId"] = computerId, ["vmId"] = vmId, ["generation"] = generation, ["projectId"] = projectId, ["leaseId"] = leaseId,
        ["leaseGeneration"] = leaseGeneration, ["operationId"] = operationId, ["actionDigest"] = actionDigest ?? TaskDigest(), ["checkpointId"] = checkpointId, ["checkpointType"] = checkpointType, ["observedAt"] = observedAt, ["expiresAt"] = expiresAt,
    };

    /// <summary>The action digest the Authority computes for a task.start guest.command DTO with these args (the statement is bound to it, issue #133).</summary>
    private static string TaskDigest(string args = TaskArgs) =>
        ActionDigest.ComputeFromJson("guest.command", Encoding.UTF8.GetBytes($"{{\"action\":\"task.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{args}}}"));

    /// <summary>The envelope JSON for a task-start body, signed by <paramref name="key"/>, plus its digest. <paramref name="signedBytes"/> replaces the bytes that are signed (a wrong-domain forgery).</summary>
    private static (string Json, string Digest) TaskEnvelope(Dictionary<string, object> body, AttestKey key, string? keyId = null, bool flipSignature = false, byte[]? signedBytes = null)
    {
        (TaskStartVerdict verdict, string? digest, byte[]? preimage) = TaskStartAttestation.Compute(body);
        if (!verdict.Ok) throw new CheckFailed($"test body is not valid: {verdict.Code}/{verdict.Field}");
        byte[] signature = key.Key.SignData(signedBytes ?? preimage!, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        if (flipSignature) signature[10] ^= 0x01;
        string json = JsonSerializer.Serialize(new Dictionary<string, object> { ["attestation"] = body, ["digest"] = digest!, ["keyId"] = keyId ?? key.KeyId, ["signature"] = Base64Url.EncodeToString(signature) });
        return (json, digest!);
    }

    private static string TaskSubmit(string envelope, string op = "op-1", string args = TaskArgs, string action = "task.start") =>
        SubmitJson(op: op, idem: op, action: action, args: args, purpose: PurposeOf(action), extra: $",\"attestation\":{envelope}");

    private static void TaskStartAttestationChecks()
    {
        TaskStartAcceptChecks();
        TaskStartRefuseChecks();
        TaskStartActionBindingChecks();
        TaskStartDomainChecks();
    }

    private static void TaskStartAcceptChecks()
    {
        Check("task-start: standard + a valid 'none' + Production attestation signs task.start at once (v3, basis policy, the attestation digest bound in) and nobody is asked", () =>
        {
            using AttestKey key = new();
            List<string> audit = [];
            Fixture fx = StandardWith(key, audit);
            (string envelope, string digest) = TaskEnvelope(TaskBody(), key);
            JsonElement reply = fx.Submit(TaskSubmit(envelope));
            Assert(Code(reply) == "ok" && StateOf(reply) == "approved", $"{reply}");
            string id = reply.GetProperty("approvalId").GetString()!;
            (byte[] receipt, byte[] signature) = ReceiptOf(fx.Status(id));
            using ECDsa signerKey = ECDsa.Create();
            signerKey.ImportSubjectPublicKeyInfo(fx.Signer.PublicKeySpki, out _);
            Assert(signerKey.VerifyData(receipt, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation), "the Authority signed it");
            IReadOnlyDictionary<string, object> r = ReceiptFields(fx, id);
            Assert((long)r["v"] == 3 && (string)r["basis"] == "policy" && (string)r["action"] == "task.start" && (string)r["purpose"] == "guest.command" && (string)r["attestationDigest"] == digest, "v3, policy basis, digest bound in");
            Assert((string)r["policyVersion"] == PolicyOf(PolicyJson(1, "standard")).Hash(), "policyVersion is the hash of the policy in force");
            Assert((long)r["exp"] == Start + 55, "the receipt ends with the attestation (55 s left)");
            Assert(fx.List().GetProperty("pending").GetArrayLength() == 0, "nothing reached the approver's list");
            Assert(audit.Contains($"POLICY_SIGNED=task.start {id} ATTESTED={digest}"), $"audit line: {string.Join(" | ", audit)}");
            ValidatedAction dto = ActionDigest.Validate("guest.command", StrictJson.Parse(Encoding.UTF8.GetBytes($"{{\"action\":\"task.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{TaskArgs}}}"), 3));
            PendingRequest request = new("guest.command", "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", dto);
            Assert(ReceiptBuilder.Check(receipt, request, fx.Identity, fx.Signer.Issuer, fx.Now).Ok, "contract verdict");
        });
        Check("task-start: the receipt never outlives the attestation, 10 s is the least worth signing, and the same operation is one request whichever submit came first", () =>
        {
            using AttestKey key = new();
            Fixture fx = StandardWith(key, []);
            JsonElement longLived = fx.Submit(TaskSubmit(TaskEnvelope(TaskBody(operationId: "a", expiresAt: Start + 295), key).Json, op: "a"));
            Assert((long)ReceiptFields(fx, ApprovalIdOf(longLived))["exp"] == Start + 120, "a long attestation does not stretch the receipt past 120 s");
            Assert(StateOf(fx.Submit(TaskSubmit(TaskEnvelope(TaskBody(operationId: "b", expiresAt: Start + 10), key).Json, op: "b"))) == "approved", "exactly 10 s left is signed");
            Assert(IsPending(fx, fx.Submit(TaskSubmit(TaskEnvelope(TaskBody(operationId: "c", expiresAt: Start + 9), key).Json, op: "c"))), "9 s left: a person is asked");
            string queued = ApprovalIdOf(fx.Submit(SubmitJson(op: "q", idem: "q", action: "task.start", args: TaskArgs, purpose: "guest.command")));
            JsonElement again = fx.Submit(TaskSubmit(TaskEnvelope(TaskBody(operationId: "q"), key).Json, op: "q"));
            Assert(ApprovalIdOf(again) == queued && StateOf(again) == "pending", "a request already waiting for a person is not turned into a receipt by a later attestation");
        });
        Check("task-start: the Authority's receipt contract refuses a policy receipt for task.start without the digest, and one whose action names no VM", () =>
        {
            using AttestKey key = new();
            (string envelope, string digest) = TaskEnvelope(TaskBody(), key);
            Fixture fx = StandardWith(key, []);
            string id = ApprovalIdOf(fx.Submit(TaskSubmit(envelope)));
            string json = Encoding.UTF8.GetString(ReceiptOf(fx.Status(id)).Receipt);
            string withoutDigest = json.Replace($",\"attestationDigest\":\"{digest}\"", "", StringComparison.Ordinal);
            Assert(withoutDigest != json && ReceiptV3.Parse(Encoding.UTF8.GetBytes(withoutDigest)).Ok, "the stripped receipt is still well formed ...");
            ValidatedAction dto = ActionDigest.Validate("guest.command", StrictJson.Parse(Encoding.UTF8.GetBytes($"{{\"action\":\"task.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{TaskArgs}}}"), 3));
            PendingRequest request = new("guest.command", "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", dto);
            ReceiptVerdict noDigest = ReceiptBuilder.Check(Encoding.UTF8.GetBytes(withoutDigest), request, fx.Identity, fx.Signer.Issuer, fx.Now);
            Assert(noDigest is { Ok: false, Code: "attestation", Field: "attestationDigest" }, $"... but the contract says {noDigest.Code}/{noDigest.Field}");
            ValidatedAction noVm = ActionDigest.Validate("guest.command", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"task.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{\"task\":\"build the project\"}}"), 3));
            ReceiptVerdict noVmVerdict = ReceiptBuilder.Check(ReceiptOf(fx.Status(id)).Receipt, new PendingRequest("guest.command", "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", noVm), fx.Identity, fx.Signer.Issuer, fx.Now);
            Assert(noVmVerdict is { Ok: false, Code: "attestation", Field: "vmId" }, $"{noVmVerdict.Code}/{noVmVerdict.Field}");
        });
    }

    private static void TaskStartRefuseChecks()
    {
        Check("task-start: no attestation, no pinned key, careful tier, an override on task.start or missing expectedGeneration / vmId args: a person is asked", () =>
        {
            using AttestKey key = new();
            string envelope = TaskEnvelope(TaskBody(), key).Json;
            List<string> audit = [];
            Fixture omitted = StandardWith(key, audit);
            Assert(IsPending(omitted, omitted.Submit(SubmitJson(action: "task.start", args: TaskArgs, purpose: "guest.command"))) && audit.Count == 0, "no attestation: silent");
            Fixture noKey = StandardWith(null, audit);
            Assert(IsPending(noKey, noKey.Submit(TaskSubmit(envelope))) && audit.SequenceEqual(["ATTESTATION_REFUSED=no_key_pinned"]), "the Authority pins no key");
            Fixture careful = new(policy: PolicyStore.InMemory(PolicyOf(PolicyJson(1, "careful"))), attestation: key.Pinned());
            Assert(IsPending(careful, careful.Submit(TaskSubmit(envelope))), "careful tier: always a person");
            Fixture overridden = StandardWith(key, [], PolicyJson(2, "standard", "task.start"));
            Assert(IsPending(overridden, overridden.Submit(TaskSubmit(envelope))), "an override forcing a prompt on task.start wins over a valid attestation");
            Fixture onlyStart = StandardWith(key, [], PolicyJson(3, "standard", "environment.start"));
            Assert(StateOf(onlyStart.Submit(TaskSubmit(envelope))) == "approved", "control: an override on start alone does not stop task.start");
            audit.Clear();
            Fixture f = StandardWith(key, audit);
            Assert(IsPending(f, f.Submit(TaskSubmit(envelope, args: "{\"task\":\"x\",\"vmId\":\"" + AttestVm + "\"}"))) && audit.SequenceEqual(["ATTESTATION_REFUSED=generation_missing"]), "no expectedGeneration to bind");
            audit.Clear();
            Assert(IsPending(f, f.Submit(TaskSubmit(envelope, op: "nv", args: "{\"task\":\"x\",\"expectedGeneration\":3}"))) && audit.SequenceEqual(["ATTESTATION_REFUSED=vm_id_missing"]), "no vmId to bind");
            int n = 0;
            foreach (string args in new[] { "{\"expectedGeneration\":0,\"vmId\":\"" + AttestVm + "\"}", "{\"expectedGeneration\":\"3\",\"vmId\":\"" + AttestVm + "\"}", "{\"expectedGeneration\":3,\"vmId\":\"vm-1\"}",
                "{\"expectedGeneration\":3,\"vmId\":\"AAAAAAAA-2222-4333-8444-555555555555\"}" })
                Assert(IsPending(f, f.Submit(TaskSubmit(envelope, op: $"b{n++}", args: args))), args);
        });
        Check("task-start: a forged, stale, mismatched, 'present' / 'unknown' or Standard-checkpoint attestation is not an error: the request waits for a person, with a fixed-word audit reason", () =>
        {
            using AttestKey key = new();
            using AttestKey stranger = new();
            (string Reason, string Envelope)[] cases =
            [
                ("signature:signature", TaskEnvelope(TaskBody(), stranger).Json),
                ("signature:signature", TaskEnvelope(TaskBody(), key, keyId: "broker-attest-test-2").Json),
                ("signature:signature", TaskEnvelope(TaskBody(), key, flipSignature: true).Json),
                ("digest:digest", TaskEnvelope(TaskBody(), key).Json.Replace("\"checkpointType\":\"production\"", "\"checkpointType\":\"standard\"", StringComparison.Ordinal)),
                ("network_present", TaskEnvelope(TaskBody("present"), key).Json),
                ("network_unknown", TaskEnvelope(TaskBody("unknown"), key).Json),
                ("checkpoint_standard", TaskEnvelope(TaskBody(checkpointType: "standard"), key).Json),
                ("network_present", TaskEnvelope(TaskBody("present", "standard"), key).Json),
                ("expired:expiresAt", TaskEnvelope(TaskBody(observedAt: Start - 100, expiresAt: Start), key).Json),
                ("not_yet_valid:observedAt", TaskEnvelope(TaskBody(observedAt: Start + 31, expiresAt: Start + 91), key).Json),
                ("binding:computerId", TaskEnvelope(TaskBody(computerId: "pc-02"), key).Json),
                ("binding:projectId", TaskEnvelope(TaskBody(projectId: "proj-beta"), key).Json),
                ("binding:generation", TaskEnvelope(TaskBody(generation: 4), key).Json),
                ("binding:leaseId", TaskEnvelope(TaskBody(leaseId: "lease-2"), key).Json),
                ("binding:leaseGeneration", TaskEnvelope(TaskBody(leaseGeneration: 8), key).Json),
                ("binding:operationId", TaskEnvelope(TaskBody(operationId: "op-2"), key).Json),
                ("binding:vmId", TaskEnvelope(TaskBody(vmId: OtherVm), key).Json),
                ("malformed:$extra", TaskEnvelope(TaskBody(), key).Json.Replace("\"digest\"", "\"extra\":\"x\",\"digest\"", StringComparison.Ordinal)),
                ("malformed:$extra", "{}"),
                ("malformed", "5"),
            ];
            foreach ((string reason, string envelope) in cases)
            {
                List<string> audit = [];
                Fixture fx = StandardWith(key, audit);
                JsonElement reply = fx.Submit(TaskSubmit(envelope));
                Assert(IsPending(fx, reply), $"{reason}: {reply}");
                Assert(audit.Count == 1 && audit[0] == $"ATTESTATION_REFUSED={reason}", $"{reason}: audit {string.Join("|", audit)}");
                Assert(!fx.List().GetRawText().Contains("attestation", StringComparison.Ordinal), $"{reason}: the approver's list does not carry the claim");
            }
        });
        Check("task-start: an attestation for another operation, another VM, or another lease cannot be reused: each is a binding refusal and the request waits for a person", () =>
        {
            using AttestKey key = new();
            List<string> audit = [];
            Fixture fx = StandardWith(key, audit);
            string forOp1 = TaskEnvelope(TaskBody(operationId: "op-1"), key).Json;
            Assert(StateOf(fx.Submit(TaskSubmit(forOp1, op: "op-1"))) == "approved", "control: its own operation");
            Assert(IsPending(fx, fx.Submit(TaskSubmit(forOp1, op: "op-2"))) && audit.Contains("ATTESTATION_REFUSED=binding:operationId"), "the same statement for the next task.start is refused");
            string otherArgs = "{\"expectedGeneration\":3,\"task\":\"x\",\"vmId\":\"" + OtherVm + "\"}";
            audit.Clear();
            Assert(IsPending(fx, fx.Submit(TaskSubmit(forOp1, op: "op-1b", args: otherArgs))) && audit.Count == 1, "VM A's statement for a task.start that names VM B");
        });
    }

    private static void TaskStartActionBindingChecks()
    {
        Check("task-start: ONE statement backs ONE action (issue #133): the same operation with another task is a binding refusal on actionDigest (a person is asked), the statement made for that task is approved, and a statement that names a digest the Authority did not compute is refused", () =>
        {
            using AttestKey key = new();
            List<string> audit = [];
            Fixture fx = StandardWith(key, audit);
            string otherTask = "{\"expectedGeneration\":3,\"task\":\"delete everything\",\"vmId\":\"" + AttestVm + "\"}";
            Assert(TaskDigest() != TaskDigest(otherTask), "control: the two tasks have two action digests");
            string forBuild = TaskEnvelope(TaskBody(), key).Json;
            Assert(StateOf(fx.Submit(TaskSubmit(forBuild))) == "approved" && audit.Count == 1 && audit[0].StartsWith("POLICY_SIGNED=", StringComparison.Ordinal), $"control: its own task: {string.Join("|", audit)}");
            // Same computer, project, lease, lease generation, VM, generation AND operationId; only the task differs, under another idempotency key (a resubmit with other content).
            audit.Clear();
            JsonElement second = fx.Submit(SubmitJson(op: "op-1", idem: "op-1.c2", action: "task.start", args: otherTask, purpose: "guest.command", extra: $",\"attestation\":{forBuild}"));
            Assert(Code(second) != "ok" || StateOf(second) != "approved", $"the first statement did not back a second receipt: {second}");
            Assert(!audit.Any(line => line.StartsWith("POLICY_SIGNED=", StringComparison.Ordinal)), $"no second receipt was signed without a person: {string.Join("|", audit)}");
            // The same on a clean Authority (nothing known about op-1): the verdict is the binding on actionDigest, and only that.
            audit.Clear();
            Fixture clean = StandardWith(key, audit);
            Assert(IsPending(clean, clean.Submit(TaskSubmit(forBuild, args: otherTask))) && audit.SequenceEqual(["ATTESTATION_REFUSED=binding:actionDigest"]), $"another task: {string.Join("|", audit)}");
            audit.Clear();
            Assert(StateOf(clean.Submit(TaskSubmit(TaskEnvelope(TaskBody(operationId: "op-2", actionDigest: TaskDigest(otherTask)), key).Json, op: "op-2", args: otherTask))) == "approved", "the statement made for that task backs that task");
            // A digest the Authority did not compute (the Control Plane's own expectedDigest never feeds it) is refused, whatever its shape.
            audit.Clear();
            string foreign = TaskEnvelope(TaskBody(operationId: "op-3", actionDigest: "sha256:" + new string('0', 64)), key).Json;
            Assert(IsPending(clean, clean.Submit(TaskSubmit(foreign, op: "op-3"))) && audit.SequenceEqual(["ATTESTATION_REFUSED=binding:actionDigest"]), $"foreign digest: {string.Join("|", audit)}");
            // A body without actionDigest (the previous version's shape), or one with a malformed digest, is malformed.
            Dictionary<string, object> noDigest = TaskBody();
            noDigest.Remove("actionDigest");
            Assert(TaskStartAttestation.ValidateBody(noDigest) is { Ok: false, Code: "malformed", Field: "$extra" }, "13 keys: malformed $extra");
            Dictionary<string, object> badDigest = TaskBody();
            badDigest["actionDigest"] = "sha256:" + new string('A', 64);
            Assert(TaskStartAttestation.ValidateBody(badDigest) is { Ok: false, Code: "malformed", Field: "actionDigest" }, "uppercase digest: malformed actionDigest");
        });
        Check("task-start: the caller's own expected values are validated and NAMED, and counters are safe integers (issue #133)", () =>
        {
            using AttestKey key = new();
            (string json, _) = TaskEnvelope(TaskBody(), key);
            using JsonDocument document = JsonDocument.Parse(json);
            object signed = VectorValue(document.RootElement);
            using PinnedAttestationKey pinned = key.Pinned();
            string digest = TaskDigest();
            TaskStartExpected Good(string? computerId = null, string? projectId = null, string? leaseId = null, string? operationId = null, string? vmId = null, string? actionDigest = null, long generation = 3, long leaseGeneration = 7) =>
                new(computerId ?? "pc-01", vmId ?? AttestVm, generation, projectId ?? "proj-alpha", leaseId ?? "lease-1", leaseGeneration, operationId ?? "op-1", actionDigest ?? digest);
            (string Want, TaskStartExpected Expected)[] cases =
            [
                ("computerId", Good(computerId: "has space")), ("projectId", Good(projectId: "")), ("leaseId", Good(leaseId: "lease/1")), ("operationId", Good(operationId: new string('x', 65))),
                ("vmId", Good(vmId: "AAAAAAAA-2222-4333-8444-555555555555")), ("actionDigest", Good(actionDigest: "sha256:abc")), ("generation", Good(generation: 0)), ("generation", Good(generation: -1)),
                ("generation", Good(generation: StrictJson.MaxSafeInteger + 1)), ("leaseGeneration", Good(leaseGeneration: 0)), ("leaseGeneration", Good(leaseGeneration: StrictJson.MaxSafeInteger + 1)),
                ("computerId", Good(computerId: "has space", vmId: "nope", generation: 0)), ("vmId", Good(vmId: "nope", actionDigest: "nope")), ("actionDigest", Good(actionDigest: "nope", generation: 0)),
                ("generation", Good(generation: 0, leaseGeneration: 0)),
            ];
            foreach ((string want, TaskStartExpected expected) in cases)
            {
                TaskStartVerdict verdict = TaskStartAttestation.Verify(signed, () => Start, pinned.Verify, expected);
                Assert(verdict is { Ok: false, Code: "invalid_expected" } && verdict.Field == want, $"{want}: got {verdict.Code}/{verdict.Field}");
            }
            TaskStartVerdict atMax = TaskStartAttestation.Verify(signed, () => Start, pinned.Verify, Good(generation: StrictJson.MaxSafeInteger));
            Assert(atMax is { Ok: false, Code: "binding", Field: "generation" }, $"the largest safe integer is a plain mismatch: {atMax.Code}/{atMax.Field}");
            Assert(TaskStartAttestation.Verify(signed, () => Start, pinned.Verify, Good()).Ok, "control: the real expectation verifies");
        });
    }

    private static void TaskStartDomainChecks()
    {
        Check("task-start: DOMAIN SEPARATION: a genuine network attestation (signed by the pinned key) does not count for task.start, and a task-start attestation does not count for environment.start", () =>
        {
            using AttestKey key = new();
            List<string> audit = [];
            Fixture fx = StandardWith(key, audit);
            (string network, _) = AttestEnvelope(AttestBody(), key);
            (string task, _) = TaskEnvelope(TaskBody(), key);
            Assert(IsPending(fx, fx.Submit(TaskSubmit(network, op: "n-for-task"))) && audit.SequenceEqual(["ATTESTATION_REFUSED=malformed:$extra"]), $"network attestation for task.start: {string.Join("|", audit)}");
            audit.Clear();
            Assert(IsPending(fx, fx.Submit(AttestedSubmit(task, op: "t-for-start"))) && audit.SequenceEqual(["ATTESTATION_REFUSED=malformed:$extra"]), $"task-start attestation for environment.start: {string.Join("|", audit)}");
            (string okTask, _) = TaskEnvelope(TaskBody(operationId: "ok-task"), key);
            Assert(StateOf(fx.Submit(AttestedSubmit(network, op: "ok-start"))) == "approved" && StateOf(fx.Submit(TaskSubmit(okTask, op: "ok-task"))) == "approved", "control: each kind for its own action");
            // The same body keys cannot cross over either: a task-start body signed under the NETWORK domain (key and body both genuine) fails the signature.
            byte[] underNetworkDomain = [.. Encoding.UTF8.GetBytes(NetworkAttestation.Domain), 0, .. TaskStartPreimageBody(TaskBody())];
            audit.Clear();
            (string crossed, _) = TaskEnvelope(TaskBody(), key, signedBytes: underNetworkDomain);
            Assert(IsPending(fx, fx.Submit(TaskSubmit(crossed, op: "x1"))) && audit.SequenceEqual(["ATTESTATION_REFUSED=signature:signature"]), $"wrong-domain signature: {string.Join("|", audit)}");
            Assert(TaskStartAttestation.Domain != NetworkAttestation.Domain, "two domains");
        });
        Check("task-start: it never lets any other action skip a person (create, destroy, retire, purge, synthetic.noop, start with this kind of statement), at any tier", () =>
        {
            using AttestKey key = new();
            string task = TaskEnvelope(TaskBody(), key).Json;
            foreach (string tier in new[] { "standard", "careful" })
            {
                Fixture fx = new(policy: PolicyStore.InMemory(PolicyOf(PolicyJson(1, tier))), attestation: key.Pinned());
                int n = 0;
                foreach (string action in new[] { "environment.create", "environment.destroy", "environment.retire", "environment.purge", "environment.start", "synthetic.noop" })
                    Assert(IsPending(fx, fx.Submit(AttestedSubmit(task, action, op: $"x{n++}"))), $"{tier} {action}");
                Assert(IsPending(fx, fx.Submit(SubmitJson(op: "noop-g", idem: "noop-g", action: "synthetic.noop", purpose: "guest.command", args: TaskArgs, extra: $",\"attestation\":{task}"))), $"{tier} guest synthetic.noop");
                Assert(IsPending(fx, fx.Submit(TaskSubmit(TaskEnvelope(TaskBody(operationId: "ts-t"), key).Json, op: "ts-t"))) == (tier == "careful"), $"{tier}: task.start is attested at standard only");
            }
        });
        Check("task-start: the pinned task-start vectors (Node-made, ephemeral key) give the same verdicts through the production PinnedAttestationKey", () =>
        {
            using Stream stream = typeof(Harness).Assembly.GetManifestResourceStream("task-start-attestation-vectors.json") ?? throw new CheckFailed("the vector file is not embedded");
            using JsonDocument document = JsonDocument.Parse(stream);
            JsonElement verify = document.RootElement.GetProperty("verifyVectors");
            using PinnedAttestationKey pinned = PinnedAttestationKey.TryCreate(verify.GetProperty("keyId").GetString()!, Convert.FromBase64String(verify.GetProperty("publicKeySpki").GetString()!)) ?? throw new CheckFailed("the vector key does not pin");
            int count = 0;
            foreach (JsonElement c in verify.GetProperty("cases").EnumerateArray())
            {
                JsonElement e = c.GetProperty("expected");
                TaskStartExpected expected = new(e.GetProperty("computerId").GetString()!, e.GetProperty("vmId").GetString()!, e.GetProperty("generation").GetInt64(), e.GetProperty("projectId").GetString()!,
                    e.GetProperty("leaseId").GetString()!, e.GetProperty("leaseGeneration").GetInt64(), e.GetProperty("operationId").GetString()!, e.GetProperty("actionDigest").GetString()!);
                long now = c.GetProperty("now").GetInt64();
                TaskStartVerdict verdict = TaskStartAttestation.Verify(VectorValue(c.GetProperty("signed")), () => now, pinned.Verify, expected);
                JsonElement want = c.GetProperty("result");
                string wantCode = want.GetProperty("ok").GetBoolean() ? "ok" : want.GetProperty("code").GetString()!;
                string wantField = want.TryGetProperty("field", out JsonElement f) ? f.GetString()! : "";
                Assert((verdict.Ok ? "ok" : verdict.Code) == wantCode && (verdict.Field ?? "") == wantField, $"{c.GetProperty("name").GetString()}: got {verdict.Code}/{verdict.Field}, want {wantCode}/{wantField}");
                count++;
            }
            Assert(count >= 75, $"only {count} cases");
        });
        Check("task-start policy: dropping the override on task.start needs the Hello signature (the rule is by effect), adding it back needs none", () =>
        {
            Fixture fx = Under(PolicyJson(1, "standard", "task.start"));
            string loosened = PolicyJson(2, "standard");
            Assert(Code(fx.PolicySet(loosened)) == "presence_mismatch" && fx.Core.Policy() is { Revision: 1 }, "no signature: nothing changed");
            Assert(Code(fx.PolicySet(loosened, PolicyProof(loosened))) == "ok" && fx.Core.Policy() is { Revision: 2 }, "signed");
            string tighter = PolicyJson(3, "standard", "task.start");
            Assert(Code(fx.PolicySet(tighter)) == "ok" && fx.Core.Policy() is { Revision: 3 }, "adding the override needs none");
            Assert(fx.Core.Policy()!.NoPromptActions().Contains("task.start") == false && PolicyOf(PolicyJson(1, "standard")).AttestedNoPromptActions().Contains("task.start"), "task.start is an attested action, never an unattested one");
        });
    }

    private static byte[] TaskStartPreimageBody(Dictionary<string, object> body)
    {
        using MemoryStream buffer = new();
        ActionDigest.Write(buffer, body);
        return buffer.ToArray();
    }
}
