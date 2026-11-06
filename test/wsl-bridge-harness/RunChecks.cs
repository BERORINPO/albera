using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

internal static partial class Harness
{
    private static void Ended(Rig rig, string what)
    {
        Assert(rig.Bridge.ActiveRuns == 0 && rig.Host.Count("terminate:albera-run-op-1") == 1 && rig.Host.Count("unregister:albera-run-op-1") == 1, what + ": the run must be terminated and unregistered");
        int terminate = rig.Host.Calls.IndexOf("terminate:albera-run-op-1"), unregister = rig.Host.Calls.IndexOf("unregister:albera-run-op-1");
        Assert(terminate >= 0 && terminate < unregister, what + ": terminate comes before unregister");
    }

    private static void RunChecks()
    {
        Check("exec, put and get go through the agent and come back", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            Reply exec = rig.Exec("echo hi");
            Assert(exec.Ok && Encoding.ASCII.GetString(exec.Body, 5, exec.Body.Length - 5) == "ok", "exec output");
            Assert(rig.Put("notes/a.txt", [1, 2, 3]).Ok, "put");
            Reply get = rig.Get("notes/a.txt");
            Assert(get.Ok && get.Body.SequenceEqual(new byte[] { 1, 2, 3 }), "get returns what was put");
            Same(Reason.AgentFileError, Refused(rig.Get("missing.txt")), "a file the agent cannot read");
            Assert(rig.Bridge.ActiveRuns == 1, "an agent refusal does not end the run");
        });

        Check("calls: the bridge counts every call against maxCalls and refuses the next", () =>
        {
            using Rig three = new();
            three.BeginOk("op-1", lease: three.Lease(tweak: body => body["maxCalls"] = 3L));
            for (int i = 0; i < 3; i++) Assert(three.Exec().Ok, $"call {i + 1}");
            Same(Reason.CallsExhausted, Refused(three.Exec()), "fourth call");
            Same(Reason.CallsExhausted, Refused(three.Get("a")), "a get counts too");
            Assert(three.Ledger.CallsOf("op-1") == 3, "saved count");
        });

        Check("lease end: a call after expiresAt ends the run", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Now += 601;
            Same(Reason.LeaseExpired, Refused(rig.Exec()), "after expiry");
            Ended(rig, "expiry");
        });

        Check("lease end: exec is told at most the time left, however long the caller asks", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Now += 590; // 10 s left
            Assert(rig.Exec(seconds: 100000).Ok, "exec");
            uint told = BinaryPrimitives.ReadUInt32BigEndian(rig.Host.LastAgent.Requests[^1].Body);
            Assert(told == 10, $"the agent was told {told} s");
        });

        Check("lease end: a command that does not answer by expiresAt is cut off and the run ends", () =>
        {
            using Rig rig = new();
            rig.BeginOk("op-1", lease: null);
            rig.Now += 599; // 1 s left
            rig.Host.LastAgent.Mode = AgentMode.Hang;
            Stopwatch clock = Stopwatch.StartNew();
            Same(Reason.AgentTimeout, Refused(rig.Exec(seconds: 3000)), "hang");
            Assert(clock.Elapsed < TimeSpan.FromSeconds(4), $"it took {clock.Elapsed.TotalSeconds:F1} s");
            Ended(rig, "cut off");
        });

        Check("lease end: the reaper ends a run in the middle of a command when the lease runs out", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.Mode = AgentMode.Hang;
            Task<Reply> running = Task.Run(() => rig.Exec(seconds: 500));
            Thread.Sleep(300);
            rig.Now += 601;
            rig.Bridge.ReapExpiredAsync().GetAwaiter().GetResult();
            Assert(running.Wait(TimeSpan.FromSeconds(5)), "the command in flight must be cut off");
            Same(Reason.AgentGone, Refused(running.Result), "cut-off command");
            Ended(rig, "reaper");
        });

        Check("stop: cuts off a command in flight, terminates, then unregisters", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.Mode = AgentMode.Hang;
            Task<Reply> running = Task.Run(() => rig.Exec(seconds: 500));
            Thread.Sleep(300);
            Assert(rig.Send(Verb.Stop, "op-1").Ok, "stop");
            Assert(running.Wait(TimeSpan.FromSeconds(5)), "exec must return");
            Assert(rig.Host.LastAgent.Killed, "agent stopped");
            Ended(rig, "stop");
            Same(Reason.NoRun, Refused(rig.Exec()), "a stopped run");
        });

        Check("end: terminates, then unregisters, and the run is gone", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            Assert(rig.Send(Verb.End, "op-1").Ok, "end");
            Ended(rig, "end");
            Assert(!Directory.Exists(Path.Combine(rig.Config.DistributionsFolder, "albera-run-op-1")), "folder removed");
            Same(Reason.NoRun, Refused(rig.Send(Verb.End, "op-1")), "end twice");
        });

        Check("end: a failed unregister is reported, not hidden", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.UnregisterOk = false;
            Same(Reason.UnregisterFailed, Refused(rig.Send(Verb.End, "op-1")), "unregister");
            Assert(rig.Logged("TEARDOWN=unregister_failed run=op-1"), "the word in the log");
        });

        Check("sizes: put over the cap, a long command and bad paths are refused without reaching the agent", () =>
        {
            using Rig rig = new();
            rig.BeginOk(lease: rig.Lease(tweak: body => body["maxCalls"] = 50L));
            int before = rig.Host.LastAgent.Requests.Count;
            Same(Reason.TooLarge, Refused(rig.Put("big", new byte[1025])), "put");
            Same(Reason.BadArgs, Refused(rig.Exec(new string('x', 129))), "command");
            foreach (string bad in new[] { "../x", "a/../x", "/etc/passwd", "a//b", "a\\b", "C:\\x", "x\0y", "a/", "" })
                Same(Reason.BadPath, Refused(rig.Put(bad, [1])), "put path " + bad.Replace("\0", "NUL"));
            Same(Reason.BadPath, Refused(rig.Get("../x")), "get path");
            Assert(rig.Host.LastAgent.Requests.Count == before, "nothing may reach the agent");
        });

        Check("agent limits: an output frame over the cap ends the run", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.Mode = AgentMode.Oversize;
            Same(Reason.AgentLimit, Refused(rig.Exec()), "oversize frame");
            Ended(rig, "oversize");
        });

        Check("agent limits: a file over the get cap ends the run", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.Mode = AgentMode.HugeRead;
            Same(Reason.AgentLimit, Refused(rig.Get("a")), "huge read");
            Ended(rig, "huge read");
        });

        Check("agent limits: an agent that dies ends the run", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.Mode = AgentMode.Die;
            Same(Reason.AgentGone, Refused(rig.Exec()), "dead agent");
            Ended(rig, "dead agent");
        });

        Check("only albera-run- names reach wsl, and the sweep leaves everything else alone", () =>
        {
            using Rig rig = new();
            rig.Host.Existing = ["Ubuntu", "docker-desktop", "albera-run-old1", "albera-runner", "albera-run-Bad Name", "albera-run-", "xalbera-run-x", "albera-run-old2"];
            Assert(rig.Bridge.SweepLeftoversAsync().GetAwaiter().GetResult() == 2, "two leftovers");
            rig.BeginOk();
            rig.Send(Verb.End, "op-1");
            foreach (string call in rig.Host.Calls.Where(call => call.Contains(':')))
                Assert(call.Split(':', 2)[1].StartsWith("albera-run-", StringComparison.Ordinal), "a call named something else: " + call.Split(':')[0]);
            string[] removed = rig.Host.Calls.Where(call => call.StartsWith("unregister:", StringComparison.Ordinal)).ToArray();
            Same("unregister:albera-run-old1|unregister:albera-run-old2|unregister:albera-run-op-1", string.Join('|', removed), "unregistered names");
        });

        Check("a second call while one is running is refused as busy, not queued", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.Mode = AgentMode.Hang;
            Task<Reply> running = Task.Run(() => rig.Exec(seconds: 500));
            Thread.Sleep(300);
            Same(Reason.RunBusy, Refused(rig.Get("a")), "second call");
            rig.Send(Verb.Stop, "op-1");
            running.Wait(TimeSpan.FromSeconds(5));
        });
    }
}
