// Usage: dotnet HyperVDesktopHarness.dll            -> every fake-WMI scenario as one JSON document (the Node test asserts on it)
//        dotnet HyperVDesktopHarness.dll live <vm-guid> <width> <height>   -> ONE real capture through ComWmiConnection (read only; sends no input)
using System.Text.Json;

const string Guid1 = "0123abcd-4567-89ab-cdef-0123456789ab", Guid2 = "fedcba98-7654-3210-fedc-ba9876543210";

if (args.Length == 4 && args[0] == "live") return Live(args[1], int.Parse(args[2]), int.Parse(args[3]));

Console.WriteLine(JsonSerializer.Serialize(new
{
    png = PngCases(),
    pngRefusesBadSize = PngRefusesBadSize(),
    allowMatrix = AllowMatrix(),
    gate = GateCases(),
    config = new { vmIds = new[] { "0123abcd-4567-89ab-cdef-0123456789ab", "0123ABCD-4567-89AB-CDEF-0123456789AB", "0123abcd-4567-89ab-cdef-0123456789a", "0123abcd-4567-89ab-cdef-0123456789ab\n", "0123abcd45674567-89ab-cdef-0123456789ab", "g123abcd-4567-89ab-cdef-0123456789ab", "" }.Select(ComputerBinding.IsVmId).ToArray() },
    captureRejected = CaptureRejected(),
    inputRejected = InputRejected(),
    capture = CaptureCases(),
    input = InputCases(),
}));
return 0;

static int Live(string vmId, int width, int height)
{
    HyperVDesktop desktop = new([new ComputerBinding("live", vmId)], ComWmiConnection.TryConnect);
    DesktopResult result = desktop.Capture("live", width, height);
    Console.WriteLine(JsonSerializer.Serialize(new { reason = result.Reason, png = result.Png is null ? null : Convert.ToBase64String(result.Png) }));
    return 0;
}

// ---- PNG -------------------------------------------------------------------------------------------------------------------------------------

// The pixel pattern the Node test recomputes: 16 bits per pixel, spread over the whole range.
static ushort PixelValue(int index) => (ushort)((index * 40503 + 11) & 0xFFFF);

static byte[] Pixels(int width, int height)
{
    byte[] pixels = new byte[width * height * 2];
    for (int i = 0; i < width * height; i++) { pixels[i * 2] = (byte)(PixelValue(i) & 0xFF); pixels[i * 2 + 1] = (byte)(PixelValue(i) >> 8); }
    return pixels;
}

static object PngCases() => new[] { (1, 1), (3, 2), (5, 3), (64, 64), (100, 37), (333, 201) }
    .Select(size => new { width = size.Item1, height = size.Item2, png = Convert.ToBase64String(PngEncoder.FromRgb565(Pixels(size.Item1, size.Item2), size.Item1, size.Item2)) }).ToArray();

static bool[] PngRefusesBadSize() => new (int, int, int)[] { (2, 2, 7), (2, 2, 9), (0, 2, 0), (2, 0, 0), (-1, 2, 4) }.Select(c =>
{
    try { PngEncoder.FromRgb565(new byte[Math.Max(c.Item3, 0)], c.Item1, c.Item2); return false; }
    catch (ArgumentException) { return true; }
}).ToArray();

// ---- allowlist and gate ------------------------------------------------------------------------------------------------------------------------

static object AllowMatrix()
{
    string[] classes = ["Msvm_ComputerSystem", "Msvm_VirtualSystemSettingData", "Msvm_VirtualSystemManagementService", "Msvm_Keyboard", "Msvm_SyntheticMouse", "msvm_keyboard",
        "Msvm_VirtualSystemSnapshotService", "Msvm_ShutdownComponent", "Msvm_ImageManagementService", "Msvm_MemorySettingData", "Win32_Process", ""];
    string[] methods = ["GetVirtualSystemThumbnailImage", "PressKey", "ReleaseKey", "TypeKey", "TypeText", "SetAbsolutePosition", "SetButtonState", "SetScrollPosition",
        "TypeCtrlAltDel", "DefineSystem", "ModifySystemSettings", "DestroySystem", "RequestStateChange", "CreateSnapshot", "ApplySnapshot", "pressKey", "PressKey ", ""];
    return classes.ToDictionary(c => c, c => new
    {
        queryAllowed = Try(() => DesktopAllowlist.RequireClass(c)),
        methodsAllowed = methods.Where(m => Try(() => DesktopAllowlist.RequireMethod(c, m))).ToArray(),
    });
}

static bool Try(Action check)
{
    try { check(); return true; }
    catch (DesktopRefusal) { return false; }
}

static object[] GateCases()
{
    var cases = new List<object>();
    void Case(string name, Action<WmiGate, Fake> act, string? ns = null)
    {
        Fake fake = new() { Namespace = ns ?? DesktopAllowlist.Namespace };
        string outcome;
        try { act(new WmiGate(fake), fake); outcome = "allowed"; }
        catch (DesktopRefusal refusal) { outcome = refusal.Reason; }
        cases.Add(new { name, outcome, calls = fake.Log.ToArray() });
    }
    FakeInstance Instance(Fake f, string className) => new(f, className);
    var none = new Dictionary<string, object>();
    Case("namespace root cimv2", (g, f) => { }, @"root\cimv2");
    Case("namespace with different case", (g, f) => { }, @"ROOT\virtualization\v2");
    Case("find an unlisted class", (g, f) => g.Find("Win32_Process", null));
    Case("find a listed class", (g, f) => g.Find("Msvm_ComputerSystem", Guid1));
    Case("find the snapshot service", (g, f) => g.Find("Msvm_VirtualSystemSnapshotService", null));
    Case("associate to an unlisted class", (g, f) => g.Associated(Instance(f, "Msvm_ComputerSystem"), "Msvm_ShutdownComponent"));
    Case("associate from an unlisted class", (g, f) => g.Associated(Instance(f, "Win32_Process"), "Msvm_Keyboard"));
    Case("associate listed to listed", (g, f) => g.Associated(Instance(f, "Msvm_ComputerSystem"), "Msvm_Keyboard"));
    Case("DefineSystem on the management service", (g, f) => g.Call(Instance(f, "Msvm_VirtualSystemManagementService"), "DefineSystem", none));
    Case("ModifySystemSettings on the management service", (g, f) => g.Call(Instance(f, "Msvm_VirtualSystemManagementService"), "ModifySystemSettings", none));
    Case("RequestStateChange on the computer system", (g, f) => g.Call(Instance(f, "Msvm_ComputerSystem"), "RequestStateChange", none));
    Case("TypeCtrlAltDel on the keyboard", (g, f) => g.Call(Instance(f, "Msvm_Keyboard"), "TypeCtrlAltDel", none));
    Case("PressKey on the mouse", (g, f) => g.Call(Instance(f, "Msvm_SyntheticMouse"), "PressKey", none));
    Case("method name in another case", (g, f) => g.Call(Instance(f, "Msvm_Keyboard"), "presskey", none));
    Case("method on an unlisted class", (g, f) => g.Call(Instance(f, "Win32_Process"), "Create", none));
    Case("GetVirtualSystemThumbnailImage on the management service", (g, f) => g.Call(Instance(f, "Msvm_VirtualSystemManagementService"), "GetVirtualSystemThumbnailImage", none));
    Case("TypeText on the keyboard", (g, f) => g.Call(Instance(f, "Msvm_Keyboard"), "TypeText", none));
    return cases.ToArray();
}

// ---- requests the adapter refuses before it touches WMI -----------------------------------------------------------------------------------------

static object Report(string name, DesktopResult result, Fake fake) =>
    new { name, reason = result.Reason, ok = result.Ok, pngBytes = result.Png?.Length, connects = fake.Connects, calls = fake.Log.ToArray(), open = fake.Open };

static (HyperVDesktop Desktop, Fake Fake, List<int> Sleeps) Make(Fake? fake = null)
{
    fake ??= new Fake();
    List<int> sleeps = [];
    Fake f = fake;
    HyperVDesktop desktop = new([new ComputerBinding("room-1", Guid1), new ComputerBinding("room-2", Guid2)], () => { f.Connects++; return f.Unreachable ? null : f; }, sleeps.Add);
    return (desktop, f, sleeps);
}

static object[] CaptureRejected()
{
    var cases = new List<object>();
    void Case(string name, string computerId, int width, int height)
    {
        var (desktop, fake, _) = Make();
        cases.Add(Report(name, desktop.Capture(computerId, width, height), fake));
    }
    Case("unknown computer", "nope", 640, 480);
    Case("empty computer id", "", 640, 480);
    Case("computer id in another case", "ROOM-1", 640, 480);
    Case("computer id with a trailing space", "room-1 ", 640, 480);
    Case("the VM GUID instead of the computer id", Guid1, 640, 480);
    Case("a display-name style id", "albera-clone-01", 640, 480);
    Case("width 63", "room-1", 63, 480);
    Case("height 63", "room-1", 640, 63);
    Case("width 1921", "room-1", 1921, 480);
    Case("height 1921", "room-1", 640, 1921);
    Case("zero size", "room-1", 0, 0);
    Case("negative width", "room-1", -640, 480);
    Case("huge width", "room-1", int.MaxValue, 480);
    return cases.ToArray();
}

static DesktopStep Move(long x, long y) => new("move", X: x, Y: y);
static DesktopStep Tap(long vk) => new("tap", Vk: vk);

static object[] InputRejected()
{
    var cases = new List<object>();
    void Case(string name, string computerId, params DesktopStep[] steps)
    {
        var (desktop, fake, sleeps) = Make();
        DesktopResult result = desktop.Input(computerId, steps);
        cases.Add(new { report = Report(name, result, fake), sleeps = sleeps.ToArray() });
    }
    Case("unknown computer", "nope", Tap(65));
    Case("the VM GUID instead of the computer id", Guid1, Tap(65));
    Case("no steps", "room-1");
    Case("257 steps", "room-1", Enumerable.Repeat(Tap(65), 257).ToArray());
    Case("unknown op ctrlaltdel", "room-1", new DesktopStep("ctrlaltdel"));
    Case("unknown op state", "room-1", new DesktopStep("state"));
    Case("empty op", "room-1", new DesktopStep(""));
    Case("op in another case", "room-1", new DesktopStep("Move", X: 1, Y: 1));
    Case("null op", "room-1", new DesktopStep(null!, X: 1, Y: 1));
    Case("a bad step after good ones", "room-1", Tap(65), Move(1, 1), Tap(0));
    Case("virtual key 0", "room-1", Tap(0));
    Case("virtual key 255", "room-1", new DesktopStep("press", Vk: 255));
    Case("virtual key negative", "room-1", new DesktopStep("release", Vk: -1));
    Case("button 0", "room-1", new DesktopStep("down", Button: 0));
    Case("button 4", "room-1", new DesktopStep("down", Button: 4));
    Case("button 4 up", "room-1", new DesktopStep("up", Button: 4));
    Case("x negative", "room-1", Move(-1, 0));
    Case("x 4096", "room-1", Move(4096, 0));
    Case("y 4096", "room-1", Move(0, 4096));
    Case("x beyond int32", "room-1", Move(1L << 40, 0));
    Case("x wraps to 5 in int32", "room-1", Move((1L << 32) + 5, 0));
    Case("wheel 1201", "room-1", new DesktopStep("wheel", Delta: 1201));
    Case("wheel -1201", "room-1", new DesktopStep("wheel", Delta: -1201));
    Case("text empty", "room-1", new DesktopStep("text", Text: ""));
    Case("text non-ASCII", "room-1", new DesktopStep("text", Text: "café"));
    Case("text with a tab", "room-1", new DesktopStep("text", Text: "a\tb"));
    Case("text with a newline", "room-1", new DesktopStep("text", Text: "a\nb"));
    Case("text with DEL", "room-1", new DesktopStep("text", Text: "a\u007fb"));
    Case("text of 513 characters", "room-1", new DesktopStep("text", Text: new string('a', 513)));
    Case("sleep negative", "room-1", new DesktopStep("sleep", Ms: -1));
    Case("sleep 10001", "room-1", new DesktopStep("sleep", Ms: 10001));
    Case("sleeps adding up to 12001", "room-1", new DesktopStep("sleep", Ms: 6001), new DesktopStep("sleep", Ms: 6000));
    Case("move with a stray vk", "room-1", new DesktopStep("move", X: 1, Y: 1, Vk: 65));
    Case("move without y", "room-1", new DesktopStep("move", X: 1));
    Case("tap without vk", "room-1", new DesktopStep("tap"));
    Case("text with a stray ms", "room-1", new DesktopStep("text", Text: "a", Ms: 5));
    Case("sleep with text", "room-1", new DesktopStep("sleep", Ms: 5, Text: "a"));
    return cases.ToArray();
}

// ---- accepted requests: the exact WMI traffic --------------------------------------------------------------------------------------------------

static object[] CaptureCases()
{
    var cases = new List<object>();
    void Case(string name, string computerId, int width, int height, Action<Fake>? tune = null)
    {
        Fake fake = new();
        tune?.Invoke(fake);
        var (desktop, f, _) = Make(fake);
        DesktopResult result = desktop.Capture(computerId, width, height);
        cases.Add(new { report = Report(name, result, f), png = result.Png is null ? null : Convert.ToBase64String(result.Png) });
    }
    Case("640x480", "room-1", 640, 480);
    Case("the second computer is queried by its own GUID", "room-2", 64, 64);
    Case("smallest and largest edges", "room-1", 1920, 64);
    Case("odd size", "room-1", 333, 201);
    Case("VM not found", "room-1", 640, 480, f => f.VmPresent = false);
    Case("no realized settings", "room-1", 640, 480, f => f.SettingsPresent = false);
    Case("no management service", "room-1", 640, 480, f => f.ServicePresent = false);
    Case("WMI unreachable", "room-1", 640, 480, f => f.Unreachable = true);
    Case("thumbnail returns a non-zero code", "room-1", 640, 480, f => f.Inject = (m, a, n) => m == "GetVirtualSystemThumbnailImage" ? "code" : null);
    Case("thumbnail throws", "room-1", 640, 480, f => f.Inject = (m, a, n) => m == "GetVirtualSystemThumbnailImage" ? "throw" : null);
    Case("image shorter than asked", "room-1", 640, 480, f => f.ImageDelta = -2);
    Case("image longer than asked", "room-1", 640, 480, f => f.ImageDelta = 2);
    Case("image without header", "room-1", 640, 480, f => f.ImageDelta = -4);
    Case("no image data", "room-1", 640, 480, f => f.NoImage = true);
    Case("find throws", "room-1", 640, 480, f => f.FindThrows = true);
    Case("a PNG over 8 MiB is not returned", "room-1", 1920, 1920, f => f.Noise = true);
    return cases.ToArray();
}

static object[] InputCases()
{
    var cases = new List<object>();
    void Case(string name, DesktopStep[] steps, Action<Fake>? tune = null)
    {
        Fake fake = new();
        tune?.Invoke(fake);
        var (desktop, f, sleeps) = Make(fake);
        cases.Add(new { report = Report(name, desktop.Input("room-1", steps), f), sleeps = sleeps.ToArray() });
    }
    DesktopStep[] everything =
    [
        Move(10, 20), new("down", Button: 1), new("up", Button: 1), new("press", Vk: 16), Tap(65), new("release", Vk: 16),
        new("text", Text: "hi"), new("wheel", Delta: -120), new("sleep", Ms: 250), new("sleep", Ms: 0),
    ];
    Case("every op once", everything);
    Case("limits all accepted", [Move(0, 4095), new("wheel", Delta: 1200), new("wheel", Delta: -1200), new("down", Button: 3), new("up", Button: 3), Tap(254), Tap(1),
        new("text", Text: new string('~', 512)), new("sleep", Ms: 10000), new("sleep", Ms: 2000)]);
    Case("256 steps", Enumerable.Repeat(Tap(65), 256).ToArray());
    Case("no keyboard device", [Tap(65)], f => f.KeyboardPresent = false);
    Case("no mouse device", [Tap(65)], f => f.MousePresent = false);
    Case("VM not found", [Tap(65)], f => f.VmPresent = false);
    Case("WMI unreachable", [Tap(65)], f => f.Unreachable = true);

    DesktopStep[] held = [new("press", Vk: 16), new("press", Vk: 17), new("down", Button: 1), new("down", Button: 2), Tap(65), Tap(66)];
    Case("failure releases buttons then keys, newest first (non-zero code)", held, f => f.Inject = (m, a, n) => m == "TypeKey" ? "code" : null);
    Case("failure releases buttons then keys, newest first (exception)", held, f => f.Inject = (m, a, n) => m == "TypeKey" ? "throw" : null);
    Case("a released key and button are not released again", [new("press", Vk: 16), new("press", Vk: 17), new("release", Vk: 16), new("down", Button: 1), new("down", Button: 2), new("up", Button: 1), Tap(65)],
        f => f.Inject = (m, a, n) => m == "TypeKey" ? "code" : null);
    Case("failing first step releases nothing", [Tap(65), new("press", Vk: 16)], f => f.Inject = (m, a, n) => m == "TypeKey" ? "code" : null);
    Case("the press that fails is released too", [new("down", Button: 1), new("press", Vk: 16)], f => f.Inject = (m, a, n) => m == "PressKey" ? "throw" : null);
    Case("the down that fails is released too", [new("press", Vk: 16), new("down", Button: 2)], f => f.Inject = (m, a, n) => m == "SetButtonState" && (bool)a["IsDown"] ? "code" : null);
    Case("a failing release does not stop the others and keeps the original reason", held,
        f => f.Inject = (m, a, n) => m == "TypeKey" || (m == "SetButtonState" && !(bool)a["IsDown"]) || (m == "ReleaseKey" && (uint)a["KeyCode"] == 17) ? "throw" : null);
    Case("failure in the middle of text leaves nothing held", [new("press", Vk: 16), new("text", Text: "abc")], f => f.Inject = (m, a, n) => m == "TypeText" ? "code" : null);
    Case("sleeps run before a later failure", [new("sleep", Ms: 100), new("press", Vk: 16), new("sleep", Ms: 200), Tap(65)], f => f.Inject = (m, a, n) => m == "TypeKey" ? "code" : null);
    return cases.ToArray();
}

// ---- the fake WMI --------------------------------------------------------------------------------------------------------------------------------

sealed class Fake : IWmiConnection
{
    public List<string> Log { get; } = [];
    public string Namespace { get; set; } = DesktopAllowlist.Namespace;
    public int Connects, Open;
    public bool Unreachable, VmPresent = true, SettingsPresent = true, ServicePresent = true, KeyboardPresent = true, MousePresent = true, NoImage, Noise, FindThrows;
    private const string Secret = "SECRET-WMI-TEXT-4711";
    public int ImageDelta;
    /// <summary>(method, arguments, nth call of that method) -> "throw", "code" or null.</summary>
    public Func<string, IReadOnlyDictionary<string, object>, int, string?>? Inject;
    private readonly Dictionary<string, int> _calls = [];

    public IWmiInstance? Find(string className, string? name)
    {
        Log.Add($"Find {className} {name ?? "-"}");
        if (FindThrows) throw new InvalidOperationException(Secret);
        bool present = className switch { "Msvm_ComputerSystem" => VmPresent && name is "0123abcd-4567-89ab-cdef-0123456789ab" or "fedcba98-7654-3210-fedc-ba9876543210", "Msvm_VirtualSystemManagementService" => ServicePresent, _ => true };
        return present ? new FakeInstance(this, className) : null;
    }

    internal WmiOutcome Invoke(string className, string method, IReadOnlyDictionary<string, object> arguments, string? output)
    {
        string text = string.Join(",", arguments.OrderBy(a => a.Key, StringComparer.Ordinal).Select(a => $"{a.Key}={Format(a.Value)}"));
        Log.Add($"Invoke {className}.{method} {text}");
        int nth = _calls[method] = _calls.GetValueOrDefault(method) + 1;
        string? injected = Inject?.Invoke(method, arguments, nth);
        if (injected == "throw") throw new InvalidOperationException(Secret);
        if (injected == "code") return new WmiOutcome(32775, null);
        if (method != "GetVirtualSystemThumbnailImage") return new WmiOutcome(0, null);
        return new WmiOutcome(0, NoImage || !arguments.ContainsKey("WidthPixels") ? null : Image((ushort)arguments["WidthPixels"], (ushort)arguments["HeightPixels"]));
    }

    private byte[] Image(int width, int height)
    {
        byte[] image = new byte[4 + width * height * 2 + ImageDelta];
        if (Noise) new Random(7).NextBytes(image); // incompressible: the PNG cannot fit in 8 MiB
        else for (int i = 4; i < image.Length; i++) image[i] = (byte)((i - 4) % 251);
        return image;
    }

    private static string Format(object value) => value is IWmiInstance reference ? $"ref:{reference.ClassName}" : $"{value.GetType().Name}:{value}";

    public void Dispose() => Log.Add("Dispose connection");
}

sealed class FakeInstance : IWmiInstance
{
    private readonly Fake _fake;

    public FakeInstance(Fake fake, string className) { _fake = fake; ClassName = className; _fake.Open++; }

    public string ClassName { get; }

    public IWmiInstance? Associated(string resultClass, string? property = null, string? equals = null)
    {
        _fake.Log.Add($"Associated {ClassName}->{resultClass}{(property is null ? "" : $" [{property}={equals}]")}");
        bool present = resultClass switch { "Msvm_VirtualSystemSettingData" => _fake.SettingsPresent, "Msvm_Keyboard" => _fake.KeyboardPresent, "Msvm_SyntheticMouse" => _fake.MousePresent, _ => true };
        return present ? new FakeInstance(_fake, resultClass) : null;
    }

    public WmiOutcome Invoke(string method, IReadOnlyDictionary<string, object> arguments, string? output = null) => _fake.Invoke(ClassName, method, arguments, output);

    public void Dispose() => _fake.Open--;
}
