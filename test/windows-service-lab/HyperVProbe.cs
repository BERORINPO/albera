using System.Buffers.Binary;
using System.Collections;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.CSharp.RuntimeBinder;

namespace Albera.Lab;

// Hyper-V rights probe (probe `hyperv <vmGuid>`). It measures what the CALLING token may do to one running VM through the two operations the host Broker
// will own (ADR-002): a screen capture and keyboard / mouse input. It runs as whichever account launches it; lab-hyperv-rights-check.ps1 starts it as
// a virtual-account service (restricted or unrestricted service SID, member of Hyper-V Administrators or not) through the shim's child mode.
//
// Two kinds of check. The raw ones (thumbnail, keyboard_typekey, mouse_setabsoluteposition) call WMI directly, the way the Broker will: COM late binding on
// WbemScripting.SWbemLocator, in this process, namespace root\virtualization\v2. The adapter ones (adapter_capture, adapter_input) run the Broker's REAL
// adapter, HyperVDesktop with ComWmiConnection (src/runtime/windows-broker, source-included by AlberaLabServiceShim.csproj), so what is measured is the code
// that will ship. There is no PowerShell, no CIM cmdlet and no System.Management here. What changes inside the VM: one TypeKey (Shift) and one
// SetAbsolutePosition (raw), then one move, one tap of Shift and one press and release of mouse button 1 at the same spot (adapter). The management service
// is only read.
//
// A WMI result is read ONLY as Properties_.Item("<name>").Value (see Property). Reading it as `result.ReturnValue` makes the dynamic binder cache a per-object
// dispatch id from the first call, and every later call in the process then fails with E_FAIL (found while building the adapter; the first lab run saw it as
// keyboard_typekey / mouse_setabsoluteposition 0x80004005 after a successful thumbnail).
//
// Output: ONE JSON line per check, flushed as it happens, so a hang or a kill later in the run keeps the earlier results.
//   {"probe":"hyperv","id":"<check>","ok":true|false, ...}
// Fields on failure: exception (type name), hresult ("0x80041003"), message (first 200 characters). Fields on a method call: returnValue (the WMI method's
// ReturnValue; Hyper-V uses 0 = done, 32769 = access denied). An adapter check says {"ok":false,"reason":"<DesktopReason word>"} when the adapter refused or
// failed (the adapter hides the cause on purpose; lab-hyperv-rights-check.ps1 reads it against the raw check of the same operation), and reason "png_invalid"
// when a capture came back that is not a PNG of the asked size. A check that could not run says {"skipped":true,"because":"<earlier check>"}.
// Exit 0 after the checks (the verdict belongs to the caller), 64 for a bad argument.
internal static class HyperVProbe
{
    private const string WmiNamespace = @"root\virtualization\v2";
    private const string RealizedSettings = "Microsoft:Hyper-V:System:Realized";
    private const int ImpersonationLevelImpersonate = 3;
    private const int ThumbnailWidth = 640, ThumbnailHeight = 480;
    private const int ShiftKeyCode = 0x10, MouseX = 100, MouseY = 100, LeftButton = 1;
    private const string AdapterComputerId = "lab";   // the contract id the adapter is configured with; its one VM is the GUID this probe was given
    private const int MaxMessageLength = 200;

    public static int Run(string vmArgument)
    {
        if (!Guid.TryParse(vmArgument, out Guid vmId)) return 64;
        string vmPath = $"Msvm_ComputerSystem.CreationClassName=\"Msvm_ComputerSystem\",Name=\"{vmId.ToString("D").ToUpperInvariant()}\"";

        object? connected = null;
        Check("wmi_connect", () => { connected = Connect(); return Ok(); });
        if (connected is not { } wmi)
        {
            foreach (string id in (string[])["vm_lookup", "mgmt_read", "thumbnail", "keyboard_typekey", "mouse_setabsoluteposition", "adapter_capture", "adapter_input"]) Skipped(id, "wmi_connect");
            return 0;
        }

        // Get by key path: no enumeration involved. EnabledState 2 = Enabled (running).
        Check("vm_lookup", () => { dynamic vm = ((dynamic)wmi).Get(vmPath); return Ok(("enabledState", Convert.ToInt32(Property((object)vm, "EnabledState")))); });
        // A read-only reference point: what the group membership alone opens up, although the Broker never calls it.
        Check("mgmt_read", () =>
        {
            (List<object> services, string mode) = Query(wmi, "SELECT * FROM Msvm_VirtualSystemManagementService");
            return services.Count > 0 ? Ok(("enumeration", mode)) : throw new InvalidOperationException("management_service_not_found");
        });
        Check("thumbnail", () => Thumbnail(wmi, vmPath));
        Check("keyboard_typekey", () => DeviceCall(wmi, vmPath, "Msvm_Keyboard", "TypeKey", ("KeyCode", ShiftKeyCode)));
        Check("mouse_setabsoluteposition", () => DeviceCall(wmi, vmPath, "Msvm_SyntheticMouse", "SetAbsolutePosition", ("HorizontalPosition", MouseX), ("VerticalPosition", MouseY)));
        // The Broker's own adapter, configured with this one VM. It opens its own WMI connection for every operation.
        HyperVDesktop desktop = new([new ComputerBinding(AdapterComputerId, vmId.ToString("D").ToLowerInvariant())], ComWmiConnection.TryConnect);
        Check("adapter_capture", () => AdapterCapture(desktop));
        Check("adapter_input", () => AdapterInput(desktop));
        return 0;
    }

    private static Dictionary<string, object?> Ok(params (string Name, object? Value)[] extra)
    {
        Dictionary<string, object?> result = new() { ["ok"] = true };
        foreach ((string name, object? value) in extra) result[name] = value;
        return result;
    }

    // Runs one check. An exception becomes a failed check with its HRESULT; nothing is thrown out of here.
    private static void Check(string id, Func<Dictionary<string, object?>> body)
    {
        Dictionary<string, object?> line = new() { ["probe"] = "hyperv", ["id"] = id };
        try
        {
            foreach ((string name, object? value) in body()) line[name] = value;
        }
        catch (Exception raw)
        {
            Exception ex = raw is TargetInvocationException { InnerException: { } inner } ? inner : raw;
            line["ok"] = false;
            line["exception"] = ex.GetType().Name;
            line["hresult"] = $"0x{(uint)ex.HResult:X8}";
            line["message"] = ex.Message.Length > MaxMessageLength ? ex.Message[..MaxMessageLength] : ex.Message;
        }
        Emit(line);
    }

    private static void Skipped(string id, string because) =>
        Emit(new Dictionary<string, object?> { ["probe"] = "hyperv", ["id"] = id, ["ok"] = false, ["skipped"] = true, ["because"] = because });

    private static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }

    private static object Connect()
    {
        Type locatorType = Type.GetTypeFromProgID("WbemScripting.SWbemLocator") ?? throw new InvalidOperationException("WbemScripting.SWbemLocator is not registered");
        dynamic locator = Activator.CreateInstance(locatorType) ?? throw new InvalidOperationException("SWbemLocator did not instantiate");
        dynamic services = locator.ConnectServer(".", WmiNamespace);
        services.Security_.ImpersonationLevel = ImpersonationLevelImpersonate;
        return services;
    }

    // WQL through SWbemServices.ExecQuery with flags 0 (a bidirectional set, so Count and ItemIndex work). ItemIndex first; if the COM binder cannot do that,
    // the IEnumVARIANT enumerator. The mode that worked goes into the evidence, so the Broker can copy the one that does.
    private static (List<object> Items, string Mode) Query(object wmi, string wql)
    {
        dynamic set = ((dynamic)wmi).ExecQuery(wql, "WQL", 0);
        try
        {
            int count = Convert.ToInt32((object)set.Count);
            List<object> items = new(count);
            for (int i = 0; i < count; i++) items.Add((object)set.ItemIndex(i));
            return (items, "ItemIndex");
        }
        catch (Exception ex) when (ex is RuntimeBinderException or COMException)
        {
            return ([.. ((IEnumerable)set).Cast<object>()], "IEnumerable");
        }
    }

    private static object ManagementService(object wmi) =>
        Query(wmi, "SELECT * FROM Msvm_VirtualSystemManagementService").Items.FirstOrDefault() ?? throw new InvalidOperationException("management_service_not_found");

    // The VM's Keyboard / SyntheticMouse device: the instance associated with the VM.
    private static object Device(object wmi, string vmPath, string resultClass) =>
        Query(wmi, $"ASSOCIATORS OF {{{vmPath}}} WHERE ResultClass = {resultClass}").Items.FirstOrDefault() ?? throw new InvalidOperationException($"{resultClass}_not_found");

    // Sets the named in-parameters by name and runs the method. Numbers are passed as 32-bit integers (what VBScript passes; WMI converts to uint16 / uint32 / sint32).
    private static object Call(object target, string method, params (string Name, object Value)[] arguments)
    {
        dynamic instance = target;
        dynamic input = instance.Methods_.Item(method).InParameters.SpawnInstance_();
        foreach ((string name, object value) in arguments) input.Properties_.Item(name).Value = value;
        return instance.ExecMethod_(method, input);
    }

    // A WMI property is read through Properties_.Item, never by its own name: see the header.
    private static object? Property(object wmiObject, string name) => (object?)((dynamic)wmiObject).Properties_.Item(name).Value;

    private static long ReturnValue(object output) => Convert.ToInt64(Property(output, "ReturnValue"));

    private static Dictionary<string, object?> DeviceCall(object wmi, string vmPath, string deviceClass, string method, params (string Name, object Value)[] arguments)
    {
        long returnValue = ReturnValue(Call(Device(wmi, vmPath, deviceClass), method, arguments));
        return new() { ["ok"] = returnValue == 0, ["returnValue"] = returnValue, ["method"] = method };
    }

    // The screen capture, the way desktop-io.ps1 does it: the VM's realized Msvm_VirtualSystemSettingData is the TargetSystem (by object path).
    private static Dictionary<string, object?> Thumbnail(object wmi, string vmPath)
    {
        object service = ManagementService(wmi);
        object settings = Query(wmi, $"ASSOCIATORS OF {{{vmPath}}} WHERE ResultClass = Msvm_VirtualSystemSettingData").Items
            .FirstOrDefault(item => Property(item, "VirtualSystemType") as string == RealizedSettings) ?? throw new InvalidOperationException("realized_settings_not_found");
        string settingsPath = (string)((dynamic)settings).Path_.Path;
        object output = Call(service, "GetVirtualSystemThumbnailImage", ("TargetSystem", settingsPath), ("WidthPixels", ThumbnailWidth), ("HeightPixels", ThumbnailHeight));
        long returnValue = ReturnValue(output);
        Dictionary<string, object?> result = new() { ["ok"] = returnValue == 0, ["returnValue"] = returnValue, ["width"] = ThumbnailWidth, ["height"] = ThumbnailHeight };
        if (returnValue == 0)
        {
            object? image = Property(output, "ImageData");
            result["bytes"] = image is Array bytes ? bytes.Length : 0;
            result["ok"] = image is Array { Length: > 0 };
        }
        return result;
    }

    private static Dictionary<string, object?> Failed(string reason) => new() { ["ok"] = false, ["reason"] = reason };

    // One capture through the Broker's adapter, then a look at what came back: a PNG of the asked size, nothing else is trusted.
    private static Dictionary<string, object?> AdapterCapture(HyperVDesktop desktop)
    {
        DesktopResult result = desktop.Capture(AdapterComputerId, ThumbnailWidth, ThumbnailHeight);
        if (!result.Ok || result.Png is not { } png) return Failed(result.Reason ?? DesktopReason.CaptureFailed);
        string? defect = PngDefect(png, ThumbnailWidth, ThumbnailHeight);
        if (defect is not null) return new() { ["ok"] = false, ["reason"] = "png_invalid", ["pngCheck"] = defect, ["bytes"] = png.Length };
        return Ok(("width", ThumbnailWidth), ("height", ThumbnailHeight), ("bytes", png.Length), ("pngCheck", "signature_ihdr_iend_ok"));
    }

    // One move, one tap (Shift), one press and release of the left button: the step kinds the room's input uses, with a key and a button that do nothing at the UEFI screen.
    private static Dictionary<string, object?> AdapterInput(HyperVDesktop desktop)
    {
        DesktopStep[] steps =
        [
            new("move", X: MouseX, Y: MouseY),
            new("tap", Vk: ShiftKeyCode),
            new("down", Button: LeftButton),
            new("up", Button: LeftButton),
        ];
        DesktopResult result = desktop.Input(AdapterComputerId, steps);
        return result.Ok ? Ok(("steps", steps.Length)) : Failed(result.Reason ?? DesktopReason.InputFailed);
    }

    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private static readonly byte[] PngIend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];   // length 0, "IEND", its CRC-32
    private const int IhdrChunkStart = 8, IhdrDataStart = 16, IhdrDataLength = 13;

    // Null when `png` has the PNG signature, an IHDR for a width x height 8-bit truecolour picture (no interlace) and an IEND at the end; else the first thing that is wrong.
    // The chunk CRCs are not recomputed here (the encoder's own tests do that).
    private static string? PngDefect(byte[] png, int width, int height)
    {
        if (png.Length < IhdrDataStart + IhdrDataLength + 4 + PngIend.Length) return "too_short";
        if (!png.AsSpan(0, PngSignature.Length).SequenceEqual(PngSignature)) return "bad_signature";
        ReadOnlySpan<byte> chunk = png.AsSpan(IhdrChunkStart, 8);
        if (BinaryPrimitives.ReadUInt32BigEndian(chunk) != IhdrDataLength || !chunk[4..].SequenceEqual("IHDR"u8)) return "bad_ihdr_chunk";
        ReadOnlySpan<byte> data = png.AsSpan(IhdrDataStart, IhdrDataLength);
        if (BinaryPrimitives.ReadUInt32BigEndian(data) != width || BinaryPrimitives.ReadUInt32BigEndian(data[4..]) != height) return "bad_size";
        if (data[8] != 8 || data[9] != 2 || data[10] != 0 || data[11] != 0 || data[12] != 0) return "bad_format";
        return png.AsSpan(png.Length - PngIend.Length).SequenceEqual(PngIend) ? null : "bad_iend";
    }
}
