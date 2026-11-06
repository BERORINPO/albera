namespace Albera.WslBridge;

// The only words a refusal ever carries, on the pipe and in the log (ADR-012: fixed words only). A word never contains a path, a repository name, a lease value or anything a job wrote,
// so a log line or a reply cannot be steered by content. A check in the harness fails if a reply carries a word that is not in this class.
internal static class Reason
{
    // The frame and who sent it
    public const string BadFrame = "bad_frame", BadVerb = "bad_verb", BadArgs = "bad_args", PeerDenied = "peer_denied", Internal = "internal";
    // The lease (begin)
    public const string LeaseMissing = "lease_missing", LeaseMalformed = "lease_malformed", LeaseSignature = "lease_signature", LeaseNotYetValid = "lease_not_yet_valid",
        LeaseExpired = "lease_expired", LeaseTarget = "lease_target", LeaseGeneration = "lease_generation", LeaseUsed = "lease_used", BaseMoved = "base_moved", RepositoryUnknown = "repository_unknown", HeadUnreadable = "head_unreadable";
    // The machine (begin)
    public const string ImageMissing = "image_missing", ImageHash = "image_hash", WslUnavailable = "wsl_unavailable", WslOld = "wsl_old", KernelOld = "kernel_old", FloorExpired = "floor_expired",
        RunName = "run_name", RunExists = "run_exists", TooManyRuns = "too_many_runs", StateUnwritable = "state_unwritable", StateFull = "state_full", ImportFailed = "import_failed",
        AgentStart = "agent_start", BundleFailed = "bundle_failed", BundleTooLarge = "bundle_too_large";
    // A run in progress
    public const string NoRun = "no_run", RunBusy = "run_busy", CallsExhausted = "calls_exhausted", TooLarge = "too_large", BadPath = "bad_path",
        AgentGone = "agent_gone", AgentLimit = "agent_limit", AgentTimeout = "agent_timeout", UnregisterFailed = "unregister_failed";
    // What the agent itself said no to (its status byte, 1 to 5)
    public const string AgentBadPath = "agent_bad_path", AgentTooLarge = "agent_too_large", AgentFileError = "agent_file_error", AgentNoStart = "agent_no_start", AgentFailed = "agent_failed";

    public static readonly IReadOnlySet<string> All = typeof(Reason).GetFields()
        .Where(field => field.IsLiteral && field.FieldType == typeof(string)).Select(field => (string)field.GetRawConstantValue()!).ToHashSet(StringComparer.Ordinal);

    /// <summary>The word for an agent status byte (1 to 5), or null for a status this bridge does not know.</summary>
    public static string? ForAgentStatus(byte status) => status switch
    {
        1 => AgentBadPath, 2 => AgentTooLarge, 3 => AgentFileError, 4 => AgentNoStart, 5 => AgentFailed, _ => null,
    };
}
