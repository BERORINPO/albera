using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

// The Broker's journal (ADR-002, Proposed / NOT VERIFIED; issues #84 and the receipt v2 work). Everything that touches SQLite lives here: the schema, the
// forward migration, the Broker-owned fence state (epoch, lease generation, clock high-water mark), the single-use challenges, the claim insert, the stored
// outcome of an exact duplicate, and the side-effect-free read used by the fixed `inspect` request.
//
// Schema version = PRAGMA user_version, written in the same transaction as the DDL (the Node store, sqlite-operation-store.mjs, uses the same mechanism):
//   0 + no table      fresh file: created at the current version
//   0 + legacy claims the unversioned journal of #22 / #23 (six columns): migrated forward, every row kept
//   2                 claims gained request_digest (SHA-256 over the exact receipt bytes and signature, NULL for a migrated row): migrated forward
//   3                 current: + broker_state (one row: epoch, lease_generation, clock_high_water) and challenges (single-use, Broker-issued)
//   > 3               written by a newer Broker: refused ("newer"), never opened for writing, never migrated backwards
//   1, < 0, or any shape that is not EXACTLY the CREATE statements this file knows (compared with sqlite_schema, not just column names),
//   or a file SQLite cannot read: refused ("unsupported" / "unreadable"), nothing is changed
// A refusal at start-up is a fixed exit code (ExitJournalRefused) before RUNNING; on a request it is a plain denial.
//
// The fence state is Broker-owned: `epoch` goes up by one every time a Broker process starts (BeginEpochAsync, in the same transaction that deletes every
// challenge), so a challenge can never outlive the process that issued it; `lease_generation` starts at the configured value when the journal is first created
// and is never taken from a request; `clock_high_water` is the largest `iat` of an accepted claim.
internal static class Journal
{
    internal const long CurrentVersion = 3;
    internal const string UnknownState = "UNKNOWN";
    private const int MaxChallenges = 64; // oldest first; an evicted challenge is simply unknown (denied), so single use is never weakened

    // The only states a row may hold and a reply may carry (the client accepts exactly these). A row with any other value is treated as no record.
    private static readonly string[] RecordedStates = [UnknownState];

    // The exact CREATE statements, as SQLite stores them in sqlite_schema.sql (no trailing semicolon, no IF NOT EXISTS).
    private const string LegacyClaimsSql = "CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL)";
    private const string RequestDigestColumn = "request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64)";
    private const string ClaimsSql = "CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL, " + RequestDigestColumn + ")";
    private const string BrokerStateSql = "CREATE TABLE broker_state (id INTEGER PRIMARY KEY CHECK(id = 1), epoch INTEGER NOT NULL CHECK(epoch >= 0), lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1), clock_high_water INTEGER NOT NULL CHECK(clock_high_water >= 0))";
    private const string ChallengesSql = "CREATE TABLE challenges (challenge TEXT PRIMARY KEY CHECK(length(challenge) = 22), epoch INTEGER NOT NULL, lease_generation INTEGER NOT NULL, computer_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('issued', 'consumed')))";

    // `ALTER TABLE ... ADD COLUMN` makes SQLite append ", <column>" to the stored text of the migrated table, so a migrated claims table has its own exact text.
    private static readonly string MigratedClaimsSql = LegacyClaimsSql[..^1] + ", " + RequestDigestColumn + ")";

    internal sealed class RefusedException(string reason) : Exception(reason)
    {
        public string Reason { get; } = reason;
    }

    internal readonly record struct Claim(string OperationId, string ReceiptId, string ApprovalId, string Digest, long LeaseGeneration, string RequestDigest,
        string Challenge, long Epoch, string ComputerId, long IssuedAt);
    internal enum ClaimKind { Persisted, Rejected }
    internal readonly record struct FenceState(long Epoch, long LeaseGeneration, long ClockHighWater);
    internal readonly record struct ChallengeRow(long Epoch, long LeaseGeneration, string ComputerId, bool Consumed);
    internal readonly record struct ClaimContext(FenceState State, ChallengeRow? Challenge, string? RecordedState);
    internal readonly record struct IssuedChallenge(long Epoch, long LeaseGeneration, string Challenge);

    /// <summary>SHA-256 over the exact receipt bytes and signature (length-prefixed, so the split between them is unambiguous), upper-case hex.</summary>
    internal static string RequestDigest(byte[] receipt, byte[] signature) =>
        Convert.ToHexString(SHA256.HashData([.. BitConverter.GetBytes(receipt.Length), .. receipt, .. signature]));

    /// <summary>Start-up check of an EXISTING journal: migrate it forward or refuse it. A missing file is fine here (BeginEpochAsync creates it once the pipe is ours).</summary>
    internal static async Task CheckExistingAsync(string database, long initialGeneration)
    {
        if (!File.Exists(database)) return;
        try
        {
            await using SqliteConnection db = Open(database, SqliteOpenMode.ReadWrite);
            await db.OpenAsync();
            await PrepareAsync(db, initialGeneration);
        }
        catch (SqliteException) { throw new RefusedException("unreadable"); }
    }

    /// <summary>
    /// A Broker process starts a new epoch: create / migrate the journal, add one to the epoch and delete every challenge in one transaction. Called only after this
    /// process owns the pipe name, so a second Broker that loses the name race never touches the epoch of the one that is serving. Returns the new epoch.
    /// </summary>
    internal static async Task<long> BeginEpochAsync(string database, long initialGeneration)
    {
        try
        {
            await using SqliteConnection db = Open(database, SqliteOpenMode.ReadWriteCreate);
            await db.OpenAsync();
            await PrepareAsync(db, initialGeneration);
            return await InImmediateTransactionAsync(db, async () =>
            {
                await ExecuteAsync(db, "UPDATE broker_state SET epoch = epoch + 1 WHERE id = 1; DELETE FROM challenges;");
                return (await ReadStateAsync(db)).Epoch;
            });
        }
        catch (SqliteException) { throw new RefusedException("unreadable"); }
    }

    /// <summary>
    /// Issue one single-use challenge for `computerId`, bound to the current epoch and lease generation. Null when the journal's epoch is not `expectedEpoch`
    /// (another process changed the epoch, or the file was replaced): this Broker no longer owns the journal it started with.
    /// </summary>
    internal static async Task<IssuedChallenge?> IssueChallengeAsync(string database, long expectedEpoch, string computerId)
    {
        await using SqliteConnection db = Open(database, SqliteOpenMode.ReadWrite);
        await db.OpenAsync();
        await RequireCurrentVersionAsync(db);
        return await InImmediateTransactionAsync<IssuedChallenge?>(db, async () =>
        {
            FenceState state = await ReadStateAsync(db);
            if (state.Epoch != expectedEpoch) return null;
            string challenge = NewChallenge();
            await using SqliteCommand insert = db.CreateCommand();
            insert.CommandText = "INSERT INTO challenges(challenge, epoch, lease_generation, computer_id, state) VALUES ($c, $e, $g, $m, 'issued');" +
                " DELETE FROM challenges WHERE challenge IN (SELECT challenge FROM challenges ORDER BY rowid DESC LIMIT -1 OFFSET " + MaxChallenges + ");";
            insert.Parameters.AddWithValue("$c", challenge); insert.Parameters.AddWithValue("$e", state.Epoch);
            insert.Parameters.AddWithValue("$g", state.LeaseGeneration); insert.Parameters.AddWithValue("$m", computerId);
            await insert.ExecuteNonQueryAsync();
            return new IssuedChallenge(state.Epoch, state.LeaseGeneration, challenge);
        });
    }

    /// <summary>128 random bits as unpadded base64url: 22 characters, the last one one of A Q g w (the canonical form the receipt grammar demands).</summary>
    private static string NewChallenge() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Everything a claim needs to be judged, read through one read-only connection (never creates, migrates or writes).</summary>
    internal static async Task<ClaimContext> ReadClaimContextAsync(string database, string challenge, string operationId, string requestDigest)
    {
        if (!File.Exists(database)) throw new RefusedException("unreadable");
        await using SqliteConnection db = Open(database, SqliteOpenMode.ReadOnly);
        await db.OpenAsync();
        await RequireCurrentVersionAsync(db);
        FenceState state = await ReadStateAsync(db);
        ChallengeRow? row = null;
        await using (SqliteCommand lookup = db.CreateCommand())
        {
            lookup.CommandText = "SELECT epoch, lease_generation, computer_id, state FROM challenges WHERE challenge = $c;";
            lookup.Parameters.AddWithValue("$c", challenge);
            await using SqliteDataReader reader = await lookup.ExecuteReaderAsync();
            if (await reader.ReadAsync()) row = new ChallengeRow(reader.GetInt64(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3) == "consumed");
        }
        await using SqliteCommand recorded = db.CreateCommand();
        recorded.CommandText = "SELECT state FROM claims WHERE operation_id = $o AND request_digest = $q;"; // a NULL digest never matches
        recorded.Parameters.AddWithValue("$o", operationId); recorded.Parameters.AddWithValue("$q", requestDigest);
        string? recordedState = await recorded.ExecuteScalarAsync() as string;
        return new ClaimContext(state, row, recordedState is not null && RecordedStates.Contains(recordedState) ? recordedState : null);
    }

    /// <summary>
    /// Consume the challenge, insert the claim as UNKNOWN and raise the clock high-water mark, in one IMMEDIATE transaction. The challenge update repeats the
    /// checks inside the transaction (still issued, same epoch / generation / computer, and both still the journal's current values), so nothing is decided on a
    /// stale read. Any uniqueness collision (operationId, receiptId, approvalId) rolls everything back, the challenge included: Rejected("duplicate").
    /// </summary>
    internal static async Task<(ClaimKind Kind, string Reason)> ClaimAsync(string database, Claim claim)
    {
        await using SqliteConnection db = Open(database, SqliteOpenMode.ReadWrite);
        await db.OpenAsync();
        await RequireCurrentVersionAsync(db);
        try { return await ClaimInTransactionAsync(db, claim); }
        catch (CollisionException) { return (ClaimKind.Rejected, "duplicate"); }
    }

    private static Task<(ClaimKind Kind, string Reason)> ClaimInTransactionAsync(SqliteConnection db, Claim claim) =>
        InImmediateTransactionAsync(db, async () =>
        {
            await using SqliteCommand consume = db.CreateCommand();
            consume.CommandText = "UPDATE challenges SET state = 'consumed' WHERE challenge = $c AND state = 'issued' AND epoch = $e AND lease_generation = $g AND computer_id = $m" +
                " AND epoch = (SELECT epoch FROM broker_state WHERE id = 1) AND lease_generation = (SELECT lease_generation FROM broker_state WHERE id = 1);";
            consume.Parameters.AddWithValue("$c", claim.Challenge); consume.Parameters.AddWithValue("$e", claim.Epoch);
            consume.Parameters.AddWithValue("$g", claim.LeaseGeneration); consume.Parameters.AddWithValue("$m", claim.ComputerId);
            if (await consume.ExecuteNonQueryAsync() != 1) return (ClaimKind.Rejected, "challenge_unusable");

            await using SqliteCommand insert = db.CreateCommand();
            insert.CommandText = "INSERT INTO claims(operation_id, receipt_id, approval_id, digest, lease_generation, state, request_digest) VALUES ($o,$r,$a,$d,$g,'UNKNOWN',$q);" +
                " UPDATE broker_state SET clock_high_water = MAX(clock_high_water, $i) WHERE id = 1;";
            insert.Parameters.AddWithValue("$o", claim.OperationId); insert.Parameters.AddWithValue("$r", claim.ReceiptId);
            insert.Parameters.AddWithValue("$a", claim.ApprovalId); insert.Parameters.AddWithValue("$d", claim.Digest);
            insert.Parameters.AddWithValue("$g", claim.LeaseGeneration); insert.Parameters.AddWithValue("$q", claim.RequestDigest);
            insert.Parameters.AddWithValue("$i", claim.IssuedAt);
            try { await insert.ExecuteNonQueryAsync(); }
            catch (SqliteException ex) when (ex.SqliteErrorCode == 19) { throw new CollisionException(); }
            return (ClaimKind.Persisted, "");
        });

    private sealed class CollisionException : Exception;

    /// <summary>
    /// The recorded state of one operation, or null when there is no such record. Opens the file read-only (never creates it, never migrates it, never
    /// writes a row); a journal that is not at the current version is refused rather than interpreted.
    /// </summary>
    internal static async Task<string?> RecordedStateAsync(string database, string operationId)
    {
        if (!File.Exists(database)) return null;
        await using SqliteConnection db = Open(database, SqliteOpenMode.ReadOnly);
        await db.OpenAsync();
        await RequireCurrentVersionAsync(db);
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

    private static async Task RequireCurrentVersionAsync(SqliteConnection db)
    {
        if (await UserVersionAsync(db) != CurrentVersion) throw new RefusedException("unsupported");
    }

    private static async Task<FenceState> ReadStateAsync(SqliteConnection db)
    {
        await using SqliteCommand command = db.CreateCommand();
        command.CommandText = "SELECT epoch, lease_generation, clock_high_water FROM broker_state WHERE id = 1;";
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        return await reader.ReadAsync() ? new FenceState(reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2)) : throw new RefusedException("unsupported");
    }

    private static async Task ExecuteAsync(SqliteConnection db, string sql)
    {
        await using SqliteCommand command = db.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }

    // BEGIN IMMEDIATE ... COMMIT around `body`; any exception rolls the transaction back and propagates.
    private static async Task<T> InImmediateTransactionAsync<T>(SqliteConnection db, Func<Task<T>> body)
    {
        await ExecuteAsync(db, "BEGIN IMMEDIATE;");
        try
        {
            T result = await body();
            await ExecuteAsync(db, "COMMIT;");
            return result;
        }
        catch
        {
            await RollbackQuietlyAsync(db);
            throw;
        }
    }

    private static async Task RollbackQuietlyAsync(SqliteConnection db)
    {
        try { await ExecuteAsync(db, "ROLLBACK;"); }
        catch (SqliteException) { /* keep the original failure; a rollback that cannot run changes nothing */ }
    }

    // Every object SQLite stores for this database as "type|name|sql", by name. Internal tables and indexes (sqlite_sequence, sqlite_autoindex_*) are skipped;
    // the LIKE needs an ESCAPE because '_' is itself a wildcard, which would also hide a user table such as "sqliteXfoo".
    private static async Task<List<string>> SchemaAsync(SqliteConnection db)
    {
        await using SqliteCommand command = db.CreateCommand();
        command.CommandText = "SELECT type || '|' || name || '|' || COALESCE(sql, '') FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name;";
        List<string> objects = [];
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) objects.Add(reader.GetString(0));
        return objects;
    }

    private static string Table(string name, string sql) => $"table|{name}|{sql}";
    private static readonly string[] LegacySchema = [Table("claims", LegacyClaimsSql)];
    private static readonly string[] Version2Schema = [Table("claims", ClaimsSql)];
    private static readonly string[] Version2MigratedSchema = [Table("claims", MigratedClaimsSql)];
    private static string[] CurrentSchema(string claimsSql) => [Table("broker_state", BrokerStateSql), Table("challenges", ChallengesSql), Table("claims", claimsSql)];

    private enum Shape { Current, Fresh, Legacy, Version2 }

    // Read-only classification: the version and, for anything but a newer version, the exact objects and CREATE statements. Throws RefusedException otherwise.
    private static async Task<Shape> ShapeAsync(SqliteConnection db)
    {
        long version = await UserVersionAsync(db);
        if (version > CurrentVersion) throw new RefusedException("newer");
        if (version != 0 && version != 2 && version != CurrentVersion) throw new RefusedException("unsupported");
        List<string> schema = await SchemaAsync(db);
        bool Is(params string[][] allowed) => allowed.Any(candidate => schema.SequenceEqual(candidate));
        if (version == CurrentVersion) return Is(CurrentSchema(ClaimsSql), CurrentSchema(MigratedClaimsSql)) ? Shape.Current : throw new RefusedException("unsupported");
        if (version == 2) return Is(Version2Schema, Version2MigratedSchema) ? Shape.Version2 : throw new RefusedException("unsupported");
        if (schema.Count == 0) return Shape.Fresh;
        return Is(LegacySchema) ? Shape.Legacy : throw new RefusedException("unsupported");
    }

    // Classify first and refuse before anything is written (not even journal_mode); then create / migrate inside one IMMEDIATE transaction that
    // classifies again, so the DDL, the first fence row and the new version number commit together or not at all.
    private static async Task PrepareAsync(SqliteConnection db, long initialGeneration)
    {
        await ShapeAsync(db);
        await ExecuteAsync(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        await ExecuteAsync(db, "BEGIN IMMEDIATE;");
        try
        {
            Shape shape = await ShapeAsync(db);
            if (shape == Shape.Fresh) await ExecuteAsync(db, ClaimsSql);
            else if (shape == Shape.Legacy) await ExecuteAsync(db, "ALTER TABLE claims ADD COLUMN " + RequestDigestColumn + ";");
            if (shape != Shape.Current)
            {
                await ExecuteAsync(db, BrokerStateSql);
                await ExecuteAsync(db, ChallengesSql);
                await ExecuteAsync(db, $"INSERT INTO broker_state(id, epoch, lease_generation, clock_high_water) VALUES (1, 0, {initialGeneration}, 0);");
                await ExecuteAsync(db, $"PRAGMA user_version = {CurrentVersion};");
            }
            await ExecuteAsync(db, "COMMIT;");
        }
        catch
        {
            await RollbackQuietlyAsync(db);
            throw;
        }
    }
}
