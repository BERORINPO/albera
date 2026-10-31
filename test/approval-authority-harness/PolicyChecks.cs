using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.ApprovalAuthority;
using Albera.BrokerContract;

// Tier policy checks (issue #115 step 3): the careful default, the standard tier, overrides, the Hello-signed policy change (by effect, domain separated, bound to the hash and
// the revision), the policy file (load, refuse, atomic write) and the Control Plane's inability to influence any of it. In-process; the only files are in a temp folder this
// process creates, and the only "Hello" is the throw-away RSA key of Program.cs.
internal static partial class Harness
{
    private static readonly string[] Skippable = ["environment.inspect", "environment.stop", "workspace.inspect", "task.cancel"];
    private static readonly string[] NeverSkipped = ["environment.create", "environment.start", "environment.destroy", "environment.retire", "environment.purge", "task.start", "synthetic.noop"];

    private static string PurposeOf(string action) => action is "task.start" or "task.cancel" or "workspace.inspect" ? "guest.command" : "broker.operation";

    private static string PolicyJson(long rev, string tier, params string[] prompts) =>
        $"{{\"v\":1,\"rev\":{rev},\"tier\":\"{tier}\",\"overrides\":{{{string.Join(',', prompts.Select(a => $"\"{a}\":\"prompt\""))}}}}}";

    private static TierPolicy PolicyOf(string json) => TierPolicy.TryParse(Encoding.UTF8.GetBytes(json)) ?? throw new CheckFailed($"test policy does not parse: {json}");

    private static byte[] HelloSign(byte[] message) => Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

    private static readonly AuthorityIdentity DefaultIdentity = new("authority-key-2026-10", "albera-host-broker", "policy-2026-10", "hello-key-yosuke-01");

    private static byte[] PolicyProof(string json, string kid = "authority-key-2026-10", string audience = "albera-host-broker") => HelloSign(PolicyChange.Message(PolicyOf(json), kid, audience));

    private static PolicyStore? LoadPolicy(string config, out string reason, out bool fromFile) =>
        PolicyStore.TryLoad(config, DefaultIdentity, RsaPresenceVerifier.TryCreate(Hello.ExportSubjectPublicKeyInfo())!, out reason, out fromFile);

    /// <summary>policy.json as the Authority writes it: the policy, and the policy the signature authorized with that signature.</summary>
    private static string SignedFile(string policyJson, string authorizedJson, byte[] presence) =>
        policyJson[..^1] + ",\"authorized\":" + authorizedJson[..^1] + ",\"presence\":\"" + Convert.ToBase64String(presence) + "\"}}";

    private static JsonElement SubmitAction(Fixture fx, string action, string op = "op-1") => fx.Submit(SubmitJson(op: op, idem: op, action: action, purpose: PurposeOf(action)));

    private static string StateOf(JsonElement submitReply) => submitReply.GetProperty("state").GetString()!;

    /// <summary>A fixture whose policy is already in force (loaded as a file would be, without a file).</summary>
    private static Fixture Under(string policyJson) => new(policy: PolicyStore.InMemory(PolicyOf(policyJson)));

    private static void PolicyChecks()
    {
        PolicyDecisionChecks();
        PolicyChangeChecks();
        PolicyFileChecks();
    }

    private static void PolicyDecisionChecks()
    {
        Check("policy: with no policy file the default is careful and EVERY action needs a person (nothing is signed on submit)", () =>
        {
            Fixture fx = new();
            Assert(fx.Core.Policy() is { Tier: "careful", Revision: 0 }, "default policy");
            int n = 0;
            foreach (string action in Skippable.Concat(NeverSkipped).Concat(["synthetic.noop"]))
            {
                JsonElement reply = SubmitAction(fx, action, $"op-{n++}");
                Assert(Code(reply) == "ok" && StateOf(reply) == "pending", $"{action}: {reply}");
                Assert(fx.Store.Get(reply.GetProperty("approvalId").GetString()!)!.Receipt is null, $"{action}: no receipt");
            }
            Assert(fx.Store.Count == n && fx.List().GetProperty("pending").GetArrayLength() > 0, "every one is waiting for a person");
        });
        Check("policy: careful with overrides still prompts for everything (an override can add prompts, never remove them)", () =>
        {
            Fixture fx = Under(PolicyJson(3, "careful", "environment.stop"));
            foreach (string action in Skippable) Assert(StateOf(SubmitAction(fx, action, action.Replace('.', '-'))) == "pending", action);
        });
        Check("policy: standard signs the four skippable actions at once with a v3 receipt, basis policy and the policy hash, and nobody is asked", () =>
        {
            string json = PolicyJson(1, "standard");
            Fixture fx = Under(json);
            foreach (string action in Skippable)
            {
                JsonElement reply = SubmitAction(fx, action, action.Replace('.', '-'));
                Assert(Code(reply) == "ok" && StateOf(reply) == "approved", $"{action}: {reply}");
                string id = reply.GetProperty("approvalId").GetString()!;
                JsonElement status = fx.Status(id);
                Assert(Code(status) == "ok" && status.GetProperty("state").GetString() == "approved", $"{action}: status");
                (byte[] receipt, byte[] signature) = ReceiptOf(status);
                using ECDsa key = ECDsa.Create();
                key.ImportSubjectPublicKeyInfo(fx.Signer.PublicKeySpki, out _);
                Assert(key.VerifyData(receipt, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation), $"{action}: signature");
                ReceiptVerdict parsed = ReceiptV3.Parse(receipt);
                Assert(parsed.Ok, $"{action}: v3 parse {parsed.Code}/{parsed.Field}");
                IReadOnlyDictionary<string, object> r = parsed.Receipt!;
                Assert((long)r["v"] == 3 && (string)r["basis"] == "policy" && (string)r["action"] == action, $"{action}: v / basis / action");
                Assert((string)r["policyVersion"] == PolicyOf(json).Hash(), $"{action}: policyVersion is the hash of the policy in force");
                Assert((string)r["approvalId"] == id && (string)r["approverKeyId"] == "hello-key-yosuke-01", $"{action}: ids");
                Assert((long)r["exp"] - (long)r["iat"] == 120, $"{action}: 120 s");
                Assert(fx.Store.Get(id)!.State == EntryState.Approved && fx.Store.Get(id)!.Receipt is not null, $"{action}: the entry stays readable in the store");
            }
            Assert(fx.List().GetProperty("pending").GetArrayLength() == 0, "nothing reached the approver's list");
        });
        Check("policy: the receipt a policy signs validates with the contract exactly as the Broker will run it, and not for another action or another basis", () =>
        {
            Fixture fx = Under(PolicyJson(1, "standard"));
            string id = ApprovalIdOf(SubmitAction(fx, "environment.stop"));
            byte[] receipt = ReceiptOf(fx.Status(id)).Receipt;
            ValidatedAction dto = ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"environment.stop\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{}}"), 3));
            PendingRequest request = new("broker.operation", "op-1", "op-1", "lease-1", 7, 3, "_-7dzLuqmYh3ZlVEMyIRAA", dto);
            Assert(ReceiptBuilder.Check(receipt, request, fx.Identity, fx.Signer.Issuer, fx.Now).Ok, "contract verdict");
            // The same bytes with the basis flipped to presence, or for a non-skippable action with basis policy, are not what the Authority signed and not what the contract takes.
            string json = Encoding.UTF8.GetString(receipt);
            Assert(ReceiptV3.Parse(Encoding.UTF8.GetBytes(json.Replace("\"basis\":\"policy\"", "\"basis\":\"grant:g-1\""))) is { Ok: false, Field: "basis" }, "a grant basis is not accepted");
            string destroyDigest = ActionDigest.Compute("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"environment.destroy\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{}}"), 3));
            byte[] forged = Encoding.UTF8.GetBytes(json.Replace("\"action\":\"environment.stop\"", "\"action\":\"environment.destroy\"").Replace(ActionDigestOf(receipt), destroyDigest));
            ReceiptVerdict refused = Receipts.Validate(forged, new ReceiptContext(() => fx.Now, "test", new Dictionary<string, object>
            {
                ["audience"] = "albera-host-broker", ["purpose"] = "broker.operation", ["operationId"] = "op-1", ["idempotencyKey"] = "op-1", ["leaseId"] = "lease-1",
                ["leaseGeneration"] = 7L, ["brokerEpoch"] = 3L, ["brokerChallenge"] = "_-7dzLuqmYh3ZlVEMyIRAA",
            }, ReceiptBuilder.DtoOf(ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"environment.destroy\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{}}"), 3)))));
            Assert(refused is { Ok: false, Code: "basis_action" }, $"basis policy for destroy: {refused.Code}");
        });
        Check("policy: standard still needs a person for create / start / destroy / retire / purge / task.start / synthetic.noop, and a person's approval gives a plain v2 receipt", () =>
        {
            Fixture fx = Under(PolicyJson(1, "standard"));
            int n = 0;
            foreach (string action in NeverSkipped)
            {
                JsonElement reply = SubmitAction(fx, action, $"op-{n++}");
                Assert(StateOf(reply) == "pending", $"{action}: {reply}");
                Assert(fx.Store.Get(reply.GetProperty("approvalId").GetString()!)!.Receipt is null, $"{action}: no receipt");
            }
            JsonElement guestNoop = fx.Submit(SubmitJson(op: "guest-noop", idem: "guest-noop", action: "synthetic.noop", purpose: "guest.command"));
            Assert(StateOf(guestNoop) == "pending", "synthetic.noop under guest.command");
            string id = ApprovalIdOf(SubmitAction(fx, "environment.destroy", "destroy-2"));
            Assert(Code(fx.ApproveSigned(id)) == "ok", "approve");
            Assert(ReceiptOf(fx.Status(id)).Receipt is { } bytes && ReceiptV2.Parse(bytes).Ok && !ReceiptV3.Parse(bytes).Ok, "approved by a person: receipt v2");
        });
        Check("policy: standard with overrides asks for exactly the overridden actions; every other skippable action is still signed at once", () =>
        {
            Fixture fx = Under(PolicyJson(2, "standard", "environment.stop", "task.cancel"));
            Assert(StateOf(SubmitAction(fx, "environment.stop", "a")) == "pending" && StateOf(SubmitAction(fx, "task.cancel", "b")) == "pending", "overridden actions wait for a person");
            Assert(StateOf(SubmitAction(fx, "environment.inspect", "c")) == "approved" && StateOf(SubmitAction(fx, "workspace.inspect", "d")) == "approved", "the others are signed");
        });
        Check("policy: nothing in a submit request can select, lower or name a tier or a basis (every extra field is request_invalid), and the digest field is never a way round", () =>
        {
            foreach (string policyJson in new[] { PolicyJson(0, "careful"), PolicyJson(1, "standard") })
            {
                Fixture fx = Under(policyJson);
                string[] extras = [",\"tier\":\"standard\"", ",\"basis\":\"policy\"", ",\"policy\":{\"v\":1,\"rev\":9,\"tier\":\"standard\",\"overrides\":{}}", ",\"policyVersion\":\"sha256:" + new string('a', 64) + "\"",
                    ",\"noPrompt\":true", ",\"presence\":\"AAAA\"", ",\"scheduled\":true", ",\"approverKeyId\":\"x\""];
                foreach (string extra in extras) Assert(Code(fx.Submit(SubmitJson(action: "environment.destroy", extra: extra))) == "request_invalid", $"destroy with {extra}");
                // The same inside the action DTO (a skippable action carrying such args is still the action the Authority hashed; its args are bound by the digest).
                Assert(Code(fx.Submit(SubmitJson(op: "x", idem: "x", action: "environment.stop", extra: ",\"tier\":\"standard\""))) == "request_invalid", "stop with a tier field");
                Assert(fx.Store.Count == 0, "nothing was queued or signed by any of them");
                // Policy verbs do not exist on the submit pipe, and submit does not exist on the approver pipe.
                Assert(Code(fx.Call(PipeRole.Submit, "{\"v\":1,\"verb\":\"policy\"}")) == "request_invalid", "policy on the submit pipe");
                Assert(Code(fx.Call(PipeRole.Submit, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{PolicyJson(9, "standard")}}}")) == "request_invalid", "policy_set on the submit pipe");
                Assert(Code(fx.Call(PipeRole.Approver, SubmitJson())) == "request_invalid", "submit on the approver pipe");
            }
            Fixture careful = new();
            string expected = ActionDigest.Compute("broker.operation", ReceiptBuilder.DtoOf(ActionDigest.Validate("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes("{\"action\":\"environment.stop\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{}}"), 3))));
            Assert(StateOf(careful.Submit(SubmitJson(action: "environment.stop", extra: $",\"expectedDigest\":\"{expected}\""))) == "pending", "a correct expectedDigest does not lower the tier");
        });
        Check("policy: a request that is already waiting for a person stays waiting when the policy later skips that action (same key returns the pending entry; nothing is upgraded)", () =>
        {
            Fixture fx = new();
            string pending = ApprovalIdOf(SubmitAction(fx, "environment.stop", "keep"));
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"), PolicyProof(PolicyJson(1, "standard")))) == "ok", "loosen");
            JsonElement again = SubmitAction(fx, "environment.stop", "keep");
            Assert(ApprovalIdOf(again) == pending && StateOf(again) == "pending", "same request, still pending");
            Assert(fx.Store.Get(pending)!.Receipt is null, "no receipt appeared");
            Assert(StateOf(SubmitAction(fx, "environment.stop", "fresh")) == "approved", "a new request under the new policy is signed");
        });
        Check("policy: a signer that fails gives authority_unavailable and leaves nothing behind (no pending entry, no receipt)", () =>
        {
            Fixture fx = Under(PolicyJson(1, "standard"));
            fx.Signer.Failing = true;
            Assert(Code(SubmitAction(fx, "environment.inspect")) == "authority_unavailable", "submit");
            Assert(fx.Store.Count == 0 && fx.List().GetProperty("pending").GetArrayLength() == 0, "nothing stored");
            fx.Signer.Failing = false;
            Assert(StateOf(SubmitAction(fx, "environment.inspect")) == "approved", "works again once the signer does");
        });
        Check("policy: every receipt signed without a person and every applied policy change is reported on the audit line (fixed words, the action name, ids and the hash; nothing else, and nothing for a refusal)", () =>
        {
            List<string> lines = [];
            Fixture fx = new(audit: lines.Add);
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"))) == "presence_mismatch" && lines.Count == 0, "a refused change is not reported");
            string standard = PolicyJson(1, "standard");
            Assert(Code(fx.PolicySet(standard, PolicyProof(standard))) == "ok", "loosen");
            string id = ApprovalIdOf(SubmitAction(fx, "environment.stop"));
            ApprovalIdOf(SubmitAction(fx, "environment.destroy", "d"));
            Assert(lines.SequenceEqual([$"POLICY_CHANGED=1 standard {PolicyOf(standard).Hash()}", $"POLICY_SIGNED=environment.stop {id}"]), string.Join('|', lines));
            fx.Signer.Failing = true;
            SubmitAction(fx, "environment.inspect", "x");
            Assert(lines.Count == 2, "a receipt that could not be signed is not reported as signed");
        });
        Check("policy: the worst-case policy receipt (64-character ids) fits the receipt limit and a 2 KiB status reply", () =>
        {
            string id64 = new('a', 64);
            Fixture fx = new(identity: new AuthorityIdentity(id64, new string('b', 64), id64, id64), policy: PolicyStore.InMemory(PolicyOf(PolicyJson(1, "standard"))));
            string request = SubmitJson(op: id64, idem: id64, action: "environment.inspect").Replace("lease-1", id64).Replace("proj-alpha", id64).Replace("pc-01", id64);
            string approvalId = ApprovalIdOf(fx.Submit(request));
            byte[] bytes = fx.Protocol.Handle(PipeRole.Submit, Encoding.UTF8.GetBytes($"{{\"v\":1,\"verb\":\"status\",\"approvalId\":\"{approvalId}\"}}"));
            (byte[] receipt, _) = ReceiptOf(Parse(bytes));
            Assert(receipt.Length <= ReceiptV2.MaxReceiptBytes && bytes.Length <= AuthorityProtocol.MaxFrameBytes, $"receipt {receipt.Length} bytes, reply {bytes.Length} bytes");
        });
    }

    private static string ActionDigestOf(byte[] receipt) => StrictJson.Parse(receipt, 1)["actionDigest"] is string digest ? digest : "";

    private static void PolicyChangeChecks()
    {
        Check("policy change: the approver reads the policy in force (default: careful, revision 0) and its hash", () =>
        {
            Fixture fx = new();
            JsonElement reply = fx.PolicyGet();
            Assert(Code(reply) == "ok" && reply.GetProperty("policyVersion").GetString() == TierPolicy.Default.Hash(), $"{reply}");
            Assert(TierPolicy.TryParse(Encoding.UTF8.GetBytes(reply.GetProperty("policy").GetRawText()))!.Hash() == TierPolicy.Default.Hash(), "the policy object hashes to the reported hash");
            Assert(reply.GetProperty("kid").GetString() == "authority-key-2026-10" && reply.GetProperty("audience").GetString() == "albera-host-broker", "the reply names what a signature is bound to");
        });
        Check("policy change: raising (careful to standard) without a presence signature is presence_mismatch and changes nothing", () =>
        {
            Fixture fx = new();
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"))) == "presence_mismatch", "no proof");
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"), [])) == "presence_mismatch", "empty proof");
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"), new byte[256])) == "presence_mismatch", "garbage proof");
            Assert(fx.Core.Policy() is { Tier: "careful", Revision: 0 } && StateOf(SubmitAction(fx, "environment.inspect")) == "pending", "still careful: the action still waits for a person");
        });
        Check("policy change: a signature over the wrong domain (a presence message, a self-check message) or over a different policy hash or from another key is presence_mismatch", () =>
        {
            Fixture fx = new();
            string target = PolicyJson(1, "standard");
            TierPolicy policy = PolicyOf(target);
            byte[] presenceDomain = HelloSign(Encoding.UTF8.GetBytes($"albera.presence.v1\0{policy.Hash()}"));
            byte[] selfCheckDomain = HelloSign(Encoding.UTF8.GetBytes($"albera.selfcheck.v1\0{policy.Hash()}"));
            byte[] bareHash = HelloSign(Encoding.UTF8.GetBytes(policy.Hash()));
            byte[] otherPolicy = PolicyProof(PolicyJson(1, "standard", "task.cancel"));      // a real policy signature, but for a different policy
            byte[] otherRevision = PolicyProof(PolicyJson(2, "standard"));                    // the same tier at another revision
            byte[] otherKid = PolicyProof(target, kid: "authority-key-2026-11");              // made for another Authority that pins the same approver key
            byte[] otherAudience = PolicyProof(target, audience: "albera-other-broker");
            using RSA stranger = RSA.Create(2048);
            byte[] otherKey = stranger.SignData(PolicyChange.Message(policy, "authority-key-2026-10", "albera-host-broker"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            foreach ((string label, byte[] proof) in new[] { ("presence domain", presenceDomain), ("self-check domain", selfCheckDomain), ("bare hash", bareHash), ("different policy", otherPolicy), ("different revision", otherRevision), ("another kid", otherKid), ("another audience", otherAudience), ("another key", otherKey) })
                Assert(Code(fx.PolicySet(target, proof)) == "presence_mismatch", label);
            Assert(fx.Core.Policy() is { Tier: "careful" }, "nothing changed");
            Assert(Code(fx.PolicySet(target, PolicyProof(target))) == "ok", "control: the right signature works");
        });
        Check("policy change: the policy message is not a presence message and a presence signature for a request never changes the policy", () =>
        {
            Fixture fx = new();
            string id = ApprovalIdOf(SubmitAction(fx, "environment.stop"));
            byte[] approvalSignature = SignPresence(Hello, fx.Store.Get(id)!);
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"), approvalSignature)) == "presence_mismatch", "an approval signature");
            Assert(PolicyChange.Domain != PresenceMessage.Domain && !PolicyChange.Message(PolicyOf(PolicyJson(1, "standard")), "authority-key-2026-10", "albera-host-broker").AsSpan().StartsWith(Encoding.UTF8.GetBytes(PresenceMessage.Domain + "\0")), "distinct domain words");
        });
        Check("policy change: a signature when Hello is not reachable is presence_unavailable, and the policy stays", () =>
        {
            Fixture fx = new(presence: new FakePresenceVerifier());
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"), FakePresenceVerifier.UnavailableProof)) == "presence_unavailable", "unavailable");
            Assert(Code(fx.PolicySet(PolicyJson(1, "standard"), FakePresenceVerifier.ProofFor(PolicyChange.Message(PolicyOf(PolicyJson(1, "standard")), "authority-key-2026-10", "albera-host-broker")))) == "ok", "the fake verifier accepts the right proof");
        });
        Check("policy change: with a valid signature the tier rises, the revision moves on, and the next skippable request is signed at once", () =>
        {
            Fixture fx = new();
            string target = PolicyJson(1, "standard");
            JsonElement reply = fx.PolicySet(target, PolicyProof(target));
            Assert(Code(reply) == "ok" && reply.GetProperty("policyVersion").GetString() == PolicyOf(target).Hash(), $"{reply}");
            Assert(fx.PolicyGet().GetProperty("policyVersion").GetString() == PolicyOf(target).Hash(), "read back");
            Assert(StateOf(SubmitAction(fx, "environment.inspect")) == "approved" && StateOf(SubmitAction(fx, "environment.destroy", "d")) == "pending", "standard applies");
        });
        Check("policy change: lowering (standard to careful) and adding an override need no signature; both take effect at once", () =>
        {
            Fixture fx = Under(PolicyJson(1, "standard"));
            Assert(Code(fx.PolicySet(PolicyJson(2, "standard", "task.cancel"))) == "ok", "add an override");
            Assert(StateOf(SubmitAction(fx, "task.cancel", "a")) == "pending" && StateOf(SubmitAction(fx, "environment.stop", "b")) == "approved", "override applies");
            Assert(Code(fx.PolicySet(PolicyJson(3, "careful"))) == "ok", "to careful");
            Assert(StateOf(SubmitAction(fx, "environment.stop", "c")) == "pending", "careful applies at once");
        });
        Check("policy change: the rule is by effect, not by tier name (removing an override, swapping overrides, standard without overrides after careful-with-override all loosen)", () =>
        {
            (string From, string To, bool NeedsProof)[] cases =
            [
                (PolicyJson(1, "standard", "environment.stop"), PolicyJson(2, "standard"), true),                                  // removing an override
                (PolicyJson(1, "standard", "environment.stop"), PolicyJson(2, "standard", "task.cancel"), true),                   // a different action is now skipped
                (PolicyJson(1, "standard", "environment.stop"), PolicyJson(2, "standard", "environment.stop", "task.cancel"), false), // only adds a prompt
                (PolicyJson(1, "careful", "task.cancel"), PolicyJson(2, "standard"), true),                                         // careful with an override to standard
                (PolicyJson(1, "standard"), PolicyJson(2, "standard", "environment.destroy"), false),                               // an override on an action that never skipped a person: no effect
                (PolicyJson(1, "standard"), PolicyJson(2, "standard"), false),                                                      // same effect, new revision
                (PolicyJson(1, "careful"), PolicyJson(2, "careful", "task.cancel"), false),
            ];
            foreach ((string from, string to, bool needsProof) in cases)
            {
                Fixture fx = Under(from);
                string withoutProof = Code(fx.PolicySet(to));
                Assert(needsProof ? withoutProof == "presence_mismatch" : withoutProof == "ok", $"{from} -> {to}: without proof {withoutProof}");
                if (needsProof) Assert(Code(fx.PolicySet(to, PolicyProof(to))) == "ok", $"{from} -> {to}: with proof");
            }
        });
        Check("policy change: only revision + 1 is accepted, so a captured signature cannot be applied twice or after the policy moved on (request_invalid)", () =>
        {
            Fixture fx = new();
            string standard1 = PolicyJson(1, "standard");
            byte[] captured = PolicyProof(standard1);
            Assert(Code(fx.PolicySet(standard1, captured)) == "ok", "first use");
            Assert(Code(fx.PolicySet(standard1, captured)) == "request_invalid", "the same change again (revision 1 is not 2)");
            Assert(Code(fx.PolicySet(PolicyJson(2, "careful"))) == "ok", "lowering");
            Assert(Code(fx.PolicySet(standard1, captured)) == "request_invalid", "replay of the old signature after the policy moved on");
            foreach (long rev in new long[] { 0, 2, 4, 9 }) Assert(Code(fx.PolicySet(PolicyJson(rev, "careful"))) == "request_invalid", $"revision {rev} while the current one is 2");
            Assert(fx.Core.Policy() is { Tier: "careful", Revision: 2 }, "unchanged");
        });
        Check("policy change: malformed or out-of-grammar policies (extra key, unknown tier, an override that is not \"prompt\", an unknown action, a non-object) are request_invalid", () =>
        {
            Fixture fx = new();
            string[] bad =
            [
                "{\"v\":1,\"rev\":1,\"tier\":\"standard\",\"overrides\":{},\"extra\":1}", "{\"v\":1,\"rev\":1,\"tier\":\"delegated\",\"overrides\":{}}", "{\"v\":1,\"rev\":1,\"tier\":\"Standard\",\"overrides\":{}}",
                "{\"v\":1,\"rev\":1,\"tier\":\"standard\",\"overrides\":{\"environment.stop\":\"allow\"}}", "{\"v\":1,\"rev\":1,\"tier\":\"standard\",\"overrides\":{\"environment.explode\":\"prompt\"}}",
                "{\"v\":1,\"rev\":1,\"tier\":\"standard\"}", "{\"v\":2,\"rev\":1,\"tier\":\"standard\",\"overrides\":{}}", "{\"v\":1,\"rev\":-1,\"tier\":\"standard\",\"overrides\":{}}",
                "{\"v\":1,\"rev\":\"1\",\"tier\":\"standard\",\"overrides\":{}}", "\"standard\"", "{}",
            ];
            foreach (string policy in bad) Assert(Code(fx.PolicySet(policy, HelloSign([1]))) == "request_invalid", policy);
            Assert(Code(fx.Call(PipeRole.Approver, "{\"v\":1,\"verb\":\"policy_set\"}")) == "request_invalid", "no policy");
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{PolicyJson(1, "careful")},\"presence\":5}}")) == "request_invalid", "presence not a string");
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{PolicyJson(1, "careful")},\"presence\":\"!!!\"}}")) == "request_invalid", "presence not base64");
            Assert(Code(fx.Call(PipeRole.Approver, $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{PolicyJson(1, "careful")},\"extra\":1}}")) == "request_invalid", "extra key in the request");
            Assert(fx.Core.Policy() is { Revision: 0 }, "unchanged");
        });
    }

    private static string NewFolder()
    {
        string folder = Path.Combine(Path.GetTempPath(), "AlberaPolicy-" + Guid.NewGuid().ToString("N"));
        DirectoryInfo directory = Directory.CreateDirectory(folder);
        // Only this user and SYSTEM, nothing inherited (the default temp ACL has more principals): what a trusted config folder looks like to ServicePathGuard.
        System.Security.AccessControl.DirectorySecurity security = new();
        security.SetAccessRuleProtection(true, false);
        foreach (System.Security.Principal.SecurityIdentifier sid in new[] { System.Security.Principal.WindowsIdentity.GetCurrent().User!, new System.Security.Principal.SecurityIdentifier("S-1-5-18") })
            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(sid, System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit, System.Security.AccessControl.PropagationFlags.None,
                System.Security.AccessControl.AccessControlType.Allow));
        directory.SetAccessControl(security);
        return folder;
    }

    /// <summary>Runs <paramref name="body"/> with a config path in a fresh temp folder, the current user standing in for the service (the file guard), and cleans up.</summary>
    private static void InFolder(Action<string> body)
    {
        string folder = NewFolder();
        try
        {
            ServicePathGuard.ServiceSidForTest = System.Security.Principal.WindowsIdentity.GetCurrent().User;
            body(Path.Combine(folder, "config.json"));
        }
        finally
        {
            ServicePathGuard.ServiceSidForTest = null;
            Directory.Delete(folder, recursive: true);
        }
    }

    private static void PolicyFileChecks()
    {
        Check("policy file: no file means careful and a normal start; the file name is policy.json next to the config", () =>
        {
            InFolder(config =>
            {
                PolicyStore? store = LoadPolicy(config, out string reason, out bool fromFile);
                Assert(store is not null && !fromFile && reason == "" && store.Current.Hash() == TierPolicy.Default.Hash(), "careful default");
                Assert(PolicyStore.PathFor(config) == Path.Combine(Path.GetDirectoryName(config)!, "policy.json"), "path");
            });
        });
        Check("policy file: a signed standard file (the signature over THIS Authority's message for the policy it authorizes) is loaded, and the core applies it from the first request; a later change that only added prompts is loaded too", () =>
        {
            InFolder(config =>
            {
                string signed = PolicyJson(1, "standard"), later = PolicyJson(4, "standard", "task.cancel");
                File.WriteAllText(PolicyStore.PathFor(config), SignedFile(later, signed, PolicyProof(signed)));
                PolicyStore? store = LoadPolicy(config, out _, out bool fromFile);
                Assert(store is not null && fromFile && store.Current is { Tier: "standard", Revision: 4 }, "loaded");
                Fixture fx = new(policy: store);
                Assert(StateOf(SubmitAction(fx, "environment.inspect", "a")) == "approved" && StateOf(SubmitAction(fx, "task.cancel", "b")) == "pending", "applied");
                File.WriteAllText(PolicyStore.PathFor(config), SignedFile(signed, signed, PolicyProof(signed)));
                Assert(LoadPolicy(config, out _, out _) is { } same && same.Current.Revision == 1, "the signed policy itself");
                File.WriteAllText(PolicyStore.PathFor(config), SignedFile(PolicyJson(7, "careful"), signed, PolicyProof(signed)));
                Assert(LoadPolicy(config, out _, out _) is { } careful && careful.Current.Tier == "careful", "careful with a stale signature is fine");
                File.WriteAllText(PolicyStore.PathFor(config), PolicyJson(7, "careful", "task.cancel"));
                Assert(LoadPolicy(config, out _, out _) is not null, "a careful-equivalent policy needs no signature");
            });
        });
        Check("policy file: a policy that skips a person without a valid signature for THIS Authority and THIS policy is refused (policy_unsigned): unsigned, signed over another hash, another revision, another kid, another audience, another key, a bigger policy than was signed, a signature newer than the policy", () =>
        {
            InFolder(config =>
            {
                string file = PolicyStore.PathFor(config);
                string standard = PolicyJson(1, "standard"), withPrompt = PolicyJson(2, "standard", "task.cancel"), signedWithPrompt = PolicyJson(1, "standard", "task.cancel");
                using RSA stranger = RSA.Create(2048);
                byte[] strangerSignature = stranger.SignData(PolicyChange.Message(PolicyOf(standard), "authority-key-2026-10", "albera-host-broker"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                (string Label, string Content)[] cases =
                [
                    ("unsigned standard", standard),
                    ("unsigned standard with an override", withPrompt),
                    ("signed over a different hash", SignedFile(standard, standard, PolicyProof(PolicyJson(1, "standard", "task.cancel")))),
                    ("signed over another revision of the same policy", SignedFile(standard, standard, PolicyProof(PolicyJson(2, "standard")))),
                    ("signed for another kid", SignedFile(standard, standard, PolicyProof(standard, kid: "authority-key-2026-11"))),
                    ("signed for another audience", SignedFile(standard, standard, PolicyProof(standard, audience: "albera-other-broker"))),
                    ("signed by another key", SignedFile(standard, standard, strangerSignature)),
                    ("a presence-domain signature over the hash", SignedFile(standard, standard, HelloSign(Encoding.UTF8.GetBytes("albera.presence.v1\0" + PolicyOf(standard).Hash())))),
                    ("a truncated signature", SignedFile(standard, standard, PolicyProof(standard)[..255])),
                    ("a policy that skips more than the signed one (the override was removed by hand)", SignedFile(standard, signedWithPrompt, PolicyProof(signedWithPrompt))),
                    ("a signature that is newer than the policy", SignedFile(standard, PolicyJson(2, "standard"), PolicyProof(PolicyJson(2, "standard")))),
                ];
                foreach ((string label, string content) in cases)
                {
                    File.WriteAllText(file, content);
                    PolicyStore? store = LoadPolicy(config, out string reason, out bool fromFile);
                    Assert(store is null && fromFile && reason == "policy_unsigned", $"{label}: {reason}");
                }
                File.WriteAllText(file, SignedFile(standard, standard, PolicyProof(standard)));
                Assert(LoadPolicy(config, out _, out _) is not null, "control: the right signature loads");
            });
        });
        Check("policy file: a malformed signature block is policy_invalid (not base64, no presence, a presence in the wrong place, an extra key)", () =>
        {
            InFolder(config =>
            {
                string file = PolicyStore.PathFor(config), standard = PolicyJson(1, "standard"), good = SignedFile(standard, standard, PolicyProof(standard));
                foreach (string content in new[] { good.Replace("\"presence\":\"", "\"presence\":\"!!"), good.Replace("\"presence\"", "\"proof\""), good.Replace("}}", ",\"extra\":1}}"), standard[..^1] + ",\"presence\":\"AAAA\"}",
                    standard[..^1] + ",\"authorized\":\"x\"}", good.Replace("\"authorized\":{\"v\":1,", "\"authorized\":{") })
                {
                    File.WriteAllText(file, content);
                    Assert(LoadPolicy(config, out string reason, out _) is null && reason == "policy_invalid", $"{reason}: {content[..Math.Min(content.Length, 90)]}");
                }
            });
        });
        Check("policy file: an invalid file refuses to start with a fixed reason word and is never read as a looser tier (shape, tier, override, BOM, size, untrusted, unreadable)", () =>
        {
            InFolder(config =>
            {
                string file = PolicyStore.PathFor(config);
                (string Label, byte[] Content, string Reason)[] cases =
                [
                    ("not json", Encoding.UTF8.GetBytes("standard"), "policy_invalid"),
                    ("missing field", Encoding.UTF8.GetBytes("{\"v\":1,\"tier\":\"standard\",\"overrides\":{}}"), "policy_invalid"),
                    ("missing overrides", Encoding.UTF8.GetBytes("{\"v\":1,\"rev\":1,\"tier\":\"standard\"}"), "policy_invalid"),
                    ("extra field", Encoding.UTF8.GetBytes("{\"v\":1,\"rev\":1,\"tier\":\"standard\",\"overrides\":{},\"grants\":{}}"), "policy_invalid"),
                    ("unknown tier", Encoding.UTF8.GetBytes("{\"v\":1,\"rev\":1,\"tier\":\"delegated\",\"overrides\":{}}"), "policy_invalid"),
                    ("an override that would remove a prompt", Encoding.UTF8.GetBytes("{\"v\":1,\"rev\":1,\"tier\":\"standard\",\"overrides\":{\"environment.stop\":\"allow\"}}"), "policy_invalid"),
                    ("duplicate tier key", Encoding.UTF8.GetBytes("{\"v\":1,\"rev\":1,\"tier\":\"careful\",\"tier\":\"standard\",\"overrides\":{}}"), "policy_invalid"),
                    ("utf-8 bom", [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(PolicyJson(1, "careful"))], "policy_invalid"),
                    ("empty", [], "policy_invalid"),
                    ("too large", Encoding.UTF8.GetBytes(PolicyJson(1, "careful") + new string(' ', 2100)), "policy_too_large"),
                ];
                foreach ((string label, byte[] content, string expected) in cases)
                {
                    File.WriteAllBytes(file, content);
                    PolicyStore? store = LoadPolicy(config, out string reason, out bool fromFile);
                    Assert(store is null && fromFile && reason == expected, $"{label}: {reason}");
                }
                File.Delete(file);
                Directory.CreateDirectory(file); // a folder where the file should be: unreadable, not "no file"
                Assert(LoadPolicy(config, out string folderReason, out _) is null && folderReason == "policy_unreadable", $"a folder: {folderReason}");
                Directory.Delete(file);
                string signed = PolicyJson(1, "standard");
                File.WriteAllText(file, SignedFile(signed, signed, PolicyProof(signed)));
                ServicePathGuard.ServiceSidForTest = null; // no per-service SID in this token: the production rule trusts nothing
                Assert(LoadPolicy(config, out string untrusted, out _) is null && untrusted == "policy_untrusted", $"untrusted: {untrusted}");
            });
        });
        Check("policy file: a change is written atomically (compact file with the authorizing signature, read back as the same policy, no temp file left) and survives a restart; adding a prompt keeps the signature; lowering drops it", () =>
        {
            InFolder(config =>
            {
                PolicyStore store = LoadPolicy(config, out _, out _)!;
                Fixture fx = new(policy: store);
                string target = PolicyJson(1, "standard", "task.cancel");
                byte[] proof = PolicyProof(target);
                Assert(Code(fx.PolicySet(target, proof)) == "ok", "loosen");
                string file = PolicyStore.PathFor(config);
                Assert(File.ReadAllText(file) == SignedFile(target, target, proof), $"file content {File.ReadAllText(file)}");
                Assert(Directory.GetFiles(Path.GetDirectoryName(config)!, "*.tmp").Length == 0, "no temp file left");
                PolicyStore? restarted = LoadPolicy(config, out _, out bool fromFile);
                Assert(restarted is not null && fromFile && restarted.Current.Hash() == PolicyOf(target).Hash(), "a restart reads the same policy");
                string tighter = PolicyJson(2, "standard", "environment.stop", "task.cancel");
                Assert(Code(fx.PolicySet(tighter)) == "ok" && File.ReadAllText(file) == SignedFile(tighter, target, proof), "adding a prompt needs no signature and keeps the one that authorized the ceiling");
                Assert(LoadPolicy(config, out _, out _)!.Current.Revision == 2, "and loads");
                Assert(Code(fx.PolicySet(PolicyJson(3, "careful"))) == "ok" && File.ReadAllText(file) == PolicyJson(3, "careful"), "lowering is persisted without a signature block");
                Assert(LoadPolicy(config, out _, out _)!.Current is { Tier: "careful", Revision: 3 }, "and survives a restart");
                // Rollback by someone who can already write the trusted folder is out of scope: the older signed file is accepted if its signature is valid, and only then.
                File.WriteAllText(file, SignedFile(target, target, proof));
                Assert(LoadPolicy(config, out _, out _)!.Current.Revision == 1, "an older file with a valid signature loads (out of scope: only a trusted writer can put it there)");
                File.WriteAllText(file, target);
                Assert(LoadPolicy(config, out string rollback, out _) is null && rollback == "policy_unsigned", "the same file without its signature does not");
            });
        });
        Check("config folder: the folder must not let anyone but the service, SYSTEM and Administrators create files, and that is decided at the config load (config_folder_untrusted) BEFORE any policy.json is looked at", () =>
        {
            InFolder(config =>
            {
                File.WriteAllText(config, ConfigJson());
                Assert(AuthorityConfig.TryLoad(config, strictSeparation: false, out string fine) is not null, $"control: a protected folder loads ({fine})");
                string folder = Path.GetDirectoryName(config)!;
                Assert(ServicePathGuard.IsTrustedConfigFolder(folder), "protected folder");
                // A low-privilege user squats policy.json in a folder that lets them create files; the file's own ACL is theirs, so on its own it would block every start with exit 79.
                DirectoryInfo directory = new(folder);
                System.Security.AccessControl.DirectorySecurity security = directory.GetAccessControl();
                security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(UsersSid, System.Security.AccessControl.FileSystemRights.CreateFiles,
                    System.Security.AccessControl.InheritanceFlags.None, System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
                directory.SetAccessControl(security);
                File.WriteAllText(PolicyStore.PathFor(config), "squatted");
                Assert(!ServicePathGuard.IsTrustedConfigFolder(folder), "a folder where Users may create files");
                Assert(AuthorityConfig.TryLoad(config, strictSeparation: false, out string reason) is null && reason == "config_folder_untrusted", $"config load: {reason}");
                // Other ways to create, replace or take over: append (create sub-folder), delete-child, write-DAC, write-owner, generic write, full control, even inherit-only.
                foreach (System.Security.AccessControl.FileSystemRights right in new[] { System.Security.AccessControl.FileSystemRights.AppendData, System.Security.AccessControl.FileSystemRights.DeleteSubdirectoriesAndFiles,
                    System.Security.AccessControl.FileSystemRights.ChangePermissions, System.Security.AccessControl.FileSystemRights.TakeOwnership, System.Security.AccessControl.FileSystemRights.FullControl })
                {
                    byte[] descriptor = Descriptor(AdminsSid, [SystemSid, AdminsSid], allowMask: (int)right);
                    Assert(ServicePathGuard.IsTrustedDescriptor(descriptor, SystemSid), $"control: {right} for SYSTEM and Administrators only");
                    Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(AdminsSid, [SystemSid, AdminsSid, UsersSid], allowMask: (int)right), SystemSid), $"{right} for Users");
                }
            });
        });
        Check("policy file: a write that fails changes nothing (authority_unavailable, policy in memory unchanged, no temp file left), and a refused change never writes", () =>
        {
            InFolder(config =>
            {
                PolicyStore store = LoadPolicy(config, out _, out _)!;
                Fixture fx = new(policy: store);
                Assert(Code(fx.PolicySet(PolicyJson(1, "standard"))) == "presence_mismatch" && !File.Exists(PolicyStore.PathFor(config)), "a refused change writes no file");
                Directory.CreateDirectory(PolicyStore.PathFor(config)); // the move over policy.json cannot succeed
                string target = PolicyJson(1, "standard");
                Assert(Code(fx.PolicySet(target, PolicyProof(target))) == "authority_unavailable", "write failure");
                Assert(fx.Core.Policy() is { Tier: "careful", Revision: 0 } && StateOf(SubmitAction(fx, "environment.inspect")) == "pending", "memory unchanged");
                Assert(Directory.GetFiles(Path.GetDirectoryName(config)!, "*.tmp").Length == 0, "no temp file left");
                Directory.Delete(PolicyStore.PathFor(config));
                Assert(Code(fx.PolicySet(target, PolicyProof(target))) == "ok", "the same change works once the obstacle is gone");
            });
        });
        Check("policy file: a new file that would not pass the start-up trust check is not installed (the change is refused)", () =>
        {
            InFolder(config =>
            {
                PolicyStore store = LoadPolicy(config, out _, out _)!;
                Fixture fx = new(policy: store);
                ServicePathGuard.ServiceSidForTest = new System.Security.Principal.SecurityIdentifier("S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555"); // not the owner of what the process creates
                string target = PolicyJson(1, "standard");
                Assert(Code(fx.PolicySet(target, PolicyProof(target))) == "authority_unavailable", "untrusted new file");
                Assert(!File.Exists(PolicyStore.PathFor(config)) && fx.Core.Policy() is { Revision: 0 }, "nothing installed, nothing changed");
                Assert(Directory.GetFiles(Path.GetDirectoryName(config)!, "*.tmp").Length == 0, "no temp file left");
            });
        });
        Check("policy file: the exit code and the reason words are fixed (79) and the file name is the documented one", () =>
        {
            Assert(ExitCodes.PolicyInvalid == 79 && PolicyStore.FileName == "policy.json", "constants");
            string[] reasons = [PolicyStore.Reason.Invalid, PolicyStore.Reason.Unreadable, PolicyStore.Reason.TooLarge, PolicyStore.Reason.Untrusted];
            Assert(reasons.All(r => r.StartsWith("policy_", StringComparison.Ordinal)), "reason words");
        });
    }
}
