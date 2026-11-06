using System.Security.AccessControl;
using System.Security.Principal;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

internal static partial class Harness
{
    private static string RunFolder(Rig rig, string id = "op-1") => Path.Combine(rig.Config.DistributionsFolder, "albera-run-" + id);

    private static void Reap(Rig rig) => rig.Bridge.ReapExpiredAsync().GetAwaiter().GetResult();

    // Holds a begin inside its bundle (the agent is up, the run is not registered) until the check lets it go.
    private sealed class HeldBegin : IDisposable
    {
        private readonly ManualResetEventSlim _inside = new(), _release = new();
        public readonly Task<Reply> Reply;

        public HeldBegin(Rig rig)
        {
            rig.Repos.Bundle = _ => { _inside.Set(); _release.Wait(TimeSpan.FromSeconds(20)); return FakeRepositories.BundleOf(Rig.Head); };
            byte[] lease = rig.Lease();
            Reply = Task.Run(() => rig.Begin(lease: lease));
            Assert(_inside.Wait(TimeSpan.FromSeconds(10)), "begin never reached the bundle");
        }

        public void Release() => _release.Set();
        public void Dispose() { _release.Set(); try { Reply.Wait(TimeSpan.FromSeconds(10)); } catch (AggregateException) { } _inside.Dispose(); _release.Dispose(); }
    }

    private static void TeardownChecks()
    {
        Check("reaper: an exception in one teardown does not stop the next, and only a real end is logged as expired", () =>
        {
            using Rig rig = new();
            rig.BeginOk("op-1");
            rig.BeginOk("op-2");
            rig.Host.OnUnregister = name => { if (name == "albera-run-op-1") throw new IOException("wsl is stuck"); };
            rig.Now += 601;
            Reap(rig);
            Assert(rig.Logged("REAP=expired run=op-2") && !rig.Host.Existing.Contains("albera-run-op-2"), "the second run must still be ended");
            Assert(rig.Logged("REAP=failed run=op-1") && rig.Logged("TEARDOWN=unregister_failed run=op-1"), "the failure is in the log");
            Assert(!rig.Logged("REAP=expired run=op-1"), "a run that is still there is not reported as ended");
        });

        Check("reaper: a teardown that failed is tried again until the distribution is gone", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.UnregisterOk = false;
            rig.Now += 601;
            Reap(rig);
            int first = rig.Host.Count("unregister:albera-run-op-1");
            Assert(rig.Host.Existing.Contains("albera-run-op-1") && first >= 1, "the attempts so far failed");
            Reap(rig);
            Assert(rig.Host.Count("unregister:albera-run-op-1") > first, "tried again at the next tick");
            rig.Host.UnregisterOk = true;
            Reap(rig);
            Assert(rig.Host.Existing.Count == 0 && rig.Logged("TEARDOWN=recovered run=op-1"), "gone once unregister works");
            Assert(!Directory.Exists(RunFolder(rig)), "the folder went with it");
            int attempts = rig.Host.Count("unregister:albera-run-op-1");
            Reap(rig);
            Assert(rig.Host.Count("unregister:albera-run-op-1") == attempts, "nothing is left to try");
        });

        Check("reaper: a stop that failed to unregister is tried again as well", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.UnregisterOk = false;
            Same(Reason.UnregisterFailed, Refused(rig.Send(Verb.Stop, "op-1")), "stop");
            rig.Host.UnregisterOk = true;
            Reap(rig);
            Assert(rig.Host.Existing.Count == 0, "gone");
        });

        Check("reaper: an unregister that failed but worked is not repeated: the name is gone from the list, so only the folder is left", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.UnregisterOk = false;
            Refused(rig.Send(Verb.End, "op-1"));
            rig.Host.Existing.Clear();
            Reap(rig);
            Assert(rig.Host.Count("unregister:albera-run-op-1") == 1 && !Directory.Exists(RunFolder(rig)), "folder removed without a second unregister");
        });

        Check("reaper: a folder left after the unregister is collected without unregistering twice", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            FileStream held = new(Path.Combine(RunFolder(rig), "ext4.vhdx"), FileMode.Create, FileAccess.Write, FileShare.None);
            try
            {
                Assert(rig.Send(Verb.End, "op-1").Ok, "the distribution itself is gone, so end is ok");
                Assert(Directory.Exists(RunFolder(rig)) && rig.Logged("TEARDOWN=folder_failed run=op-1"), "the folder stayed and the log says so");
            }
            finally { held.Dispose(); }
            Reap(rig);
            Assert(!Directory.Exists(RunFolder(rig)) && rig.Host.Count("unregister:albera-run-op-1") == 1, "collected by the reaper");
        });

        Check("sweep: a run folder with no distribution is collected, and a folder that is not ours is left", () =>
        {
            using Rig rig = new();
            Directory.CreateDirectory(RunFolder(rig, "gone1"));
            string notOurs = Path.Combine(rig.Config.DistributionsFolder, "albera-runner");
            Directory.CreateDirectory(notOurs);
            Assert(rig.Bridge.SweepLeftoversAsync().GetAwaiter().GetResult() == 0, "no distribution was removed");
            Assert(!Directory.Exists(RunFolder(rig, "gone1")) && Directory.Exists(notOurs), "only the run folder");
            Assert(rig.Host.Count("unregister:") == 0, "nothing to unregister");
        });

        Check("stop during begin: the agent is cut off, the run is never registered and the distribution is gone", () =>
        {
            using Rig rig = new();
            using HeldBegin begin = new(rig);
            Assert(rig.Send(Verb.Stop, "op-1").Ok, "stop");
            Assert(rig.Host.LastAgent.Killed, "stop reaches the agent at once");
            begin.Release();
            Assert(begin.Reply.Wait(TimeSpan.FromSeconds(10)), "begin must return");
            Same(Reason.RunStopped, Refused(begin.Reply.Result), "begin");
            Assert(rig.Bridge.ActiveRuns == 0 && rig.Host.Existing.Count == 0, "nothing may be left");
            Same(Reason.NoRun, Refused(rig.Exec()), "no run to call");
        });

        Check("stop during begin: a second begin of the same id is refused while the first is in flight", () =>
        {
            using Rig rig = new();
            using HeldBegin begin = new(rig);
            Same(Reason.RunExists, Refused(rig.Begin()), "second begin");
            Assert(rig.Host.Count("import:") == 1, "only one import");
        });

        Check("stop all: waits for a begin in flight and leaves no distribution, and no begin starts afterwards", () =>
        {
            using Rig rig = new();
            using HeldBegin begin = new(rig);
            Task stopping = rig.Bridge.StopAllAsync();
            Assert(!stopping.Wait(TimeSpan.FromMilliseconds(300)), "stop all must wait for the begin");
            begin.Release();
            Assert(stopping.Wait(TimeSpan.FromSeconds(10)), "stop all must finish once the begin has");
            Same(Reason.RunStopped, Refused(begin.Reply.Result), "begin");
            Assert(rig.Host.Existing.Count == 0 && rig.Bridge.ActiveRuns == 0, "nothing may be left");
            Same(Reason.BridgeStopping, Refused(rig.Begin("op-2")), "a begin after the stop");
        });
    }

    private static void RevocationChecks()
    {
        Check("revocation: the floor is read at every begin, so rewriting the file revokes without a restart", () =>
        {
            using Rig rig = new();
            rig.BeginOk("op-1"); // generation 1 passes floor 1
            rig.SetFloor("3\r\n"); // the runbook's step, on a running bridge
            Same(Reason.LeaseGeneration, Refused(rig.Begin("op-2", rig.LeaseOfGeneration(2, "op-2"))), "below the new floor");
            Assert(rig.Ledger.CallsOf("op-2") == -1, "a refused lease does not use up its operation id");
            rig.BeginOk("op-3", rig.LeaseOfGeneration(3, "op-3"));
        });

        Check("revocation: a floor that cannot be read refuses every begin, and a readable one brings them back", () =>
        {
            using Rig rig = new();
            foreach (string bad in new[] { "", "\n", "two", "-1", "+1", "0", "1 2", " 1", "1.0", "9007199254740992", new string('1', 40) })
            {
                rig.SetFloor(bad);
                Same(Reason.LeaseFloorUnreadable, Refused(rig.Begin()), $"the text [{bad}]");
            }
            File.Delete(rig.FloorFile);
            Same(Reason.LeaseFloorUnreadable, Refused(rig.Begin()), "a missing file");
            NothingImported(rig, "unreadable floor");
            Assert(rig.Ledger.CallsOf("op-1") == -1, "the operation id is not used up");
            rig.SetFloor("1");
            rig.BeginOk();
        });

        Check("revocation: a floor file or folder that someone else can write is not read", () =>
        {
            using Rig rig = new();
            SecurityIdentifier everyone = new("S-1-1-0");
            FileInfo file = new(rig.FloorFile);
            FileSecurity loose = file.GetAccessControl();
            FileSystemAccessRule anyoneWrites = new(everyone, FileSystemRights.Write, AccessControlType.Allow);
            loose.AddAccessRule(anyoneWrites);
            file.SetAccessControl(loose);
            Same(Reason.LeaseFloorUnreadable, Refused(rig.Begin()), "loose file");
            loose.RemoveAccessRule(anyoneWrites);
            file.SetAccessControl(loose);
            Assert(rig.ReadFloor() == 1, "the same file with its ACL put right");
            DirectoryInfo folder = new(Path.GetDirectoryName(rig.FloorFile)!);
            DirectorySecurity looseFolder = folder.GetAccessControl();
            looseFolder.AddAccessRule(new FileSystemAccessRule(everyone, FileSystemRights.Write, AccessControlType.Allow));
            folder.SetAccessControl(looseFolder);
            Same(Reason.LeaseFloorUnreadable, Refused(rig.Begin()), "loose folder: the file could be swapped for an older one");
        });

        Check("revocation: a run below a raised floor is ended by the reaper, and a run at the floor goes on", () =>
        {
            using Rig rig = new();
            rig.BeginOk("op-1");
            rig.BeginOk("op-2", rig.LeaseOfGeneration(2, "op-2"));
            rig.SetFloor("2");
            Reap(rig);
            Assert(rig.Logged("REAP=generation run=op-1") && !rig.Host.Existing.Contains("albera-run-op-1"), "the old run is gone");
            Assert(rig.Host.Existing.Contains("albera-run-op-2") && rig.Bridge.ActiveRuns == 1, "the run at the floor goes on");
        });

        Check("revocation: a floor that cannot be read ends no run, and says so", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            File.Delete(rig.FloorFile);
            Reap(rig);
            Assert(rig.Bridge.ActiveRuns == 1 && rig.Logged("REAP=floor_unreadable"), "the run goes on until its lease ends");
            rig.Now += 601;
            Reap(rig);
            Assert(rig.Bridge.ActiveRuns == 0, "the lease's end still works without the floor");
        });
    }
}
