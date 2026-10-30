namespace Albera.Approver;

// Fixed process exit codes. 0 = done; every other code leaves the Authority's state exactly as the line on stderr says.
internal static class ExitCodes
{
    public const int Ok = 0;
    public const int BadUsage = 64;
    public const int Refused = 65;           // the app refused locally (digest mismatch, unknown / invalid entry, not confirmed): nothing was decided
    public const int ServerRefused = 66;     // before any write: the pipe server is not the Authority, or it is not reachable
    public const int AuthorityRejected = 67; // the Authority answered {"ok":false,"code":...}
    public const int TransportUnknown = 68;  // after the write: timeout / broken pipe / unparseable reply (the outcome is unknown; `list` again)
    public const int SignerUnavailable = 69; // no usable Windows Hello key (unsupported, not enrolled, no signer in this build): nothing was sent; `enroll` fixes it
    public const int Internal = 70;
}
