// Guy Code Windows app-automation helper.
//
// One instance == one isolation SESSION. On startup it creates a hidden Win32
// desktop (CreateDesktop) and binds its own process to it so every app it
// launches, every UI-Automation walk, every PrintWindow capture, and all
// input happen on that hidden desktop - never on the user's interactive
// desktop. The user's screen / mouse / keyboard are untouched.
//
// Protocol: newline-delimited JSON over stdin/stdout.
//   Request:  {"id":<n>,"op":"launch|list|screenshot|click|type|key|close|ping","args":{...}}
//   Response: {"id":<n>,"ok":true,"data":{...}}  or  {"id":<n>,"ok":false,"error":"..."}
// Screenshots come back as base64 PNG in data.pngBase64.
//
// Built against .NET Framework 4.x with csc.exe (present on every Win10/11
// box): references System.Drawing + UIAutomationClient + UIAutomationTypes.
// No SDK or runtime install required.
//
// IMPORTANT: the helper's MAIN THREAD calls SetThreadDesktop FIRST, before any
// USER32 / UIA / Console window work, so the ERROR_BUSY (gle=170) ordering
// trap is avoided. All op handling runs on that desktop-bound thread.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Native {
  // Per-monitor-v2 DPI awareness. Without this, the hidden-desktop compositor
  // applies a DPI scale factor when a window activates, which (a) RESIZES the
  // window on focus (e.g. 1106 -> 1383 wide) and (b) makes screenshot pixels
  // and SendInput screen coords disagree - so coordinates from one screenshot
  // are stale for the next click/drag, and strokes land in the wrong place or
  // not at all. Declaring the helper per-monitor-v2 aware keeps everything in
  // real device pixels and stops the on-focus rescale.
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4
  public static readonly IntPtr DPI_PER_MONITOR_V2 = new IntPtr(-4);
  // Fallbacks for older Windows where the above isn't available.
  [DllImport("shcore.dll", SetLastError = true)]
  public static extern int SetProcessDpiAwareness(int value); // 2 = PROCESS_PER_MONITOR_DPI_AWARE
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr dm, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr h);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  // Window mouse messages: these go straight to the target window's message
  // queue and work REGARDLESS of input desktop. SendInput / SetCursorPos do
  // NOT work on a hidden (non-input) desktop - the cursor is frozen at 0,0 -
  // so a canvas receives zero mouse events. PostMessage is how we drive a
  // window on the hidden desktop. wParam MK_LBUTTON during WM_MOUSEMOVE tells
  // the app the button is held (so a canvas draws while dragging).
  public const uint WM_MOUSEMOVE = 0x0200;
  public const int MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002;
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

  // SendInput: injects real mouse/keyboard events into the desktop the
  // CALLING THREAD is attached to. Because the helper's thread is bound to
  // the hidden desktop (SetThreadDesktop), these land there - producing real
  // mouse drags the canvas honors - without touching the user's real desktop.
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inp, int sz);

  public const uint DESKTOP_ALL = 0x01FF;
  public const uint PW_RENDERFULLCONTENT = 0x00000002;
  public const uint WM_CHAR = 0x0102, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;
  public const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
  // SendInput mouse flags.
  public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  public const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
}

// Minimal JSON writer/reader (no external deps; csc-only build).
static class J {
  public static string Esc(string s) {
    if (s == null) return "";
    var sb = new StringBuilder();
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default: if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4")); else sb.Append(c); break;
      }
    }
    return sb.ToString();
  }
  // Tiny field extractor: pulls "key":"value" (string) or "key":num. Good
  // enough for our fixed request shape; not a general JSON parser.
  public static string Str(string json, string key) {
    string pat = "\"" + key + "\"";
    int i = json.IndexOf(pat); if (i < 0) return null;
    i = json.IndexOf(':', i + pat.Length); if (i < 0) return null;
    i++; while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
    if (i >= json.Length || json[i] != '"') return null;
    i++; var sb = new StringBuilder();
    while (i < json.Length && json[i] != '"') {
      if (json[i] == '\\' && i + 1 < json.Length) {
        i++; char c = json[i];
        if (c == 'n') sb.Append('\n'); else if (c == 't') sb.Append('\t');
        else if (c == 'r') sb.Append('\r'); else if (c == 'u' && i + 4 < json.Length) {
          sb.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16)); i += 4;
        } else sb.Append(c);
      } else sb.Append(json[i]);
      i++;
    }
    return sb.ToString();
  }
  public static int Int(string json, string key, int def) {
    string pat = "\"" + key + "\""; int i = json.IndexOf(pat); if (i < 0) return def;
    i = json.IndexOf(':', i + pat.Length); if (i < 0) return def; i++;
    while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
    int j = i; if (j < json.Length && (json[j] == '-' || json[j] == '+')) j++;
    while (j < json.Length && char.IsDigit(json[j])) j++;
    int v; return int.TryParse(json.Substring(i, j - i), out v) ? v : def;
  }
}

class Helper {
  static IntPtr hDesk;
  static string deskName;
  static readonly Dictionary<string, int> appPids = new Dictionary<string, int>();
  static int appSeq = 0;

  static void MakeDpiAware() {
    // Try the modern per-monitor-v2 API first; fall back for older Windows.
    try { if (Native.SetProcessDpiAwarenessContext(Native.DPI_PER_MONITOR_V2)) return; } catch { }
    try { if (Native.SetProcessDpiAwareness(2) == 0) return; } catch { }
    try { Native.SetProcessDPIAware(); } catch { }
  }

  static int Main() {
    // MUST run before any window / desktop / SendInput work so the process is
    // DPI-aware from the start (prevents on-focus rescale + coord drift).
    MakeDpiAware();
    deskName = "GuyCodeApp_" + System.Diagnostics.Process.GetCurrentProcess().Id;
    hDesk = Native.CreateDesktop(deskName, IntPtr.Zero, IntPtr.Zero, 0, Native.DESKTOP_ALL, IntPtr.Zero);
    if (hDesk == IntPtr.Zero) {
      Console.WriteLine("{\"id\":0,\"ok\":false,\"error\":\"CreateDesktop failed gle=" + Marshal.GetLastWin32Error() + "\"}");
      return 2;
    }
    // Bind THIS thread to the hidden desktop before any UIA/window work. All
    // request handling runs here, so UIA/capture/input target the hidden
    // desktop natively (no ERROR_BUSY).
    if (!Native.SetThreadDesktop(hDesk)) {
      Console.WriteLine("{\"id\":0,\"ok\":false,\"error\":\"SetThreadDesktop failed gle=" + Marshal.GetLastWin32Error() + "\"}");
      return 3;
    }
    // Signal readiness.
    Out("{\"id\":0,\"ok\":true,\"data\":{\"ready\":true,\"desktop\":\"" + J.Esc(deskName) + "\"}}");

    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      int id = J.Int(line, "id", 0);
      string op = J.Str(line, "op") ?? "";
      try {
        Handle(id, op, line);
      } catch (Exception ex) {
        Out("{\"id\":" + id + ",\"ok\":false,\"error\":\"" + J.Esc(ex.Message) + "\"}");
      }
      if (op == "shutdown") break;
    }
    TeardownAll();
    return 0;
  }

  static void Out(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
  static void Ok(int id, string dataJson) { Out("{\"id\":" + id + ",\"ok\":true,\"data\":" + (dataJson ?? "{}") + "}"); }
  static void Err(int id, string msg) { Out("{\"id\":" + id + ",\"ok\":false,\"error\":\"" + J.Esc(msg) + "\"}"); }

  static void Handle(int id, string op, string req) {
    switch (op) {
      case "ping": Ok(id, "{\"pong\":true}"); break;
      case "launch": Launch(id, req); break;
      case "list": List(id, req); break;
      case "screenshot": Screenshot(id, req); break;
      case "click": Click(id, req); break;
      case "drag": Drag(id, req); break;
      case "type": Type(id, req); break;
      case "key": Key(id, req); break;
      case "close": Close(id, req); break;
      case "shutdown": Ok(id, "{}"); break;
      default: Err(id, "unknown op '" + op + "'"); break;
    }
  }

  static void Launch(int id, string req) {
    string cmd = J.Str(req, "command");
    if (string.IsNullOrEmpty(cmd)) { Err(id, "launch requires 'command'"); return; }
    var si = new Native.STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = deskName;
    Native.PROCESS_INFORMATION pi;
    // Use lpCommandLine (mutable copy) so apps that read argv work; for a bare
    // exe path this still launches correctly.
    string cmdline = cmd;
    bool ok = Native.CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    if (!ok) {
      // Retry with app-name form for full paths.
      ok = Native.CreateProcess(cmd, null, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    }
    if (!ok) { Err(id, "CreateProcess failed gle=" + Marshal.GetLastWin32Error()); return; }
    string appId = "app" + (++appSeq);
    appPids[appId] = pi.dwProcessId;
    Ok(id, "{\"appId\":\"" + appId + "\",\"pid\":" + pi.dwProcessId + "}");
  }

  static List<IntPtr> WindowsFor(int pid) {
    var list = new List<IntPtr>();
    Native.EnumDesktopWindows(hDesk, (h, l) => {
      uint p; Native.GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid && Native.IsWindowVisible(h)) {
        Native.RECT r; Native.GetWindowRect(h, out r);
        if (r.Right - r.Left > 20 && r.Bottom - r.Top > 20) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static int PidFor(string appId) { int p; return appPids.TryGetValue(appId, out p) ? p : -1; }

  static void List(int id, string req) {
    int pid = PidFor(J.Str(req, "appId"));
    if (pid < 0) { Err(id, "unknown appId"); return; }
    var sb = new StringBuilder("{\"windows\":[");
    bool first = true;
    foreach (var h in WindowsFor(pid)) {
      Native.RECT r; Native.GetWindowRect(h, out r);
      var t = new StringBuilder(256); Native.GetWindowTextW(h, t, 256);
      if (!first) sb.Append(",");
      first = false;
      sb.Append("{\"windowId\":\"" + (long)h + "\",\"title\":\"" + J.Esc(t.ToString()) + "\",\"x\":" + r.Left +
        ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}");
    }
    sb.Append("]}");
    Ok(id, sb.ToString());
  }

  static IntPtr ResolveWindow(string appId, string windowId) {
    if (!string.IsNullOrEmpty(windowId)) return (IntPtr)long.Parse(windowId);
    int pid = PidFor(appId);
    var ws = WindowsFor(pid);
    return ws.Count > 0 ? ws[0] : IntPtr.Zero;
  }

  // ---- Real mouse input via SendInput (lands on the hidden desktop) ----

  // Bring the target window to the foreground ON THE HIDDEN DESKTOP before a
  // gesture. Many classic Win32 apps ignore mouse input unless they're the
  // foreground/active window. (This affects only the hidden desktop, so the
  // user's real foreground window is untouched.) Note: modern WinUI3 / Store
  // apps route input through an InputSiteWindowClass that doesn't accept
  // injected input on a non-active desktop, so this won't make those drawable
  // - but it makes classic apps reliable.
  static void FocusWindow(IntPtr h) {
    try { Native.SetForegroundWindow(h); Native.BringWindowToTop(h); } catch { }
  }

  static void MouseMoveAbs(int screenX, int screenY) {
    int sw = Native.GetSystemMetrics(Native.SM_CXSCREEN);
    int sh = Native.GetSystemMetrics(Native.SM_CYSCREEN);
    if (sw < 1) sw = 1; if (sh < 1) sh = 1;
    var inp = new Native.INPUT[1];
    inp[0].type = 0; // INPUT_MOUSE
    inp[0].mi.dx = (int)(((long)screenX * 65535) / sw);
    inp[0].mi.dy = (int)(((long)screenY * 65535) / sh);
    inp[0].mi.dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE;
    Native.SendInput(1, inp, Marshal.SizeOf(typeof(Native.INPUT)));
  }

  static void MouseBtn(uint flag) {
    var inp = new Native.INPUT[1];
    inp[0].type = 0;
    inp[0].mi.dwFlags = flag;
    Native.SendInput(1, inp, Marshal.SizeOf(typeof(Native.INPUT)));
  }

  // Parse a JSON array of {"x":N,"y":N} points from the request.
  static List<int[]> ParsePath(string req) {
    var pts = new List<int[]>();
    int i = req.IndexOf("\"path\"");
    if (i < 0) return pts;
    i = req.IndexOf('[', i); if (i < 0) return pts;
    int end = req.IndexOf(']', i); if (end < 0) end = req.Length;
    string seg = req.Substring(i, end - i);
    int p = 0;
    while (true) {
      int br = seg.IndexOf('{', p); if (br < 0) break;
      int brEnd = seg.IndexOf('}', br); if (brEnd < 0) break;
      string obj = seg.Substring(br, brEnd - br + 1);
      int x = J.Int(obj, "x", int.MinValue), y = J.Int(obj, "y", int.MinValue);
      if (x != int.MinValue && y != int.MinValue) pts.Add(new int[] { x, y });
      p = brEnd + 1;
    }
    return pts;
  }

  static void Drag(int id, string req) {
    IntPtr h = ResolveWindow(J.Str(req, "appId"), J.Str(req, "windowId"));
    if (h == IntPtr.Zero) { Err(id, "no window"); return; }
    var path = ParsePath(req);
    // Convenience: accept fromX/fromY/toX/toY if no explicit path.
    if (path.Count == 0) {
      int fx = J.Int(req, "fromX", int.MinValue), fy = J.Int(req, "fromY", int.MinValue);
      int tx = J.Int(req, "toX", int.MinValue), ty = J.Int(req, "toY", int.MinValue);
      if (fx == int.MinValue || tx == int.MinValue) { Err(id, "drag needs 'path' or fromX/fromY/toX/toY"); return; }
      path.Add(new int[] { fx, fy });
      path.Add(new int[] { tx, ty });
    }
    if (path.Count < 1) { Err(id, "empty path"); return; }
    string button = J.Str(req, "button") ?? "left";
    uint bdown = button == "right" ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN;
    uint bup = button == "right" ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP;

    FocusWindow(h);
    Thread.Sleep(20);

    // Drive the window with PostMessage mouse messages in CLIENT coordinates.
    // SendInput does NOT work on a hidden desktop (no input desktop -> cursor
    // frozen -> zero events), but window messages reach the message queue
    // directly. We convert the window-relative coords the model sends (from
    // the PrintWindow screenshot, which includes the title bar/border) into
    // client coords.
    int offX, offY;
    ClientOffset(h, out offX, out offY);
    int mkButton = button == "right" ? Native.MK_RBUTTON : Native.MK_LBUTTON;
    uint wmDown = button == "right" ? Native.WM_RBUTTONDOWN : Native.WM_LBUTTONDOWN;
    uint wmUp = button == "right" ? Native.WM_RBUTTONUP : Native.WM_LBUTTONUP;
    Func<int, int, IntPtr> lp = (wx, wy) => MakeLParam(wx - offX, wy - offY);

    // Move to the first point, press (button held), drag through interpolated
    // points with MK_LBUTTON in wParam so the canvas knows the button is down,
    // then release.
    Native.PostMessage(h, Native.WM_MOUSEMOVE, IntPtr.Zero, lp(path[0][0], path[0][1])); Thread.Sleep(15);
    Native.PostMessage(h, wmDown, (IntPtr)mkButton, lp(path[0][0], path[0][1])); Thread.Sleep(20);
    int prevX = path[0][0], prevY = path[0][1];
    for (int k = 1; k < path.Count; k++) {
      int cx = path[k][0], cy = path[k][1];
      int dx = cx - prevX, dy = cy - prevY;
      int dist = (int)Math.Sqrt(dx * dx + dy * dy);
      int steps = Math.Max(1, Math.Min(80, dist / 5)); // ~one sample per 5px
      for (int s = 1; s <= steps; s++) {
        int ix = prevX + dx * s / steps, iy = prevY + dy * s / steps;
        Native.PostMessage(h, Native.WM_MOUSEMOVE, (IntPtr)mkButton, lp(ix, iy));
        Thread.Sleep(5);
      }
      prevX = cx; prevY = cy;
    }
    Thread.Sleep(15);
    Native.PostMessage(h, wmUp, IntPtr.Zero, lp(prevX, prevY));
    Ok(id, "{\"via\":\"postmessage-drag\",\"points\":" + path.Count + "}");
  }

  // Client-area origin offset within the window (window-relative -> client).
  static void ClientOffset(IntPtr h, out int offX, out int offY) {
    Native.RECT wr; Native.GetWindowRect(h, out wr);
    var origin = new Native.POINT { X = 0, Y = 0 };
    Native.ClientToScreen(h, ref origin);
    offX = origin.X - wr.Left;
    offY = origin.Y - wr.Top;
  }

  static IntPtr MakeLParam(int x, int y) {
    return (IntPtr)((y << 16) | (x & 0xFFFF));
  }

  // A click via PostMessage window messages (works on the hidden desktop where
  // SendInput cannot). Coords are window-relative; converted to client coords.
  static void RealClick(IntPtr h, int x, int y, string button) {
    FocusWindow(h);
    int offX, offY; ClientOffset(h, out offX, out offY);
    int mk = button == "right" ? Native.MK_RBUTTON : Native.MK_LBUTTON;
    uint d = button == "right" ? Native.WM_RBUTTONDOWN : Native.WM_LBUTTONDOWN;
    uint u = button == "right" ? Native.WM_RBUTTONUP : Native.WM_LBUTTONUP;
    IntPtr lp = MakeLParam(x - offX, y - offY);
    Native.PostMessage(h, Native.WM_MOUSEMOVE, IntPtr.Zero, lp); Thread.Sleep(10);
    Native.PostMessage(h, d, (IntPtr)mk, lp); Thread.Sleep(15);
    Native.PostMessage(h, u, IntPtr.Zero, lp);
  }

  static void Screenshot(int id, string req) {
    IntPtr h = ResolveWindow(J.Str(req, "appId"), J.Str(req, "windowId"));
    if (h == IntPtr.Zero) { Err(id, "no window to capture"); return; }
    Native.RECT r; Native.GetWindowRect(h, out r);
    int w = r.Right - r.Left, hh = r.Bottom - r.Top;
    if (w < 1 || hh < 1) { Err(id, "degenerate window size"); return; }
    using (var bmp = new Bitmap(w, hh)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        Native.PrintWindow(h, hdc, Native.PW_RENDERFULLCONTENT);
        g.ReleaseHdc(hdc);
      }
      using (var ms = new MemoryStream()) {
        bmp.Save(ms, ImageFormat.Png);
        string b64 = Convert.ToBase64String(ms.ToArray());
        Ok(id, "{\"pngBase64\":\"" + b64 + "\",\"width\":" + w + ",\"height\":" + hh + "}");
      }
    }
  }

  static AutomationElement ElementAt(IntPtr hwnd, int x, int y) {
    try {
      AutomationElement win = AutomationElement.FromHandle(hwnd);
      if (win == null) return null;
      Native.RECT r; Native.GetWindowRect(hwnd, out r);
      var pt = new System.Windows.Point(r.Left + x, r.Top + y);
      return AutomationElement.FromPoint(pt);
    } catch { return null; }
  }

  static void Click(int id, string req) {
    IntPtr h = ResolveWindow(J.Str(req, "appId"), J.Str(req, "windowId"));
    if (h == IntPtr.Zero) { Err(id, "no window"); return; }
    int x = J.Int(req, "x", 0), y = J.Int(req, "y", 0);
    string button = J.Str(req, "button") ?? "left";
    // Prefer UIA Invoke on the element under the point (no synthetic mouse).
    var el = ElementAt(h, x, y);
    if (el != null) {
      object pat;
      if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) {
        ((InvokePattern)pat).Invoke(); Ok(id, "{\"via\":\"uia-invoke\"}"); return;
      }
      if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) {
        ((TogglePattern)pat).Toggle(); Ok(id, "{\"via\":\"uia-toggle\"}"); return;
      }
      if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) {
        ((SelectionItemPattern)pat).Select(); Ok(id, "{\"via\":\"uia-select\"}"); return;
      }
    }
    // Fall back to a REAL SendInput click (works on canvases / custom-drawn
    // surfaces where neither UIA nor posted messages register). This lands on
    // the hidden desktop, so the user's real cursor is untouched.
    RealClick(h, x, y, button);
    Ok(id, "{\"via\":\"sendinput-click\"}");
  }

  static void Type(int id, string req) {
    IntPtr h = ResolveWindow(J.Str(req, "appId"), J.Str(req, "windowId"));
    if (h == IntPtr.Zero) { Err(id, "no window"); return; }
    string text = J.Str(req, "text") ?? "";
    // Prefer UIA ValuePattern on the focused element, else WM_CHAR to the
    // focused control.
    try {
      AutomationElement focused = AutomationElement.FocusedElement;
      object pat;
      if (focused != null && focused.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) {
        var vp = (ValuePattern)pat;
        ((ValuePattern)pat).SetValue((vp.Current.Value ?? "") + text);
        Ok(id, "{\"via\":\"uia-value\"}"); return;
      }
    } catch { /* fall through */ }
    foreach (char c in text) Native.PostMessage(h, Native.WM_CHAR, (IntPtr)c, IntPtr.Zero);
    Ok(id, "{\"via\":\"wm-char\"}");
  }

  static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    {"enter",0x0D},{"return",0x0D},{"tab",0x09},{"escape",0x1B},{"esc",0x1B},{"space",0x20},
    {"backspace",0x08},{"delete",0x2E},{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},
    {"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},{"f1",0x70},{"f2",0x71},{"f3",0x72},{"f4",0x73},{"f5",0x74}
  };

  static void Key(int id, string req) {
    IntPtr h = ResolveWindow(J.Str(req, "appId"), J.Str(req, "windowId"));
    if (h == IntPtr.Zero) { Err(id, "no window"); return; }
    string combo = (J.Str(req, "combo") ?? "").Trim();
    // Last token is the key; earlier tokens (ctrl/alt/shift) would need
    // keybd state - for posted messages we handle the plain key + common
    // named keys. Modifiers via WM_* are unreliable; UIA actions cover most
    // real needs. Best-effort: send the named vk as keydown/up.
    string keyName = combo;
    int plus = combo.LastIndexOf('+');
    if (plus >= 0) keyName = combo.Substring(plus + 1);
    ushort vk;
    if (!Vk.TryGetValue(keyName, out vk)) {
      if (keyName.Length == 1) vk = (ushort)char.ToUpper(keyName[0]);
      else { Err(id, "unknown key '" + keyName + "'"); return; }
    }
    Native.PostMessage(h, Native.WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
    Native.PostMessage(h, Native.WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
    Ok(id, "{\"via\":\"wm-key\"}");
  }

  static void Close(int id, string req) {
    string appId = J.Str(req, "appId");
    int pid = PidFor(appId);
    if (pid > 0) { try { System.Diagnostics.Process.GetProcessById(pid).Kill(); } catch { } appPids.Remove(appId); }
    Ok(id, "{}");
  }

  static void TeardownAll() {
    foreach (var kv in appPids) { try { System.Diagnostics.Process.GetProcessById(kv.Value).Kill(); } catch { } }
    appPids.Clear();
    if (hDesk != IntPtr.Zero) { Native.CloseDesktop(hDesk); hDesk = IntPtr.Zero; }
  }
}
