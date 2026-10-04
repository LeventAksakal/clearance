# Cross-checks the scribe's snapshot against independent readings, to show the
# census does not understate what the machine and the sessions use.
#   machine:  performance counters (PDH) instead of GlobalMemoryStatusEx
#   sessions: the process tree rebuilt from Get-Process .Parent instead of
#             Toolhelp, measured as private bytes and as working set
# Read-only: it writes nothing. Usage: pwsh -NoProfile -File verify.ps1 [-Json]
param([switch]$Json)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:USERPROFILE '.claude\clearance'
$snap = Get-Content (Join-Path $root 'snapshot.json') -Raw | ConvertFrom-Json
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$MB = { param($b) [math]::Round($b / 1MB) }

# Machine, by PDH.
$c = (Get-Counter '\Memory\Available Bytes', '\Memory\Committed Bytes', '\Memory\Commit Limit').CounterSamples
$pdh = @{
  availableMB   = & $MB ($c | Where-Object Path -like '*available bytes').CookedValue
  commitMB      = & $MB ($c | Where-Object Path -like '*committed bytes').CookedValue
  commitLimitMB = & $MB ($c | Where-Object Path -like '*commit limit').CookedValue
}

# Every process once, with its parent, by .NET.
$procs = @{}
$kids = @{}
foreach ($p in Get-Process) {
  $parent = try { $p.Parent.Id } catch { $null }
  $priv = try { $p.PrivateMemorySize64 } catch { -1 }
  $procs[$p.Id] = [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; Parent = $parent; Private = $priv; WS = $p.WorkingSet64 }
  if ($parent) { if (-not $kids[$parent]) { $kids[$parent] = [Collections.Generic.List[int]]::new() }; $kids[$parent].Add($p.Id) }
}
function Tree([int]$id) {
  $out = [Collections.Generic.List[int]]::new(); $q = [Collections.Generic.Queue[int]]::new(); $q.Enqueue($id)
  while ($q.Count) { $x = $q.Dequeue(); $out.Add($x); foreach ($k in @($kids[$x])) { if ($k -and $k -ne $x) { $q.Enqueue($k) } } }
  $out
}

$attributed = [Collections.Generic.HashSet[int]]::new()
$rows = foreach ($s in $snap.sessions) {
  $ids = @(Tree $s.pid) | Where-Object { $procs.ContainsKey($_) }
  $ids | ForEach-Object { [void]$attributed.Add($_) }
  $set = $ids | ForEach-Object { $procs[$_] }
  $unreadable = @($set | Where-Object Private -lt 0).Count
  $privMB = & $MB (($set | Where-Object Private -ge 0 | Measure-Object Private -Sum).Sum)
  $wsMB = & $MB (($set | Measure-Object WS -Sum).Sum)
  $census = $s.selfMB + $s.childMB
  [pscustomobject]@{
    session = $s.sessionId.Substring(0, 8); where = ($s.cwd -split '[\\/]')[-1]
    censusMB = $census; procs = 1 + $s.children; verifyProcs = $ids.Count
    privateMB = $privMB; workingSetMB = $wsMB; unreadable = $unreadable
    gapMB = $privMB - $census
  }
}

# What no session owns: the rest of the machine, by working set.
$rest = $procs.Values | Where-Object { -not $attributed.Contains($_.Id) }
$top = $rest | Group-Object Name | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; count = $_.Count; workingSetMB = & $MB (($_.Group | Measure-Object WS -Sum).Sum); privateMB = & $MB (($_.Group | Where-Object Private -ge 0 | Measure-Object Private -Sum).Sum) }
} | Sort-Object workingSetMB -Descending | Select-Object -First 8

$m = $snap.machine
$result = [ordered]@{
  snapshotAgeS = [math]::Round(($now - $snap.t) / 1000, 1)
  machine      = [ordered]@{
    availableMB   = @{ snapshot = $m.availableMB; pdh = $pdh.availableMB; diff = $m.availableMB - $pdh.availableMB }
    commitMB      = @{ snapshot = $m.commitMB; pdh = $pdh.commitMB; diff = $m.commitMB - $pdh.commitMB }
    commitLimitMB = @{ snapshot = $m.commitLimitMB; pdh = $pdh.commitLimitMB; diff = $m.commitLimitMB - $pdh.commitLimitMB }
  }
  sessions     = @($rows)
  unattributed = @($top)
}
if ($Json) { $result | ConvertTo-Json -Depth 5; return }

"snapshot age: $($result.snapshotAgeS) s"
''
'machine (snapshot = GlobalMemoryStatusEx, pdh = performance counters)'
$result.machine.GetEnumerator() | ForEach-Object { [pscustomobject]@{ metric = $_.Key; snapshot = $_.Value.snapshot; pdh = $_.Value.pdh; diff = $_.Value.diff } } | Format-Table -AutoSize | Out-String -Width 200
'sessions (census = selfMB + childMB; gap = verified private - census; >0 means the census understates)'
$rows | Format-Table -AutoSize | Out-String -Width 200
'not attributed to any session (largest by working set)'
$top | Format-Table -AutoSize | Out-String -Width 200
