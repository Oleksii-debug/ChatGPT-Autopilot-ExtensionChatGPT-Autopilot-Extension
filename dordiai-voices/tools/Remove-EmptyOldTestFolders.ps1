$ErrorActionPreference='Stop'
if([DateTime]::UtcNow.ToString('yyyy-MM-dd') -ne '2026-11-22'){throw 'Dated manual cleanup only'}
$root='D:\Синтезатор мовлення KX-47'
$removed=@()
foreach($relative in @('Перевірка','Основний синтезатор\Перевірка')){
    $base=[IO.Path]::GetFullPath((Join-Path $root $relative))
    if(-not $base.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid base'}
    if([IO.File]::GetAttributes($base) -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse base'}
    foreach($child in [IO.Directory]::EnumerateDirectories($base)){
        if($child -match "(?i)unified|Єдиний|ЄГ|П.ять|Другий|Англійська|Швидке читання|0\.10\.1[12] перевірка"){continue}
        if([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint){continue}
        # Nonrecursive deletion only; refuses any nonempty directory atomically.
        if(-not [IO.Directory]::EnumerateFileSystemEntries($child).GetEnumerator().MoveNext()){
            [IO.Directory]::Delete($child,$false);$removed+=$child
        }
    }
}
$receipt=@{format='dordiai-empty-old-test-folder-prune';removed=$removed;recursive_deletion=$false;reparse_targets_traversed=$false;finished_utc=[DateTime]::UtcNow.ToString('o')}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\windows-evidence\storage-cleanup-20261122\empty-folders.json') -Encoding utf8
Write-Output "Removed $($removed.Count) empty old test folders; no recursion"
