using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

internal static partial class Harness
{
    private static JsonObject GoodConfig(Rig rig) => new()
    {
        ["pipeName"] = "ALBERA_WslBridge_t", ["controlPlaneSid"] = Rig.CurrentSid(), ["computerId"] = Rig.Computer, ["brokerKeyId"] = Rig.KeyId, ["brokerSpki"] = Convert.ToBase64String(rig.Signer.ExportSubjectPublicKeyInfo()),
        ["leaseFloorPath"] = @"C:\albera\lease-floor", ["imagePath"] = @"C:\albera\image.tar", ["imageSha256"] = new string('0', 64), ["distributionsFolder"] = @"C:\albera\dist", ["stateFolder"] = @"C:\albera\state",
        ["gitPath"] = @"C:\Program Files\Git\cmd\git.exe", ["minWslVersion"] = "2.4.0", ["minKernelVersion"] = "6.6.87", ["floorExpiresAt"] = 1_900_000_000,
        ["repositories"] = new JsonArray(new JsonObject { ["repositoryId"] = "repo-alpha", ["path"] = @"C:\work\alpha" }),
    };

    private static string ConfigWhy(JsonObject config, out BridgeConfig? parsed)
    {
        parsed = BridgeConfig.TryParse(Encoding.UTF8.GetBytes(config.ToJsonString()), out string reason);
        return reason;
    }

    private static void ConfigChecks()
    {
        Check("config: a complete file parses, and the lease floor, computer and mapping are what the file says", () =>
        {
            using Rig rig = new();
            Same("", ConfigWhy(GoodConfig(rig), out BridgeConfig? parsed), "reason");
            Assert(parsed is not null && parsed.ComputerId == "pc-wsl" && parsed.Repositories["repo-alpha"] == @"C:\work\alpha" && parsed.LeaseFloorPath == @"C:\albera\lease-floor" && parsed.Floor.ExpiresAt == 1_900_000_000, "values");
        });

        Check("config: every bad value maps to one fixed reason word", () =>
        {
            using Rig rig = new();
            (string Key, JsonNode? Value, string Why)[] cases =
            [
                ("pipeName", "a\\b", BridgeConfig.Why.PipeName), ("controlPlaneSid", "S-1-1-0", BridgeConfig.Why.ControlPlaneSid), ("controlPlaneSid", "WD", BridgeConfig.Why.ControlPlaneSid),
                ("computerId", "bad id", BridgeConfig.Why.ComputerId), ("brokerSpki", "AAAA", BridgeConfig.Why.BrokerKey), ("brokerSpki", "not base64!", BridgeConfig.Why.BrokerKey),
                ("leaseFloorPath", "lease-floor", BridgeConfig.Why.LeaseFloor), ("leaseFloorPath", 1, BridgeConfig.Why.LeaseFloor), ("imagePath", "image.tar", BridgeConfig.Why.Image), ("imageSha256", "ABC", BridgeConfig.Why.ImageHash),
                ("stateFolder", @"\\server\share", BridgeConfig.Why.Folder), ("gitPath", @"C:\a\..\git.exe", BridgeConfig.Why.GitPath), ("minWslVersion", "two", BridgeConfig.Why.Floor),
                ("floorExpiresAt", 0, BridgeConfig.Why.Floor), ("repositories", new JsonArray(), BridgeConfig.Why.Repositories),
            ];
            foreach ((string key, JsonNode? value, string why) in cases)
            {
                JsonObject config = GoodConfig(rig);
                config[key] = value?.DeepClone();
                Same(why, ConfigWhy(config, out BridgeConfig? parsed), key);
                Assert(parsed is null, key + " parsed");
            }
        });

        Check("config: an unknown key, a missing key, a repeated repository and a repeated JSON key are refused", () =>
        {
            using Rig rig = new();
            JsonObject extra = GoodConfig(rig); extra["extra"] = 1;
            Same(BridgeConfig.Why.Keys, ConfigWhy(extra, out _), "unknown key");
            JsonObject missing = GoodConfig(rig); missing.Remove("gitPath");
            Same(BridgeConfig.Why.Keys, ConfigWhy(missing, out _), "missing key");
            JsonObject twice = GoodConfig(rig);
            twice["repositories"] = new JsonArray(new JsonObject { ["repositoryId"] = "r1", ["path"] = @"C:\a" }, new JsonObject { ["repositoryId"] = "r2", ["path"] = @"C:\a" });
            Same(BridgeConfig.Why.Repositories, ConfigWhy(twice, out _), "one folder for two ids");
            string duplicated = GoodConfig(rig).ToJsonString().Replace("{", "{\"computerId\":\"x\",", StringComparison.Ordinal);
            Assert(BridgeConfig.TryParse(Encoding.UTF8.GetBytes(duplicated), out string reason) is null && reason == BridgeConfig.Why.Keys, "repeated key");
        });

        Check("identity: an elevated start is refused, always; the Control Plane as the bridge's own account is refused outside the seam", () =>
        {
            SecurityIdentifier self = new(Rig.CurrentSid());
            string other = self.Value[..self.Value.LastIndexOf('-')] + "-501";
            Same(BridgeConfig.Why.ControlPlaneIsSelf, BridgeConfig.RefuseIdentity(self.Value, self, elevated: false, selfAsControlPlane: false) ?? "(allowed)", "own SID");
            Same(BridgeConfig.Why.Elevated, BridgeConfig.RefuseIdentity(other, self, elevated: true, selfAsControlPlane: false) ?? "(allowed)", "elevated");
            Same(BridgeConfig.Why.Elevated, BridgeConfig.RefuseIdentity(self.Value, self, elevated: true, selfAsControlPlane: true) ?? "(allowed)", "the seam does not excuse elevation");
            Assert(BridgeConfig.RefuseIdentity(other, self, elevated: false, selfAsControlPlane: false) is null, "another account, not elevated");
            Assert(BridgeConfig.RefuseIdentity(self.Value, self, elevated: false, selfAsControlPlane: true) is null, "the seam");
        });

        Check("config paths: a lease floor file that is missing or not a number stops the start", () =>
        {
            using Rig rig = new();
            File.WriteAllText(rig.Config.GitPath, "git");
            Assert(rig.Config.CheckPaths(rig.Guard, rig.Guard) is null, "all there");
            rig.SetFloor("not a number");
            Same(BridgeConfig.Why.LeaseFloorUntrusted, rig.Config.CheckPaths(rig.Guard, rig.Guard) ?? "(allowed)", "not a number");
            File.Delete(rig.FloorFile);
            Same(BridgeConfig.Why.LeaseFloorUntrusted, rig.Config.CheckPaths(rig.Guard, rig.Guard) ?? "(allowed)", "missing");
        });

        Check("path guard: a folder anyone can write is not trusted, one only the owner and SYSTEM can write is, and a junction is not", () =>
        {
            string root = Path.Combine(Path.GetTempPath(), "albera-guard-" + Guid.NewGuid().ToString("N")[..10]);
            string open = Path.Combine(root, "open"), closed = Path.Combine(root, "closed"), link = Path.Combine(root, "link");
            Directory.CreateDirectory(open); Directory.CreateDirectory(closed);
            try
            {
                SecurityIdentifier me = new(Rig.CurrentSid()), system = new("S-1-5-18"), everyone = new("S-1-1-0");
                DirectorySecurity strict = new();
                strict.SetAccessRuleProtection(true, false);
                strict.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                strict.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                new DirectoryInfo(closed).SetAccessControl(strict);
                DirectorySecurity loose = new();
                loose.SetAccessRuleProtection(true, false);
                loose.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, AccessControlType.Allow));
                loose.AddAccessRule(new FileSystemAccessRule(everyone, FileSystemRights.Write, AccessControlType.Allow));
                new DirectoryInfo(open).SetAccessControl(loose);
                Assert(PathGuard.OwnerToo(me).IsTrusted(closed), "closed folder, owner trusted");
                Assert(!PathGuard.OwnerToo(me).IsTrusted(open), "a folder Everyone can write");
                Assert(!PathGuard.AdminOnly().IsTrusted(open), "a folder Everyone can write (admin guard)");
                Assert(!PathGuard.OwnerToo(me).IsTrusted(Path.Combine(root, "missing")), "a path that does not exist");
                Directory.CreateSymbolicLink(link, closed);
                Assert(!PathGuard.OwnerToo(me).IsTrusted(link), "a symbolic link");
            }
            finally { try { Directory.Delete(link); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { } try { Directory.Delete(root, true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { } }
        });
    }

    // ---- the real pipe ------------------------------------------------------------------------------------------------------------------------------------------------------

    private static byte[] Talk(string pipeName, byte[] payload)
    {
        using NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut);
        client.Connect(5000);
        client.Write(Wire.Frame(payload));
        client.Flush();
        byte[]? reply = Wire.ReadFrameAsync(client, 1 << 20, new CancellationTokenSource(5000).Token).GetAwaiter().GetResult();
        return reply ?? throw new CheckFailed("no reply");
    }

    private static byte[] StopFrame(string id) => [6, (byte)id.Length, .. Encoding.ASCII.GetBytes(id)];

    /// <summary>A real pipe in front of the rig's bridge, with one run in progress: what `body` does to the pipe must leave `stop` able to reach that run.</summary>
    private static void StopStillArrives(Action<string> body)
    {
        using Rig rig = new();
        rig.BeginOk();
        string name = "ALBERA_WslBridge_test_" + Guid.NewGuid().ToString("N")[..8];
        PipeServer? server = PipeServer.Create(name, Rig.CurrentSid(), rig.Bridge, rig.Limits, _ => { }, out int failure);
        Assert(server is not null, $"pipe not created ({failure})");
        server!.Start(CancellationToken.None);
        try
        {
            body(name);
            Same("ok", ReplyWord(Talk(name, StopFrame("op-1"))), "stop after those clients");
            Assert(rig.Bridge.ActiveRuns == 0 && rig.Host.Count("unregister:albera-run-op-1") == 1, "the run must be gone");
        }
        finally { server.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
    }

    private static void ConnectAndLeave(string pipeName, byte[]? send = null)
    {
        using NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut);
        client.Connect(5000);
        if (send is null) return;
        client.Write(Wire.Frame(send));
        client.Flush();
    }

    private static void SilentClientChecks()
    {
        // More clients than the four instances: one dead instance per client would leave none for stop.
        const int Clients = 8;
        Check("pipe: stop still arrives after 8 clients connected and closed without a word", () => StopStillArrives(name => { for (int i = 0; i < Clients; i++) ConnectAndLeave(name); }));
        Check("pipe: stop still arrives after 8 clients read their reply and closed at once", () => StopStillArrives(name => { for (int i = 0; i < Clients; i++) Same("no_run", ReplyWord(Talk(name, [5, 2, (byte)'n', (byte)'o'])), "reply"); }));
        Check("pipe: stop still arrives after 8 clients sent a request and left without reading the reply", () => StopStillArrives(name => { for (int i = 0; i < Clients; i++) ConnectAndLeave(name, [5, 2, (byte)'n', (byte)'o']); }));
    }

    private static string ReplyWord(byte[] reply) => reply[0] == 1 ? Encoding.ASCII.GetString(reply, 1, reply.Length - 1) : "ok";

    private static void PipeChecks()
    {
        SilentClientChecks();

        Check("pipe: a real connection gets a fixed refusal, and the caller's SID is checked", () =>
        {
            using Rig rig = new();
            string name = "ALBERA_WslBridge_test_" + Guid.NewGuid().ToString("N")[..8];
            PipeServer? server = PipeServer.Create(name, Rig.CurrentSid(), rig.Bridge, rig.Limits, _ => { }, out int failure);
            Assert(server is not null, $"pipe not created ({failure})");
            server!.Start(CancellationToken.None);
            try
            {
                Same("lease_missing", ReplyWord(Talk(name, [1, 4, (byte)'o', (byte)'p', (byte)'-', (byte)'1'])), "begin without a lease");
                Same("bad_frame", ReplyWord(Talk(name, [9, 9, 9])), "a frame that is not a request");
                Same("no_run", ReplyWord(Talk(name, [5, 4, (byte)'o', (byte)'p', (byte)'-', (byte)'1'])), "end of a run that does not exist");
            }
            finally { server.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
        });

        Check("pipe: a caller that is not the configured Control Plane SID is denied with peer_denied", () =>
        {
            using Rig rig = new();
            string me = Rig.CurrentSid();
            string guest = me[..me.LastIndexOf('-')] + "-501"; // a real user SID that is not this user: the pipe names it, so the Control Plane is "somebody else"
            string name = "ALBERA_WslBridge_test_" + Guid.NewGuid().ToString("N")[..8];
            PipeServer? server = PipeServer.Create(name, guest, rig.Bridge, rig.Limits, _ => { }, out int failure);
            Assert(server is not null, $"pipe not created ({failure})");
            server!.Start(CancellationToken.None);
            try { Same("peer_denied", ReplyWord(Talk(name, [1, 4, (byte)'o', (byte)'p', (byte)'-', (byte)'1'])), "denied"); }
            finally { server.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
            Assert(rig.Host.Calls.Count == 0, "nothing may reach wsl");
        });

        Check("pipe: an instance that cannot be reset ends the bridge instead of serving on with fewer", () =>
        {
            using Rig rig = new();
            string name = "ALBERA_WslBridge_test_" + Guid.NewGuid().ToString("N")[..8];
            List<string> log = [];
            PipeServer? server = PipeServer.Create(name, Rig.CurrentSid(), rig.Bridge, rig.Limits, line => { lock (log) log.Add(line); }, out int failure);
            Assert(server is not null, $"pipe not created ({failure})");
            server!.Start(CancellationToken.None);
            try
            {
                Assert(!server.Failed.IsCompleted, "nothing has failed yet");
                var pipes = (List<NamedPipeServerStream>)typeof(PipeServer).GetField("_pipes", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(server)!;
                pipes[0].Dispose();
                Assert(server.Failed.Wait(TimeSpan.FromSeconds(5)), "Failed must complete");
                lock (log) Assert(log.Contains("PIPE=slot_failed"), "the word in the log");
            }
            finally { server.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
        });

        Check("pipe: a pipe of the same name that already exists stops the start (first instance only)", () =>
        {
            using Rig rig = new();
            string name = "ALBERA_WslBridge_test_" + Guid.NewGuid().ToString("N")[..8];
            PipeSecurity open = new();
            open.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(Rig.CurrentSid()), PipeAccessRights.FullControl, AccessControlType.Allow));
            using NamedPipeServerStream squatter = LocalPipe.Create(name, open);
            PipeServer? server = PipeServer.Create(name, Rig.CurrentSid(), rig.Bridge, rig.Limits, _ => { }, out int failure);
            Assert(server is null && failure == 70, $"the name was taken but the result was {failure}");
        });
    }

    // ---- interop with the Node twin and the closing checks ---------------------------------------------------------------------------------------------------------------

    private static void NodeProbe(string probeFile)
    {
        Check("interop: a lease signed by the Node twin with a Node key is accepted by begin", () =>
        {
            using JsonDocument probe = JsonDocument.Parse(File.ReadAllBytes(probeFile));
            JsonElement root = probe.RootElement;
            using ECDsa key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(root.GetProperty("spki").GetString()!), out _);
            using Rig rig = new(signer: key, keyId: root.GetProperty("keyId").GetString(), now: root.GetProperty("now").GetInt64());
            Reply reply = rig.Begin("op-node", Encoding.UTF8.GetBytes(root.GetProperty("lease").GetRawText()));
            Assert(reply.Ok, "refused: " + reply.Reason);
        });
    }

    private static void ClosingChecks()
    {
        Check("every refusal word that was sent is one of the fixed words", () =>
        {
            string[] seen;
            lock (Rig.AllReasons) seen = Rig.AllReasons.Distinct().ToArray();
            Assert(seen.Length >= 20, $"only {seen.Length} distinct refusals were exercised");
            Assert(seen.All(Reason.All.Contains), "a word outside Reason.cs: " + string.Join(',', seen.Where(word => !Reason.All.Contains(word))));
            Assert(Reason.All.All(word => word.All(c => c is >= 'a' and <= 'z' or '_')), "words are lowercase ASCII");
        });

        Check("the log has fixed words only: no path, repository name, lease value or output", () =>
        {
            string[] lines;
            lock (Rig.AllLogs) lines = Rig.AllLogs.ToArray();
            Assert(lines.Length > 50, "too few log lines to mean anything: " + lines.Length);
            const string Shapes = "^(BEGIN|EXEC|PUT|GET|END|STOP)=(ok|refused:[a-z_]+) run=[A-Za-z0-9._:-]+$|^REAP=(expired|generation|failed) run=[a-z0-9-]+$|^REAP=floor_unreadable$|^TEARDOWN=(unregister_failed|folder_failed|agent_failed|recovered) run=[a-z0-9-]+$|^SWEEP=(\\d+|unreadable)$";
            Assert(lines.All(line => System.Text.RegularExpressions.Regex.IsMatch(line, Shapes)), "a line outside the fixed shapes: " + lines.FirstOrDefault(line => !System.Text.RegularExpressions.Regex.IsMatch(line, Shapes)));
            Assert(lines.Contains("BEGIN=ok run=op-1") && lines.Contains("REAP=expired run=op-2"), "the run id stands next to the fixed word");
            Assert(!lines.Any(line => line.Contains(Rig.SecretMark) || line.Contains("repo-alpha") || line.Contains(Path.GetTempPath())), "a name or path in the log");
        });
    }
}
