# clearance: claim scribe epoch <n> (0006). CreateNew is atomic, so of every
# contender exactly one creates the file; it writes who it is and prints "won".
# The others print "lost". Run with -File, never as an inline -Command.
param(
  [Parameter(Mandatory)][string]$Dir,
  [Parameter(Mandatory)][long]$Epoch,
  [Parameter(Mandatory)][string]$SessionId,
  [long]$OwnerPid = 0,
  [string]$ProcStart = '-'
)
$ErrorActionPreference = 'Stop'

[IO.Directory]::CreateDirectory($Dir) | Out-Null
$path = Join-Path $Dir "epoch-$Epoch"
try {
  $f = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
} catch [System.IO.IOException] {
  'lost'
  exit 0
}
try {
  $doc = [ordered]@{
    sessionId = $SessionId
    pid       = $OwnerPid
    procStart = $(if ($ProcStart -eq '-') { '' } else { $ProcStart })
    at        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($doc)
  $f.Write($bytes, 0, $bytes.Length)
} finally {
  $f.Close()
}
'won'
