using System.Security.Cryptography;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

internal static partial class Harness
{
    private static void NothingImported(Rig rig, string what) => Assert(rig.Host.Count("import:") == 0 && rig.Host.Count("agent:") == 0, what + ": wsl was used");

    private static void LeaseChecks()
    {
        // ---- G1: one check each for a missing, expired, reused and wrong-target lease, and a bundle whose head is not baseOid ----
        Check("g1 no lease: begin without a lease is refused and nothing is imported", () =>
        {
            using Rig rig = new();
            Same(Reason.LeaseMissing, Refused(rig.Send(Verb.Begin, "op-1")), "empty body");
            Same(Reason.LeaseMalformed, Refused(rig.Send(Verb.Begin, "op-1", "{\"not\":\"a lease\"}"u8.ToArray())), "not a lease");
            NothingImported(rig, "no lease");
            Assert(rig.Ledger.CallsOf("op-1") == -1, "a refused lease must not use up the operation id");
        });

        Check("g1 expired lease: refused, nothing is imported, and git was not run for it", () =>
        {
            using Rig rig = new();
            byte[] lease = rig.Lease(tweak: body => { body["issuedAt"] = rig.Now - 700; body["expiresAt"] = rig.Now - 100; });
            Same(Reason.LeaseExpired, Refused(rig.Begin(lease: lease)), "expired");
            NothingImported(rig, "expired");
            Assert(rig.Repos.HeadReads == 0, "an unauthenticated (here: expired) lease must not make the bridge read any repository");
        });

        Check("g1 reused lease: the second begin of an operation is refused, across a restart and with a different signature", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            Assert(rig.Send(Verb.End, "op-1").Ok, "end");
            Same(Reason.LeaseUsed, Refused(rig.Begin()), "the same operation again (a fresh signature of the same body)");
            rig.Restart();
            Same(Reason.LeaseUsed, Refused(rig.Begin()), "after a restart of the bridge");
            Same(Reason.LeaseUsed, Refused(rig.Begin(lease: rig.Lease(tweak: body => body["maxCalls"] = 9L))), "the same operation id with another body");
            Assert(rig.Host.Count("import:") == 1, "only the first begin may import");
        });

        Check("g1 wrong computer: a lease for another computer is refused", () =>
        {
            using Rig rig = new();
            Same(Reason.LeaseTarget, Refused(rig.Begin(lease: rig.Lease(tweak: body => body["computerId"] = "pc-other"))), "computer");
            NothingImported(rig, "wrong computer");
        });

        Check("g1 wrong repository: a repository the config does not list is refused before any git", () =>
        {
            using Rig rig = new();
            Same(Reason.RepositoryUnknown, Refused(rig.Begin(lease: rig.Lease(tweak: body => body["repositoryId"] = "repo-unknown"))), "repository");
            Assert(rig.Repos.HeadReads == 0, "no head may be read for an unknown repository");
            NothingImported(rig, "wrong repository");
        });

        Check("g1 wrong operation: a lease for another operation than the request names is refused", () =>
        {
            using Rig rig = new();
            Same(Reason.LeaseTarget, Refused(rig.Send(Verb.Begin, "op-2", rig.Lease("op-1"))), "operation");
            NothingImported(rig, "wrong operation");
        });

        Check("g1 old generation: a lease below the config's floor is refused", () =>
        {
            using Rig strict = new();
            BridgeConfig raised = strict.Config with { MinLeaseGeneration = 2 };
            Bridge bridge = new(raised, strict.Host, strict.Repos, strict.Ledger, strict.Key, () => strict.Now, strict.Limits, _ => { });
            Reply reply = bridge.HandleAsync(new Request(Verb.Begin, "op-1", strict.Lease())).GetAwaiter().GetResult();
            Same(Reason.LeaseGeneration, Refused(reply), "generation");
        });

        Check("g1 lease runs out while the head is being read: refused after the read", () =>
        {
            using Rig rig = new();
            rig.Repos.OnReadHead = () => rig.Now += 601; // git is slow, and the lease ends meanwhile
            Same(Reason.LeaseExpired, Refused(rig.Begin()), "expired during the read");
            NothingImported(rig, "expiry during the head read");
        });

        Check("g1 wrong signer: a lease signed by another key is refused", () =>
        {
            using Rig rig = new();
            using ECDsa other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            Same(Reason.LeaseSignature, Refused(rig.Begin(lease: rig.Lease(by: other))), "signature");
            Assert(rig.Repos.HeadReads == 0, "a forged lease must not make the bridge read any repository");
        });

        Check("g1 tampered lease: a body changed after signing is refused", () =>
        {
            using Rig rig = new();
            string text = System.Text.Encoding.UTF8.GetString(rig.Lease()).Replace("\"maxCalls\":5", "\"maxCalls\":9");
            Same(Reason.LeaseMalformed, Refused(rig.Begin(lease: System.Text.Encoding.UTF8.GetBytes(text))), "digest");
        });

        Check("g1 head is not baseOid: a repository that moved on is refused", () =>
        {
            using Rig rig = new();
            rig.Repos.Head = new string('b', 40);
            Same(Reason.BaseMoved, Refused(rig.Begin()), "head");
            NothingImported(rig, "moved head");
        });

        Check("g1 bundle head is not baseOid: a bundle of another commit is refused and the distribution is removed", () =>
        {
            using Rig rig = new();
            rig.Repos.Bundle = _ => FakeRepositories.BundleOf(new string('c', 40));
            Same(Reason.BaseMoved, Refused(rig.Begin()), "bundle");
            Assert(rig.Host.Count("import:") == 1 && rig.Host.Count("unregister:albera-run-op-1") == 1, "the half-made distribution must be unregistered");
            Assert(rig.Host.LastAgent.Killed, "the agent must be stopped");
            Assert(rig.Bridge.ActiveRuns == 0, "no run may be left");
        });

        // ---- the rest of begin: order, image, floor, files ----
        Check("begin order: version and floor, then import, then the agent, then the bundle and its clone", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            string[] calls = rig.Host.Calls.ToArray();
            Same("version|import:albera-run-op-1|agent:albera-run-op-1", string.Join('|', calls), "wsl calls in order");
            FakeAgent agent = rig.Host.LastAgent;
            Assert(agent.Files.ContainsKey("input.bundle"), "the bridge's own bundle must be put in /work");
            Assert(agent.Requests.Count == 2 && agent.Requests[0].Op == 3 && agent.Requests[1].Op == 1, "write, then clone");
            Assert(System.Text.Encoding.UTF8.GetString(agent.Requests[1].Body).Contains("git clone -q input.bundle repo"), "the clone runs inside the sandbox");
        });

        Check("begin: an image that is not the pinned file is refused before any import", () =>
        {
            using Rig rig = new();
            File.WriteAllText(rig.Config.ImagePath, "a different image");
            Same(Reason.ImageHash, Refused(rig.Begin()), "image");
            NothingImported(rig, "image hash");
            Assert(rig.Ledger.CallsOf("op-1") == 0, "the operation id is used up from the moment the lease was accepted");
        });

        Check("begin: a missing image is refused", () =>
        {
            using Rig rig = new();
            File.Delete(rig.Config.ImagePath);
            Same(Reason.ImageMissing, Refused(rig.Begin()), "missing");
        });

        Check("begin: the kernel floor, its expiry and an unreadable wsl are refused before any import", () =>
        {
            using Rig rig = new();
            rig.Host.Versions = new WslVersions(new Version(2, 6, 3, 0), new Version(6, 1, 0));
            Same(Reason.KernelOld, Refused(rig.Begin("op-1")), "kernel");
            rig.Host.Versions = new WslVersions(new Version(2, 1, 0), new Version(6, 6, 87));
            Same(Reason.WslOld, Refused(rig.Begin("op-2")), "wsl");
            rig.Host.Versions = null;
            Same(Reason.WslUnavailable, Refused(rig.Begin("op-3")), "no version");
            rig.Host.Versions = new WslVersions(new Version(2, 6, 3, 0), new Version(6, 6, 87));
            BridgeConfig expired = rig.Config with { Floor = rig.Config.Floor with { ExpiresAt = rig.Now - 1 } };
            Bridge bridge = new(expired, rig.Host, rig.Repos, rig.Ledger, rig.Key, () => rig.Now, rig.Limits, _ => { });
            Same(Reason.FloorExpired, Refused(bridge.HandleAsync(new Request(Verb.Begin, "op-4", rig.Lease("op-4"))).GetAwaiter().GetResult()), "floor expiry");
            NothingImported(rig, "floor");
        });

        Check("begin: a failed import leaves nothing behind", () =>
        {
            using Rig rig = new();
            rig.Host.ImportOk = false;
            Same(Reason.ImportFailed, Refused(rig.Begin()), "import");
            Assert(rig.Host.Count("unregister:albera-run-op-1") == 1 && rig.Bridge.ActiveRuns == 0, "discarded");
            Assert(!Directory.Exists(Path.Combine(rig.Config.DistributionsFolder, "albera-run-op-1")), "the folder is removed");
        });

        Check("begin: an operation id that is not plain lowercase cannot name a distribution", () =>
        {
            using Rig rig = new();
            Same(Reason.RunName, Refused(rig.Begin("Op.1")), "uppercase and dot");
            Assert(RunName.For("op-1") == "albera-run-op-1" && RunName.For("a b") is null && RunName.For("-x") is null, "names");
        });

        Check("begin: the number of runs is limited", () =>
        {
            using Rig rig = new(limits => limits with { MaxRuns = 1 });
            rig.BeginOk("op-1");
            Same(Reason.TooManyRuns, Refused(rig.Begin("op-2")), "second run");
        });

        // ---- the ledger: on disk, across restarts, until expiresAt + 30 s, and a failed save refuses ----
        Check("ledger: the call count is saved and survives a restart", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            Assert(rig.Exec().Ok && rig.Exec().Ok, "two calls");
            rig.Restart();
            Assert(rig.Ledger.CallsOf("op-1") == 2, "the count is read back from the file");
        });

        Check("ledger: an entry is kept until expiresAt + 30 s and then forgotten", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            long expires = rig.Now + 600;
            rig.Now = expires + OperationLedger.MarginSeconds - 1;
            rig.Restart();
            Assert(rig.Ledger.CallsOf("op-1") >= 0, "still remembered inside the margin");
            rig.Now = expires + OperationLedger.MarginSeconds;
            rig.Restart();
            Assert(rig.Ledger.CallsOf("op-1") == -1, "forgotten once the lease can only be refused as expired");
        });

        Check("ledger: when the save fails, begin and calls are refused and nothing is imported", () =>
        {
            using Rig rig = new();
            rig.Ledger.Dispose(); // the file handle is gone: every write now fails
            Same(Reason.StateUnwritable, Refused(rig.Begin()), "begin");
            NothingImported(rig, "unwritable ledger");
        });

        Check("ledger: a call whose count cannot be saved is refused", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Ledger.Dispose();
            Same(Reason.StateUnwritable, Refused(rig.Exec()), "exec");
        });

        Check("ledger: a malformed file stops the bridge from starting", () =>
        {
            string file = Path.Combine(Path.GetTempPath(), "albera-ledger-" + Guid.NewGuid().ToString("N") + ".log");
            File.WriteAllText(file, "R op-1 notanumber\n");
            try { Assert(OperationLedger.TryOpen(file, () => 1_800_000_000) is null, "malformed state must not be ignored"); }
            finally { File.Delete(file); File.Delete(file + ".new"); }
        });
    }
}
