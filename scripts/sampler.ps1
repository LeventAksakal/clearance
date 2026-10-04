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

public sealed class ClearanceProc { public int Pid; public int ParentPid; public string Name; public long PrivateBytes; }

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

function Get-Sessions($byPid, $kids) {
  foreach ($file in [IO.Directory]::EnumerateFiles($Registry, '*.json')) {
    if (-not $file.EndsWith('.json')) { continue }   # never the *.key secrets
    try { $r = [IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { continue }
    $sessionPid = [int]$r.pid
    $self = $byPid[$sessionPid]
    if (-not $self) { continue }
    # Descendants; a visited set guards the cycles pid reuse can make.
    $seen = [Collections.Generic.HashSet[int]]::new()
    [void]$seen.Add($sessionPid)
    $queue = [Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($sessionPid)
    $desc = [Collections.Generic.List[object]]::new()
    while ($queue.Count -gt 0) {
      $p = $queue.Dequeue()
      if (-not $kids.ContainsKey($p)) { continue }
      foreach ($c in $kids[$p]) {
        $cp = $c.Pid
        if ($seen.Add($cp)) { $desc.Add($c); $queue.Enqueue($cp) }
      }
    }
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
    $sessions = @(Get-Sessions $byPid $kids)
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
    $json = ConvertTo-Json -InputObject $snap -Depth 6 -Compress
    if (Test-Fenced) { exit 0 }
    [IO.File]::WriteAllText($tmpPath, $json, $utf8)
    try {
      [IO.File]::Move($tmpPath, $snapPath, $true)
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 50
      [IO.File]::Move($tmpPath, $snapPath, $true)
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
