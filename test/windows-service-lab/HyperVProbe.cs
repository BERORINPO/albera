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
// It calls WMI the way the Broker will: COM late binding on WbemScripting.SWbemLocator, in this process, namespace root\virtualization\v2. There is no
// PowerShell, no CIM cmdlet and no System.Management here. The only calls that change anything inside the VM are one TypeKey (Shift) and one
// SetAbsolutePosition; the management service is only read.
//
// Output: ONE JSON line per check, flushed as it happens, so a hang or a kill later in the run keeps the earlier results.
//   {"probe":"hyperv","id":"<check>","ok":true|false, ...}
// Fields on failure: exception (type name), hresult ("0x80041003"), message (first 200 characters). Fields on a method call: returnValue (the WMI method's
// ReturnValue; Hyper-V uses 0 = done, 32769 = access denied). A check that could not run says {"skipped":true,"because":"<earlier check>"}.
// Exit 0 after the checks (the verdict belongs to the caller), 64 for a bad argument.
internal static class HyperVProbe
{
    private const string WmiNamespace = @"root\virtualization\v2";
    private const string RealizedSettings = "Microsoft:Hyper-V:System:Realized";
    private const int ImpersonationLevelImpersonate = 3;
    private const int ThumbnailWidth = 640, ThumbnailHeight = 480;
    private const int ShiftKeyCode = 0x10, MouseX = 100, MouseY = 100;
    private const int MaxMessageLength = 200;

    public static int Run(string vmArgument)
    {
        if (!Guid.TryParse(vmArgument, out Guid vmId)) return 64;
        string vmPath = $"Msvm_ComputerSystem.CreationClassName=\"Msvm_ComputerSystem\",Name=\"{vmId.ToString("D").ToUpperInvariant()}\"";

        object? connected = null;
        Check("wmi_connect", () => { connected = Connect(); return Ok(); });
        if (connected is not { } wmi)
        {
            foreach (string id in (string[])["vm_lookup", "mgmt_read", "thumbnail", "keyboard_typekey", "mouse_setabsoluteposition"]) Skipped(id, "wmi_connect");
            return 0;
        }

        // Get by key path: no enumeration involved. EnabledState 2 = Enabled (running).
        Check("vm_lookup", () => { dynamic vm = ((dynamic)wmi).Get(vmPath); return Ok(("enabledState", Convert.ToInt32((object)vm.EnabledState))); });
        // A read-only reference point: what the group membership alone opens up, although the Broker never calls it.
        Check("mgmt_read", () =>
        {
            (List<object> services, string mode) = Query(wmi, "SELECT * FROM Msvm_VirtualSystemManagementService");
            return services.Count > 0 ? Ok(("enumeration", mode)) : throw new InvalidOperationException("management_service_not_found");
        });
        Check("thumbnail", () => Thumbnail(wmi, vmPath));
        Check("keyboard_typekey", () => DeviceCall(wmi, vmPath, "Msvm_Keyboard", "TypeKey", ("KeyCode", ShiftKeyCode)));
        Check("mouse_setabsoluteposition", () => DeviceCall(wmi, vmPath, "Msvm_SyntheticMouse", "SetAbsolutePosition", ("HorizontalPosition", MouseX), ("VerticalPosition", MouseY)));
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

    private static long ReturnValue(object output) => Convert.ToInt64((object)((dynamic)output).ReturnValue);

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
            .FirstOrDefault(item => (string?)((dynamic)item).VirtualSystemType == RealizedSettings) ?? throw new InvalidOperationException("realized_settings_not_found");
        string settingsPath = (string)((dynamic)settings).Path_.Path;
        dynamic output = Call(service, "GetVirtualSystemThumbnailImage", ("TargetSystem", settingsPath), ("WidthPixels", ThumbnailWidth), ("HeightPixels", ThumbnailHeight));
        long returnValue = Convert.ToInt64((object)output.ReturnValue);
        Dictionary<string, object?> result = new() { ["ok"] = returnValue == 0, ["returnValue"] = returnValue, ["width"] = ThumbnailWidth, ["height"] = ThumbnailHeight };
        if (returnValue == 0)
        {
            object? image = output.ImageData;
            result["bytes"] = image is Array bytes ? bytes.Length : 0;
            result["ok"] = image is Array { Length: > 0 };
        }
        return result;
    }
}
