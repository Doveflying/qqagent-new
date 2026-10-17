using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace QQAgent
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            bool smoke = args.Length > 0 && args[0] == "--smoke";
            var app = new ControlPanel();
            if (smoke)
            {
                app.RunSmokeTest();
                return;
            }
            Application.EnableVisualStyles();
            Application.Run(app);
        }
    }

    internal sealed class ControlPanel : Form
    {
        private readonly string _repo;
        private readonly Label[] _state = new Label[5];
        private readonly Panel[] _dot = new Panel[5];
        private readonly System.Windows.Forms.Timer _timer;
        private readonly System.Windows.Forms.Timer _watchdogTimer;

        private string _watchdogLine = "";
        private DateTime _watchdogAt = DateTime.MinValue;

        public ControlPanel()
        {
            _repo = FindRepo();

            Text = "QQ Agent 控制台";
            ClientSize = new Size(470, 430);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            Font = new Font("Microsoft YaHei UI", 9f);

            var title = new Label
            {
                Text = "QQ Agent",
                Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold),
                Location = new Point(16, 12),
                Size = new Size(240, 32),
            };
            Controls.Add(title);

            var sub = new Label
            {
                Text = "QQ 智能体运行控制台",
                ForeColor = Color.Gray,
                Location = new Point(20, 44),
                Size = new Size(260, 18),
            };
            Controls.Add(sub);

            var group = new GroupBox { Text = "服务状态", Location = new Point(16, 70), Size = new Size(438, 190) };
            Controls.Add(group);

            string[] names = { "Agent 主进程", "NapCat / OneBot", "语音代理", "VoiceStudio", "QQ 真在线" };
            int y = 26;
            for (int i = 0; i < names.Length; i++)
            {
                _dot[i] = new Panel { Location = new Point(16, y + 4), Size = new Size(10, 10), BackColor = Color.LightGray };
                group.Controls.Add(_dot[i]);

                var label = new Label { Text = names[i], Location = new Point(34, y), Size = new Size(160, 20) };
                group.Controls.Add(label);

                _state[i] = new Label { Text = "检查中…", Location = new Point(200, y), Size = new Size(210, 20) };
                group.Controls.Add(_state[i]);
                y += 30;
            }

            var ops = new GroupBox { Text = "操作", Location = new Point(16, 270), Size = new Size(438, 104) };
            Controls.Add(ops);

            ops.Controls.Add(MakeButton("启动全部", 12, 22, delegate { RunCmd("start-all.cmd"); }));
            ops.Controls.Add(MakeButton("停止全部", 120, 22, delegate { RunCmd("stop-all.cmd"); }));
            ops.Controls.Add(MakeButton("管理面板", 228, 22, delegate
            {
                if (!TestPort(3081)) { MessageBox.Show(this, "Agent 没在运行，先点\"启动全部\"。", "QQ Agent"); return; }
                try { Process.Start("http://127.0.0.1:3081"); } catch { }
            }));
            ops.Controls.Add(MakeButton("修复登录", 336, 22, delegate { RunCmd("repair-login.cmd"); }));
            ops.Controls.Add(MakeButton("强制重登", 12, 60, delegate { RunCmd("repair-login.cmd", "force"); }));
            ops.Controls.Add(MakeButton("打开日志", 120, 60, delegate
            {
                try { Process.Start("explorer.exe", Path.Combine(_repo, "logs")); } catch { }
            }));
            ops.Controls.Add(MakeButton("刷新", 228, 60, delegate { UpdateStatus(); }));

            var footer = new Label
            {
                Text = "关闭窗口不会停止机器人；停止请点\"停止全部\"。",
                ForeColor = Color.Gray,
                Location = new Point(16, 382),
                Size = new Size(438, 20),
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

        private Button MakeButton(string text, int x, int y, EventHandler onClick)
        {
            var b = new Button { Text = text, Location = new Point(x, y), Size = new Size(100, 30) };
            b.Click += onClick;
            return b;
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

        private void SetRow(int i, string text, Color color, Color dotColor)
        {
            _state[i].Text = text;
            _state[i].ForeColor = color;
            _dot[i].BackColor = dotColor;
        }

        private void UpdateStatus()
        {
            Color ok = Color.FromArgb(22, 143, 63), okDot = Color.FromArgb(46, 204, 113);
            Color warn = Color.FromArgb(190, 120, 0), warnDot = Color.FromArgb(241, 196, 15);
            Color bad = Color.FromArgb(190, 40, 40), badDot = Color.FromArgb(231, 76, 60);

            // Agent
            bool agentUp = TestPort(3081);
            if (agentUp)
            {
                double uptime = 0;
                long selfId = 0;
                bool connected = false;
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
                SetRow(0, "运行中 · " + (int)uptime + "s" + (connected ? " · " + selfId : " · 未连 OneBot"),
                    connected ? ok : warn, connected ? okDot : warnDot);
            }
            else SetRow(0, "未运行", bad, badDot);

            if (TestPort(3001)) SetRow(1, "已连接（3001）", ok, okDot);
            else SetRow(1, "未运行", bad, badDot);

            if (TestPort(3910)) SetRow(2, "运行中（3910）", ok, okDot);
            else SetRow(2, "未运行（语音退化为文字）", warn, warnDot);

            if (TestPort(3900)) SetRow(3, "运行中（3900）", ok, okDot);
            else SetRow(3, "未运行（本地音色不可用）", warn, warnDot);

            if ((DateTime.Now - _watchdogAt).TotalSeconds >= 25)
            {
                _watchdogLine = RunWatchdog();
                _watchdogAt = DateTime.Now;
            }

            if (_watchdogLine.Contains("ONLINE")) SetRow(4, "在线（消息可达）", ok, okDot);
            else if (_watchdogLine.Contains("OFFLINE")) SetRow(4, "假在线：连接已断，需重新登录", warn, warnDot);
            else if (_watchdogLine.Contains("DOWN")) SetRow(4, "无法检测（NapCat 未运行）", bad, badDot);
            else SetRow(4, "检测中…", Color.Gray, Color.LightGray);
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

        public void RunSmokeTest()
        {
            UpdateStatus();
            string[] keys = { "agent", "napcat", "proxy", "studio", "online" };
            var sb = new StringBuilder();
            for (int i = 0; i < keys.Length; i++)
                sb.AppendLine(keys[i] + " = " + _state[i].Text);
            string outFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "smoke.txt");
            File.WriteAllText(outFile, sb.ToString(), Encoding.UTF8);
            Console.WriteLine(sb.ToString());
        }
    }
}
