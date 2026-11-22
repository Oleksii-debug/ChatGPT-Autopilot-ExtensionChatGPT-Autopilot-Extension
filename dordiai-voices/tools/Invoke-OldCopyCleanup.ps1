param([switch]$Execute)
$ErrorActionPreference='Stop'
if($Execute -and [DateTime]::UtcNow.ToString('yyyy-MM-dd') -ne '2026-11-22') {throw 'This is the dated2026-11-22 authorized cleanup, not an automatic future cleanup. Prepare a new inventory and review.'}
$audit=Join-Path $PSScriptRoot '..\windows-evidence\storage-cleanup-20261122'
$plan=Get-Content -LiteralPath (Join-Path $audit 'deletion-plan.json') -Raw | ConvertFrom-Json
$expected='D:\Синтезатор мовлення KX-47'
$root=[IO.Path]::GetFullPath($plan.root).TrimEnd('\')
if ($root -cne $expected) { throw 'Unexpected cleanup root' }
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Root is a reparse point'}
function Assert-SafeTarget([string]$path) {
    $full=[IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {throw "Out of root: $full"}
    foreach($protect in $plan.protected) {
        $kept=[IO.Path]::GetFullPath((Join-Path $root $protect))
        if ($full.Equals($kept,[StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($kept+'\',[StringComparison]::OrdinalIgnoreCase) -or $kept.StartsWith($full+'\',[StringComparison]::OrdinalIgnoreCase)) {throw "Protected path overlap: $full"}
    }
    if ($full -match "(?i)unified|Єдиний|П.ять|Другий|0\.12\.2\.nvda-addon$") {throw "Protected single-voice/release target: $full"}
    $ancestor=[IO.Path]::GetDirectoryName($full)
    while($ancestor -ne $root) {
        if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) {throw "Reparse ancestor: $ancestor"}
        $ancestor=[IO.Path]::GetDirectoryName($ancestor)
    }
    return $full
}
$checks=@()
foreach($target in $plan.targets) {
    $full=Assert-SafeTarget (Join-Path $root $target.path)
    $checks+=@{path=$full;logical_bytes=$target.bytes;exists=(Test-Path -LiteralPath $full)}
}
# Reject misleading old folder names when they contain any unified installation.
foreach($target in $checks) {
    if(-not $target.exists -or -not [IO.Directory]::Exists($target.path)){continue}
    if($target.path -eq (Join-Path $root 'Інструменти\uv-cache')){continue}
    $pending=[Collections.Generic.Stack[string]]::new(); $pending.Push($target.path)
    while($pending.Count -gt 0) {
        $current=$pending.Pop()
        foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            $attributes=[IO.File]::GetAttributes($entry)
            if($attributes -band [IO.FileAttributes]::ReparsePoint){continue}
            if($attributes -band [IO.FileAttributes]::Directory) {
                if([IO.Path]::GetFileName($entry) -match '(?i)unified') {throw "Single-voice contents: $entry"}
                $pending.Push($entry)
            } elseif([IO.Path]::GetFileName($entry) -ieq 'manifest.ini') {
                if([IO.File]::ReadAllText($entry) -match '(?i)unified|Єдиний голос') {throw "Single-voice manifest: $entry"}
            }
        }
    }
}
$receipt=[ordered]@{started_utc=[DateTime]::UtcNow.ToString('o');root=$root;plan_sha256=(Get-FileHash -LiteralPath (Join-Path $audit 'deletion-plan.json') -Algorithm SHA256).Hash;execute=[bool]$Execute;volume_free_before=[IO.DriveInfo]::new('D:\').AvailableFreeSpace;target_count=$checks.Count;targets=$checks;results=@();reparse_points_unlinked=@();protected_paths=$plan.protected}
$receiptPath=Join-Path $audit $(if($Execute){'deletion-receipt.json'}else{'deletion-preflight.json'})
function Save-Receipt { $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
Save-Receipt
if (-not $Execute) { Write-Output "PREFLIGHT PASSED: $($checks.Count) explicit targets; no deletion"; exit 0 }
foreach($target in $checks) {
    $full=Assert-SafeTarget $target.path
    $row=[ordered]@{path=$full;logical_bytes=$target.logical_bytes;started_utc=[DateTime]::UtcNow.ToString('o');removed=$false;error=$null}
    try {
        if(Test-Path -LiteralPath $full) {
            if($full.StartsWith((Join-Path $root 'Основний синтезатор\Перевірка')+'\',[StringComparison]::OrdinalIgnoreCase) -and $full.EndsWith('.nvda-addon')) {
                $backup=Get-Content -LiteralPath (Join-Path $audit 'historical-main-deltas.report.json') -Raw | ConvertFrom-Json
                if($backup.status -ne 'verified'){throw 'Historical delta backup is not verified'}
                if((Get-FileHash -LiteralPath $backup.backup_path -Algorithm SHA256).Hash -ine $backup.backup_sha256){throw 'Historical delta backup changed'}
                $source=@($backup.source_archives | Where-Object { $_.path -eq $full })
                if($source.Count -ne 1 -or (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine $source[0].sha256){throw 'Historical archive identity mismatch'}
            }
            # Enumerate only real directories. Remove links themselves before recursive deletion.
            $todo=[Collections.Generic.Stack[string]]::new()
            $item=Get-Item -LiteralPath $full -Force
            if($item.PSIsContainer){$todo.Push($full)}
            while($todo.Count -gt 0) {
                $dir=$todo.Pop()
                foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($dir)) {
                    $attributes=[IO.File]::GetAttributes($entry)
                    if($attributes -band [IO.FileAttributes]::ReparsePoint) {
                        if($attributes -band [IO.FileAttributes]::Directory){[IO.Directory]::Delete($entry,$false)}else{[IO.File]::Delete($entry)}
                        $receipt.reparse_points_unlinked+=@{path=$entry;target_traversed=$false}
                    } elseif($attributes -band [IO.FileAttributes]::Directory) {$todo.Push($entry)}
                }
            }
            Remove-Item -LiteralPath $full -Force -Recurse
        }
        $row.removed=-not(Test-Path -LiteralPath $full)
    } catch { $row.error=$_.Exception.Message }
    $row.finished_utc=[DateTime]::UtcNow.ToString('o')
    $receipt.results+= $row
    Save-Receipt
    Write-Output ((@{removed=$row.removed;path=$full;error=$row.error}) | ConvertTo-Json -Compress)
}
$receipt.finished_utc=[DateTime]::UtcNow.ToString('o')
$receipt.volume_free_after=[IO.DriveInfo]::new('D:\').AvailableFreeSpace
$receipt.volume_free_delta=$receipt.volume_free_after-$receipt.volume_free_before
$totalRemoved=[long]0
foreach($result in $receipt.results){if($result.removed){$totalRemoved += [long]$result.logical_bytes}}
$receipt.removed_logical_bytes=$totalRemoved
$receipt.failed_targets=@($receipt.results | Where-Object { -not $_.removed }).Count
Save-Receipt
Write-Output ((@{volume_free_delta=$receipt.volume_free_delta;removed_logical_bytes=$receipt.removed_logical_bytes;failed_targets=$receipt.failed_targets}) | ConvertTo-Json -Compress)
if($receipt.failed_targets -gt 0){exit 2}
