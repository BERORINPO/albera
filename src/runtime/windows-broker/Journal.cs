using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

// The Broker's claim journal (ADR-002, Proposed / NOT VERIFIED; issue #84). Everything that touches SQLite lives here: the schema version, the forward
// migration, the claim insert, the stored outcome of an exact duplicate, and the side-effect-free read used by the fixed `synthetic.inspect` action.
//
// Schema version = PRAGMA user_version, written in the same transaction as the DDL (the Node store, sqlite-operation-store.mjs, uses the same mechanism):
//   0 + no table      fresh file: created at the current version
//   0 + legacy claims the unversioned journal of #22 / #23 (six columns): migrated forward to 2, every row kept
//   2                 current: claims gained request_digest (SHA-256 over the exact receipt bytes and signature, NULL for a migrated row)
//   > 2               written by a newer Broker: refused ("newer"), never opened for writing, never migrated backwards
//   1, < 0, 0 + any other table or column set, or a file SQLite cannot read: refused ("unsupported" / "unreadable"), nothing is changed
// A refusal at start-up is a fixed exit code (ExitJournalRefused) before the pipe exists; on a request it is a plain denial.
internal static class Journal
{
    internal const long CurrentVersion = 2;
    internal const string UnknownState = "UNKNOWN";

    // The only states a row may hold and a reply may carry (the client accepts exactly these). A row with any other value is treated as no record.
    private static readonly string[] RecordedStates = [UnknownState];
    private static readonly string[] LegacyColumns = ["operation_id", "receipt_id", "approval_id", "digest", "lease_generation", "state"];
    private static readonly string[] CurrentColumns = [.. LegacyColumns, "request_digest"];

    internal sealed class RefusedException(string reason) : Exception(reason)
    {
        public string Reason { get; } = reason;
    }

    internal readonly record struct Claim(string OperationId, string ReceiptId, string ApprovalId, string Digest, long LeaseGeneration, string RequestDigest);
    internal enum ClaimKind { Persisted, Replay, Rejected }

    /// <summary>SHA-256 over the exact receipt bytes and signature (length-prefixed, so the split between them is unambiguous), upper-case hex.</summary>
    internal static string RequestDigest(byte[] receipt, byte[] signature) =>
        Convert.ToHexString(SHA256.HashData([.. BitConverter.GetBytes(receipt.Length), .. receipt, .. signature]));

    /// <summary>Start-up check of an EXISTING journal: migrate it forward or refuse it. A missing file is fine (the first claim creates it at the current version).</summary>
    internal static async Task CheckExistingAsync(string database)
    {
        if (!File.Exists(database)) return;
        try
        {
            await using SqliteConnection db = Open(database, SqliteOpenMode.ReadWrite);
            await db.OpenAsync();
            await PrepareAsync(db);
        }
        catch (SqliteException) { throw new RefusedException("unreadable"); }
    }

    /// <summary>
    /// Insert the claim as UNKNOWN. A second request that hits a uniqueness rule is an exact duplicate only when the SAME operationId was recorded with
    /// the same receipt bytes and signature: then the recorded state comes back. Anything else (another receipt for that operation, a reused receiptId or
    /// approvalId, a migrated row that stored no digest, an unexpected stored state) is Rejected.
    /// </summary>
    internal static async Task<(ClaimKind Kind, string State)> ClaimAsync(string database, Claim claim)
    {
        await using SqliteConnection db = Open(database, SqliteOpenMode.ReadWriteCreate);
        await db.OpenAsync();
        await PrepareAsync(db);
        await using var tx = (SqliteTransaction)await db.BeginTransactionAsync();
        await using SqliteCommand insert = db.CreateCommand();
        insert.Transaction = tx;
        insert.CommandText = "INSERT INTO claims(operation_id, receipt_id, approval_id, digest, lease_generation, state, request_digest) VALUES ($o,$r,$a,$d,$g,'UNKNOWN',$q);";
        insert.Parameters.AddWithValue("$o", claim.OperationId); insert.Parameters.AddWithValue("$r", claim.ReceiptId);
        insert.Parameters.AddWithValue("$a", claim.ApprovalId); insert.Parameters.AddWithValue("$d", claim.Digest);
        insert.Parameters.AddWithValue("$g", claim.LeaseGeneration); insert.Parameters.AddWithValue("$q", claim.RequestDigest);
        try { await insert.ExecuteNonQueryAsync(); }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 19)
        {
            // The failed insert changed nothing and the transaction rolls back when it is disposed; this is a read only.
            await using SqliteCommand lookup = db.CreateCommand();
            lookup.Transaction = tx;
            lookup.CommandText = "SELECT state FROM claims WHERE operation_id = $o AND request_digest = $q;";
            lookup.Parameters.AddWithValue("$o", claim.OperationId); lookup.Parameters.AddWithValue("$q", claim.RequestDigest);
            return await lookup.ExecuteScalarAsync() is string state && RecordedStates.Contains(state) ? (ClaimKind.Replay, state) : (ClaimKind.Rejected, "");
        }
        await tx.CommitAsync();
        return (ClaimKind.Persisted, UnknownState);
    }

    /// <summary>
    /// The recorded state of one operation, or null when there is no such record. Opens the file read-only (never creates it, never migrates it, never
    /// writes a row); a journal that is not at the current version is refused rather than interpreted.
    /// </summary>
    internal static async Task<string?> RecordedStateAsync(string database, string operationId)
    {
        if (!File.Exists(database)) return null;
        await using SqliteConnection db = Open(database, SqliteOpenMode.ReadOnly);
        await db.OpenAsync();
        if (await UserVersionAsync(db) != CurrentVersion) throw new RefusedException("unsupported");
        await using SqliteCommand lookup = db.CreateCommand();
        lookup.CommandText = "SELECT state FROM claims WHERE operation_id = $o;";
        lookup.Parameters.AddWithValue("$o", operationId);
        return await lookup.ExecuteScalarAsync() is string state && RecordedStates.Contains(state) ? state : null;
    }

    private static SqliteConnection Open(string database, SqliteOpenMode mode) =>
        new(new SqliteConnectionStringBuilder { DataSource = database, Mode = mode }.ToString());

    private static async Task<long> UserVersionAsync(SqliteConnection db)
    {
        await using SqliteCommand command = db.CreateCommand();
        command.CommandText = "PRAGMA user_version;";
        return await command.ExecuteScalarAsync() is long version ? version : throw new RefusedException("unsupported");
    }

    private static async Task ExecuteAsync(SqliteConnection db, string sql)
    {
        await using SqliteCommand command = db.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<List<string>> NamesAsync(SqliteConnection db, string sql)
    {
        await using SqliteCommand command = db.CreateCommand();
        command.CommandText = sql;
        List<string> names = [];
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) names.Add(reader.GetString(0));
        return names;
    }

    private static Task<List<string>> ColumnsAsync(SqliteConnection db) => NamesAsync(db, "SELECT name FROM pragma_table_info('claims') ORDER BY cid;");
    private static Task<List<string>> TablesAsync(SqliteConnection db) => NamesAsync(db, "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name;");

    private enum Shape { Current, Fresh, Legacy }

    // Read-only classification: the version and, for anything but a newer version, the exact table and column set. Throws RefusedException otherwise.
    private static async Task<Shape> ShapeAsync(SqliteConnection db)
    {
        long version = await UserVersionAsync(db);
        if (version > CurrentVersion) throw new RefusedException("newer");
        if (version != 0 && version != CurrentVersion) throw new RefusedException("unsupported");
        if (version == CurrentVersion)
            return (await ColumnsAsync(db)).SequenceEqual(CurrentColumns) ? Shape.Current : throw new RefusedException("unsupported");
        List<string> tables = await TablesAsync(db);
        if (tables.Count == 0) return Shape.Fresh;
        return tables.SequenceEqual(["claims"]) && (await ColumnsAsync(db)).SequenceEqual(LegacyColumns) ? Shape.Legacy : throw new RefusedException("unsupported");
    }

    // Classify first and refuse before anything is written (not even journal_mode); then create / migrate inside one IMMEDIATE transaction that
    // classifies again, so the DDL and the new version number commit together or not at all.
    private static async Task PrepareAsync(SqliteConnection db)
    {
        await ShapeAsync(db);
        await ExecuteAsync(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        await ExecuteAsync(db, "BEGIN IMMEDIATE;");
        try
        {
            Shape shape = await ShapeAsync(db);
            if (shape == Shape.Fresh)
                await ExecuteAsync(db, "CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL, request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64));");
            else if (shape == Shape.Legacy)
                await ExecuteAsync(db, "ALTER TABLE claims ADD COLUMN request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64);");
            if (shape != Shape.Current) await ExecuteAsync(db, $"PRAGMA user_version = {CurrentVersion};");
            await ExecuteAsync(db, "COMMIT;");
        }
        catch
        {
            try { await ExecuteAsync(db, "ROLLBACK;"); }
            catch (SqliteException) { /* keep the original failure; a rollback that cannot run changes nothing */ }
            throw;
        }
    }
}
