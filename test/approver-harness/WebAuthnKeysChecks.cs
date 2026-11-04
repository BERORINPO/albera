using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.Approver;

// `enroll --webauthn`, `keys list | add | remove` and the approval window with WebAuthn (docs/architecture/approver-webauthn.md, phase 3). Same fixtures and the same independent verifier as WebAuthnChecks.cs.
internal static partial class Harness
{
    private const string Sid = "S-1-5-21-1-2-3-1001";

    private static EnrollWebAuthnCommand EnrollCommand(WebAuthnKit? kit, StringWriter output, StringWriter errors, bool interactive = true, string sid = Sid) => new(kit, () => sid, output, errors, interactive);

    private static int FilesIn(string folder) => Directory.Exists(folder) ? Directory.GetFiles(folder).Length : 0;

    /// <summary>The Authority's key verbs, as far as `keys` needs them: a key list that remove changes, a fixed challenge, and replies in the contract's shape (no key_add: the Authority has none).
    /// <paramref name="decide"/> may replace the answer to a verb; <paramref name="policyReset"/> adds "policyReset":true to the key_remove reply.</summary>
    private static FakeChannel KeyChannel(List<string> entries, Func<string, string?>? decide = null, bool policyReset = false) => new(request =>
    {
        if (decide?.Invoke(request) is { } custom) return custom;
        switch (Verb(request))
        {
            case "key_challenge": return $"{{\"ok\":true,\"challenge\":\"{AddChallenge}\",\"expiresAt\":{Now + 120}}}";
            case "key_remove":
                using (JsonDocument remove = JsonDocument.Parse(request)) { string id = remove.RootElement.GetProperty("keyId").GetString()!; entries.RemoveAll(e => e.Contains($"\"{id}\"")); }
                return policyReset ? KeysReply([.. entries])[..^1] + ",\"policyReset\":true}" : KeysReply([.. entries]);
            default: return KeysReply([.. entries]);
        }
    });

    /// <summary>Signs any message with the Hello RSA key and remembers it (the real Hello signer signs exactly the message bytes).</summary>
    private sealed class HelloSigningAnything : IPresenceSigner
    {
        public readonly List<byte[]> Messages = [];
        public SignResult Sign(byte[] message) { Messages.Add(message); return SignResult.Signed(Hello.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)); }
    }

    private static string HelloListing() => $"{{\"keyId\":\"{ApproverKeyId.Of(Hello.ExportSubjectPublicKeyInfo())}\",\"kind\":\"hello-rsa\"}}";

    private static void WebAuthnEnrollChecks()
    {
        Check("enroll --webauthn: the opt-in, a console and a usable platform are checked BEFORE a credential is made; refusals create nothing and write nothing", () =>
        {
            SoftwareAuthenticator authenticator = new();
            string folder = TempFolder();
            WebAuthnKit kit = Kit(authenticator, remote: false, folder);
            StringWriter output = new(), errors = new();
            Assert(EnrollCommand(kit, output, errors).Run(acceptUnattested: false) == ExitCodes.Refused && errors.ToString().StartsWith("error: unattested_not_accepted\nhint: ") && errors.ToString().Contains("--accept-unattested") && output.ToString() == "", errors.ToString());
            errors = new();
            Assert(EnrollCommand(kit, output, errors, interactive: false).Run(true) == ExitCodes.Refused && errors.ToString() == "error: not_interactive\n", errors.ToString());
            errors = new();
            Assert(EnrollCommand(kit, output, errors, sid: "").Run(true) == ExitCodes.Internal && errors.ToString() == "error: sid_unavailable\n", errors.ToString());
            errors = new();
            Assert(EnrollCommand(null, output, errors).Run(true) == ExitCodes.SignerUnavailable && errors.ToString() == "error: webauthn_unavailable\n", errors.ToString());
            Assert(authenticator.Created == 0 && FilesIn(folder) == 0 && output.ToString() == "", "nothing was made, nothing was written, nothing was printed");
        });
        Check("enroll --webauthn: makes a credential, prints the record's fields and approverSid, and writes the canonical record JSON to <keyId>.json (what the installer's set-approver reads)", () =>
        {
            SoftwareAuthenticator authenticator = new();
            string folder = TempFolder();
            StringWriter output = new(), errors = new();
            Assert(EnrollCommand(Kit(authenticator, remote: false, folder), output, errors).Run(true) == ExitCodes.Ok && errors.ToString() == "", errors.ToString());
            string text = output.ToString();
            string Printed(string name) => text.Split('\n').Single(l => l.StartsWith($"  \"{name}\": ", StringComparison.Ordinal))[($"  \"{name}\": ").Length..].TrimEnd(',').Trim('"');
            string keyId = Printed("keyId"), publicKey = Printed("publicKey"), credentialId = Printed("credentialId");
            Assert(Printed("kind") == "webauthn" && Printed("alg") == "-7" && Printed("approverSid") == Sid, text);
            Assert(keyId == "webauthn-" + Convert.ToHexStringLower(SHA256.HashData(Convert.FromBase64String(publicKey)).AsSpan(0, 8)), "the key id rule");
            string path = Path.Combine(folder, keyId + ".json");
            string canonical = $"{{\"keyId\":\"{keyId}\",\"kind\":\"webauthn\",\"alg\":-7,\"publicKey\":\"{publicKey}\",\"credentialId\":\"{credentialId}\"}}";
            Assert(FilesIn(folder) == 1 && File.ReadAllBytes(path).SequenceEqual(Encoding.UTF8.GetBytes(canonical)), "one file, exactly the canonical bytes (no BOM, no newline)");
            Assert(text.Contains($"record file: {path}\n") && text.Contains("attestation: none (accepted with --accept-unattested: this key is NOT proven to be hardware-backed)\n"), text);
            string[] lines = text.TrimEnd().Split('\n');
            Assert(lines[^2].StartsWith("next (the owner, in an elevated prompt; Windows asks for the administrator's consent): ", StringComparison.Ordinal) && lines[^2].EndsWith($"albera-host.ps1 -Mode set-approver -ApproverKeyFile \"{path}\""), $"the exact next step, with the record file: {lines[^2]}");
            Assert(lines[^1].StartsWith("This key approves nothing until set-approver has added it to the Authority.", StringComparison.Ordinal) && !text.Contains("keys add"), "and what the key can do until then; no run-time add is offered");
            Assert(!text.Contains("PRIVATE") && text.Split('\n').Count(l => l.StartsWith("  \"", StringComparison.Ordinal)) == 6, "public values only: keyId, kind, alg, publicKey, credentialId, approverSid");
            Assert(authenticator.Created == 1 && authenticator.LastWindow == IntPtr.Zero, "one credential; the console window is the default parent");
            StringWriter again = new();
            Assert(EnrollCommand(Kit(authenticator, remote: false, folder), again, new StringWriter()).Run(true) == ExitCodes.Ok && !again.ToString().Contains(keyId) && FilesIn(folder) == 2, "a second run makes a second, different key and never replaces the first");
        });
        Check("enroll --webauthn: a dismissed prompt (69 webauthn_cancelled), an unusable platform or a result that breaks the contract (69 webauthn_unavailable) print no key and write no file; a record file that cannot be written is 70 with the values still printed", () =>
        {
            foreach ((SoftwareAuthenticator authenticator, string code) in new (SoftwareAuthenticator, string)[] { (new() { Cancel = true }, "webauthn_cancelled"), (new() { NotReady = true }, "webauthn_unavailable"), (new() { Flags = 0x01 }, "webauthn_unavailable"), (new() { RpId = "evil.example" }, "webauthn_unavailable") })
            {
                string folder = TempFolder();
                StringWriter output = new(), errors = new();
                Assert(EnrollCommand(Kit(authenticator, false, folder), output, errors).Run(true) == ExitCodes.SignerUnavailable && errors.ToString().StartsWith($"error: {code}\nhint: "), errors.ToString());
                Assert(output.ToString() == "" && FilesIn(folder) == 0, "nothing printed, nothing written");
            }
            string blocked = Path.Combine(TempFolder(), "not-a-folder");
            File.WriteAllText(blocked, "x");
            StringWriter printed = new(), failed = new();
            Assert(EnrollCommand(Kit(new SoftwareAuthenticator(), false, blocked), printed, failed).Run(true) == ExitCodes.Internal && failed.ToString().StartsWith("error: record_file_failed\nhint: ") && printed.ToString().Contains("record file: NOT written\n") && printed.ToString().Contains("\"publicKey\": \"") && !printed.ToString().Contains("next ("), "the values are still printed, but no next step is offered for a file that does not exist: " + failed);
        });
        Check("key record store: creates one file per key id, never overwrites a different one, and builds no path from anything but a derived key id", () =>
        {
            string folder = Path.Combine(TempFolder(), "nested", "approver-keys");
            KeyRecordStore store = new(folder);
            SoftwareAuthenticator authenticator = new();
            ApproverKeyRecord record = WebAuthnCreator.Create(authenticator, default).Record!, other = WebAuthnCreator.Create(authenticator, default).Record!;
            Assert(store.TrySave(record, out string? path) && path == Path.Combine(folder, record.KeyId + ".json") && File.ReadAllBytes(path).SequenceEqual(record.CanonicalBytes()), "created, with its folder, holding exactly the canonical bytes");
            Assert(store.TrySave(record, out _), "the same record again is fine (the file already holds it)");
            File.WriteAllText(path!, "tampered");
            Assert(!store.TrySave(record, out _) && File.ReadAllText(path!) == "tampered", "a different file is never overwritten");
            Assert(store.TrySave(other, out string? otherPath) && otherPath != path, "another key gets its own file");
            foreach (string bad in new[] { "..\\x", "../x", "webauthn-0123456789abcdef\n", "webauthn-0123456789ABCDEF", "webauthn-0123", "C:\\x", "", "hello-0123456789abcdef.json", "other-0123456789abcdef" })
                Assert(store.PathOf(bad) is null, $"'{bad}' builds no path");
        });
    }

    private static void WebAuthnKeysChecks()
    {
        Check("keys list: prints the Authority's keys (count, id, kind, credential id), needs no console and no kit, and is read only", () =>
        {
            FakeChannel channel = KeyChannel([HelloEntry, ListedElsewhere([1, 2, 3])]);
            WebRun run = new(channel, Signing(), null, interactive: false);
            Assert(run.Keys.ListAsync().GetAwaiter().GetResult() == ExitCodes.Ok && run.Err.ToString() == "", run.Err.ToString());
            string[] lines = run.Out.ToString().TrimEnd().Split('\n');
            Assert(lines[0] == "keys: 2" && lines[1] == "key \"hello-951a135537287eae\"" && lines[2] == "  kind: \"hello-rsa\"" && lines[3].StartsWith("key \"webauthn-") && lines[4] == "  kind: \"webauthn\"" && lines[5] == "  credentialId: \"AQID\"" && lines.Length == 6, run.Out.ToString());
            Assert(Verbs(channel).SequenceEqual(["keys"]), "one read");
            FakeChannel refused = new(_ => "{\"ok\":false,\"code\":\"request_invalid\"}");
            WebRun failing = new(refused, Signing(), null);
            Assert(failing.Keys.ListAsync().GetAwaiter().GetResult() == ExitCodes.AuthorityRejected && failing.Err.ToString() == "error: authority:request_invalid\n", failing.Err.ToString());
        });
        Check("keys remove: keys, the typed yes, key_challenge (remove), key_remove with a registered key's proof over albera.keyremove.v1 0x00 keyId 0x00 challenge, for a key from ANOTHER device (this PC has no record file of it); the independent verifier accepts it", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered registered = Register(authenticator), target = Register(authenticator);
            List<string> entries = [registered.KeyJson, target.KeyJson];
            FakeChannel channel = KeyChannel(entries);
            WebAuthnKit kit = Kit(authenticator, remote: true);
            WebRun run = new(channel, Signing(), kit);
            Assert(Directory.Exists(kit.Records.Folder) == false || Directory.GetFiles(kit.Records.Folder).Length == 0, "no record file exists for any key on this PC");
            Assert(run.Keys.RemoveAsync(target.Record.KeyId).GetAwaiter().GetResult() == ExitCodes.Ok && run.Err.ToString() == "", run.Err.ToString());
            Assert(Verbs(channel).SequenceEqual(["keys", "key_challenge", "key_remove"]) && run.Input.RequestsAtFirstRead == 1, string.Join(',', Verbs(channel)));
            Assert(channel.Requests[1] == $"{{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"remove\",\"keyId\":\"{target.Record.KeyId}\"}}", channel.Requests[1]);
            JsonElement remove = Frame(channel, "key_remove");
            Assert(remove.EnumerateObject().Select(p => p.Name).SequenceEqual(["v", "verb", "keyId", "challenge", "by"]) && remove.GetProperty("keyId").GetString() == target.Record.KeyId && remove.GetProperty("challenge").GetString() == AddChallenge, "frame shape");
            byte[] message = Encoding.UTF8.GetBytes($"albera.keyremove.v1\0{target.Record.KeyId}\0{AddChallenge}");
            Assert(ProofVerifies(remove.GetProperty("by"), registered.Key, message, registered.CredentialId), "a registered key's proof over the remove message (the first allowed credential this authenticator holds)");
            Assert(authenticator.AllowLists.Single().Select(Url).SequenceEqual([Url(registered.CredentialId), Url(target.CredentialId)]) && run.Out.ToString().Contains("result: key removed\nkeys: 1\n"), "any registered key may sign, including the one removed; the list shows the key gone");
        });
        Check("keys remove refuses locally an unknown key, the last key, no console, a refusal to confirm, and a remote session that cannot sign; nothing is signed or sent after the key list", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered registered = Register(authenticator), other = Register(authenticator);
            WebAuthnKit kit = Kit(authenticator, remote: false);
            WebRun Make(List<string> entries, WebAuthnKit? use = null, bool interactive = true, string stdin = "yes\n") => new(KeyChannel(entries), Signing(), use ?? kit, stdin, interactive);
            (string Why, WebRun Run, string Id, int Exit, string Code)[] cases =
            [
                ("unknown key", Make([registered.KeyJson, other.KeyJson]), "webauthn-ffffffffffffffff", ExitCodes.Refused, "key_unknown"),
                ("last key", Make([registered.KeyJson]), registered.Record.KeyId, ExitCodes.Refused, "last_key"),
                ("no console", Make([registered.KeyJson, other.KeyJson], interactive: false), other.Record.KeyId, ExitCodes.Refused, "not_interactive"),
            ];
            foreach (var (why, run, id, exit, code) in cases)
                Assert(run.Keys.RemoveAsync(id).GetAwaiter().GetResult() == exit && run.Err.ToString().StartsWith($"error: {code}\n") && run.Out.ToString() == "", $"{why}: {run.Err}");
            WebRun declined = Make([registered.KeyJson, other.KeyJson], stdin: "no\n");
            Assert(declined.Keys.RemoveAsync(other.Record.KeyId).GetAwaiter().GetResult() == ExitCodes.Refused && declined.Err.ToString() == "error: not_confirmed\n" && authenticator.AllowLists.Count == 0, declined.Err.ToString());
            // Over Remote Desktop with only Hello registered nothing can sign: remote_session, before the typed yes.
            WebRun remote = Make([HelloListing(), "{\"keyId\":\"hello-0000000000000002\",\"kind\":\"hello-rsa\"}"], new WebAuthnKit(authenticator, true, kit.Records));
            Assert(remote.Keys.RemoveAsync("hello-0000000000000002").GetAwaiter().GetResult() == ExitCodes.SignerUnavailable && remote.Err.ToString().StartsWith("error: remote_session\n") && remote.Input.RequestsAtFirstRead == -1 && remote.Out.ToString() == "", remote.Err.ToString());
        });
        Check("keys remove with only Hello keys registered (local session): the proof is the Hello signature (a quoted base64 string) over albera.keyremove.v1 0x00 keyId 0x00 challenge", () =>
        {
            SoftwareAuthenticator authenticator = new();
            string helloId = ApproverKeyId.Of(Hello.ExportSubjectPublicKeyInfo());
            List<string> entries = [HelloListing(), "{\"keyId\":\"hello-0000000000000002\",\"kind\":\"hello-rsa\"}"];
            FakeChannel channel = KeyChannel(entries);
            HelloSigningAnything signer = new();
            WebRun run = new(channel, signer, Kit(authenticator, remote: false));
            Assert(run.Keys.RemoveAsync("hello-0000000000000002").GetAwaiter().GetResult() == ExitCodes.Ok && run.Err.ToString() == "", run.Err.ToString());
            byte[] message = Encoding.UTF8.GetBytes($"albera.keyremove.v1\0hello-0000000000000002\0{AddChallenge}");
            Assert(signer.Messages.Single().SequenceEqual(message) && authenticator.AllowLists.Count == 0, "Hello signed exactly the remove message");
            JsonElement remove = Frame(channel, "key_remove");
            Assert(remove.GetProperty("by").ValueKind == JsonValueKind.String && Hello.VerifyData(message, Convert.FromBase64String(remove.GetProperty("by").GetString()!), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "the quoted base64 RSA signature");
            WebRun lying = new(KeyChannel([HelloListing(), HelloListing().Replace(helloId, "hello-0000000000000002")], request => Verb(request) == "key_remove" ? KeysReply(HelloListing(), HelloListing().Replace(helloId, "hello-0000000000000002")) : null),
                new HelloSigningAnything(), Kit(authenticator, false));
            Assert(lying.Keys.RemoveAsync("hello-0000000000000002").GetAwaiter().GetResult() == ExitCodes.TransportUnknown && lying.Err.ToString() == "error: invalid_response\n" && !lying.Out.ToString().Contains("key removed"), "an Authority that says ok but still lists the key");
        });
        Check("keys remove: \"policyReset\":true in the reply tells the person the policy is back to careful; any other form of that field, or any other extra field, is an invalid response; without it nothing is said", () =>
        {
            (SoftwareAuthenticator Authenticator, Registered Registered, Registered Target, WebAuthnKit Kit) Setup()
            {
                SoftwareAuthenticator authenticator = new();
                Registered registered = Register(authenticator), target = Register(authenticator);
                WebAuthnKit kit = Kit(authenticator, remote: false);
                return (authenticator, registered, target, kit);
            }
            var (_, registered1, target1, kit1) = Setup();
            WebRun reset = new(KeyChannel([registered1.KeyJson, target1.KeyJson], policyReset: true), Signing(), kit1);
            Assert(reset.Keys.RemoveAsync(target1.Record.KeyId).GetAwaiter().GetResult() == ExitCodes.Ok && reset.Err.ToString() == "", reset.Err.ToString());
            string text = reset.Out.ToString();
            Assert(text.Contains("result: key removed\npolicy: set back to careful (the removed key had signed the policy in force).") && text.IndexOf("policy: set back", StringComparison.Ordinal) < text.IndexOf("keys: 1", StringComparison.Ordinal), text);
            var (_, registered2, target2, kit2) = Setup();
            WebRun plain = new(KeyChannel([registered2.KeyJson, target2.KeyJson]), Signing(), kit2);
            Assert(plain.Keys.RemoveAsync(target2.Record.KeyId).GetAwaiter().GetResult() == ExitCodes.Ok && !plain.Out.ToString().Contains("policy:"), "no policy line without the flag");
            foreach (string tail in new[] { ",\"policyReset\":false}", ",\"policyReset\":\"true\"}", ",\"policyReset\":1}", ",\"policyReset\":true,\"x\":1}", ",\"x\":1}" })
            {
                var (_, registered3, target3, kit3) = Setup();
                string after = KeysReply(registered3.KeyJson)[..^1] + tail;
                WebRun bad = new(KeyChannel([registered3.KeyJson, target3.KeyJson], request => Verb(request) == "key_remove" ? after : null), Signing(), kit3);
                Assert(bad.Keys.RemoveAsync(target3.Record.KeyId).GetAwaiter().GetResult() == ExitCodes.TransportUnknown && bad.Err.ToString() == "error: invalid_response\n" && !bad.Out.ToString().Contains("key removed"), $"{tail}: {bad.Err}");
            }
            WebRun inKeysReply = new(KeyChannel([registered1.KeyJson, target1.KeyJson], request => Verb(request) == "keys" ? KeysReply(registered1.KeyJson, target1.KeyJson)[..^1] + ",\"policyReset\":true}" : null), Signing(), kit1);
            Assert(inKeysReply.Keys.ListAsync().GetAwaiter().GetResult() == ExitCodes.TransportUnknown && inKeysReply.Err.ToString() == "error: invalid_response\n", "policyReset belongs to key_remove only");
        });
        Check("keys remove: a dismissed prompt sends nothing (webauthn_no_proof, 69); the Authority's refusals are reported with their codes; a code the contract no longer has (key_exists) is an invalid response; key_add is never sent", () =>
        {
            SoftwareAuthenticator dismissing = new() { Cancel = true };
            Registered registered = Register(dismissing), target = Register(dismissing);
            WebAuthnKit kit = Kit(dismissing, remote: false);
            FakeChannel channel = KeyChannel([registered.KeyJson, target.KeyJson]);
            WebRun run = new(channel, Signing(), kit);
            Assert(run.Keys.RemoveAsync(target.Record.KeyId).GetAwaiter().GetResult() == ExitCodes.SignerUnavailable && run.Err.ToString().StartsWith("error: webauthn_no_proof\nhint: ") && Verbs(channel).SequenceEqual(["keys", "key_challenge"]), run.Err.ToString());
            foreach ((string code, int exit, string shown) in new[] { ("presence_mismatch", 67, "authority:presence_mismatch"), ("challenge_unknown", 67, "authority:challenge_unknown"), ("challenge_expired", 67, "authority:challenge_expired"),
                ("key_unknown", 67, "authority:key_unknown"), ("last_key", 67, "authority:last_key"), ("too_many_keys", 67, "authority:too_many_keys"), ("key_exists", 68, "invalid_response"), ("key_add", 68, "invalid_response") })
            {
                SoftwareAuthenticator authenticator = new();
                Registered held = Register(authenticator), other = Register(authenticator);
                WebAuthnKit useKit = Kit(authenticator, remote: false);
                FakeChannel refusing = KeyChannel([held.KeyJson, other.KeyJson], request => Verb(request) == "key_remove" ? $"{{\"ok\":false,\"code\":\"{code}\"}}" : null);
                WebRun refused = new(refusing, Signing(), useKit);
                Assert(refused.Keys.RemoveAsync(other.Record.KeyId).GetAwaiter().GetResult() == exit && refused.Err.ToString() == $"error: {shown}\n" && !refused.Out.ToString().Contains("key removed"), $"{code}: {refused.Err}");
                Assert(!Verbs(refusing).Contains("key_add") && Verbs(refusing).SequenceEqual(["keys", "key_challenge", "key_remove"]), "the verbs are keys, key_challenge and key_remove only");
            }
        });
    }

    private static void WebAuthnWindowChecks()
    {
        Check("GUI window with a WebAuthn key: the correct pick asks the authenticator once with the window's own handle as the prompt's parent and exactly the registered credential ids, and sends the proof; Hello is not asked", () =>
        {
            DateTimeOffset now = Shown;
            SoftwareAuthenticator authenticator = new();
            Registered key = Register(authenticator);
            FakeChannel channel = WebAuthnChannel(KeysReply(HelloEntry, key.KeyJson), Entry());
            RecordingSigner hello = Signing();
            ApproverCommands commands = new(channel, hello, TextWriter.Null, TextWriter.Null, TextReader.Null, () => now, interactive: false, webAuthn: Kit(authenticator, remote: true));
            ApprovalWindow window = new(PromptOf(Entry()), commands, () => now, remoteSession: true);
            IntPtr handle = window.Handle;
            try
            {
                now += TimeSpan.FromSeconds(2);
                window.ApplyState();
                Pump(window.HandleChoiceAsync(MatchCode.Choices(Id1, DigestOf()).CorrectIndex));
                Assert(handle != IntPtr.Zero && authenticator.LastWindow == handle && authenticator.AllowLists.Single().Single().SequenceEqual(key.CredentialId) && hello.Messages.Count == 0, "the window's handle parents the prompt");
                Assert(ProofVerifies(Frame(channel, "decide").GetProperty("presence"), key.Key, PresenceBytes(), key.CredentialId) && window.IsFinished && window.StatusText == "承認しました。", window.StatusText);
            }
            finally { window.Dispose(); }
        });
        Check("GUI: a remote session with no WebAuthn key is told before any digit is offered (the prompt has no approve buttons, deny only); with a WebAuthn key, with a local session, with no kit or with an unreadable key list it is not blocked", () =>
        {
            SoftwareAuthenticator authenticator = new();
            Registered key = Register(authenticator);
            bool Blocked(FakeChannel channel, bool remote, bool withKit = true) =>
                new ApproverCommands(channel, Signing(), TextWriter.Null, TextWriter.Null, TextReader.Null, () => Shown, interactive: false, webAuthn: withKit ? Kit(authenticator, remote) : null).SigningBlockedAsync().GetAwaiter().GetResult();
            Assert(Blocked(WebAuthnChannel(KeysReply(HelloEntry)), remote: true), "remote, Hello only");
            Assert(Blocked(WebAuthnChannel("{\"ok\":false,\"code\":\"request_invalid\"}"), remote: true), "remote, an Authority from before WebAuthn");
            Assert(!Blocked(WebAuthnChannel(KeysReply(HelloEntry, key.KeyJson)), remote: true) && !Blocked(WebAuthnChannel(KeysReply(HelloEntry)), remote: false), "a WebAuthn key, or a local session");
            FakeChannel unused = WebAuthnChannel(KeysReply(HelloEntry));
            Assert(!Blocked(unused, remote: true, withKit: false) && unused.Requests.Count == 0, "no kit: Hello only, the Authority is not asked");
            Assert(!Blocked(new FakeChannel(_ => throw new ChannelException(ChannelCodes.AuthorityUnreachable, sent: false)), remote: true) && !Blocked(WebAuthnChannel("{\"ok\":false,\"code\":\"authority_unavailable\"}"), remote: true), "an unreadable list is no block: the click meets the real error");
            ApprovalPrompt blocked = ApprovalPrompt.From(Parsed(Entry()), Shown, signingBlocked: true);
            Assert(blocked.Block == BlockReason.SigningBlocked && !blocked.CanApprove && blocked.Choices.Count == 0 && blocked.BlockText.Contains("WebAuthn") && blocked.DenyEnabled(new PickState(), Shown.AddSeconds(5)), "deny only, with the reason");
            Assert(ApprovalPrompt.From(Parsed(Entry(digest: "sha256:" + new string('0', 64))), Shown, signingBlocked: true).Block == BlockReason.DigestMismatch, "a hostile entry is still reported as such first");
            Assert(ApprovalPrompt.From(Parsed(Entry()), Shown).Block == BlockReason.None, "the default is unblocked");
            Assert(ApprovalPrompt.ApproveResultText(new CommandOutcome(ExitCodes.SignerUnavailable, "remote_session")).Contains("リモートデスクトップ") && ApprovalPrompt.ApproveResultText(new CommandOutcome(ExitCodes.SignerUnavailable, "remote_session")).Contains("何も送っていません"), "result text");
        });
    }
}
