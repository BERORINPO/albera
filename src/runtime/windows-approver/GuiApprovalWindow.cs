using System.Drawing;
using System.Windows.Forms;

namespace Albera.Approver;

// A button that only a real mouse click can press. It cannot take the keyboard focus (so Enter and Space never reach it), it is never a default button, and a click that did
// not start with a left mouse-down on it (PerformClick, an accessibility "invoke", a stray BM_CLICK) is dropped.
internal sealed class MouseOnlyButton : Button
{
    private bool pressedByMouse;

    public MouseOnlyButton()
    {
        SetStyle(ControlStyles.Selectable, false);
        TabStop = false;
        UseMnemonic = false;
    }

    protected override void OnMouseDown(MouseEventArgs mevent)
    {
        pressedByMouse = mevent.Button == MouseButtons.Left;
        base.OnMouseDown(mevent);
    }

    protected override void OnMouseUp(MouseEventArgs mevent)
    {
        base.OnMouseUp(mevent); // the click, if any, is raised in here
        pressedByMouse = false;
    }

    protected override void OnClick(EventArgs e)
    {
        bool real = pressedByMouse;
        pressedByMouse = false;
        if (real) base.OnClick(e);
    }

    protected override bool IsInputKey(Keys keyData) => false;

    protected override void OnKeyDown(KeyEventArgs kevent) => kevent.Handled = true;

    protected override void OnKeyUp(KeyEventArgs kevent) => kevent.Handled = true;
}

// The approval window: one per pending request. It draws an ApprovalPrompt and forwards clicks; every rule (which buttons exist, when they can be pressed, what a wrong pick does)
// lives in ApprovalPrompt. Shown without taking focus (ShowWithoutActivation plus a taskbar flash), no default button, Enter and Space do nothing.
// The only call that approves anything in the whole program is in HandleChoiceAsync, which only the click handler of a match-code button calls.
internal sealed class ApprovalWindow : Form
{
    private const int AutoCloseSeconds = 3;
    private static readonly Color Highlight = Color.Gold, Alarm = Color.Firebrick, Notice = Color.DarkOrange;

    private readonly ApprovalPrompt prompt;
    private readonly ApproverCommands commands;
    private readonly Func<DateTimeOffset> clock;
    private readonly List<MouseOnlyButton> choiceButtons = [];
    private readonly MouseOnlyButton denyButton = new() { Text = "拒否する", Size = new Size(120, 40) };
    private readonly Label countdown = MakeLabel(""), warning = MakeLabel(""), status = MakeLabel("");
    private readonly System.Windows.Forms.Timer tick = new() { Interval = 250 };
    private PickState state = new();
    private DateTimeOffset? closeAt;

    internal ApprovalWindow(ApprovalPrompt prompt, ApproverCommands commands, Func<DateTimeOffset> clock, bool remoteSession)
    {
        this.prompt = prompt;
        this.commands = commands;
        this.clock = clock;
        Text = "ALBERA 承認の依頼";
        AcceptButton = null;
        CancelButton = null;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = true;
        TopMost = true;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        ShowIcon = true;
        Icon = SystemIcons.Shield;
        Build(remoteSession);
        warning.ForeColor = Alarm;
        denyButton.Click += OnDenyClick;
        tick.Tick += (_, _) => ApplyState();
        Load += (_, _) => PlaceInCorner();
        Shown += (_, _) => GuiNative.FlashTaskbar(Handle);
        tick.Start();
        ApplyState();
    }

    /// <summary>Windows is told not to activate this window when it is shown: a window that appears while the person types must not take the keystrokes.</summary>
    protected override bool ShowWithoutActivation => true;

    internal string StatusText => status.Text;

    internal string WarningText => warning.Text;

    internal IReadOnlyList<Button> ChoiceButtons => choiceButtons;

    internal Button DenyButton => denyButton;

    internal bool IsFinished => state.Finished;

    /// <summary>The tray calls this when the request is no longer in the Authority's list (it expired or was decided elsewhere) and this window decided nothing: there is nothing left to click.</summary>
    internal void CloseIfIdle()
    {
        if (!state.Busy && !state.Finished) Close();
    }

    // Enter and Space are swallowed for the whole window: nothing is decided from the keyboard.
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData) =>
        (keyData & Keys.KeyCode) is Keys.Enter or Keys.Space || base.ProcessCmdKey(ref msg, keyData);

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (state.Busy) e.Cancel = true; // Windows Hello or the Authority call is running: closing now would hide the outcome
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) tick.Dispose();
        base.Dispose(disposing);
    }

    // ---- state ------------------------------------------------------------------------------------------------------------------------

    /// <summary>Re-reads the clock and sets every button's enabled flag and the countdown from the prompt's rules. Called by the timer; the harness calls it with its own clock.</summary>
    internal void ApplyState()
    {
        DateTimeOffset now = clock();
        for (int i = 0; i < choiceButtons.Count; i++) choiceButtons[i].Enabled = prompt.ChoiceEnabled(state, i, now);
        denyButton.Enabled = prompt.DenyEnabled(state, now);
        countdown.Text = prompt.ExpiryText(now);
        if (prompt.IsExpired(now) && !state.Finished && status.Text.Length == 0) status.Text = "期限が切れました。ボタンは使えません。";
        if (closeAt is { } at && now >= at) Close();
    }

    // The click handler of a match-code button: the pick is judged by the prompt, and only the correct one starts Windows Hello and the approval.
    private async void OnChoiceClick(object? sender, EventArgs e)
    {
        if (sender is not MouseOnlyButton { Tag: int index }) return;
        try { await HandleChoiceAsync(index); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { Fail(); }
    }

    private async void OnDenyClick(object? sender, EventArgs e)
    {
        try { await HandleDenyAsync(); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { Fail(); }
    }

    internal async Task HandleChoiceAsync(int index)
    {
        (state, PickOutcome outcome) = prompt.Pick(state, index, clock());
        ApplyState();
        switch (outcome)
        {
            case PickOutcome.Wrong:
                warning.Text = "違います。ルーム画面の照合コードをもう一度見てください。あと 1 回間違えると、拒否として送ります。";
                break;
            case PickOutcome.WrongTwice:
                warning.Text = "2 回間違えました。";
                await SendDenyAsync();
                break;
            case PickOutcome.Correct:
                status.Text = "Windows Hello で確認してください。";
                TopMost = false; // do not cover the Windows Hello prompt
                GuiNative.BringToFront(Handle);
                CommandOutcome result = await Task.Run(() => commands.ApproveShownAsync(prompt.View!)); // Windows Hello blocks: never on the UI thread
                state = ApprovalPrompt.AfterApprove(state, result);
                Present(ApprovalPrompt.ApproveResultText(result), result.Ok);
                break;
        }
    }

    internal Task HandleDenyAsync() => prompt.DenyEnabled(state, clock()) ? SendDenyAsync() : Task.CompletedTask;

    private async Task SendDenyAsync()
    {
        state = ApprovalPrompt.BeginDeny(state);
        ApplyState();
        CommandOutcome result = await commands.DenyShownAsync(prompt.ApprovalId!);
        state = ApprovalPrompt.AfterDeny(state);
        Present(ApprovalPrompt.DenyResultText(result), result.Ok);
    }

    private void Present(string text, bool done)
    {
        status.Text = text;
        if (done) closeAt = clock().AddSeconds(AutoCloseSeconds);
        ApplyState();
    }

    private void Fail()
    {
        state = state with { Busy = false, Finished = true };
        Present("内部エラーです。承認は完了していません。", done: false);
    }

    // ---- layout -----------------------------------------------------------------------------------------------------------------------

    private void Build(bool remoteSession)
    {
        TableLayoutPanel layout = new() { ColumnCount = 1, AutoSize = true, Padding = new Padding(14), Dock = DockStyle.Fill };
        Controls.Add(layout);
        if (remoteSession) layout.Controls.Add(Banner("リモートデスクトップで接続中です。この PC の前で承認してください。", Notice));
        if (prompt.Block != BlockReason.None) layout.Controls.Add(Banner(prompt.BlockText, Alarm));
        layout.Controls.Add(MakeLabel("承認の依頼", bold: true, size: 14f));
        layout.Controls.Add(MakeLabel(prompt.Summary));
        if (prompt.TaskRuns is { } task) layout.Controls.Add(Box("タスク (送られた文字列そのまま。黄色は ASCII 以外の文字)", 80, [new DisplayLine("", task)]));
        if (prompt.Details.Count > 0) layout.Controls.Add(Box("内容", 120, prompt.Details));
        layout.Controls.Add(countdown);
        if (prompt.CanApprove)
        {
            layout.Controls.Add(MakeLabel("ルーム画面に出ている 4 桁の照合コードと同じものを選んでください。", bold: true));
            FlowLayoutPanel choices = new() { AutoSize = true, Margin = new Padding(0, 6, 0, 6) };
            for (int i = 0; i < prompt.Choices.Count; i++)
            {
                MouseOnlyButton button = new() { Text = prompt.Choices[i], Tag = i, Size = new Size(130, 56), Margin = new Padding(0, 0, 10, 0), Font = new Font(Font.FontFamily, 18f, FontStyle.Bold) };
                button.Click += OnChoiceClick;
                choiceButtons.Add(button);
                choices.Controls.Add(button);
            }
            layout.Controls.Add(choices);
        }
        layout.Controls.Add(warning);
        layout.Controls.Add(status);
        layout.Controls.Add(denyButton);
    }

    private static Label MakeLabel(string text, bool bold = false, float size = 0f)
    {
        Label label = new() { Text = text, AutoSize = true, MaximumSize = new Size(560, 0), Margin = new Padding(0, 4, 0, 4) };
        if (bold || size > 0f) label.Font = new Font(label.Font.FontFamily, size > 0f ? size : label.Font.Size, bold ? FontStyle.Bold : FontStyle.Regular);
        return label;
    }

    private static Label Banner(string text, Color color)
    {
        Label banner = MakeLabel(text, bold: true);
        banner.BackColor = color;
        banner.ForeColor = Color.White;
        banner.Padding = new Padding(6);
        return banner;
    }

    private static Control Box(string caption, int height, IEnumerable<DisplayLine> lines)
    {
        FlowLayoutPanel group = new() { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Margin = new Padding(0, 4, 0, 4) };
        group.Controls.Add(MakeLabel(caption));
        RichTextBox box = new() { ReadOnly = true, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, DetectUrls = false, TabStop = false, ScrollBars = RichTextBoxScrollBars.Vertical, Size = new Size(560, height), Cursor = Cursors.Default };
        bool first = true;
        foreach (DisplayLine line in lines)
        {
            if (!first) Append(box, "\n", false);
            first = false;
            if (line.Label.Length > 0) Append(box, line.Label + ": ", false);
            foreach (TextRun run in line.Runs) Append(box, run.Text, run.Highlight);
        }
        group.Controls.Add(box);
        return group;
    }

    private static void Append(RichTextBox box, string text, bool highlight)
    {
        int start = box.TextLength;
        box.AppendText(text);
        box.Select(start, text.Length);
        box.SelectionBackColor = highlight ? Highlight : box.BackColor;
        box.Select(box.TextLength, 0);
    }

    private void PlaceInCorner()
    {
        Rectangle area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1024, 768);
        Location = new Point(Math.Max(area.Left, area.Right - Width - 16), Math.Max(area.Top, area.Bottom - Height - 16));
    }
}
