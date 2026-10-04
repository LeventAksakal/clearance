# clearance sampler: one warm pwsh for the scribe's term. Every interval it
# samples the machine and the session trees and writes snapshot.json (schema 1)
# with a temp file and a rename. Before each write it fences: it exits when a
# higher epoch is claimed, its own epoch is resigned, or its owner is gone.
# Run with -File, never as an inline -Command. Stdout: one heartbeat line per
# sample. Stderr: errors.
param(
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Registry,
  [Parameter(Mandatory)][long]$Epoch,
  [int]$IntervalMs = 5000,
  # The scribe's claude process. $.process.spawn starts us through cmd.exe, so
  # the parent is not the session; 0 falls back to the parent.
  [int]$OwnerPid = 0
)
$ErrorActionPreference = 'Stop'

$scribeDir = Join-Path $Root 'scribe'
$snapPath = Join-Path $Root 'snapshot.json'
$presenceDir = Join-Path $Root 'sessions'
$tmpPath = Join-Path $Root "snapshot.$PID.tmp"
$utf8 = [Text.UTF8Encoding]::new($false)
# Win32 directly, not CIM: under some hosts (the CLI's spawn) pwsh is denied
# loading CIM's native DLL. One Toolhelp snapshot gives parent pids; .NET's
# process list gives private bytes from the same kind of system snapshot, so
# no process is opened. GlobalMemoryStatusEx gives available and commit.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public sealed class ClearanceProc { public int Pid; public int ParentPid; public string Name; public long PrivateBytes; public long StartTicks; }

public static class ClearanceNative {
  [StructLayout(LayoutKind.Sequential)]
  struct MEMORYSTATUSEX {
    public uint dwLength, dwMemoryLoad;
    public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Explicit)]
  struct PDH_FMT_COUNTERVALUE { [FieldOffset(0)] public uint CStatus; [FieldOffset(8)] public double doubleValue; }
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string source, IntPtr user, out IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll")] static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, IntPtr type, out PDH_FMT_COUNTERVALUE value);
  static IntPtr pdhQuery = IntPtr.Zero, pagesIn = IntPtr.Zero;

  /// Hard page reads per second over the last interval (\Memory\Pages Input/sec):
  /// the paging pressure signal. -1 on the first call (a rate needs two reads) or on error.
  public static double PagesInPerSec() {
    if (pdhQuery == IntPtr.Zero) {
      if (PdhOpenQueryW(null, IntPtr.Zero, out pdhQuery) != 0) { pdhQuery = IntPtr.Zero; return -1; }
      if (PdhAddEnglishCounterW(pdhQuery, "\\Memory\\Pages Input/sec", IntPtr.Zero, out pagesIn) != 0) return -1;
      PdhCollectQueryData(pdhQuery);
      return -1;
    }
    if (PdhCollectQueryData(pdhQuery) != 0) return -1;
    PDH_FMT_COUNTERVALUE v;
    if (PdhGetFormattedCounterValue(pagesIn, 0x200 /* PDH_FMT_DOUBLE */, IntPtr.Zero, out v) != 0 || v.CStatus != 0) return -1;
    return v.doubleValue;
  }

  /// totalPhys, availPhys, commitLimit, commitAvail (bytes)
  public static ulong[] Memory() {
    var m = new MEMORYSTATUSEX();
    m.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
    if (!GlobalMemoryStatusEx(ref m)) throw new System.ComponentModel.Win32Exception();
    return new[] { m.ullTotalPhys, m.ullAvailPhys, m.ullTotalPageFile, m.ullAvailPageFile };
  }

  public static List<ClearanceProc> Processes() {
    var rows = new Dictionary<int, ClearanceProc>();
    IntPtr snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
    if (snap == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var e = new PROCESSENTRY32W();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
        rows[(int)e.th32ProcessID] = new ClearanceProc { Pid = (int)e.th32ProcessID, ParentPid = (int)e.th32ParentProcessID, Name = e.szExeFile };
    } finally { CloseHandle(snap); }
    foreach (var p in Process.GetProcesses()) {
      using (p) {
        ClearanceProc row;
        if (!rows.TryGetValue(p.Id, out row)) continue;
        try { row.PrivateBytes = p.PrivateMemorySize64; } catch { }
        try { row.StartTicks = p.StartTime.ToUniversalTime().Ticks; } catch { }
      }
    }
    return new List<ClearanceProc>(rows.Values);
  }
}
'@

$owner = if ($OwnerPid -gt 0) { $OwnerPid } else { ([ClearanceNative]::Processes() | Where-Object Pid -eq $PID).ParentPid }
$keepEpochs = 5
$tick = 0
$reported = $false

function Test-Fenced {
  foreach ($f in [IO.Directory]::EnumerateFiles($scribeDir)) {
    $n = [IO.Path]::GetFileName($f)
    if ($n -match '^epoch-(\d+)$' -and [long]$Matches[1] -gt $Epoch) { return $true }
    if ($n -eq "resigned-$Epoch") { return $true }
  }
  return $false
}

# Epoch files older than the newest few are the current scribe's to delete.
function Remove-OldEpochs {
  $old = [IO.Directory]::EnumerateFiles($scribeDir) |
    ForEach-Object { if ([IO.Path]::GetFileName($_) -match '^(epoch|resigned)-(\d+)$') { [long]$Matches[2] } } |
    Sort-Object -Unique -Descending |
    Select-Object -Skip $keepEpochs
  foreach ($n in $old) {
    if ($n -ge $Epoch) { continue }
    foreach ($kind in 'epoch', 'resigned') {
      $p = Join-Path $scribeDir "$kind-$n"
      if ([IO.File]::Exists($p)) { [IO.File]::Delete($p) }
    }
  }
}

function MB([double]$bytes) { [int][Math]::Round($bytes / 1MB) }

# A process's descendants. Windows doesn't reparent orphans, so a child's
# ParentPid can name a dead process whose pid was reused: a child counts only
# if it started after its parent. Without the check a session adopted whole
# orphaned trees (the WSL VM, a detached dev server) and read 8.4 GB of children.
function Get-Descendants([int]$top, $byPid, $kids) {
  $seen = [Collections.Generic.HashSet[int]]::new()
  [void]$seen.Add($top)
  $queue = [Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($top)
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    if (-not $kids.ContainsKey($p)) { continue }
    $parentStart = $byPid[$p].StartTicks
    foreach ($c in $kids[$p]) {
      if ($c.StartTicks -le 0 -or $parentStart -le 0 -or $c.StartTicks -lt $parentStart) { continue }
      if ($seen.Add($c.Pid)) { $c; $queue.Enqueue($c.Pid) }
    }
  }
}

# Docker: `docker ps` and `docker stats --no-stream` take ~3 s, so they run in a
# thread job every 6th tick and the result joins whichever sample finds it done.
$dockerExe = (Get-Command docker -ErrorAction SilentlyContinue).Source
$dockerJob = $null
$containers = $null
$containersT = 0

function ConvertTo-MB([string]$text) {
  if ($text -notmatch '^\s*([\d.]+)\s*([KMG]i?B|B)') { return 0 }
  $n = [double]$Matches[1]
  switch -regex ($Matches[2]) { '^G' { $n * 1024 } '^M' { $n } '^K' { $n / 1024 } default { $n / 1MB } }
}

function Read-Docker($result) {
  $ps, $stats = $result
  $byName = @{}
  foreach ($line in @($ps)) {
    try { $c = $line | ConvertFrom-Json } catch { continue }
    $labels = @{}
    foreach ($kv in ([string]$c.Labels -split ',')) { $i = $kv.IndexOf('='); if ($i -gt 0) { $labels[$kv.Substring(0, $i)] = $kv.Substring($i + 1) } }
    $byName[[string]$c.Names] = [ordered]@{
      name       = [string]$c.Names
      project    = $labels['com.docker.compose.project']
      workingDir = $labels['com.docker.compose.project.working_dir']
      ports      = [string]$c.Ports
      memMB      = 0
    }
  }
  foreach ($line in @($stats)) {
    try { $st = $line | ConvertFrom-Json } catch { continue }
    $row = $byName[[string]$st.Name]
    if ($row) { $row.memMB = [int][Math]::Round((ConvertTo-MB (([string]$st.MemUsage -split '/')[0]))) }
  }
  @($byName.Values)
}

function Get-Sessions($byPid, $kids) {
  foreach ($file in [IO.Directory]::EnumerateFiles($Registry, '*.json')) {
    if (-not $file.EndsWith('.json')) { continue }   # never the *.key secrets
    try { $r = [IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { continue }
    $sessionPid = [int]$r.pid
    $self = $byPid[$sessionPid]
    if (-not $self) { continue }
    $desc = @(Get-Descendants $sessionPid $byPid $kids)
    foreach ($d in $desc) { [void]$script:attributed.Add($d.Pid) }
    [void]$script:attributed.Add($sessionPid)
    if ($r.entrypoint -eq 'claude-desktop') { [void]$script:desktopRoots.Add($self.ParentPid) }
    $childBytes = ($desc | Measure-Object -Property PrivateBytes -Sum).Sum
    $top = $desc | Sort-Object PrivateBytes -Descending | Select-Object -First 3 | ForEach-Object {
      [ordered]@{ pid = $_.Pid; name = $_.Name; privateMB = (MB $_.PrivateBytes) }
    }
    $row = [ordered]@{
      sessionId   = $r.sessionId
      pid         = $sessionPid
      cwd         = $r.cwd
      entrypoint  = $r.entrypoint
      selfMB      = (MB $self.PrivateBytes)
      childMB     = (MB $childBytes)
      children    = $desc.Count
      topChildren = @($top)
    }
    # The session's presence file, written by its clearance mod (absent without the mod).
    $presencePath = Join-Path $presenceDir "$($r.sessionId).json"
    if ([IO.File]::Exists($presencePath)) {
      try {
        $pr = [IO.File]::ReadAllText($presencePath) | ConvertFrom-Json
        $row.agentsInFlight = [int]$pr.agentsInFlight
        $row.reservedMB = [int]$pr.reservedMB
        $row.busy = [bool]$pr.busy
        $row.lastProgressAt = [long]$pr.lastProgressAt
      } catch { }
    }
    $script:live.Add([string]$r.sessionId) | Out-Null
    $row
  }
}

# Presence files of sessions that left the registry over an hour ago are the
# current scribe's to delete (their writers can't: $.fs has no delete).
function Remove-OldPresence {
  if (-not [IO.Directory]::Exists($presenceDir)) { return }
  $cutoff = [DateTime]::UtcNow.AddHours(-1)
  foreach ($f in [IO.Directory]::EnumerateFiles($presenceDir, '*.json')) {
    $id = [IO.Path]::GetFileNameWithoutExtension($f)
    if (-not $script:live.Contains($id) -and [IO.File]::GetLastWriteTimeUtc($f) -lt $cutoff) { [IO.File]::Delete($f) }
  }
}

while ($true) {
  $tick++
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $mem = [ClearanceNative]::Memory()
    $procs = [ClearanceNative]::Processes()
    $byPid = @{}
    $kids = @{}
    foreach ($p in $procs) {
      $byPid[$p.Pid] = $p
      $pp = $p.ParentPid
      if (-not $kids.ContainsKey($pp)) { $kids[$pp] = [Collections.Generic.List[object]]::new() }
      $kids[$pp].Add($p)
    }
    if (-not $byPid.ContainsKey($owner)) { exit 0 }   # the scribe's session is gone
    $script:live = [Collections.Generic.HashSet[string]]::new()
    $script:attributed = [Collections.Generic.HashSet[int]]::new()
    $script:desktopRoots = [Collections.Generic.HashSet[int]]::new()
    $sessions = @(Get-Sessions $byPid $kids)
    $pagesIn = [ClearanceNative]::PagesInPerSec()

    # The Claude desktop app: the Electron tree the desktop sessions run under, less the sessions.
    $desktopBytes = 0; $desktopProcs = 0
    # (Not $root: PowerShell names are case-insensitive, and the [string] -Root
    # parameter would turn each pid into a string.)
    foreach ($deskPid in $script:desktopRoots) {
      if (-not $byPid.ContainsKey($deskPid)) { continue }
      $tree = [Collections.Generic.List[object]]::new()
      $tree.Add($byPid[$deskPid])
      foreach ($d in @(Get-Descendants $deskPid $byPid $kids)) { $tree.Add($d) }
      foreach ($d in $tree) {
        if ($script:attributed.Contains($d.Pid)) { continue }
        [void]$script:attributed.Add($d.Pid)
        $desktopBytes += $d.PrivateBytes; $desktopProcs++
      }
    }
    $vmBytes = ($procs | Where-Object { $_.Name -like 'vmmem*' } | Measure-Object -Property PrivateBytes -Sum).Sum

    if ($dockerExe -and -not $dockerJob -and ($tick % 6 -eq 1)) {
      $dockerJob = Start-ThreadJob -ArgumentList $dockerExe -ScriptBlock {
        param($exe)
        $ps = & $exe ps --no-trunc --format '{{json .}}' 2>$null
        $stats = & $exe stats --no-stream --format '{{json .}}' 2>$null
        , @(@($ps), @($stats))
      }
    }
    if ($dockerJob -and $dockerJob.State -in 'Completed', 'Failed', 'Stopped') {
      try { $containers = Read-Docker (Receive-Job $dockerJob); $containersT = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } catch { }
      Remove-Job $dockerJob -Force
      $dockerJob = $null
    }
    $sw.Stop()
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $snap = [ordered]@{
      schema     = 1
      epoch      = $Epoch
      t          = $t
      sampleMs   = $sw.ElapsedMilliseconds
      intervalMs = $IntervalMs
      machine    = [ordered]@{
        totalMB       = (MB $mem[0])
        # Available = free + standby: what can be handed out without paging. The
        # free list alone reads near zero on a healthy machine.
        availableMB   = (MB $mem[1])
        commitMB      = (MB ($mem[2] - $mem[3]))
        commitLimitMB = (MB $mem[2])   # Windows grows the pagefile: read every sample
      }
      sessions   = $sessions
    }
    if ($pagesIn -ge 0) { $snap.machine.pagesInPerSec = [Math]::Round($pagesIn, 1) }
    if ($desktopProcs -gt 0) { $snap.desktop = [ordered]@{ privateMB = (MB $desktopBytes); procs = $desktopProcs } }
    if ($vmBytes -gt 0 -or $containers) {
      $containersMB = 0
      foreach ($c in @($containers)) { if ($c) { $containersMB += [int]$c.memMB } }
      $snap.dockerVm = [ordered]@{ privateMB = (MB $vmBytes); containersMB = $containersMB; t = $containersT }
    }
    if ($containers) { $snap.containers = @($containers) }
    $json = ConvertTo-Json -InputObject $snap -Depth 6 -Compress
    if (Test-Fenced) { exit 0 }
    [IO.File]::WriteAllText($tmpPath, $json, $utf8)
    # A reader holding snapshot.json open makes the replace fail with an
    # IOException or an UnauthorizedAccessException: retry briefly.
    for ($try = 1; ; $try++) {
      try { [IO.File]::Move($tmpPath, $snapPath, $true); break }
      catch { if ($try -ge 5) { throw }; Start-Sleep -Milliseconds (40 * $try) }
    }
    [Console]::Out.WriteLine("{""t"":$t,""ms"":$($sw.ElapsedMilliseconds),""sessions"":$($sessions.Count)}")
    [Console]::Out.Flush()
    if ($tick % 60 -eq 1) { Remove-OldEpochs; Remove-OldPresence }
  } catch {
    $msg = "sample failed: $($_.Exception.Message)"
    if (-not $reported) {
      # Once: the whole exception chain and the environment.
      $reported = $true
      $inner = $_.Exception.InnerException
      while ($inner) { $msg += " <- $($inner.GetType().Name): $($inner.Message)"; $inner = $inner.InnerException }
      $msg += " | SystemRoot=$env:SystemRoot windir=$env:windir TEMP=$env:TEMP PSModulePath=$env:PSModulePath"
    }
    [Console]::Error.WriteLine($msg)
  }
  Start-Sleep -Milliseconds ([Math]::Max(100, $IntervalMs - $sw.ElapsedMilliseconds))
}
