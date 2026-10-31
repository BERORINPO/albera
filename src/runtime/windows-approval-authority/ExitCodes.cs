namespace Albera.ApprovalAuthority;

// Fixed process exit codes; also the service-specific exit code the SCM reports. Same numbers as the Broker where the meaning is the same.
internal static class ExitCodes
{
    public const int BadUsage = 64;
    public const int PipeUnavailable = 70;           // a pipe name is already taken (squatting / second Authority): refuse to start
    public const int ImpersonationRevertFailed = 71; // RevertToSelf failed or lied: terminate, never handle another request
    public const int PipeOwnerUnavailable = 72;      // the pipe owner could not be set to this process's own SID
    public const int ConfigInvalid = 73;             // the config file is missing, untrusted, malformed or has a rejected value
    public const int NotStartedByScm = 74;           // StartServiceCtrlDispatcher failed: nothing is created
    public const int LoopFailed = 75;                // an unexpected exception ended the serve loop
    public const int SignerUnavailable = 77;         // the machine signing key cannot be opened or is not a P-256 ECDSA key: nothing is served
    public const int SigningKeyUnprotected = 78;     // the signing key is exportable, or its owner / DACL names a principal other than this service, SYSTEM and Administrators: nothing is served
    public const int PolicyInvalid = 79;             // the tier policy file (policy.json next to the config) exists but is untrusted, unreadable, too large or not exactly the documented shape: nothing is served, never a looser tier. No file = careful, which starts fine
}
