using System.Text;
using Albera.Approver;
using Albera.BrokerContract;

// `policy` and `policy set` (PolicyCommand.cs, issue #115 step 3): the command grammar, what is shown, when Hello is asked (by effect), what is signed (the message over the hash this
// app computed itself) and what is sent. Canned channel and recording signer; no Authority, no Hello, no key.
internal static partial class Harness
{
    private static string PolicyJson(long rev, string tier, params string[] prompts) =>
        $"{{\"v\":1,\"rev\":{rev},\"tier\":\"{tier}\",\"overrides\":{{{string.Join(',', prompts.Select(a => $"\"{a}\":\"prompt\""))}}}}}";

    private static TierPolicy PolicyOf(string json) => TierPolicy.TryParse(Encoding.UTF8.GetBytes(json))!;

    private static string PolicyReply(string policyJson, string? reportedHash = null) => $"{{\"ok\":true,\"policy\":{policyJson},\"policyVersion\":\"{reportedHash ?? PolicyOf(policyJson).Hash()}\"}}";

    /// <summary>A channel that answers `policy` with the policy in force and `policy_set` with <paramref name="setReply"/> (default: success naming the hash of the policy it was sent).</summary>
    private static FakeChannel PolicyChannel(string inForce, Func<string, string>? setReply = null) => new(request =>
        request.Contains("\"verb\":\"policy_set\"") ? (setReply ?? (r => $"{{\"ok\":true,\"policyVersion\":\"{SentPolicy(r).Hash()}\"}}"))(request) : PolicyReply(inForce));

    private static TierPolicy SentPolicy(string request)
    {
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(request);
        return PolicyOf(document.RootElement.GetProperty("policy").GetRawText());
    }

    private static int RunPolicy(FakeChannel channel, IPresenceSigner signer, Func<PolicyCommand, Task<int>> body, out string stdout, out string stderr, string stdin = "yes\n", bool interactive = true)
    {
        StringWriter output = new(), errors = new();
        int exit = body(new PolicyCommand(channel, signer, output, errors, new StringReader(stdin), interactive)).GetAwaiter().GetResult();
        stdout = output.ToString();
        stderr = errors.ToString();
        return exit;
    }

    private static RecordingSigner SigningPolicy(string policyJson) => new(SignResult.Signed(Sign(PolicyChange.Message(PolicyOf(policyJson)))));

    private static bool SentSetRequest(FakeChannel channel) => channel.Requests.Any(r => r.Contains("\"verb\":\"policy_set\""));

    private static void PolicyChecks()
    {
        Check("CommandLine: policy [show] and policy set <tier> [--prompt <action>]... are commands; an unknown tier or action, a dangling --prompt and any other word are not", () =>
        {
            Assert(CommandLine.TryParse(["policy"]) is { Verb: "policy", Option: "show" } && CommandLine.TryParse(["policy", "show"]) is { Verb: "policy", Option: "show" }, "show");
            Assert(CommandLine.TryParse(["policy", "set", "standard"]) is { Verb: "policy", Option: "set", Tier: "standard", Prompts: { Count: 0 } }, "set standard");
            Assert(CommandLine.TryParse(["policy", "set", "careful", "--prompt", "task.cancel", "--prompt", "environment.stop", "--prompt", "task.cancel"]) is { Tier: "careful", Prompts: ["environment.stop", "task.cancel"] }, "set with prompts, sorted and distinct");
            string[][] rejected = [["policy", "set"], ["policy", "set", "delegated"], ["policy", "set", "Standard"], ["policy", "set", "standard", "--prompt"], ["policy", "set", "standard", "--prompt", "environment.explode"],
                ["policy", "set", "standard", "task.cancel"], ["policy", "set", "standard", "--prompt", "task.cancel", "extra"], ["policy", "set", "standard", "--allow", "task.cancel"], ["policy", "show", "x"],
                ["policy", "set", "standard\",\"x"], ["policy", "set", "standard", "--prompt", "task.cancel\":\"allow"], ["policy", "x"], ["policy", "set", "standard", "--yes"]];
            foreach (string[] bad in rejected) Assert(CommandLine.TryParse(bad) is null, string.Join(' ', bad));
        });
        Check("policy show: prints the tier, the revision, who needs no person and the hash, and sends only the read request", () =>
        {
            FakeChannel channel = PolicyChannel(PolicyJson(4, "standard", "task.cancel"));
            int exit = RunPolicy(channel, Signing(), c => c.ShowAsync(), out string stdout, out string stderr);
            Assert(exit == 0 && stderr == "", $"{exit} {stderr}");
            Assert(stdout.Contains("revision 4") && stdout.Contains("tier: standard") && stdout.Contains("needs no person: environment.inspect, environment.stop, workspace.inspect") && stdout.Contains("always asks you: task.cancel")
                && stdout.Contains(PolicyOf(PolicyJson(4, "standard", "task.cancel")).Hash()), stdout);
            Assert(channel.Requests.SequenceEqual(["{\"v\":1,\"verb\":\"policy\"}"]), "one read request");
            Assert(RunPolicy(PolicyChannel(PolicyJson(0, "careful")), Signing(), c => c.ShowAsync(), out string careful, out _) == 0 && careful.Contains("nothing; every action needs a person"), careful);
        });
        Check("policy show / set: a policy reply that is not exactly the documented shape, or whose hash differs from the policy it carries, is refused (68) and nothing is decided", () =>
        {
            string good = PolicyJson(1, "standard");
            string[] replies =
            [
                PolicyReply(good, "sha256:" + new string('0', 64)), PolicyReply(good.Replace("\"overrides\":{}", "\"overrides\":{},\"extra\":1"), "sha256:" + new string('1', 64)),
                PolicyReply(good.Replace("standard", "delegated"), "sha256:" + new string('2', 64)),
                $"{{\"ok\":true,\"policy\":{good}}}", $"{{\"ok\":true,\"policy\":\"x\",\"policyVersion\":\"{PolicyOf(good).Hash()}\"}}", "{\"ok\":true}", "not json",
            ];
            foreach (string reply in replies)
            {
                FakeChannel channel = new(_ => reply);
                RecordingSigner signer = Signing();
                Assert(RunPolicy(channel, signer, c => c.ShowAsync(), out _, out string err) == 68 && err.Contains("invalid_response"), $"show: {reply}");
                Assert(RunPolicy(channel, signer, c => c.SetAsync("careful", []), out _, out _) == 68 && !SentSetRequest(channel) && signer.Messages.Count == 0, $"set: {reply}");
            }
        });
        Check("policy set (careful to standard): shows the change, needs a typed yes and ONE Hello signature over albera.policy.v1 + the hash of the complete new policy, then sends the policy with that signature", () =>
        {
            string current = PolicyJson(0, "careful"), next = PolicyJson(1, "standard", "task.cancel");
            FakeChannel channel = PolicyChannel(current);
            RecordingSigner signer = SigningPolicy(next);
            int exit = RunPolicy(channel, signer, c => c.SetAsync("standard", ["task.cancel"]), out string stdout, out string stderr);
            Assert(exit == 0 && stderr == "" && stdout.EndsWith("result: policy applied (revision 1)\n"), $"{exit} {stderr}\n{stdout}");
            Assert(stdout.Contains("will no longer ask you: environment.inspect, environment.stop, workspace.inspect") && stdout.Contains("will start asking you: (none)") && stdout.Contains("windows hello: needed")
                && stdout.Contains("Type yes to apply exactly this change"), stdout);
            Assert(signer.Messages.Count == 1 && signer.Messages[0].SequenceEqual(Encoding.UTF8.GetBytes($"albera.policy.v1\0{PolicyOf(next).Hash()}")), "one signature over the policy message of the hash this app computed");
            Assert(channel.Requests.Count == 2 && SentPolicy(channel.Requests[1]).Hash() == PolicyOf(next).Hash(), "the complete new policy was sent");
            Assert(channel.Requests[1].Contains($"\"presence\":\"{Convert.ToBase64String(Sign(PolicyChange.Message(PolicyOf(next))))}\""), "with the signature");
        });
        Check("policy set: a change that lets an action skip a person needs a console and a typed yes BEFORE anything is signed or sent (not interactive: 65; no / empty: 65)", () =>
        {
            string current = PolicyJson(0, "careful");
            FakeChannel channel = PolicyChannel(current);
            RecordingSigner signer = SigningPolicy(PolicyJson(1, "standard"));
            Assert(RunPolicy(channel, signer, c => c.SetAsync("standard", []), out _, out string err, interactive: false) == 65 && err.Contains("not_interactive"), "not interactive");
            foreach (string answer in new[] { "no\n", "\n", "y\n", "" })
            {
                Assert(RunPolicy(channel, signer, c => c.SetAsync("standard", []), out _, out string refused, stdin: answer) == 65 && refused.Contains("not_confirmed"), $"answer '{answer.Trim()}'");
            }
            Assert(signer.Messages.Count == 0 && !SentSetRequest(channel), "nothing was signed and no change was requested");
        });
        Check("policy set: no usable Hello key or no proof from Hello sends nothing (69)", () =>
        {
            foreach (SignResult result in new[] { SignResult.Unavailable, SignResult.NotReady })
            {
                FakeChannel channel = PolicyChannel(PolicyJson(0, "careful"));
                Assert(RunPolicy(channel, new RecordingSigner(result), c => c.SetAsync("standard", []), out _, out string err) == 69, $"{result.Status}: {err}");
                Assert(!SentSetRequest(channel), "nothing sent");
            }
        });
        Check("policy set: lowering the tier or adding a prompt asks for no Hello, no typed yes and no console, and sends no signature", () =>
        {
            (string Current, string Tier, string[] Prompts)[] cases =
            [
                (PolicyJson(3, "standard"), "careful", []),                                           // standard to careful
                (PolicyJson(3, "standard"), "standard", ["task.cancel"]),                             // one more prompt
                (PolicyJson(3, "standard", "task.cancel"), "careful", ["task.cancel", "environment.stop"]),
            ];
            foreach ((string current, string tier, string[] prompts) in cases)
            {
                FakeChannel channel = PolicyChannel(current);
                RecordingSigner signer = Signing();
                int exit = RunPolicy(channel, signer, c => c.SetAsync(tier, prompts), out string stdout, out string err, stdin: "", interactive: false);
                Assert(exit == 0 && err == "" && stdout.Contains("windows hello: not needed"), $"{tier}: {exit} {err}");
                Assert(signer.Messages.Count == 0 && channel.Requests.Count == 2 && !channel.Requests[1].Contains("presence"), $"{tier}: no signature");
                Assert(SentPolicy(channel.Requests[1]).Revision == PolicyOf(current).Revision + 1, $"{tier}: revision + 1");
            }
        });
        Check("policy set: the rule is by effect: removing a prompt (same tier) needs Hello, and so does a different set of prompts that skips an action that was asked before", () =>
        {
            foreach ((string current, string[] prompts) in new[] { (PolicyJson(2, "standard", "task.cancel"), Array.Empty<string>()), (PolicyJson(2, "standard", "task.cancel"), new[] { "environment.stop" }) })
            {
                FakeChannel channel = PolicyChannel(current);
                RecordingSigner signer = new(SignResult.Signed(Sign([1])));
                Assert(RunPolicy(channel, signer, c => c.SetAsync("standard", prompts), out string stdout, out _) == 0 && signer.Messages.Count == 1 && stdout.Contains("windows hello: needed"), string.Join(',', prompts));
            }
        });
        Check("policy set: asking for the policy that is already in force sends nothing", () =>
        {
            FakeChannel channel = PolicyChannel(PolicyJson(2, "standard", "task.cancel"));
            RecordingSigner signer = Signing();
            Assert(RunPolicy(channel, signer, c => c.SetAsync("standard", ["task.cancel"]), out string stdout, out _) == 0 && stdout.Contains("no change") && !SentSetRequest(channel) && signer.Messages.Count == 0, stdout);
        });
        Check("policy set: the Authority's refusals are exit 67 with its code (a wrong revision is request_invalid, a bad signature presence_mismatch); a success naming another hash is 68", () =>
        {
            foreach (string code in new[] { "request_invalid", "presence_mismatch", "presence_unavailable", "authority_unavailable" })
            {
                FakeChannel channel = PolicyChannel(PolicyJson(0, "careful"), _ => $"{{\"ok\":false,\"code\":\"{code}\"}}");
                Assert(RunPolicy(channel, new RecordingSigner(SignResult.Signed(Sign([1]))), c => c.SetAsync("standard", []), out _, out string err) == 67 && err.Contains($"authority:{code}"), code);
            }
            FakeChannel wrongHash = PolicyChannel(PolicyJson(0, "careful"), _ => "{\"ok\":true,\"policyVersion\":\"sha256:" + new string('0', 64) + "\"}");
            Assert(RunPolicy(wrongHash, new RecordingSigner(SignResult.Signed(Sign([1]))), c => c.SetAsync("standard", []), out _, out string wrong) == 68 && wrong.Contains("invalid_response"), "wrong hash");
        });
        Check("policy set: only the fixed words of this app ever go into the request (the tier and the actions come from the contract's lists, never from the Authority's reply or free text)", () =>
        {
            FakeChannel channel = PolicyChannel(PolicyJson(0, "careful"));
            RunPolicy(channel, SigningPolicy(PolicyJson(1, "standard", "environment.stop")), c => c.SetAsync("standard", ["environment.stop"]), out _, out _);
            string request = channel.Requests[1];
            Assert(request.StartsWith("{\"v\":1,\"verb\":\"policy_set\",\"policy\":{\"v\":1,\"rev\":1,\"tier\":\"standard\",\"overrides\":{\"environment.stop\":\"prompt\"}},\"presence\":\"", StringComparison.Ordinal) && request.Length < 2048, request);
        });
    }
}
