using System.Runtime.InteropServices;

// The Broker's Hyper-V desktop adapter (ADR-002 "Amendment 2026-11-03", option C; Proposed / NOT VERIFIED): screen capture and input for the VMs named in
// the service config, and nothing else. Once the Broker's service SID is in Hyper-V Administrators this code, not the OS, is what limits it, so:
//   * the operation-layer allowlist is ONE table (DesktopAllowlist.Classes) that every WMI call is checked against before it is made (WmiGate);
//   * WMI is called in-process through COM late binding (ComWmiConnection), never through a script host or a child process, and the only WQL text is a
//     class name from the table plus a config-derived, format-checked VM GUID;
//   * the caller names a `computerId` only; the VM is resolved from the config by `Name` (the GUID), never by a display name;
//   * every refusal or failure is one fixed reason word (DesktopReason). Exception text and WMI strings never leave this file.
// Only the desktop pipe (DesktopPipe.cs) calls this: Capture from a view or act session, Input from an act session that holds the current lease (DesktopLeases.cs).

/// <summary>One configured room computer: the contract id the caller uses and the lowercase GUID (`Msvm_ComputerSystem.Name`) of its VM.</summary>
internal sealed record ComputerBinding(string ComputerId, string VmId)
{
    /// <summary>Lowercase 8-4-4-4-12 hex. Checked by hand: a regex `$` would accept a trailing newline, and this text goes into a WQL query.</summary>
    internal static bool IsVmId(string value)
    {
        if (value.Length != 36) return false;
        for (int i = 0; i < value.Length; i++)
        {
            bool dash = i is 8 or 13 or 18 or 23;
            if (dash ? value[i] != '-' : !(value[i] is >= '0' and <= '9' or >= 'a' and <= 'f')) return false;
        }
        return true;
    }
}

/// <summary>One input step. Exactly the fields of its `Op` are set (a step with a stray field is refused). Numbers are `long` so a value outside int32 is refused, not wrapped.</summary>
internal sealed record DesktopStep(string Op, long? X = null, long? Y = null, long? Button = null, long? Vk = null, long? Delta = null, long? Ms = null, string? Text = null);

/// <summary>`Reason` is null on success. On a refusal or failure it is one of DesktopReason, never text from an exception or from WMI.</summary>
internal sealed record DesktopResult(string? Reason, byte[]? Png = null)
{
    public bool Ok => Reason is null;
}

internal static class DesktopReason
{
    public const string ComputerUnknown = "computer_unknown", CaptureSize = "capture_size", InputSteps = "input_steps", Unavailable = "desktop_unavailable",
        CaptureFailed = "capture_failed", InputFailed = "input_failed", Allowlist = "allowlist", InputCancelled = "input_cancelled";
}

/// <summary>Raised inside the adapter with a DesktopReason word; the public operations turn it into a DesktopResult.</summary>
internal sealed class DesktopRefusal(string reason) : Exception(reason)
{
    public string Reason { get; } = reason;
}

internal static class DesktopAllowlist
{
    internal const string Namespace = @"root\virtualization\v2";

    // Class -> the methods that may be executed on it; a class with no methods is only queried or read. Anything not in this table is refused before WMI is
    // touched (DefineSystem, ModifySystemSettings, DestroySystem, RequestStateChange, TypeCtrlAltDel, every snapshot class, ...). test/windows-broker-hyperv-desktop-source.test.mjs pins it.
    private static readonly Dictionary<string, string[]> Classes = new(StringComparer.Ordinal)
    {
        ["Msvm_ComputerSystem"] = [],
        ["Msvm_VirtualSystemSettingData"] = [],
        ["Msvm_VirtualSystemManagementService"] = ["GetVirtualSystemThumbnailImage"],
        ["Msvm_Keyboard"] = ["PressKey", "ReleaseKey", "TypeKey", "TypeText"],
        ["Msvm_SyntheticMouse"] = ["SetAbsolutePosition", "SetButtonState", "SetScrollPosition"],
    };

    internal static void RequireClass(string className)
    {
        if (!Classes.ContainsKey(className)) throw new DesktopRefusal(DesktopReason.Allowlist);
    }

    internal static void RequireMethod(string className, string method)
    {
        if (!Classes.TryGetValue(className, out string[]? methods) || !methods.Contains(method, StringComparer.Ordinal)) throw new DesktopRefusal(DesktopReason.Allowlist);
    }
}

/// <summary>The bounds of the desktop operations (the step bounds of src/runtime/hyperv-desktop/desktop-io.ps1, plus the capture size and reply cap of the amendment).</summary>
internal static class DesktopLimits
{
    internal const int MinCapture = 64, MaxCapture = 1920, MaxPngBytes = 8 * 1024 * 1024;
    internal const int MaxSteps = 256, MaxTextLength = 512, MaxSleepMs = 10000, MaxSleepTotalMs = 12000;

    internal static bool IsCaptureSize(int width, int height) => width is >= MinCapture and <= MaxCapture && height is >= MinCapture and <= MaxCapture;

    internal static bool AreValidSteps(IReadOnlyList<DesktopStep> steps)
    {
        if (steps is null || steps.Count is < 1 or > MaxSteps) return false; // null comes from a caller's JSON, not from this code: refuse it, never throw
        long sleepTotal = 0;
        foreach (DesktopStep step in steps)
        {
            if (step is null || !IsValidStep(step)) return false;
            sleepTotal += step.Ms ?? 0;
        }
        return sleepTotal <= MaxSleepTotalMs;
    }

    // The field count makes a step strict: a `move` that also carries a `vk` is refused, not silently trimmed.
    private static bool IsValidStep(DesktopStep step) => step.Op switch
    {
        "move" => InRange(step.X, 0, 4095) && InRange(step.Y, 0, 4095) && FieldCount(step) == 2,
        "down" or "up" => InRange(step.Button, 1, 3) && FieldCount(step) == 1,
        "press" or "release" or "tap" => InRange(step.Vk, 1, 254) && FieldCount(step) == 1,
        "wheel" => InRange(step.Delta, -1200, 1200) && FieldCount(step) == 1,
        "sleep" => InRange(step.Ms, 0, MaxSleepMs) && FieldCount(step) == 1,
        "text" => IsPrintableAscii(step.Text) && FieldCount(step) == 1,
        _ => false,
    };

    private static bool InRange(long? value, long min, long max) => value is { } v && v >= min && v <= max;

    private static bool IsPrintableAscii(string? text) => text is { Length: >= 1 and <= MaxTextLength } && text.All(c => c is >= ' ' and <= '~');

    private static int FieldCount(DesktopStep s) => new object?[] { s.X, s.Y, s.Button, s.Vk, s.Delta, s.Ms, s.Text }.Count(field => field is not null);
}

/// <summary>The thin seam to WMI. The real one is ComWmiConnection; the tests substitute a fake. It performs no checks of its own: WmiGate does, before every call.</summary>
internal interface IWmiConnection : IDisposable
{
    string Namespace { get; }

    /// <summary>The instance of `className` whose `Name` equals `name` (a lowercase GUID), or the class's only instance when `name` is null; null when there is none.</summary>
    IWmiInstance? Find(string className, string? name);
}

internal readonly record struct WmiOutcome(uint ReturnValue, object? Output);

internal interface IWmiInstance : IDisposable
{
    string ClassName { get; }

    /// <summary>The first associated instance of `resultClass` (optionally the first whose string property `property` equals `equals`); null when there is none.</summary>
    IWmiInstance? Associated(string resultClass, string? property = null, string? equals = null);

    /// <summary>Executes `method`. An argument that is an IWmiInstance is passed as a reference to it. `output` names one output parameter to hand back.</summary>
    WmiOutcome Invoke(string method, IReadOnlyDictionary<string, object> arguments, string? output = null);
}

/// <summary>The only way the adapter reaches WMI: every query, association and method call is checked against DesktopAllowlist first.</summary>
internal sealed class WmiGate
{
    private readonly IWmiConnection _connection;

    public WmiGate(IWmiConnection connection)
    {
        if (!string.Equals(connection.Namespace, DesktopAllowlist.Namespace, StringComparison.Ordinal)) throw new DesktopRefusal(DesktopReason.Allowlist);
        _connection = connection;
    }

    public IWmiInstance? Find(string className, string? name)
    {
        DesktopAllowlist.RequireClass(className);
        return _connection.Find(className, name);
    }

    public IWmiInstance? Associated(IWmiInstance source, string resultClass, string? property = null, string? equals = null)
    {
        DesktopAllowlist.RequireClass(source.ClassName);
        DesktopAllowlist.RequireClass(resultClass);
        return source.Associated(resultClass, property, equals);
    }

    public WmiOutcome Call(IWmiInstance target, string method, IReadOnlyDictionary<string, object> arguments, string? output = null)
    {
        DesktopAllowlist.RequireMethod(target.ClassName, method);
        return target.Invoke(method, arguments, output);
    }
}

internal sealed class HyperVDesktop
{
    private const string RealizedSettings = "Microsoft:Hyper-V:System:Realized";
    // Measured on a Windows 11 host (2026-11-03, 640x480, 800x600 and 333x201): ImageData is 4 bytes longer than width * height * 2, and the pixels start after those 4 bytes
    // (the row-wrap discontinuities of the picture line up at pixel 2). What the header holds is not documented; it is skipped, not read.
    private const int ThumbnailHeaderBytes = 4;
    private readonly IReadOnlyList<ComputerBinding> _computers;
    private readonly Func<IWmiConnection?> _connect;
    private readonly Action<int, CancellationToken> _sleep;

    /// <param name="connect">Opens one WMI connection per operation (null when WMI is unreachable). Tests pass a fake; production passes ComWmiConnection.TryConnect.</param>
    /// <param name="sleep">Waits for a `sleep` step (milliseconds), and returns early when the token is cancelled. Tests pass a recorder.</param>
    public HyperVDesktop(IReadOnlyList<ComputerBinding> computers, Func<IWmiConnection?> connect, Action<int, CancellationToken>? sleep = null)
    {
        _computers = computers;
        _connect = connect;
        _sleep = sleep ?? ((ms, cancel) => cancel.WaitHandle.WaitOne(ms));
    }

    public DesktopResult Capture(string computerId, int width, int height)
    {
        if (Resolve(computerId) is not { } computer) return new(DesktopReason.ComputerUnknown);
        if (!DesktopLimits.IsCaptureSize(width, height)) return new(DesktopReason.CaptureSize);
        return Run(DesktopReason.CaptureFailed, gate => CaptureFrame(gate, computer, width, height));
    }

    /// <summary>
    /// `cancel` is the end of the caller's right to send (its lease): it is looked at before WMI is touched and before every step, and a `sleep` step ends early on it. When it is cancelled
    /// half-way, what is still held is released (the same path as after a failed step) and the result is `input_cancelled`. A step already inside WMI is not interrupted.
    /// The default (never cancelled) is for the VM-lab probe, which has no lease; the desktop pipe always passes its session's token (pinned in windows-broker-desktop-pipe-source.test.mjs).
    /// </summary>
    public DesktopResult Input(string computerId, IReadOnlyList<DesktopStep> steps, CancellationToken cancel = default)
    {
        if (Resolve(computerId) is not { } computer) return new(DesktopReason.ComputerUnknown);
        if (!DesktopLimits.AreValidSteps(steps)) return new(DesktopReason.InputSteps);
        if (cancel.IsCancellationRequested) return new(DesktopReason.InputCancelled);
        return Run(DesktopReason.InputFailed, gate => SendSteps(gate, computer, steps, cancel));
    }

    private ComputerBinding? Resolve(string computerId) => _computers.FirstOrDefault(c => string.Equals(c.ComputerId, computerId, StringComparison.Ordinal));

    // The one place that catches everything: whatever COM, WMI or the binder throws becomes `failure`, a fixed word. The text of the exception is dropped on purpose.
    private DesktopResult Run(string failure, Func<WmiGate, DesktopResult> work)
    {
        try
        {
            using IWmiConnection? connection = _connect();
            return connection is null ? new(DesktopReason.Unavailable) : work(new WmiGate(connection));
        }
        catch (DesktopRefusal refusal) { return new(refusal.Reason); }
        catch (Exception) { return new(failure); }
    }

    private static DesktopResult CaptureFrame(WmiGate gate, ComputerBinding computer, int width, int height)
    {
        using IWmiInstance? vm = gate.Find("Msvm_ComputerSystem", computer.VmId);
        using IWmiInstance? settings = vm is null ? null : gate.Associated(vm, "Msvm_VirtualSystemSettingData", "VirtualSystemType", RealizedSettings);
        using IWmiInstance? service = settings is null ? null : gate.Find("Msvm_VirtualSystemManagementService", null);
        if (settings is null || service is null) return new(DesktopReason.Unavailable);
        Dictionary<string, object> arguments = new() { ["TargetSystem"] = settings, ["WidthPixels"] = (ushort)width, ["HeightPixels"] = (ushort)height };
        WmiOutcome outcome = gate.Call(service, "GetVirtualSystemThumbnailImage", arguments, "ImageData");
        // RGB565 is 2 bytes per pixel, behind a 4-byte header; any other length is not the picture that was asked for.
        if (outcome.ReturnValue != 0 || outcome.Output is not byte[] image || image.Length != ThumbnailHeaderBytes + width * height * 2) return new(DesktopReason.CaptureFailed);
        byte[] png = PngEncoder.FromRgb565(image.AsSpan(ThumbnailHeaderBytes), width, height);
        return png.Length <= DesktopLimits.MaxPngBytes ? new(null, png) : new(DesktopReason.CaptureFailed);
    }

    private DesktopResult SendSteps(WmiGate gate, ComputerBinding computer, IReadOnlyList<DesktopStep> steps, CancellationToken cancel)
    {
        using IWmiInstance? vm = gate.Find("Msvm_ComputerSystem", computer.VmId);
        using IWmiInstance? keyboard = vm is null ? null : gate.Associated(vm, "Msvm_Keyboard");
        using IWmiInstance? mouse = vm is null ? null : gate.Associated(vm, "Msvm_SyntheticMouse");
        if (keyboard is null || mouse is null) return new(DesktopReason.Unavailable);
        List<uint> heldKeys = [], heldButtons = [];
        try
        {
            foreach (DesktopStep step in steps)
            {
                if (cancel.IsCancellationRequested) throw new DesktopRefusal(DesktopReason.InputCancelled); // the catch below releases what is held, then Run turns this into the result
                Apply(gate, keyboard, mouse, step, heldKeys, heldButtons, cancel);
            }
            if (cancel.IsCancellationRequested) throw new DesktopRefusal(DesktopReason.InputCancelled); // a last `sleep` may have been cut short: what a plan left held is not left to a lease that ended
            return new(null);
        }
        catch (Exception)
        {
            // A key left pressed in the guest keeps typing. When a release fails on this connection (the RPC may be gone), what is still held is released once more on a NEW one.
            (List<uint> stuckKeys, List<uint> stuckButtons) = ReleaseHeld(gate, keyboard, mouse, heldKeys, heldButtons);
            if (stuckKeys.Count + stuckButtons.Count > 0) ReleaseOnNewConnection(computer, stuckKeys, stuckButtons);
            throw;
        }
    }

    // One retry, no more, and best effort: if the new connection cannot be made or the release fails again there is nothing left to try, and the caller reports the original failure.
    private void ReleaseOnNewConnection(ComputerBinding computer, List<uint> keys, List<uint> buttons)
    {
        try
        {
            using IWmiConnection? connection = _connect();
            if (connection is null) return;
            WmiGate gate = new(connection);
            using IWmiInstance? vm = gate.Find("Msvm_ComputerSystem", computer.VmId);
            using IWmiInstance? keyboard = vm is null ? null : gate.Associated(vm, "Msvm_Keyboard");
            using IWmiInstance? mouse = vm is null ? null : gate.Associated(vm, "Msvm_SyntheticMouse");
            if (keyboard is not null && mouse is not null) _ = ReleaseHeld(gate, keyboard, mouse, keys, buttons);
        }
        catch (Exception) { /* see above */ }
    }

    // A key or button is recorded BEFORE the call that presses it: releasing something that was never pressed is harmless, leaving something pressed is not.
    private void Apply(WmiGate gate, IWmiInstance keyboard, IWmiInstance mouse, DesktopStep step, List<uint> heldKeys, List<uint> heldButtons, CancellationToken cancel)
    {
        switch (step.Op)
        {
            case "move": Send(gate, mouse, "SetAbsolutePosition", ("HorizontalPosition", (int)step.X!.Value), ("VerticalPosition", (int)step.Y!.Value)); break;
            case "down": heldButtons.Add((uint)step.Button!.Value); Send(gate, mouse, "SetButtonState", ("ButtonIndex", (uint)step.Button!.Value), ("IsDown", true)); break;
            case "up": Send(gate, mouse, "SetButtonState", ("ButtonIndex", (uint)step.Button!.Value), ("IsDown", false)); heldButtons.Remove((uint)step.Button!.Value); break;
            case "press": heldKeys.Add((uint)step.Vk!.Value); Send(gate, keyboard, "PressKey", ("KeyCode", (uint)step.Vk!.Value)); break;
            case "release": Send(gate, keyboard, "ReleaseKey", ("KeyCode", (uint)step.Vk!.Value)); heldKeys.Remove((uint)step.Vk!.Value); break;
            case "tap": Send(gate, keyboard, "TypeKey", ("KeyCode", (uint)step.Vk!.Value)); break;
            case "text": Send(gate, keyboard, "TypeText", ("AsciiText", step.Text!)); break;
            case "wheel": Send(gate, mouse, "SetScrollPosition", ("ScrollPositionDelta", (int)step.Delta!.Value)); break;
            case "sleep": if (step.Ms > 0) _sleep((int)step.Ms.Value, cancel); break;
            default: throw new DesktopRefusal(DesktopReason.InputSteps); // unreachable after AreValidSteps; refuse rather than skip
        }
    }

    private static void Send(WmiGate gate, IWmiInstance device, string method, params (string Name, object Value)[] arguments)
    {
        WmiOutcome outcome = gate.Call(device, method, arguments.ToDictionary(a => a.Name, a => a.Value));
        if (outcome.ReturnValue != 0) throw new DesktopRefusal(DesktopReason.InputFailed);
    }

    // Buttons first, then keys, each in reverse order of pressing. A failing release must not hide the original failure or stop the others; the ones that failed are returned
    // (oldest first, like the lists that went in) so that the caller can try them once more.
    private static (List<uint> Keys, List<uint> Buttons) ReleaseHeld(WmiGate gate, IWmiInstance keyboard, IWmiInstance mouse, List<uint> heldKeys, List<uint> heldButtons)
    {
        List<uint> stuckKeys = [], stuckButtons = [];
        for (int i = heldButtons.Count - 1; i >= 0; i--)
        {
            try { Send(gate, mouse, "SetButtonState", ("ButtonIndex", heldButtons[i]), ("IsDown", false)); }
            catch (Exception) { stuckButtons.Add(heldButtons[i]); }
        }
        for (int i = heldKeys.Count - 1; i >= 0; i--)
        {
            try { Send(gate, keyboard, "ReleaseKey", ("KeyCode", heldKeys[i])); }
            catch (Exception) { stuckKeys.Add(heldKeys[i]); }
        }
        stuckKeys.Reverse();
        stuckButtons.Reverse();
        return (stuckKeys, stuckButtons);
    }
}

/// <summary>The production WMI connection: SWbemLocator through COM late binding, in this process, to the one allowlisted namespace. The only place that queries or executes.</summary>
internal sealed class ComWmiConnection : IWmiConnection
{
    private readonly dynamic _services;

    private ComWmiConnection(object services) => _services = services;

    public string Namespace => DesktopAllowlist.Namespace;

    /// <summary>Null when the scripting locator is missing or the connection is refused (no rights, WMI down): one outcome, no detail.</summary>
    public static IWmiConnection? TryConnect()
    {
        object? locator = null;
        try
        {
            if (Type.GetTypeFromProgID("WbemScripting.SWbemLocator") is not { } type) return null;
            locator = Activator.CreateInstance(type);
            dynamic late = locator!;
            return new ComWmiConnection((object)late.ConnectServer(".", DesktopAllowlist.Namespace));
        }
        catch (Exception) { return null; }
        finally { Release(locator); }
    }

    public IWmiInstance? Find(string className, string? name)
    {
        DesktopAllowlist.RequireClass(className);
        if (name is not null && !ComputerBinding.IsVmId(name)) throw new DesktopRefusal(DesktopReason.Allowlist); // the only text that is not a table entry
        string query = name is null ? $"SELECT * FROM {className}" : $"SELECT * FROM {className} WHERE Name = '{name}'";
        object results = _services.ExecQuery(query);
        return ComWmiInstance.First(results, _ => true);
    }

    public void Dispose() => Release(_services);

    internal static void Release(object? comObject)
    {
        if (comObject is not null && Marshal.IsComObject(comObject)) Marshal.FinalReleaseComObject(comObject);
    }
}

internal sealed class ComWmiInstance : IWmiInstance
{
    private readonly dynamic _object;

    internal ComWmiInstance(object wmiObject) => _object = wmiObject;

    public string ClassName => (string)_object.Path_.Class;

    private string ObjectPath => (string)_object.Path_.Path;

    public IWmiInstance? Associated(string resultClass, string? property = null, string? equals = null)
    {
        DesktopAllowlist.RequireClass(resultClass);
        object results = _object.Associators_("", resultClass);
        return First(results, candidate => property is null || string.Equals(candidate.ReadString(property), equals, StringComparison.Ordinal));
    }

    public WmiOutcome Invoke(string method, IReadOnlyDictionary<string, object> arguments, string? output = null)
    {
        DesktopAllowlist.RequireMethod(ClassName, method);
        dynamic input = _object.Methods_.Item(method).InParameters.SpawnInstance_();
        foreach ((string name, object value) in arguments) input.Properties_.Item(name).Value = value is ComWmiInstance reference ? reference.ObjectPath : value;
        dynamic result = _object.ExecMethod_(method, input);
        // Read through Properties_, never as `result.ReturnValue`: a WMI property reached by its own name gets a per-object dispatch id, which the binder caches
        // after the first call, so every later call in the process fails with E_FAIL (measured on the host).
        return new WmiOutcome(Convert.ToUInt32((object)result.Properties_.Item("ReturnValue").Value), output is null ? null : AsBytes((object?)result.Properties_.Item(output).Value));
    }

    // The scripting API hands every array back as a variant array (object[] of boxed values), also for a uint8 array such as ImageData.
    private static object? AsBytes(object? value)
    {
        if (value is not object[] elements) return value;
        byte[] bytes = new byte[elements.Length];
        for (int i = 0; i < bytes.Length; i++) bytes[i] = Convert.ToByte(elements[i]);
        return bytes;
    }

    public void Dispose() => ComWmiConnection.Release(_object);

    private string? ReadString(string property) => (object?)_object.Properties_.Item(property).Value as string;

    /// <summary>The first element of a result set that `accept` takes; the others are released.</summary>
    internal static ComWmiInstance? First(object resultSet, Func<ComWmiInstance, bool> accept)
    {
        try
        {
            foreach (object item in (System.Collections.IEnumerable)resultSet)
            {
                ComWmiInstance candidate = new(item);
                if (accept(candidate)) return candidate;
                candidate.Dispose();
            }
            return null;
        }
        finally { ComWmiConnection.Release(resultSet); }
    }
}
