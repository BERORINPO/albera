using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Albera.BrokerContract;

// The three requests of the Broker's pipe (ADR-002 "Receipt v2", Proposed / NOT VERIFIED). One frame per connection, at most 2 KiB, after the peer SID check:
//   claim    { "receipt": <base64>, "signature": <base64> }   exactly these two keys. The receipt is v2 or v3 (src/runtime/broker-contract; v3 adds `basis`, see
//                                                              ReceiptV3.cs) and names a challenge that THIS Broker issued with `fence`.
//   fence    { "fence": { "computerId": "<id>" } }             -> { "ok": true, "brokerEpoch": n, "leaseGeneration": n, "leaseId": "<id>", "brokerChallenge": "<22 chars>" }
//   inspect  { "inspect": { "operationId": "<id>" } }          -> { "ok": true, "state": "UNKNOWN", "action": "synthetic.inspect" }; read-only
// The three shapes cannot be confused: they differ in their key set. Every refusal is the one fixed `denied` reply; the reason is a fixed word on stdout only
// (DENY=<reason>), never request text.
//
// What a claim must pass, in this order (the first failure is the logged reason):
//   structure (Receipts.Parse: v3 when the bytes claim "v":3, otherwise v2) -> kid is a pinned key -> ECDSA signature over the exact receipt bytes -> the journal's epoch is the one this process started
//   -> the clock fence (now >= clock_high_water - 30 s) -> the challenge is known, unconsumed, from this epoch and lease generation, and was issued for the
//   receipt's computerId -> Receipts.Validate (TTL <= 300 s, iat <= now + 30, now < exp, issuer, bindings, and the action digest RECOMPUTED from the trusted DTO; for v3 also: basis
//   "policy" only for the few actions a policy may ever skip)
//   -> one transaction: consume the challenge, insert the claim, raise the clock high-water mark.
// An exact duplicate (same operationId, same receipt bytes and signature as a recorded claim) skips the challenge checks, because its challenge was spent (or
// wiped by a restart) when it was first claimed; it still passes the signature, the clock fence and every time / issuer / digest check, and answers with the
// recorded outcome plus `"replayed": true`.
internal static partial class Program
{
    private const string BrokerAudience = "albera-host-broker";
    private const string SyntheticAction = "synthetic.noop";
    private const string SyntheticPurpose = "broker.operation";

#if ALBERA_BROKER_TEST_FAULTS
    private const string ReceiptEnvironment = "test"; // the test-faults build also accepts `albera-test-*` issuers
#else
    private const string ReceiptEnvironment = "production";
#endif

    private sealed record BrokerReply(byte[] Body, bool IsFence = false)
    {
        public static readonly BrokerReply Denied = new(Encoding.UTF8.GetBytes(Program.Denied));
    }

    private static BrokerReply Deny(string reason)
    {
        Console.WriteLine("DENY=" + reason);
        return BrokerReply.Denied;
    }

    private static async Task<BrokerReply> HandleRequestAsync(byte[] frame, BrokerSettings settings)
    {
        using JsonDocument envelope = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement root = envelope.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return Deny("request");
        JsonProperty[] properties = [.. root.EnumerateObject()];
        if (properties.Length == 1 && properties[0].NameEquals("fence")) return await FenceAsync(properties[0].Value, settings);
        if (properties.Length == 1 && properties[0].NameEquals("inspect")) return await InspectAsync(properties[0].Value, settings);
        if (properties.Length == 2 && root.TryGetProperty("receipt", out JsonElement receipt) && receipt.ValueKind == JsonValueKind.String &&
            root.TryGetProperty("signature", out JsonElement signature) && signature.ValueKind == JsonValueKind.String)
            return await ClaimAsync(Convert.FromBase64String(receipt.GetString()!), Convert.FromBase64String(signature.GetString()!), settings);
        return Deny("request");
    }

    // The value of a one-key object such as { "computerId": "<id>" }: null unless it is exactly that and the string is a contract id.
    private static string? OnlyId(JsonElement element, string name)
    {
        JsonProperty[] properties = element.ValueKind == JsonValueKind.Object ? [.. element.EnumerateObject()] : [];
        return properties.Length == 1 && properties[0].NameEquals(name) && properties[0].Value.ValueKind == JsonValueKind.String &&
            properties[0].Value.GetString() is { } value && AuthorityKey.IsKeyId(value) ? value : null;
    }

    private static async Task<BrokerReply> FenceAsync(JsonElement body, BrokerSettings settings)
    {
        if (OnlyId(body, "computerId") is not { } computerId) return Deny("request");
        if (await Journal.IssueChallengeAsync(settings.Database, settings.Epoch, computerId, NowSeconds()) is not { } issued) return Deny("epoch_mismatch");
        Console.WriteLine("FENCE=ISSUED");
        string json = string.Create(CultureInfo.InvariantCulture, $"{{\"ok\":true,\"brokerEpoch\":{issued.Epoch},\"leaseGeneration\":{issued.LeaseGeneration},\"leaseId\":\"{settings.LeaseId}\",\"brokerChallenge\":\"{issued.Challenge}\"}}");
        return new BrokerReply(Encoding.UTF8.GetBytes(json), IsFence: true);
    }

    // Read-only: the journal is opened read-only, no row is written, nothing is consumed and no receipt is involved. The caller is already the one authenticated
    // peer; what it learns (that an operation it submitted is recorded as UNKNOWN) is what the reply to its claim said.
    private static async Task<BrokerReply> InspectAsync(JsonElement body, BrokerSettings settings)
    {
        if (OnlyId(body, "operationId") is not { } operationId) return Deny("request");
        if (await Journal.RecordedStateAsync(settings.Database, operationId) is not { } recorded) return Deny("inspect-unknown");
        Console.WriteLine("INSPECT=RECORDED");
        return Success(recorded, "synthetic.inspect", replayed: false);
    }

    private static async Task<BrokerReply> ClaimAsync(byte[] receipt, byte[] signature, BrokerSettings settings)
    {
        ReceiptVerdict parsed = Receipts.Parse(receipt);
        if (!parsed.Ok) return Deny(parsed.Code!);
        IReadOnlyDictionary<string, object> r = parsed.Receipt!;
        string kid = (string)r["kid"];
        if (settings.AuthorityKeys.FirstOrDefault(key => key.Kid == kid) is not { } authorityKey) return Deny("kid_unknown");
        using (ECDsa authority = ECDsa.Create())
        {
            authority.ImportSubjectPublicKeyInfo(authorityKey.Spki, out _);
            if (!authority.VerifyData(receipt, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) return Deny("signature");
        }

        string operationId = (string)r["operationId"], challengeId = (string)r["brokerChallenge"], computerId = (string)r["computerId"];
        string requestDigest = Journal.RequestDigest(receipt, signature);
        Journal.ClaimContext context = await Journal.ReadClaimContextAsync(settings.Database, challengeId, operationId, requestDigest);
        long now = NowSeconds();
        if (context.State.Epoch != settings.Epoch) return Deny("epoch_mismatch");
        if (now < context.State.ClockHighWater - ReceiptV2.MaxIatSkewSeconds) return Deny("clock_rollback");

        bool replay = context.RecordedState is not null;
        if (!replay && ChallengeRefusal(context, computerId) is { } refusal) return Deny(refusal);

        // Expected comes from Broker-trusted state. For a replay the fence values are the receipt's own: they were checked when it was first claimed, and a
        // restart has since wiped the challenge, so there is nothing current left to compare them with.
        long epoch = replay ? (long)r["brokerEpoch"] : context.State.Epoch, generation = replay ? (long)r["leaseGeneration"] : context.State.LeaseGeneration;
        ReceiptVerdict verdict = Receipts.Validate(receipt, TrustedContext(r, now, epoch, generation, settings));
        if (!verdict.Ok) return Deny(ReasonOf(verdict, (string)r["issuer"]));

        if (replay)
        {
            Console.WriteLine("REPLAY=RECORDED_OUTCOME");
            return Success(context.RecordedState!, SyntheticAction, replayed: true);
        }
        (Journal.ClaimKind kind, string reason) = await Journal.ClaimAsync(settings.Database, new Journal.Claim(operationId, (string)r["receiptId"], (string)r["approvalId"],
            (string)r["actionDigest"], generation, requestDigest, challengeId, epoch, computerId, (long)r["iat"]));
        if (kind == Journal.ClaimKind.Rejected) return Deny(reason);
        Console.WriteLine("CLAIM=PERSISTED_UNKNOWN");
        if (settings.Hold is { } holdFor) await Task.Delay(holdFor); // test hook: `serve ... hold` holds forever, the seam build's loop entry holds for a fixed time
        return Success(Journal.UnknownState, SyntheticAction, replayed: false);
    }

    private static string? ChallengeRefusal(Journal.ClaimContext context, string computerId) => context.Challenge switch
    {
        null => "challenge_unknown",
        { Consumed: true } => "challenge_consumed",
        { } challenge when challenge.Epoch != context.State.Epoch => "epoch_mismatch",
        { } challenge when challenge.LeaseGeneration != context.State.LeaseGeneration => "generation_stale",
        { } challenge when challenge.ComputerId != computerId => "computer_mismatch",
        _ => null,
    };

    // The synthetic actions have a fixed DTO ({action, projectId, computerId, args:{}}); only the two ids come from the (signed) receipt, and the digest in the
    // receipt is compared with the one computed here from this DTO.
    private static ReceiptContext TrustedContext(IReadOnlyDictionary<string, object> r, long now, long epoch, long generation, BrokerSettings settings)
    {
        Dictionary<string, object> action = new()
        {
            ["action"] = SyntheticAction, ["projectId"] = r["projectId"], ["computerId"] = r["computerId"], ["args"] = new Dictionary<string, object>(),
        };
        Dictionary<string, object> expected = new()
        {
            ["audience"] = BrokerAudience, ["purpose"] = SyntheticPurpose, ["operationId"] = r["operationId"], ["idempotencyKey"] = r["idempotencyKey"],
            ["leaseId"] = settings.LeaseId, ["leaseGeneration"] = generation, ["brokerEpoch"] = epoch, ["brokerChallenge"] = r["brokerChallenge"],
            ["policyVersion"] = settings.PolicyVersion,
        };
        return new ReceiptContext(() => now, ReceiptEnvironment, expected, action);
    }

    // The contract's verdict codes are already fixed words; a few are renamed to the Broker's log vocabulary.
    private static string ReasonOf(ReceiptVerdict verdict, string issuer) => verdict.Code switch
    {
        "issuer" => issuer.StartsWith("albera-test-", StringComparison.Ordinal) ? "issuer_test" : "issuer",
        "ttl" => "ttl_exceeded",
        "binding" => verdict.Field switch { "brokerEpoch" => "epoch_mismatch", "leaseGeneration" => "generation_stale", "brokerChallenge" => "challenge_unknown", _ => "binding" },
        { } code => code,
        null => "invalid",
    };

    // `state` is always one of Journal's recorded states (the client accepts exactly these); `replayed` is present, and true, only for an exact duplicate.
    private static BrokerReply Success(string state, string action, bool replayed) =>
        new(Encoding.UTF8.GetBytes($"{{\"ok\":true,\"state\":\"{state}\",\"action\":\"{action}\"{(replayed ? ",\"replayed\":true" : "")}}}"));
}
