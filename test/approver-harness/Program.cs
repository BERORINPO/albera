using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.Approver;
using Albera.BrokerContract;

// Runs every unit check in-process and prints one JSON document: { checks: [{ name, ok, detail }] }.
// The Node test (test/runtime-approver-unit.test.mjs) turns each check into a subtest.
internal static class Harness
{
    private const long Now = 1_800_000_000;
    private const string Id1 = "3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b", Id2 = "9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", Challenge = "_-7dzLuqmYh3ZlVEMyIRAA";
    private const string Dto = "{\"action\":\"environment.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{\"vmName\":\"alpha\",\"cpu\":2,\"fast\":true}}";
    private static readonly List<object> Results = [];
    private static readonly RSA Hello = RSA.Create(2048);

    private sealed class CheckFailed(string message) : Exception(message);
    private static void Assert(bool condition, string detail) { if (!condition) throw new CheckFailed(detail); }
    private static void Check(string name, Action body)
    {
        try { body(); Results.Add(new { name, ok = true, detail = "" }); }
        catch (Exception ex) { Results.Add(new { name, ok = false, detail = $"{ex.GetType().Name}: {ex.Message}" }); }
    }

    // ---- fixtures ------------------------------------------------------------------------------------------------------------------------
    private sealed class FakeChannel(Func<string, string> respond) : IApproverChannel
    {
        public readonly List<string> Requests = [];
        public Task<string> CallAsync(string requestJson) { Requests.Add(requestJson); return Task.FromResult(respond(requestJson)); }
        public int Decides => Requests.Count(r => r.Contains("\"verb\":\"decide\""));
    }

    private sealed class RecordingSigner(SignResult result) : IPresenceSigner
    {
        public readonly List<byte[]> Messages = [];
        public SignResult Sign(byte[] message) { Messages.Add(message); return result; }
    }

    private sealed class Run(FakeChannel channel, IPresenceSigner signer, string stdin = "")
    {
        public readonly StringWriter Out = new(), Err = new();
        public int Exit;
        public ApproverCommands Commands => new(channel, signer, Out, Err, new StringReader(stdin), () => DateTimeOffset.FromUnixTimeSeconds(Now));
    }

    private static string DigestOf(string dto = Dto) => ActionDigest.Compute("broker.operation", StrictJson.Parse(Encoding.UTF8.GetBytes(dto), 3));

    private static string Entry(string id = Id1, string dto = Dto, string? digest = null, string seq = "1", string extra = "", string purpose = "broker.operation") =>
        $"{{\"seq\":{seq},\"approvalId\":\"{id}\",\"purpose\":\"{purpose}\",\"operationId\":\"op-1\",\"actionDigest\":\"{digest ?? DigestOf()}\",\"challenge\":\"{Challenge}\",\"expiresAt\":{Now + 117},\"action\":{dto}{extra}}}";

    private static string Page(string[] entries, bool more = false, long last = 1) => $"{{\"ok\":true,\"pending\":[{string.Join(',', entries)}],\"more\":{(more ? "true" : "false")},\"lastSeq\":{last}}}";

    private static FakeChannel Listing(params string[] entries) => new(request => request.Contains("\"verb\":\"list\"") ? Page(entries) : "{\"ok\":true,\"state\":\"approved\"}");

    private static byte[] Sign(byte[] message) => Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    private static RecordingSigner Signing() => new(SignResult.Signed(Sign(PresenceMessage.Build(Id1, DigestOf(), Challenge))));

    private static ListedRequest Parsed(string entry)
    {
        using JsonDocument page = JsonDocument.Parse(Page([entry]));
        return PendingParser.TryParsePage(page.RootElement)!.Items.Single();
    }

    private static int RunApprove(Run run, string id = Id1, bool yes = true) { run.Exit = run.Commands.ApproveAsync(id, yes).GetAwaiter().GetResult(); return run.Exit; }

    private static string Printable(string text) => new([.. text.Where(c => c is '\n' or (>= ' ' and <= '~'))]);

    // ---- checks --------------------------------------------------------------------------------------------------------------------------
    private static void SafeTextChecks()
    {
        Check("SafeText: printable ASCII passes, the quote and the backslash are escaped", () =>
        {
            Assert(SafeText.Quote("alpha-1_x") == "\"alpha-1_x\"", SafeText.Quote("alpha-1_x"));
            Assert(SafeText.Quote("a\"b\\c") == "\"a\\\"b\\\\c\"", SafeText.Quote("a\"b\\c"));
        });
        Check("SafeText: control, bidi, zero-width, separator characters become \\u{HEX}", () =>
        {
            string shown = SafeText.Quote("a\nb\0c\u202Ed\u200Be\u2028f\u007Fg\u0085h", out int escaped);
            Assert(shown == "\"a\\u{A}b\\u{0}c\\u{202E}d\\u{200B}e\\u{2028}f\\u{7F}g\\u{85}h\"", shown);
            Assert(escaped == 7, $"escaped {escaped}");
        });
        Check("SafeText: non-ASCII letters, look-alikes, astral characters and lone surrogates are escaped by code point", () =>
        {
            Assert(SafeText.Quote("caf\u00E9") == "\"caf\\u{E9}\"", SafeText.Quote("caf\u00E9"));
            Assert(SafeText.Quote("p\u0430ypal") == "\"p\\u{430}ypal\"", "Cyrillic a is visible");
            Assert(SafeText.Quote("\U0001F600") == "\"\\u{1F600}\"", SafeText.Quote("\U0001F600"));
            Assert(SafeText.Quote("\uD800x") == "\"\\u{D800}x\"", SafeText.Quote("\uD800x"));
        });
        Check("SafeText: NFC and NFD forms show differently, and a literal \\u{41} text cannot pass for an escape", () =>
        {
            Assert(SafeText.Quote("\u00E9") != SafeText.Quote("e\u0301"), "NFC vs NFD");
            Assert(SafeText.Quote("\\u{41}") == "\"\\\\u{41}\"", SafeText.Quote("\\u{41}"));
        });
    }

    private static void RenderChecks()
    {
        Check("Renderer: shows every digest input (purpose, action, projectId, computerId, each arg), operationId, expiry and the digest", () =>
        {
            string text = Renderer.Render(Parsed(Entry()), DateTimeOffset.FromUnixTimeSeconds(Now));
            foreach (string line in new[] { "request " + Id1, "purpose: \"broker.operation\"", "action: \"environment.start\"", "projectId: \"proj-alpha\"", "computerId: \"pc-01\"", "args: 3",
                "\"cpu\" = 2 (int)", "\"fast\" = true (bool)", "\"vmName\" = \"alpha\" (string)", "operationId: \"op-1\"", $"expiresAt: {Now + 117} ({DateTimeOffset.FromUnixTimeSeconds(Now + 117):yyyy-MM-dd'T'HH:mm:ss'Z'}, in 117 s)", "actionDigest: " + DigestOf(), "digest check: OK" })
                Assert(text.Contains(line), $"missing '{line}' in:\n{text}");
            Assert(text.IndexOf("\"cpu\" =", StringComparison.Ordinal) < text.IndexOf("\"fast\" =", StringComparison.Ordinal) && text.IndexOf("\"fast\" =", StringComparison.Ordinal) < text.IndexOf("\"vmName\" =", StringComparison.Ordinal), "args are sorted");
        });
        Check("Renderer: the output is printable ASCII even when the data holds control, bidi and non-ASCII characters (built past the contract's validation)", () =>
        {
            ValidatedAction hostile = new("environment.start", "proj-alpha", "pc-01", new Dictionary<string, object> { ["vmName"] = "al\u202Epha\nINJECT: approved\0\u00E9" });
            PendingView view = new(1, Id1, "broker.operation", "op-1", DigestOf(), Challenge, Now + 10, hostile, DigestOf());
            string text = Renderer.Render(new ListedRequest(Id1, view, null), DateTimeOffset.FromUnixTimeSeconds(Now));
            Assert(text == Printable(text), "only printable ASCII and newlines");
            Assert(!text.Contains("\nINJECT"), "a newline inside a value cannot start a fake line");
            Assert(text.Contains("\\u{202E}") && text.Contains("\\u{A}") && text.Contains("\\u{E9}") && text.Contains("note: 4 character(s)"), text);
        });
        Check("Renderer: a digest mismatch is shown with both digests and DO NOT APPROVE", () =>
        {
            string text = Renderer.Render(Parsed(Entry(digest: "sha256:" + new string('0', 64))), DateTimeOffset.FromUnixTimeSeconds(Now));
            Assert(text.Contains("digest check: MISMATCH") && text.Contains(DigestOf()) && text.Contains("DO NOT APPROVE") && text.Contains("actionDigest: sha256:" + new string('0', 64)), text);
        });
        Check("Renderer: an unreadable entry says REFUSED and shows none of its fields; an expired request says expired", () =>
        {
            string bad = Renderer.Render(Parsed(Entry(extra: ",\"surprise\":1")), DateTimeOffset.FromUnixTimeSeconds(Now));
            Assert(bad.Contains("REFUSED: invalid_entry") && !bad.Contains("proj-alpha"), bad);
            Assert(Renderer.Render(Parsed(Entry()), DateTimeOffset.FromUnixTimeSeconds(Now + 500)).Contains("expired"), "expired");
        });
    }

    private static void ParserChecks()
    {
        Check("Parser: the digest is recomputed with the contract's ActionDigest and equals the Authority's for an honest entry", () =>
        {
            PendingView view = Parsed(Entry()).View!;
            Assert(view.DigestMatches && view.RecomputedDigest == DigestOf() && view.Challenge == Challenge && view.ApprovalId == Id1, "view");
        });
        Check("Parser: a changed field with the old digest is a mismatch (the Authority's digest is never trusted)", () =>
        {
            foreach (string tampered in new[] { Dto.Replace("alpha\"", "evil\""), Dto.Replace("\"cpu\":2", "\"cpu\":3"), Dto.Replace("proj-alpha", "proj-beta"), Dto.Replace("pc-01", "pc-02"), Dto.Replace("environment.start", "environment.destroy"), Dto.Replace("true", "false") })
                Assert(Parsed(Entry(dto: tampered)).View is { DigestMatches: false }, tampered);
            Assert(Parsed(Entry(purpose: "guest.command", dto: Dto.Replace("environment.start", "task.start"))).View is { DigestMatches: false }, "purpose is part of the digest");
        });
        Check("Parser: entries the contract or the shape rejects are invalid_entry with no view (extra / missing key, null, array, fraction, duplicate key, bidi, bad id, bad digest)", () =>
        {
            string[] bad = [Entry(extra: ",\"x\":1"), Entry().Replace("\"seq\":1,", ""), Entry(dto: Dto.Replace("true", "null")), Entry(dto: Dto.Replace("true", "[1]")), Entry(dto: Dto.Replace("\"cpu\":2", "\"cpu\":2.5")),
                Entry(dto: Dto.Replace("\"cpu\":2", "\"cpu\":2,\"cpu\":3")), Entry(dto: Dto.Replace("alpha\"", "al\\u202Epha\"")), Entry(dto: Dto.Replace("alpha\"", "a\\nb\"")), Entry(id: "not-a-uuid"),
                Entry(digest: "sha256:ABC"), Entry(purpose: "other.purpose"), Entry().Replace("\"op-1\"", "\"bad id\""), Entry().Replace(Challenge, "short"), Entry(dto: Dto.Replace("environment.start", "evil.action"))];
            foreach (string entry in bad) Assert(Parsed(entry).View is null && Parsed(entry).Problem == "invalid_entry", entry);
            Assert(Parsed(Entry(id: Id2, extra: ",\"x\":1")).ApprovalId == Id2 && Parsed(Entry(id: "not-a-uuid")).ApprovalId is null, "the id is kept only when well formed");
        });
        Check("Parser: a page that is not {pending[], more, lastSeq} is rejected", () =>
        {
            foreach (string reply in new[] { "{\"ok\":true,\"pending\":{},\"more\":false,\"lastSeq\":0}", "{\"ok\":true,\"pending\":[],\"more\":\"no\",\"lastSeq\":0}", "{\"ok\":true,\"pending\":[],\"more\":false}", "{\"ok\":true,\"pending\":[],\"more\":false,\"lastSeq\":-1}", "[]" })
            {
                using JsonDocument document = JsonDocument.Parse(reply);
                Assert(PendingParser.TryParsePage(document.RootElement) is null, reply);
            }
        });
        Check("CommandLine: only list, approve <uuid> [--yes] and deny <uuid>", () =>
        {
            Assert(CommandLine.TryParse(["list"]) is { Verb: "list" } && CommandLine.TryParse(["deny", Id1]) is { Verb: "deny", ApprovalId: Id1 } && CommandLine.TryParse(["approve", Id1]) is { AssumeYes: false }
                && CommandLine.TryParse(["approve", Id1, "--yes"]) is { AssumeYes: true }, "accepted forms");
            string[][] rejected = [[], ["list", "x"], ["approve"], ["approve", "x"], ["approve", Id1, "--no"], ["deny", Id1, "--yes"], ["approve", Id1.ToUpperInvariant()], ["decide", Id1], ["approve", Id1 + "\",\"x"]];
            foreach (string[] bad in rejected) Assert(CommandLine.TryParse(bad) is null, string.Join(' ', bad));
        });
    }

    private static void PresenceChecks()
    {
        Check("PresenceMessage: exactly \"albera.presence.v1\" 0x00 approvalId 0x00 actionDigest 0x00 challenge (UTF-8)", () =>
        {
            byte[] message = PresenceMessage.Build(Id1, DigestOf(), Challenge);
            byte[] expected = [.. Encoding.UTF8.GetBytes("albera.presence.v1"), 0, .. Encoding.UTF8.GetBytes(Id1), 0, .. Encoding.UTF8.GetBytes(DigestOf()), 0, .. Encoding.UTF8.GetBytes(Challenge)];
            Assert(message.SequenceEqual(expected) && message.Count(b => b == 0) == 3, Convert.ToHexString(message));
            Assert(Convert.ToHexString(PresenceMessage.Build("a", "sha256:b", "c")) == "616C626572612E70726573656E63652E763100" + "6100" + "7368613235363A6200" + "63", "fixed bytes");
        });
        Check("FakePresenceSigner: RSA PKCS#1 v1.5 / SHA-256, 256 bytes, verifies with the key; 'unavailable' signs nothing", () =>
        {
            FakePresenceSigner signer = new(Hello, unavailable: false);
            byte[] message = PresenceMessage.Build(Id1, DigestOf(), Challenge);
            SignResult result = signer.Sign(message);
            Assert(result.Status == SignStatus.Signed && result.Signature!.Length == 256 && Hello.VerifyData(message, result.Signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "signature");
            Assert(new FakePresenceSigner(Hello, unavailable: true).Sign(message).Status == SignStatus.Unavailable && new NotBuiltPresenceSigner().Sign(message).Status == SignStatus.NotBuilt, "statuses");
        });
    }

    private static void ApproveChecks()
    {
        Check("approve: lists, shows the request, signs the presence message over the RECOMPUTED digest and sends decide approve with the signature", () =>
        {
            FakeChannel channel = Listing(Entry());
            RecordingSigner signer = Signing();
            Run run = new(channel, signer);
            Assert(RunApprove(run) == ExitCodes.Ok, run.Err.ToString());
            Assert(signer.Messages.Single().SequenceEqual(PresenceMessage.Build(Id1, DigestOf(), Challenge)), "signed message");
            using JsonDocument decide = JsonDocument.Parse(channel.Requests.Last());
            Assert(decide.RootElement.GetProperty("decision").GetString() == "approve" && decide.RootElement.GetProperty("approvalId").GetString() == Id1 && decide.RootElement.EnumerateObject().Count() == 5, channel.Requests.Last());
            Assert(Hello.VerifyData(PresenceMessage.Build(Id1, DigestOf(), Challenge), Convert.FromBase64String(decide.RootElement.GetProperty("presence").GetString()!), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "the sent signature verifies");
            Assert(run.Out.ToString().Contains("\"vmName\" = \"alpha\"") && run.Out.ToString().Contains("result: approved"), run.Out.ToString());
        });
        Check("approve: digest mismatch is refused, nothing is signed and no decide is sent", () =>
        {
            FakeChannel channel = Listing(Entry(digest: "sha256:" + new string('1', 64)));
            RecordingSigner signer = Signing();
            Run run = new(channel, signer);
            Assert(RunApprove(run) == ExitCodes.Refused && run.Err.ToString().Trim() == "error: digest_mismatch", run.Err.ToString());
            Assert(signer.Messages.Count == 0 && channel.Decides == 0 && run.Out.ToString().Contains("MISMATCH"), "no signature, no decide, the mismatch is shown");
        });
        Check("approve: an entry whose shown fields differ from what was hashed (display tampered) is refused", () =>
        {
            FakeChannel channel = Listing(Entry(dto: Dto.Replace("proj-alpha", "proj-prod")));
            Run run = new(channel, Signing());
            Assert(RunApprove(run) == ExitCodes.Refused && channel.Decides == 0, run.Err.ToString());
        });
        Check("approve: invalid entry, unknown id and a malformed id are refused before any decide", () =>
        {
            FakeChannel invalid = Listing(Entry(extra: ",\"x\":1"));
            Assert(RunApprove(new Run(invalid, Signing())) == ExitCodes.Refused && invalid.Decides == 0, "invalid entry");
            FakeChannel other = Listing(Entry(id: Id2));
            Run unknown = new(other, Signing());
            Assert(RunApprove(unknown) == ExitCodes.Refused && unknown.Err.ToString().Trim() == "error: not_pending" && other.Decides == 0, unknown.Err.ToString());
            FakeChannel none = Listing(Entry());
            Run malformed = new(none, Signing());
            Assert(RunApprove(malformed, "x\",\"decision\":\"deny") == ExitCodes.BadUsage && none.Requests.Count == 0, "a malformed id sends nothing");
        });
        Check("approve: without --yes the human must type exactly 'yes'; anything else declines and nothing is signed", () =>
        {
            foreach (string answer in new[] { "", "no", "y", "YES", "yes please" })
            {
                RecordingSigner signer = Signing();
                FakeChannel channel = Listing(Entry());
                Run run = new(channel, signer, answer + "\n");
                Assert(RunApprove(run, yes: false) == ExitCodes.Refused && run.Err.ToString().Trim() == "error: not_confirmed" && signer.Messages.Count == 0 && channel.Decides == 0, $"answer '{answer}'");
            }
            Run accepted = new(Listing(Entry()), Signing(), "yes\n");
            Assert(RunApprove(accepted, yes: false) == ExitCodes.Ok && accepted.Out.ToString().Contains("Type yes to approve"), accepted.Err.ToString());
        });
        Check("approve: a build without a Hello signer sends nothing and exits 69 (the request stays pending)", () =>
        {
            FakeChannel channel = Listing(Entry());
            Run run = new(channel, new NotBuiltPresenceSigner());
            Assert(RunApprove(run) == ExitCodes.SignerNotBuilt && run.Err.ToString().Trim() == "error: presence_signer_not_built" && channel.Decides == 0, run.Err.ToString());
        });
        Check("approve: Hello gave no proof -> decide presence_unavailable is sent (no presence field) and the Authority's code maps to exit 67", () =>
        {
            FakeChannel channel = new(r => r.Contains("\"verb\":\"list\"") ? Page([Entry()]) : "{\"ok\":false,\"code\":\"presence_unavailable\"}");
            Run run = new(channel, new RecordingSigner(SignResult.Unavailable));
            Assert(RunApprove(run) == ExitCodes.AuthorityRejected && run.Err.ToString().Trim() == "error: authority:presence_unavailable", run.Err.ToString());
            Assert(channel.Requests.Last() == $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{Id1}\",\"decision\":\"presence_unavailable\"}}", channel.Requests.Last());
        });
        Check("approve: Authority refusals (presence_mismatch, request_expired, queue_full) exit 67 with the fixed code", () =>
        {
            foreach (string code in new[] { "presence_mismatch", "request_expired", "human_denied", "request_invalid" })
            {
                Run run = new(new FakeChannel(r => r.Contains("\"verb\":\"list\"") ? Page([Entry()]) : $"{{\"ok\":false,\"code\":\"{code}\"}}"), Signing());
                Assert(RunApprove(run) == ExitCodes.AuthorityRejected && run.Err.ToString().Trim() == $"error: authority:{code}", code);
            }
        });
        Check("approve: unknown codes, extra fields, a wrong state and non-JSON replies are an unknown outcome (68), never a success", () =>
        {
            foreach (string reply in new[] { "{\"ok\":false,\"code\":\"made_up\"}", "{\"ok\":false,\"code\":\"human_denied\",\"x\":1}", "{\"ok\":true,\"state\":\"denied\"}", "{\"ok\":true,\"state\":\"approved\",\"x\":1}", "{\"ok\":true}", "nope", "" })
            {
                Run run = new(new FakeChannel(r => r.Contains("\"verb\":\"list\"") ? Page([Entry()]) : reply), Signing());
                Assert(RunApprove(run) == ExitCodes.TransportUnknown && !run.Out.ToString().Contains("result:"), reply);
            }
        });
    }

    private static void ListAndDenyChecks()
    {
        Check("list: prints every pending request across pages and asks with afterSeq = lastSeq", () =>
        {
            int calls = 0;
            FakeChannel channel = new(r => ++calls == 1 ? Page([Entry(Id1, seq: "1")], more: true, last: 1) : Page([Entry(Id2, seq: "2")], last: 2));
            Run run = new(channel, Signing());
            run.Exit = run.Commands.ListAsync().GetAwaiter().GetResult();
            Assert(run.Exit == ExitCodes.Ok && run.Out.ToString().StartsWith("pending: 2\n") && run.Out.ToString().Contains("request " + Id1) && run.Out.ToString().Contains("request " + Id2), run.Out.ToString());
            Assert(channel.Requests[0] == "{\"v\":1,\"verb\":\"list\",\"afterSeq\":0}" && channel.Requests[1] == "{\"v\":1,\"verb\":\"list\",\"afterSeq\":1}", string.Join('|', channel.Requests));
        });
        Check("list: a server that says 'more' without progress ends in an unknown outcome instead of looping; an empty list says pending: 0", () =>
        {
            Run stuck = new(new FakeChannel(r => Page([], more: true, last: 0)), Signing());
            stuck.Exit = stuck.Commands.ListAsync().GetAwaiter().GetResult();
            Assert(stuck.Exit == ExitCodes.TransportUnknown, "no progress");
            Run empty = new(new FakeChannel(r => Page([], last: 0)), Signing());
            empty.Exit = empty.Commands.ListAsync().GetAwaiter().GetResult();
            Assert(empty.Exit == ExitCodes.Ok && empty.Out.ToString() == "pending: 0\n", empty.Out.ToString());
        });
        Check("list: an invalid entry is shown as REFUSED next to a good one; the good one is still shown", () =>
        {
            Run run = new(Listing(Entry(), Entry(id: Id2, extra: ",\"x\":1")), Signing());
            run.Exit = run.Commands.ListAsync().GetAwaiter().GetResult();
            Assert(run.Exit == ExitCodes.Ok && run.Out.ToString().Contains("REFUSED: invalid_entry") && run.Out.ToString().Contains("digest check: OK"), run.Out.ToString());
        });
        Check("deny: sends exactly decide deny (no presence), prints the result; a malformed id sends nothing", () =>
        {
            FakeChannel channel = new(r => "{\"ok\":true,\"state\":\"denied\"}");
            Run run = new(channel, new NotBuiltPresenceSigner());
            run.Exit = run.Commands.DenyAsync(Id1).GetAwaiter().GetResult();
            Assert(run.Exit == ExitCodes.Ok && run.Out.ToString().Trim() == "result: denied" && channel.Requests.Single() == $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{Id1}\",\"decision\":\"deny\"}}", channel.Requests.Single());
            FakeChannel never = new(r => "{\"ok\":true,\"state\":\"denied\"}");
            Run bad = new(never, new NotBuiltPresenceSigner());
            Assert(bad.Commands.DenyAsync("x\"}").GetAwaiter().GetResult() == ExitCodes.BadUsage && never.Requests.Count == 0, "malformed id");
        });
        Check("channel failures: before the write exits 66 with the code, after the write exits 68 with the code", () =>
        {
            foreach ((string code, bool sent, int exit) in new[] { (ChannelCodes.ServerIdentityMismatch, false, ExitCodes.ServerRefused), (ChannelCodes.AuthorityUnreachable, false, ExitCodes.ServerRefused), (ChannelCodes.Timeout, true, ExitCodes.TransportUnknown), (ChannelCodes.TransportError, true, ExitCodes.TransportUnknown) })
            {
                Run run = new(new FakeChannel(r => throw new ChannelException(code, sent)), Signing());
                Assert(RunApprove(run) == exit && run.Err.ToString().Trim() == $"error: {code}", code);
            }
        });
    }

    private static int Main()
    {
        SafeTextChecks();
        RenderChecks();
        ParserChecks();
        PresenceChecks();
        ApproveChecks();
        ListAndDenyChecks();
        Console.Out.Write(JsonSerializer.Serialize(new { checks = Results }));
        return 0;
    }
}
