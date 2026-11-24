using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

// ADR-012 phase 4: the verbs `bundle` and `status`.
internal static partial class Harness
{
    private static JsonElement Json(Reply reply)
    {
        Assert(reply.Ok, "expected an ok reply but got " + reply.Reason);
        return JsonDocument.Parse(reply.Body).RootElement.Clone();
    }

    private static string? Word(JsonElement element, string name) => element.GetProperty(name).ValueKind == JsonValueKind.Null ? null : element.GetProperty(name).GetString();

    private static void BundleStatusChecks()
    {
        Check("bundle: the agent is asked for the clone and the bundle comes back whole", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            byte[] bundle = FakeRepositories.BundleOf(new string('b', 40));
            rig.Host.LastAgent.BundleBytes = bundle;
            Reply reply = rig.Send(Verb.Bundle, "op-1");
            Assert(reply.Ok && reply.Body.SequenceEqual(bundle), "the bundle");
            (byte op, byte[] body) = rig.Host.LastAgent.Requests[^1];
            Assert(op == 4, "OP_BUNDLE");
            Assert(BinaryPrimitives.ReadUInt32BigEndian(body) == 120, "120 s");
            Same("repo", Encoding.UTF8.GetString(body[4..]), "the path is the clone and nothing else");
            Assert(rig.Bridge.ActiveRuns == 1, "the run goes on");
        });

        Check("bundle: a bundle of exactly the limit is accepted", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.BundleBytes = new byte[rig.Limits.MaxBundleBytes];
            Assert(rig.Send(Verb.Bundle, "op-1").Ok, "at the limit");
        });

        Check("bundle: over the limit is refused as bundle_too_large with no bytes, and the run ends", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.BundleBytes = new byte[rig.Limits.MaxBundleBytes + 1];
            Reply reply = rig.Send(Verb.Bundle, "op-1");
            Same(Reason.BundleTooLarge, Refused(reply), "over the limit");
            Assert(reply.Body.Length == 0, "no partial bytes");
            Assert(Wire.Encode(reply).Length == 1 + Reason.BundleTooLarge.Length, "the wire reply is the word only");
            Ended(rig, "oversize bundle");
        });

        Check("bundle: the agent saying too large is the same word, and an agent failure is its own", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Host.LastAgent.BundleStatus = 2;
            Same(Reason.BundleTooLarge, Refused(rig.Send(Verb.Bundle, "op-1")), "agent status 2");
            rig.Host.LastAgent.BundleStatus = 5;
            Same(Reason.AgentFailed, Refused(rig.Send(Verb.Bundle, "op-1")), "agent status 5");
            Assert(rig.Bridge.ActiveRuns == 1, "a refusal by the agent does not end the run");
        });

        Check("bundle: without a run it is no_run", () =>
        {
            using Rig rig = new();
            Same(Reason.NoRun, Refused(rig.Send(Verb.Bundle, "op-1")), "no run");
        });

        Check("bundle: the job supplies no text, so a body is refused", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            int before = rig.Host.LastAgent.Requests.Count;
            Same(Reason.BadArgs, Refused(rig.Send(Verb.Bundle, "op-1", Encoding.UTF8.GetBytes("../x"))), "a body");
            Assert(rig.Host.LastAgent.Requests.Count == before, "nothing reached the agent");
        });

        Check("bundle: it counts as a call against maxCalls", () =>
        {
            using Rig rig = new();
            rig.BeginOk("op-1", lease: rig.Lease(tweak: body => body["maxCalls"] = 2L));
            Assert(rig.Send(Verb.Bundle, "op-1").Ok && rig.Send(Verb.Bundle, "op-1").Ok, "two calls");
            Same(Reason.CallsExhausted, Refused(rig.Send(Verb.Bundle, "op-1")), "third");
            Assert(rig.Ledger.CallsOf("op-1") == 2, "saved count");
        });

        Check("bundle: after the lease's end the run ends and the agent is not asked", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            int before = rig.Host.LastAgent.Requests.Count;
            rig.Now += 601;
            Same(Reason.LeaseExpired, Refused(rig.Send(Verb.Bundle, "op-1")), "expired");
            Assert(rig.Host.LastAgent.Requests.Count == before, "nothing reached the agent");
        });

        Check("bundle: the agent is told at most the time left", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            rig.Now += 595;
            Assert(rig.Send(Verb.Bundle, "op-1").Ok, "bundle");
            Assert(BinaryPrimitives.ReadUInt32BigEndian(rig.Host.LastAgent.Requests[^1].Body) == 5, "5 s");
        });

        Check("status: kernel ok, and the reply is the small JSON with no head when none was asked", () =>
        {
            using Rig rig = new();
            JsonElement reply = Json(rig.Send(Verb.Status, "status"));
            Assert(reply.GetProperty("kernelOk").GetBoolean() && Word(reply, "reason") is null, "ok");
            Assert(!reply.TryGetProperty("head", out _), "no head unless asked");
            Assert(rig.Host.Calls.All(call => call == "version"), "only the version was read: " + string.Join(',', rig.Host.Calls));
            Assert(rig.Bridge.ActiveRuns == 0, "no run, no lease");
        });

        Check("status: below the kernel floor, the WSL floor and unavailable WSL give their words", () =>
        {
            foreach ((WslVersions? versions, string word) in new (WslVersions?, string)[]
                { (new(new Version(2, 6, 3, 0), new Version(5, 15, 0)), Reason.KernelOld), (new(new Version(2, 0, 0, 0), new Version(6, 6, 87, 2)), Reason.WslOld), (null, Reason.WslUnavailable) })
            {
                using Rig rig = new();
                rig.Host.Versions = versions;
                JsonElement reply = Json(rig.Send(Verb.Status, "status"));
                Assert(!reply.GetProperty("kernelOk").GetBoolean(), word + ": kernelOk");
                Same(word, Word(reply, "reason")!, "reason");
            }
        });

        Check("status: an expired floor says floor_expired", () =>
        {
            using Rig rig = new();
            rig.Now = rig.Config.Floor.ExpiresAt + 1;
            JsonElement reply = Json(rig.Send(Verb.Status, "status"));
            Assert(!reply.GetProperty("kernelOk").GetBoolean(), "kernelOk");
            Same(Reason.FloorExpired, Word(reply, "reason")!, "reason");
        });

        Check("status: the answer is cached for 60 s, and wsl is read again after that", () =>
        {
            using Rig rig = new();
            for (int i = 0; i < 5; i++) Json(rig.Send(Verb.Status, "status"));
            Assert(rig.Host.Count("version") == 1, "five polls, one read: " + rig.Host.Count("version"));
            rig.Host.Versions = new(new Version(2, 6, 3, 0), new Version(5, 15, 0));
            rig.Now += 59;
            Assert(Json(rig.Send(Verb.Status, "status")).GetProperty("kernelOk").GetBoolean(), "still the cached answer at 59 s");
            rig.Now += 1;
            Assert(!Json(rig.Send(Verb.Status, "status")).GetProperty("kernelOk").GetBoolean(), "a new reading at 60 s");
            Assert(rig.Host.Count("version") == 2, "two reads");
        });

        Check("status: with a run in progress it still touches no distribution", () =>
        {
            using Rig rig = new();
            rig.BeginOk();
            int before = rig.Host.Calls.Count;
            Json(rig.Send(Verb.Status, "status"));
            Assert(rig.Host.Calls.Skip(before).All(call => call == "version"), "only the version");
            Assert(rig.Bridge.ActiveRuns == 1 && rig.Ledger.CallsOf("op-1") == 0, "no run touched, no call counted");
        });

        Check("status: a repository id adds the head the bridge reads; it is never cached and an unknown id or a git failure is null", () =>
        {
            using Rig rig = new();
            byte[] ask = Encoding.UTF8.GetBytes(Rig.Repository);
            Same(Rig.Head, Json(rig.Send(Verb.Status, "status", ask)).GetProperty("head").GetString()!, "known id");
            rig.Repos.Head = new string('c', 40);
            Same(new string('c', 40), Json(rig.Send(Verb.Status, "status", ask)).GetProperty("head").GetString()!, "a moved head is seen at once");
            Assert(Word(Json(rig.Send(Verb.Status, "status", Encoding.UTF8.GetBytes("nope"))), "head") is null, "unknown id");
            rig.Repos.Head = null;
            JsonElement failed = Json(rig.Send(Verb.Status, "status", ask));
            Assert(Word(failed, "head") is null && failed.GetProperty("kernelOk").GetBoolean(), "git failed: head null, kernel part intact");
            Assert(rig.Host.Count("version") == 1, "the kernel part stayed cached");
        });

        Check("status: a body that is too long or not UTF-8 is refused, and no word or path leaks into the reply", () =>
        {
            using Rig rig = new();
            Same(Reason.BadArgs, Refused(rig.Send(Verb.Status, "status", new byte[129])), "long");
            Same(Reason.BadArgs, Refused(rig.Send(Verb.Status, "status", [0xff, 0xfe])), "not UTF-8");
            string text = Encoding.UTF8.GetString(Json(rig.Send(Verb.Status, "status", Encoding.UTF8.GetBytes(Rig.Repository))).ToString().Select(c => (byte)c).ToArray());
            Assert(!text.Contains(Rig.SecretMark), "no path");
        });
    }
}
