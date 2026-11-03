using System.Text.Json;

// The grammar of the Broker's desktop pipe (ADR-002 "Amendment 2026-11-03", "Desktop pipe"; Proposed / NOT VERIFIED). This PR serves `view` sessions only (screen capture):
//   open     { "open": { "computerId": "<id>", "mode": "view" } }     the first frame; the id must be one of the config's `computers`. mode `act` is always refused (the lease is a later change).
//   capture  { "capture": { "width": n, "height": n } }                any number of times after an accepted open; `input` is not accepted in a view session.
// Everything is strict: exactly these keys (a repeated or extra key is refused), integers only, one request per frame. Nothing here touches the pipe or the host. Every refusal is a
// fixed reason word (DesktopDeny) that goes to the Broker's own log; the client only ever gets the one fixed `denied` reply.
internal static class DesktopProtocol
{
    internal const int MaxRequestBytes = 16 * 1024;
    // One capture is boxed by the WMI scripting API (every byte of ImageData becomes an object, ~32 bytes each: about 236 MB at 1920x1920). The Broker runs one capture at a time
    // (DesktopPipe.cs) and, on top of that, refuses a picture beyond a full-HD screen: at most ~133 MB at once. The contract bound (64..1920 per side) still applies.
    internal const int MaxCapturePixels = 1920 * 1080;

    private const int MaxJsonDepth = 6; // an `input` request ({ input: { steps: [ {...} ] } }) must still parse to be named, then refused

    internal static class DesktopDeny
    {
        public const string Peer = "peer", FrameSize = "frame_size", OpenShape = "open_shape", ActUnsupported = "act_unsupported", ComputerUnknown = "computer_unknown",
            RequestShape = "request_shape", ViewInput = "view_input", CaptureShape = "capture_shape", CaptureSize = "capture_size", CaptureBusy = "capture_busy";
    }

    /// <summary>Null when the first frame is a valid `view` open for a configured computer (`computerId` is then that id); otherwise the reason word.</summary>
    internal static string? TryParseOpen(byte[] frame, IReadOnlyList<ComputerBinding> computers, out string computerId)
    {
        computerId = "";
        if (Fields(frame) is not { Count: 1 } top || !top.TryGetValue("open", out JsonElement openElement) || Fields(openElement) is not { } open) return DesktopDeny.OpenShape;
        if (!open.TryGetValue("mode", out JsonElement modeElement) || Text(modeElement) is not { } mode) return DesktopDeny.OpenShape;
        if (mode == "act") return DesktopDeny.ActUnsupported; // before the shape of the rest: an act open is refused whatever else it carries
        if (mode != "view" || open.Count != 2) return DesktopDeny.OpenShape;
        if (!open.TryGetValue("computerId", out JsonElement idElement) || Text(idElement) is not { } candidate || !AuthorityKey.IsKeyId(candidate)) return DesktopDeny.OpenShape;
        if (!computers.Any(c => string.Equals(c.ComputerId, candidate, StringComparison.Ordinal))) return DesktopDeny.ComputerUnknown;
        computerId = candidate;
        return null;
    }

    /// <summary>Null when the frame is a valid capture request (the size is within the contract and the pixel cap); otherwise the reason word.</summary>
    internal static string? TryParseCapture(byte[] frame, out int width, out int height)
    {
        width = height = 0;
        if (Fields(frame) is not { Count: 1 } top) return DesktopDeny.RequestShape;
        if (top.ContainsKey("input")) return DesktopDeny.ViewInput;
        if (!top.TryGetValue("capture", out JsonElement body)) return DesktopDeny.RequestShape;
        if (Fields(body) is not { Count: 2 } size || !size.TryGetValue("width", out JsonElement w) || !size.TryGetValue("height", out JsonElement h) ||
            w.ValueKind != JsonValueKind.Number || h.ValueKind != JsonValueKind.Number || !w.TryGetInt32(out width) || !h.TryGetInt32(out height)) return DesktopDeny.CaptureShape;
        return DesktopLimits.IsCaptureSize(width, height) && (long)width * height <= MaxCapturePixels ? null : DesktopDeny.CaptureSize;
    }

    // The text of a JSON string, or null when the element is not a string or its text is not valid (a lone surrogate escape makes GetString throw).
    private static string? Text(JsonElement element)
    {
        try { return element.ValueKind == JsonValueKind.String ? element.GetString() : null; }
        catch (InvalidOperationException) { return null; }
    }

    // The members of a JSON object by name; null when the text is not one JSON object, is not valid, or a name repeats (ambiguous: refuse rather than pick one).
    private static Dictionary<string, JsonElement>? Fields(byte[] frame)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = MaxJsonDepth });
            return Fields(document.RootElement.Clone());
        }
        catch (JsonException) { return null; }
    }

    private static Dictionary<string, JsonElement>? Fields(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        Dictionary<string, JsonElement> fields = new(StringComparer.Ordinal);
        try
        {
            foreach (JsonProperty property in element.EnumerateObject())
                if (!fields.TryAdd(property.Name, property.Value)) return null;
        }
        catch (InvalidOperationException) { return null; } // a name with a lone surrogate escape
        return fields;
    }
}
