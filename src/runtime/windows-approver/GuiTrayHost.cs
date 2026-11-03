using System.Drawing;
using System.Windows.Forms;

namespace Albera.Approver;

// `AlberaApprover.exe --tray`: lives in the notification area, asks the Authority for its pending list every 2 seconds (the same pipe, the same server check and the same
// parser as `list`: ApproverCommands.ListPendingAsync) and opens one ApprovalWindow per request. The second request onward waits; the tray text says "あと N 件".
// This class never approves anything: it opens windows. Starting it at logon (the Run key) belongs to the installer, not to this file.
internal static class TrayApp
{
    private const string InstanceName = @"Local\AlberaApproverTray"; // one tray per logon session

    public static int Run(Wiring wiring)
    {
        using Mutex instance = new(initiallyOwned: true, InstanceName, out bool isFirst);
        if (!isFirst) return ExitCodes.Ok; // already running in this session: nothing to do
        GuiNative.DetachConsole(); // started from the Run key, not from a console
        Thread thread = new(() =>
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayHost(wiring, () => DateTimeOffset.UtcNow));
        });
        thread.SetApartmentState(ApartmentState.STA); // WinForms and the notification icon need an STA thread
        thread.Start();
        thread.Join();
        return ExitCodes.Ok;
    }
}

internal sealed class TrayHost : ApplicationContext
{
    private const int PollMs = 2000, FirstPollMs = 200;

    private readonly Wiring wiring;
    private readonly Func<DateTimeOffset> clock;
    private readonly NotifyIcon icon;
    private readonly System.Windows.Forms.Timer poll = new() { Interval = FirstPollMs }; // the first look comes quickly, then every PollMs
    private HashSet<string> handled = [];
    private readonly WrongPickLedger wrongPicks = new();
    private IReadOnlyList<ListedRequest> pending = [];
    private ApprovalWindow? open;
    private string? openId, problem;
    private bool polling, exitWhenClosed;

    public TrayHost(Wiring wiring, Func<DateTimeOffset> clock)
    {
        this.wiring = wiring;
        this.clock = clock;
        ContextMenuStrip menu = new();
        menu.Items.Add("待っている依頼を開く", null, (_, _) => Reopen());
        menu.Items.Add("終了", null, (_, _) => RequestExit());
        icon = new NotifyIcon { Icon = SystemIcons.Shield, Text = ApprovalQueue.TrayText(new QueueView(null, 0, 0), null), ContextMenuStrip = menu, Visible = false }; // shown after the first look: an account that is not the approver never sees an icon
        icon.DoubleClick += (_, _) => Reopen();
        poll.Tick += async (_, _) => await PollAsync();
        poll.Start();
    }

    protected override void ExitThreadCore()
    {
        poll.Stop();
        icon.Visible = false;
        icon.Dispose();
        poll.Dispose();
        base.ExitThreadCore();
    }

    private ApproverCommands NewCommands() =>
        new(new PipeChannel(wiring.Expectation, wiring.TimeoutMs), wiring.Signer, TextWriter.Null, TextWriter.Null, TextReader.Null, clock, interactive: false);

    private async Task PollAsync()
    {
        poll.Interval = PollMs;
        if (polling) return; // a slow answer must not start a second call
        polling = true;
        bool quit = false;
        try
        {
            (CommandOutcome outcome, IReadOnlyList<ListedRequest> items) = await NewCommands().ListPendingAsync();
            quit = ApprovalQueue.ShouldQuit(outcome);
            problem = outcome.Ok ? null : outcome.ErrorCode ?? "error";
            if (outcome.Ok)
            {
                pending = items;
                handled = ApprovalQueue.Prune(handled, items);
                wrongPicks.Prune(items);
                if (openId is not null && items.All(item => item.ApprovalId != openId)) open?.CloseIfIdle(); // expired or settled elsewhere
                OpenNext();
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            problem = "internal";
        }
        finally
        {
            polling = false;
            if (quit) ExitThread(); // not the approver account: nothing for this tray to do
            else
            {
                icon.Text = ApprovalQueue.TrayText(ApprovalQueue.Next(pending, handled, open is not null), problem);
                icon.Visible = true;
            }
        }
    }

    private void OpenNext()
    {
        if (ApprovalQueue.Next(pending, handled, open is not null).OpenNow is not { ApprovalId: { } id } item) return;
        handled.Add(id);
        ApprovalWindow window = new(ApprovalPrompt.From(item, clock()), NewCommands(), clock, SystemInformation.TerminalServerSession, wrongPicks.For(id)); // wrong picks carry over to a reopened window
        window.FormClosed += (_, _) => { wrongPicks.Record(id, window.WrongMask); open = null; openId = null; window.Dispose(); if (exitWhenClosed) ExitThread(); };
        open = window;
        openId = id;
        window.Show(); // ShowWithoutActivation: the keyboard focus stays where it was
    }

    // "終了" closes the open window first: a window with a wrong pick sends its deny on closing, so quitting the tray is not a way to forget the wrong picks.
    private void RequestExit()
    {
        if (open is null) { ExitThread(); return; }
        exitWhenClosed = true;
        open.Close(); // a window that is busy refuses; the person asks again when it is done
    }

    // A window the person closed without deciding stays pending at the Authority; this brings it back.
    private void Reopen()
    {
        handled.RemoveWhere(id => id != openId);
        OpenNext();
    }
}
