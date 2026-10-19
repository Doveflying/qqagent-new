using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

// QQ Agent 控制台 —— Operate 类界面。
// 设计取舍：
//   · 表面阶梯三级（canvas / surface / raised），层级靠亮度与 hairline，不靠阴影
//   · 单一 accent（#2F6BFF）只用于 focus 环与链接；主操作按钮用 ink 实底，不和状态色抢
//   · 状态色是语义色族：ok / warn / bad / idle 四个，绝不与 accent 混用
//   · 数据（QQ 号、uptime、端口）用等宽 + tabular 数字，正文用 YaHei
//   · 只有一处动效：状态点变化时的 180ms 缩放淡入
namespace QQAgent
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            bool smoke = args.Length > 0 && args[0] == "--smoke";
            Application.EnableVisualStyles();
            var app = new ControlPanel();
            if (smoke)
            {
                app.RunSmokeTest();
                return;
            }
            if (args.Length > 1 && args[0] == "--shot")
            {
                app.RunShot(args[1]);
                return;
            }
            Application.Run(app);
        }
    }

    // ---------------- 主题 ----------------
    internal static class Theme
    {
        public static readonly Color Canvas = Color.FromArgb(0xF5, 0xF4, 0xF1);
        public static readonly Color Surface = Color.FromArgb(0xFF, 0xFF, 0xFF);
        public static readonly Color Hairline = Color.FromArgb(0xE3, 0xE1, 0xDB);
        public static readonly Color Ink = Color.FromArgb(0x1A, 0x1C, 0x1F);
        public static readonly Color Muted = Color.FromArgb(0x6B, 0x6F, 0x76);
        public static readonly Color Faint = Color.FromArgb(0x9B, 0x9E, 0xA4);
        public static readonly Color Accent = Color.FromArgb(0x2F, 0x6B, 0xFF);

        public static readonly Color Ok = Color.FromArgb(0x2E, 0x7D, 0x4F);
        public static readonly Color Warn = Color.FromArgb(0xA0, 0x6A, 0x12);
        public static readonly Color Bad = Color.FromArgb(0xB3, 0x37, 0x2F);
        public static readonly Color Idle = Color.FromArgb(0xA8, 0xA9, 0xAD);

        public static Font Title() { return new Font("Microsoft YaHei UI", 19f, FontStyle.Bold); }
        public static Font Sub() { return new Font("Microsoft YaHei UI", 9f, FontStyle.Regular); }
        public static Font Body() { return new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular); }
        public static Font Strong() { return new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold); }
        public static Font Data() { return new Font("Cascadia Mono", 9f, FontStyle.Regular); }
        public static Font DataSmall() { return new Font("Consolas", 8.5f, FontStyle.Regular); }
    }

    // ---------------- 圆点（状态） ----------------
    internal enum DotState { Idle, Ok, Warn, Bad }

    internal sealed class StatusDot : Control
    {
        private DotState _state = DotState.Idle;
        private float _scale = 1f;
        private System.Windows.Forms.Timer _pulse;

        public StatusDot()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            Size = new Size(10, 10);
            BackColor = Color.Transparent;
        }

        public void SetState(DotState s)
        {
            if (_state == s) return;
            _state = s;
            // 唯一的一处动效：状态变化时从 1.35 缩回 1（180ms）
            if (_pulse != null) { _pulse.Stop(); _pulse.Dispose(); }
            _scale = 1.35f;
            _pulse = new System.Windows.Forms.Timer { Interval = 16 };
            int ticks = 0;
            _pulse.Tick += delegate
            {
                ticks++;
                _scale = 1f + 0.35f * (float)Math.Pow(0.72, ticks);
                if (_scale < 1.01f) { _scale = 1f; _pulse.Stop(); }
                Invalidate();
            };
            _pulse.Start();
            Invalidate();
        }

        public DotState State { get { return _state; } }

        protected override void OnPaint(PaintEventArgs e)
        {
            Color c = Theme.Idle;
            if (_state == DotState.Ok) c = Theme.Ok;
            else if (_state == DotState.Warn) c = Theme.Warn;
            else if (_state == DotState.Bad) c = Theme.Bad;

            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float d = 8f * _scale;
            float x = (Width - d) / 2f;
            float y = (Height - d) / 2f;
            using (var b = new SolidBrush(c)) e.Graphics.FillEllipse(b, x, y, d, d);
        }
    }

    // ---------------- 按钮 ----------------
    internal enum BtnKind { Primary, Secondary, Danger, Quiet }

    internal sealed class FlatButton : Button
    {
        private bool _hover;
        private bool _down;
        public BtnKind Kind = BtnKind.Secondary;

        public FlatButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Font = Theme.Strong();
            Size = new Size(104, 32);
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);

            Color fill, text, border;
            switch (Kind)
            {
                case BtnKind.Primary:
                    fill = _down ? Color.FromArgb(0x33, 0x36, 0x3C) : (_hover ? Color.FromArgb(0x2A, 0x2D, 0x33) : Theme.Ink);
                    text = Color.White; border = fill;
                    break;
                case BtnKind.Danger:
                    fill = _down ? Color.FromArgb(0xF3, 0xE3, 0xE1) : (_hover ? Color.FromArgb(0xF8, 0xEC, 0xEA) : Theme.Surface);
                    text = Theme.Bad; border = Color.FromArgb(0xE8, 0xCF, 0xCB);
                    break;
                case BtnKind.Quiet:
                    fill = _hover ? Color.FromArgb(0xF0, 0xEF, 0xEB) : Theme.Surface;
                    text = Theme.Muted; border = Color.Transparent;
                    break;
                default:
                    fill = _down ? Color.FromArgb(0xEC, 0xEA, 0xE5) : (_hover ? Color.FromArgb(0xF3, 0xF2, 0xEE) : Theme.Surface);
                    text = Theme.Ink; border = Theme.Hairline;
                    break;
            }

            using (var b = new SolidBrush(fill)) g.FillRectangle(b, rect);
            if (border.A > 0)
            {
                using (var p = new Pen(border)) g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            }
            if (Focused && ShowFocusCues)
            {
                using (var p = new Pen(Theme.Accent, 2f))
                    g.DrawRectangle(p, 2, 2, Width - 5, Height - 5);
            }

            TextRenderer.DrawText(g, Text, Font, rect, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    // ---------------- 状态行 ----------------
    internal sealed class StatusRow : Panel
    {
        public readonly Label Caption = new Label();
        public readonly Label Value = new Label();
        public readonly StatusDot Dot = new StatusDot();
        private readonly bool _separator;

        public StatusRow(string name, bool separator)
        {
            _separator = separator;
            BackColor = Theme.Surface;
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);

            Caption.Text = name;
            Caption.Font = Theme.Body();
            Caption.ForeColor = Theme.Ink;
            Caption.AutoSize = false;
            Caption.TextAlign = ContentAlignment.MiddleLeft;
            Caption.BackColor = Theme.Surface;

            Value.Font = Theme.Body();
            Value.ForeColor = Theme.Muted;
            Value.AutoSize = false;
            Value.TextAlign = ContentAlignment.MiddleRight;
            Value.BackColor = Theme.Surface;
            Value.AutoEllipsis = true;

            Dot.BackColor = Theme.Surface;

            Controls.Add(Value);
            Controls.Add(Caption);
            Controls.Add(Dot);
            Arrange();
        }

        // 手动布局：不依赖 Anchor（创建时父容器尺寸为 0，锚定会把宽度算成负值）
        private void Arrange()
        {
            int w = Width;
            int rowH = Height - 1;
            Caption.Bounds = new Rectangle(14, 0, 150, rowH);
            Value.Bounds = new Rectangle(168, 0, Math.Max(40, w - 168 - 34), rowH);
            Dot.Bounds = new Rectangle(w - 26, (rowH - 10) / 2, 10, 10);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            Arrange();
        }

        public void Set(string value, DotState state, bool mono)
        {
            Value.Text = value;
            Value.Font = mono ? Theme.Data() : Theme.Body();
            Dot.SetState(state);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (_separator)
            {
                using (var p = new Pen(Theme.Hairline))
                    e.Graphics.DrawLine(p, 0, Height - 1, Width, Height - 1);
            }
        }
    }
    // ---------------- 主窗口 ----------------
    internal sealed class ControlPanel : Form
    {
        private readonly string _repo;
        private readonly StatusRow[] _rows = new StatusRow[5];
        private readonly Label _summary = new Label();
        private readonly Label _clock = new Label();
        private readonly System.Windows.Forms.Timer _timer;
        private readonly System.Windows.Forms.Timer _watchdogTimer;

        private string _watchdogLine = "";
        private DateTime _watchdogAt = DateTime.MinValue;

        private static readonly string[] RowNames = {
            "Agent 主进程", "NapCat / OneBot", "语音代理", "VoiceStudio", "QQ 真在线"
        };

        public ControlPanel()
        {
            _repo = FindRepo();

            Text = "QQ Agent";
            ClientSize = new Size(468, 452);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = Theme.Canvas;
            Font = Theme.Body();
            DoubleBuffered = true;

            // ---------- 标题区 ----------
            var title = new Label
            {
                Text = "QQ Agent",
                Font = Theme.Title(),
                ForeColor = Theme.Ink,
                Location = new Point(24, 20),
                Size = new Size(220, 38),
                BackColor = Color.Transparent,
            };
            Controls.Add(title);

            _summary.Text = "正在检查…";
            _summary.Font = Theme.Sub();
            _summary.ForeColor = Theme.Muted;
            _summary.Location = new Point(26, 58);
            _summary.Size = new Size(240, 18);
            _summary.BackColor = Color.Transparent;
            Controls.Add(_summary);

            _clock.Text = "";
            _clock.Font = Theme.DataSmall();
            _clock.ForeColor = Theme.Muted;
            _clock.TextAlign = ContentAlignment.TopRight;
            _clock.Location = new Point(300, 24);
            _clock.Size = new Size(144, 18);
            _clock.BackColor = Color.Transparent;
            _clock.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            Controls.Add(_clock);

            // ---------- 状态卡 ----------
            var card = new Panel
            {
                Location = new Point(20, 88),
                Size = new Size(428, RowNames.Length * 39 + 2),
                BackColor = Theme.Surface,
            };
            card.Paint += delegate(object s, PaintEventArgs e)
            {
                using (var p = new Pen(Theme.Hairline)) e.Graphics.DrawRectangle(p, 0, 0, card.Width - 1, card.Height - 1);
            };
            Controls.Add(card);

            for (int i = 0; i < RowNames.Length; i++)
            {
                _rows[i] = new StatusRow(RowNames[i], i < RowNames.Length - 1);
                _rows[i].Location = new Point(1, 1 + i * 39);
                _rows[i].Size = new Size(card.Width - 2, 39);
                card.Controls.Add(_rows[i]);
            }

            // ---------- 操作区 ----------
            var actions = new Panel
            {
                Location = new Point(20, 88 + card.Height + 16),
                Size = new Size(428, 76),
                BackColor = Theme.Canvas,
            };
            Controls.Add(actions);

            var start = new FlatButton { Text = "启动全部", Kind = BtnKind.Primary, Location = new Point(0, 0), Size = new Size(104, 34) };
            start.Click += delegate { RunCmd("start-all.cmd"); };

            var stop = new FlatButton { Text = "停止全部", Kind = BtnKind.Danger, Location = new Point(112, 0), Size = new Size(104, 34) };
            stop.Click += delegate { RunCmd("stop-all.cmd"); };

            var panel = new FlatButton { Text = "管理面板", Kind = BtnKind.Secondary, Location = new Point(224, 0), Size = new Size(104, 34) };
            panel.Click += delegate
            {
                if (!TestPort(3081)) { MessageBox.Show(this, "Agent 没在运行，先点「启动全部」。", "QQ Agent"); return; }
                try { Process.Start("http://127.0.0.1:3081"); } catch { }
            };

            var force = new FlatButton { Text = "强制重登", Kind = BtnKind.Secondary, Location = new Point(336, 0), Size = new Size(92, 34) };
            force.Click += delegate { RunCmd("repair-login.cmd", "force"); };

            var post = new FlatButton { Text = "发动态", Kind = BtnKind.Secondary, Location = new Point(0, 42), Size = new Size(104, 34) };
            post.Click += delegate { RunCmd("post-now.cmd"); };

            var logs = new FlatButton { Text = "打开日志", Kind = BtnKind.Quiet, Location = new Point(112, 42), Size = new Size(104, 34) };
            logs.Click += delegate { try { Process.Start("explorer.exe", Path.Combine(_repo, "logs")); } catch { } };

            var refresh = new FlatButton { Text = "刷新", Kind = BtnKind.Quiet, Location = new Point(224, 42), Size = new Size(80, 34) };
            refresh.Click += delegate { UpdateStatus(); };

            actions.Controls.Add(start);
            actions.Controls.Add(stop);
            actions.Controls.Add(panel);
            actions.Controls.Add(force);
            actions.Controls.Add(post);
            actions.Controls.Add(logs);
            actions.Controls.Add(refresh);

            // ---------- 页脚 ----------
            var footer = new Label
            {
                Text = "关闭窗口不会停止机器人；停止请点「停止全部」。",
                Font = Theme.Sub(),
                ForeColor = Theme.Muted,
                Location = new Point(22, 88 + card.Height + 16 + 80),
                Size = new Size(430, 18),
                BackColor = Color.Transparent,
            };
            Controls.Add(footer);

            _timer = new System.Windows.Forms.Timer { Interval = 3000 };
            _timer.Tick += delegate { UpdateStatus(); };
            _timer.Start();

            _watchdogTimer = new System.Windows.Forms.Timer { Interval = 30000 };
            _watchdogTimer.Tick += delegate { _watchdogAt = DateTime.MinValue; };
            _watchdogTimer.Start();

            Shown += delegate { UpdateStatus(); };
        }

        private static string FindRepo()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 4 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir, "start-all.cmd"))) return dir;
                var parent = Directory.GetParent(dir);
                if (parent == null) break;
                dir = parent.FullName;
            }
            return @"C:\桌面图标\qwe\QQagent";
        }

        private void RunCmd(string fileName, string extraArgs = "")
        {
            string full = Path.Combine(_repo, fileName);
            if (!File.Exists(full))
            {
                MessageBox.Show(this, "找不到 " + full, "QQ Agent");
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + full + "\" " + extraArgs)
                {
                    WorkingDirectory = _repo,
                    UseShellExecute = true,
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "QQ Agent");
            }
        }

        private static bool TestPort(int port)
        {
            try
            {
                using (var c = new TcpClient())
                {
                    var task = c.ConnectAsync("127.0.0.1", port);
                    if (!task.Wait(400)) return false;
                    return c.Connected;
                }
            }
            catch { return false; }
        }

        private void UpdateStatus()
        {
            _clock.Text = DateTime.Now.ToString("HH:mm:ss");

            int okCount = 0;

            // Agent
            bool agentUp = TestPort(3081);
            bool connected = false;
            double uptime = 0;
            long selfId = 0;
            if (agentUp)
            {
                try
                {
                    using (var wc = new System.Net.WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        string json = wc.DownloadString("http://127.0.0.1:3081/api/health");
                        var m1 = Regex.Match(json, "\"connected\":(true|false)");
                        if (m1.Success) connected = m1.Groups[1].Value == "true";
                        var m2 = Regex.Match(json, "\"uptimeMs\":(\\d+)");
                        if (m2.Success) uptime = double.Parse(m2.Groups[1].Value) / 1000.0;
                        var m3 = Regex.Match(json, "\"selfId\":(\\d+)");
                        if (m3.Success) selfId = long.Parse(m3.Groups[1].Value);
                    }
                }
                catch { }
            }

            if (!agentUp)
            {
                _rows[0].Set("未运行", DotState.Bad, false);
            }
            else if (connected)
            {
                _rows[0].Set(string.Format("{0}s · {1}", (int)uptime, selfId), DotState.Ok, true);
                okCount++;
            }
            else
            {
                _rows[0].Set(string.Format("未连 OneBot · {0}s", (int)uptime), DotState.Warn, false);
            }

            if (TestPort(3001)) { _rows[1].Set("已连接", DotState.Ok, false); okCount++; }
            else _rows[1].Set("未运行", DotState.Bad, false);

            if (TestPort(3910)) { _rows[2].Set("运行中", DotState.Ok, false); okCount++; }
            else _rows[2].Set("未运行", DotState.Warn, false);

            if (TestPort(3900)) { _rows[3].Set("运行中", DotState.Ok, false); okCount++; }
            else _rows[3].Set("未运行", DotState.Warn, false);

            if ((DateTime.Now - _watchdogAt).TotalSeconds >= 25)
            {
                _watchdogLine = RunWatchdog();
                _watchdogAt = DateTime.Now;
            }

            if (_watchdogLine.Contains("ONLINE")) { _rows[4].Set("在线", DotState.Ok, false); okCount++; }
            else if (_watchdogLine.Contains("OFFLINE")) _rows[4].Set("假在线 · 需重登", DotState.Warn, false);
            else if (_watchdogLine.Contains("DOWN")) _rows[4].Set("无法检测", DotState.Bad, false);
            else _rows[4].Set("检测中…", DotState.Idle, false);

            if (okCount == 5) { _summary.Text = "全部正常"; _summary.ForeColor = Theme.Ok; }
            else if (okCount >= 3) { _summary.Text = string.Format("{0}/5 正常 · 部分降级", okCount); _summary.ForeColor = Theme.Warn; }
            else { _summary.Text = string.Format("{0}/5 正常 · 需要处理", okCount); _summary.ForeColor = Theme.Bad; }
        }

        private string RunWatchdog()
        {
            try
            {
                string script = Path.Combine(_repo, "scripts", "watchdog.mjs");
                if (!File.Exists(script)) return "";
                var psi = new ProcessStartInfo("node", "\"" + script + "\" --verbose")
                {
                    WorkingDirectory = _repo,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(8000);
                    foreach (string line in output.Split('\n'))
                    {
                        if (line.Contains("ONLINE") || line.Contains("OFFLINE") || line.Contains("DOWN")) _watchdogLine = line;
                    }
                    return _watchdogLine;
                }
            }
            catch { return ""; }
        }

        // 把整个窗口渲染成 PNG：不受屏幕 DPI 缩放影响，用来核对设计
        public void RunShot(string path)
        {
            UpdateStatus();
            CreateControl();
            foreach (Control c in Controls) c.CreateControl();
            using (var bmp = new Bitmap(Width, Height))
            {
                DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                Console.WriteLine("shot saved: " + path + " " + bmp.Width + "x" + bmp.Height);
            }
        }

        public void RunSmokeTest()
        {
            UpdateStatus();
            var sb = new StringBuilder();
            sb.AppendLine("summary = " + _summary.Text);
            for (int i = 0; i < _rows.Length; i++)
                sb.AppendLine(RowNames[i] + " = " + _rows[i].Value.Text + " [" + _rows[i].Dot.State + "]");
            string outFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "smoke.txt");
            File.WriteAllText(outFile, sb.ToString(), Encoding.UTF8);
            Console.WriteLine(sb.ToString());
        }
    }
}
