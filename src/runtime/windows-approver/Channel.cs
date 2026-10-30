namespace Albera.Approver;

/// <summary>One request frame out, one reply frame back, over a connection whose server has already been verified. Implemented by PipeChannel (and by fakes in the unit tests).</summary>
internal interface IApproverChannel
{
    /// <returns>the reply's JSON text (1..2048 bytes of UTF-8)</returns>
    /// <exception cref="ChannelException">no reply: <see cref="ChannelException.Sent"/> says whether a byte of the request was written</exception>
    Task<string> CallAsync(string requestJson);
}

// The fixed code words of the channel. Pre-send codes: nothing left this process, retrying is safe. Post-send codes: the outcome is unknown.
internal static class ChannelCodes
{
    public const string RequestTooLarge = "request_too_large", AuthorityUnreachable = "authority_unreachable", AccessDenied = "access_denied",
        ServerIdentityMismatch = "server_identity_mismatch", ServerIdentityUnavailable = "server_identity_unavailable";
    public const string Timeout = "timeout", TransportError = "transport_error", InvalidResponse = "invalid_response", ResponseTooLarge = "response_too_large";
}

internal sealed class ChannelException(string code, bool sent) : Exception(code)
{
    public string Code { get; } = code;

    /// <summary>true once any byte of the request frame was written</summary>
    public bool Sent { get; } = sent;
}
