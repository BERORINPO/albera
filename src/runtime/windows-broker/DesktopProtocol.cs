using System.Text.Json;

// The grammar of the Broker's desktop pipe (ADR-002 "Amendment 2026-11-03", "Desktop pipe"; Proposed / NOT VERIFIED):
//   open     { "open": { "computerId": "<id>", "mode": "view" } }     the first frame; the id must be one of the config's `computers`.
//            { "open": { "computerId", "mode": "act", "operationId": "<id>", "leaseGeneration": n } }   an act session; the pipe checks the last two against the Broker-held lease (DesktopLeases.cs).
//            { "open": { "computerId", "mode": "act", "operationId": "<id>" } }   the same without `leaseGeneration`: it joins the lease that is current for that operationId (a Control Plane cannot
//            know the generation; the accepted reply of every act open names it, see DesktopPipe.cs). An operationId that is not the current lease's is refused as before.
//   capture  { "capture": { "width": n, "height": n } }                any number of times after an accepted open, in a view or an act session.
//   input    { "input": { "steps": [ { "op": "move", "x": n, "y": n }, ... ] } }   an act session only (a view session is refused `view_input`). The steps are the adapter's DesktopStep
//            (HyperVDesktop.cs) and its limits (DesktopLimits): at most 256 steps, the per-op ranges, 12000 ms of sleep in all.
// Everything is strict: exactly these keys (a repeated or extra key is refused), integers only, one request per frame. Nothing here touches the pipe or the host. Every refusal is a
// fixed reason word (DesktopDeny) that goes to the Broker's own log; the client only ever gets the one fixed `denied` reply.
internal static class DesktopProtocol
{
    internal const int MaxRequestBytes = 16 * 1024;
    // One capture is boxed by the WMI scripting API (every byte of ImageData becomes an object, ~32 bytes each: about 236 MB at 1920x1920). The Broker runs one capture at a time
    // (DesktopPipe.cs) and, on top of that, refuses a picture beyond a full-HD screen: at most ~133 MB at once. The contract bound (64..1920 per side) still applies.
    internal const int MaxCapturePixels = 1920 * 1080;

    private const int MaxJsonDepth = 6; // { input: { steps: [ {...} ] } } is four deep
    private static readonly string[] StepFields = ["op", "x", "y", "button", "vk", "delta", "ms", "text"];

    internal static class DesktopDeny
    {
        public const string Peer = "peer", FrameSize = "frame_size", OpenShape = "open_shape", ComputerUnknown = "computer_unknown", RequestShape = "request_shape", ViewInput = "view_input",
            CaptureShape = "capture_shape", CaptureSize = "capture_size", CaptureBusy = "capture_busy", InputShape = "input_shape", InputSteps = "input_steps", InputBusy = "input_busy";
    }

    /// <summary>An accepted open. `OperationId` is null for a view session; for an act session it, and `LeaseGeneration` when the client named one (null: the current lease), are what the lease must match.</summary>
    internal sealed record DesktopOpen(string ComputerId, string? OperationId = null, long? LeaseGeneration = null)
    {
        internal bool IsAct => OperationId is not null;
    }

    /// <summary>A valid request after the open: the input `Steps`, or (when `Steps` is null) a capture of `Width` x `Height`.</summary>
    internal sealed record DesktopRequest(int Width = 0, int Height = 0, IReadOnlyList<DesktopStep>? Steps = null)
    {
        internal bool IsInput => Steps is not null;
    }

    /// <summary>Null when the first frame is a valid `view` or `act` open for a configured computer (`open` is then set); otherwise the reason word. Whether the lease fits is not decided here.</summary>
    internal static string? TryParseOpen(byte[] frame, IReadOnlyList<ComputerBinding> computers, out DesktopOpen? open)
    {
        open = null;
        if (Fields(frame) is not { Count: 1 } top || !top.TryGetValue("open", out JsonElement openElement) || Fields(openElement) is not { } fields) return DesktopDeny.OpenShape;
        if (!fields.TryGetValue("mode", out JsonElement modeElement) || Text(modeElement) is not { } mode || mode is not ("view" or "act")) return DesktopDeny.OpenShape;
        bool act = mode == "act";
        if (fields.Count != (act ? 3 : 2) + (act && fields.ContainsKey("leaseGeneration") ? 1 : 0)) return DesktopDeny.OpenShape; // act: computerId, mode, operationId and optionally leaseGeneration; nothing else
        if (!fields.TryGetValue("computerId", out JsonElement idElement) || Text(idElement) is not { } computerId || !AuthorityKey.IsKeyId(computerId)) return DesktopDeny.OpenShape;
        string? operationId = null;
        long? generation = null;
        if (act && !TryActFields(fields, out operationId, out generation)) return DesktopDeny.OpenShape;
        if (!computers.Any(c => string.Equals(c.ComputerId, computerId, StringComparison.Ordinal))) return DesktopDeny.ComputerUnknown;
        open = new DesktopOpen(computerId, operationId, generation);
        return null;
    }

    // operationId: a contract id; leaseGeneration: absent, or an integer >= 1 (the caller counted the keys, so no other key is here).
    private static bool TryActFields(Dictionary<string, JsonElement> fields, out string? operationId, out long? generation)
    {
        operationId = null;
        generation = null;
        if (!fields.TryGetValue("operationId", out JsonElement operationElement) || Text(operationElement) is not { } id || !AuthorityKey.IsKeyId(id)) return false;
        if (fields.TryGetValue("leaseGeneration", out JsonElement generationElement))
        {
            if (!Integer(generationElement, out long named) || named < 1) return false;
            generation = named;
        }
        operationId = id;
        return true;
    }

    /// <summary>
    /// Null when the frame is a valid request (`request` is then set): a capture whose size is within the contract and the pixel cap, or, in an act session only, input whose steps are
    /// within DesktopLimits. Otherwise the reason word.
    /// </summary>
    internal static string? TryParseRequest(byte[] frame, bool act, out DesktopRequest? request)
    {
        request = null;
        if (Fields(frame) is not { Count: 1 } top) return DesktopDeny.RequestShape;
        if (top.TryGetValue("input", out JsonElement input)) return act ? TryParseInput(input, out request) : DesktopDeny.ViewInput;
        if (!top.TryGetValue("capture", out JsonElement body)) return DesktopDeny.RequestShape;
        if (Fields(body) is not { Count: 2 } size || !size.TryGetValue("width", out JsonElement w) || !size.TryGetValue("height", out JsonElement h) ||
            w.ValueKind != JsonValueKind.Number || h.ValueKind != JsonValueKind.Number || !w.TryGetInt32(out int width) || !h.TryGetInt32(out int height)) return DesktopDeny.CaptureShape;
        if (!DesktopLimits.IsCaptureSize(width, height) || (long)width * height > MaxCapturePixels) return DesktopDeny.CaptureSize;
        request = new DesktopRequest(width, height);
        return null;
    }

    // { "steps": [ ... ] } and nothing else. A step that is not an object of known integer / string fields is a shape error; a well-formed step list that breaks a limit is input_steps.
    private static string? TryParseInput(JsonElement body, out DesktopRequest? request)
    {
        request = null;
        if (Fields(body) is not { Count: 1 } fields || !fields.TryGetValue("steps", out JsonElement list) || list.ValueKind != JsonValueKind.Array) return DesktopDeny.InputShape;
        if (list.GetArrayLength() is < 1 or > DesktopLimits.MaxSteps) return DesktopDeny.InputSteps;
        List<DesktopStep> steps = [];
        foreach (JsonElement element in list.EnumerateArray())
        {
            if (ReadStep(element) is not { } step) return DesktopDeny.InputShape;
            steps.Add(step);
        }
        if (!DesktopLimits.AreValidSteps(steps)) return DesktopDeny.InputSteps;
        request = new DesktopRequest(Steps: steps);
        return null;
    }

    // One step as the adapter's record, or null when it is not an object, repeats or adds a key, has no `op` string, or carries a value of the wrong kind. Which fields an op may carry,
    // and their ranges, are DesktopLimits' to decide.
    private static DesktopStep? ReadStep(JsonElement element)
    {
        if (Fields(element) is not { } fields || fields.Keys.Any(name => !StepFields.Contains(name))) return null;
        if (!fields.TryGetValue("op", out JsonElement opElement) || Text(opElement) is not { } op) return null;
        if (!TryNumber(fields, "x", out long? x) || !TryNumber(fields, "y", out long? y) || !TryNumber(fields, "button", out long? button) || !TryNumber(fields, "vk", out long? vk) ||
            !TryNumber(fields, "delta", out long? delta) || !TryNumber(fields, "ms", out long? ms)) return null;
        string? text = null;
        if (fields.TryGetValue("text", out JsonElement textElement) && (text = Text(textElement)) is null) return null;
        return new DesktopStep(op, x, y, button, vk, delta, ms, text);
    }

    // False when the field is present and is not an integer; an absent field is fine (null).
    private static bool TryNumber(Dictionary<string, JsonElement> fields, string name, out long? value)
    {
        value = null;
        if (!fields.TryGetValue(name, out JsonElement element)) return true;
        if (!Integer(element, out long number)) return false;
        value = number;
        return true;
    }

    // An integer JSON number that fits a long (a fraction, an exponent or a string does not).
    private static bool Integer(JsonElement element, out long value)
    {
        value = 0;
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out value);
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
