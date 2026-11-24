using System.Text.Json;

namespace Albera.WslBridge.Harness;

// The Node wire (src/runtime/wsl2-bridge-wire.mjs) against Wire.cs, in both directions: frames Node made are read here by the bridge's own code, and replies encoded here must be the bytes the Node test decodes.
// test/helpers/wsl2-wire-probe.mjs writes the probe. Nothing here touches a pipe.
internal static partial class Harness
{
    private static void NodeWireProbe(string probeFile)
    {
        Check("wire interop: every request Node frames is parsed by Wire.cs to the same verb, id and body", () =>
        {
            using JsonDocument probe = JsonDocument.Parse(File.ReadAllBytes(probeFile));
            foreach (JsonElement item in probe.RootElement.GetProperty("wire").GetProperty("requests").EnumerateArray())
            {
                using MemoryStream stream = new(Convert.FromBase64String(item.GetProperty("frame").GetString()!));
                byte[]? payload = Wire.ReadFrameAsync(stream, Limits.Default.MaxRequestFrame, CancellationToken.None).GetAwaiter().GetResult();
                Assert(payload is not null, "the frame was refused");
                Assert(stream.Position == stream.Length, "the frame left bytes behind");
                Request? request = Wire.Parse(payload);
                Assert(request is not null, "the payload was refused");
                Assert((byte)request!.Verb == item.GetProperty("verb").GetByte(), "another verb");
                Same(item.GetProperty("id").GetString()!, request.RunId, "id");
                Same(item.GetProperty("body").GetString()!, Convert.ToBase64String(request.Body), "body");
            }
        });
        Check("wire interop: Wire.cs encodes every reply to the bytes the Node test decodes", () =>
        {
            using JsonDocument probe = JsonDocument.Parse(File.ReadAllBytes(probeFile));
            foreach (JsonElement item in probe.RootElement.GetProperty("wire").GetProperty("replies").EnumerateArray())
            {
                Reply reply = new(item.GetProperty("ok").GetBoolean(), item.GetProperty("reason").GetString()!, Convert.FromBase64String(item.GetProperty("body").GetString()!));
                Same(item.GetProperty("frame").GetString()!, Convert.ToBase64String(Wire.Frame(Wire.Encode(reply))), "frame");
            }
        });
    }
}
