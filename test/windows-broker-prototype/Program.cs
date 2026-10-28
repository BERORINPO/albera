using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class Program
{
    private const int MaxFrameLength = 4096;
    private const string Denied = "{\"ok\":false,\"code\":\"denied\"}";

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "inspect") return await InspectAsync(args[1]);
        if (args.Length != 7 || args[0] != "serve") return 64;
        string pipeName = args[1], database = args[2];
        byte[] publicKey = Convert.FromBase64String(args[3]);
        string allowedSid = args[4];
        long generation = long.Parse(args[5], System.Globalization.CultureInfo.InvariantCulture);
        bool hold = args[6] == "hold";

        await using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        Console.WriteLine("BROKER_READY");
        await pipe.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(20));
        byte[] response;
        try
        {
            byte[] frame = await ReadFrameAsync(pipe);
            string? peerSid = null;
            pipe.RunAsClient(() =>
            {
                using WindowsIdentity identity = WindowsIdentity.GetCurrent(ifImpersonating: true)
                    ?? throw new UnauthorizedAccessException();
                peerSid = identity.User?.Value;
            });
            Console.WriteLine(peerSid == allowedSid ? "PEER=authenticated" : "PEER=denied");
            response = string.Equals(peerSid, allowedSid, StringComparison.Ordinal)
                ? await ValidateAndClaimAsync(frame, database, publicKey, generation, hold)
                : Encoding.UTF8.GetBytes(Denied);
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or
                                   CryptographicException or FormatException or UnauthorizedAccessException or
                                   SqliteException or ArgumentException)
        {
            response = Encoding.UTF8.GetBytes(Denied);
            Console.WriteLine("REQUEST=DENIED");
        }
        await WriteFrameAsync(pipe, response);
        return 0;
    }

    private static async Task<byte[]> ValidateAndClaimAsync(byte[] frame, string database, byte[] key, long currentGeneration, bool hold)
    {
        using JsonDocument envelope = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement root = envelope.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
            !root.TryGetProperty("receipt", out JsonElement receiptElement) || receiptElement.ValueKind != JsonValueKind.String ||
            !root.TryGetProperty("signature", out JsonElement signatureElement) || signatureElement.ValueKind != JsonValueKind.String)
            return Encoding.UTF8.GetBytes(Denied);
        byte[] receipt = Convert.FromBase64String(receiptElement.GetString()!);
        byte[] signature = Convert.FromBase64String(signatureElement.GetString()!);
        using ECDsa authority = ECDsa.Create();
        authority.ImportSubjectPublicKeyInfo(key, out int used);
        if (used != key.Length || !authority.VerifyData(receipt, signature, HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) { Console.WriteLine("DENY=signature"); return Encoding.UTF8.GetBytes(Denied); }

        using JsonDocument signed = JsonDocument.Parse(receipt, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement r = signed.RootElement;
        string[] fields = ["issuer", "audience", "approvalId", "receiptId", "operationId", "idempotencyKey", "action", "actionDigest", "leaseId", "leaseGeneration", "policyVersion", "expiresAt"];
        if (r.ValueKind != JsonValueKind.Object || r.EnumerateObject().Count() != fields.Length || fields.Any(x => !r.TryGetProperty(x, out _))) { Console.WriteLine("DENY=schema"); return Encoding.UTF8.GetBytes(Denied); }
        string Get(string name) => RequiredString(r, name);
        string action = Get("action");
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(action)));
        long leaseGeneration = r.GetProperty("leaseGeneration").GetInt64();
        if (Get("issuer") != "albera-test-approval-authority" || Get("audience") != "ALBERA-HostBroker" ||
            action != "synthetic.noop" || Get("actionDigest") != digest || Get("leaseId") != "test-lease" ||
            leaseGeneration != currentGeneration || Get("policyVersion") != "test-policy-v1" ||
            r.GetProperty("expiresAt").GetInt64() <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() ||
            fields.Where(x => x is "approvalId" or "receiptId" or "operationId" or "idempotencyKey").Any(x => string.IsNullOrWhiteSpace(Get(x))))
        { Console.WriteLine("DENY=receipt-policy"); return Encoding.UTF8.GetBytes(Denied); }

        await using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Mode = SqliteOpenMode.ReadWriteCreate }.ToString());
        await db.OpenAsync();
        await using (var setup = db.CreateCommand())
        {
            setup.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL);";
            await setup.ExecuteNonQueryAsync();
        }
        await using var tx = await db.BeginTransactionAsync();
        await using var claim = db.CreateCommand();
        claim.Transaction = (SqliteTransaction)tx;
        claim.CommandText = "INSERT INTO claims(operation_id, receipt_id, approval_id, digest, lease_generation, state) VALUES ($o,$r,$a,$d,$g,'UNKNOWN');";
        claim.Parameters.AddWithValue("$o", Get("operationId")); claim.Parameters.AddWithValue("$r", Get("receiptId"));
        claim.Parameters.AddWithValue("$a", Get("approvalId")); claim.Parameters.AddWithValue("$d", digest);
        claim.Parameters.AddWithValue("$g", leaseGeneration);
        try { await claim.ExecuteNonQueryAsync(); }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 19) { Console.WriteLine("DENY=duplicate"); return Encoding.UTF8.GetBytes(Denied); }
        await tx.CommitAsync();
        Console.WriteLine("CLAIM=PERSISTED_UNKNOWN");
        if (hold) await Task.Delay(Timeout.InfiniteTimeSpan);
        return Encoding.UTF8.GetBytes("{\"ok\":true,\"state\":\"UNKNOWN\",\"action\":\"synthetic.noop\"}");
    }

    private static string RequiredString(JsonElement element, string name) => element.GetProperty(name).ValueKind == JsonValueKind.String ? element.GetProperty(name).GetString()! : throw new JsonException();
    private static async Task<byte[]> ReadFrameAsync(Stream stream)
    {
        byte[] size = new byte[4]; await stream.ReadExactlyAsync(size);
        int length = BitConverter.ToInt32(size); if (length < 1 || length > MaxFrameLength) throw new InvalidDataException();
        byte[] frame = new byte[length]; await stream.ReadExactlyAsync(frame); return frame;
    }
    private static async Task WriteFrameAsync(Stream stream, byte[] frame)
    {
        await stream.WriteAsync(BitConverter.GetBytes(frame.Length)); await stream.WriteAsync(frame); await stream.FlushAsync();
    }
    private static async Task<int> InspectAsync(string database)
    {
        if (!File.Exists(database)) { Console.WriteLine("0"); return 0; }
        await using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Mode = SqliteOpenMode.ReadOnly }.ToString());
        await db.OpenAsync(); await using var command = db.CreateCommand(); command.CommandText = "SELECT COUNT(*) FROM claims;";
        Console.WriteLine(await command.ExecuteScalarAsync()); return 0;
    }
}
