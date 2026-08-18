param(
    [Parameter(Mandatory = $true)][string]$SourceFolder,
    [Parameter(Mandatory = $true)][string]$DestFolder,
    [string]$Extensions = "*",              # comma-separated, e.g. "jpg,heic,mov" or "*" for all
    [int]$Count = 0,                        # 0 = no limit (process all local matches)
    [ValidateSet("Copy", "Move")][string]$Action = "Copy",
    [ValidateSet("Newest", "Oldest")][string]$OrderBy = "Newest"
)

$ErrorActionPreference = "Stop"

$FILE_ATTRIBUTE_RECALL_ON_OPEN        = 0x40000
$FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000

function Test-IsCloudOnly {
    param([System.IO.FileInfo]$File)
    $val = [int]$File.Attributes
    return (($val -band $FILE_ATTRIBUTE_RECALL_ON_OPEN) -ne 0) -or (($val -band $FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) -ne 0)
}

function Emit-Event {
    param([hashtable]$Data)
    $json = $Data | ConvertTo-Json -Compress
    Write-Output "::EVENT::$json"
}

if (-not (Test-Path $SourceFolder)) {
    Emit-Event @{ type = "error"; message = "Source folder not found: $SourceFolder" }
    exit 1
}

if (-not (Test-Path $DestFolder)) {
    New-Item -ItemType Directory -Path $DestFolder -Force | Out-Null
    Write-Output "Created destination folder: $DestFolder"
}

$includePatterns = if ($Extensions -eq "*" -or [string]::IsNullOrWhiteSpace($Extensions)) {
    @("*.jpg","*.jpeg","*.png","*.heic","*.mov","*.mp4","*.gif")
} else {
    $Extensions.Split(",") | ForEach-Object { "*." + $_.Trim().TrimStart(".") }
}

Write-Output "Scanning $SourceFolder ..."
$all = Get-ChildItem -Path $SourceFolder -File -Include $includePatterns -Recurse

$sorted = if ($OrderBy -eq "Oldest") {
    $all | Sort-Object LastWriteTime
} else {
    $all | Sort-Object LastWriteTime -Descending
}

$localOnly = $sorted | Where-Object { -not (Test-IsCloudOnly $_) }
$targets   = if ($Count -gt 0) { $localOnly | Select-Object -First $Count } else { $localOnly }

$total = $targets.Count
Write-Output "Found $($all.Count) matching files, $($localOnly.Count) are already local. Processing $total ($Action) ..."
Emit-Event @{ type = "start"; total = $total }

$copied  = 0
$skipped = 0
$moved   = 0
$errors  = 0
$i = 0

foreach ($file in $targets) {
    $i++
    $destPath = Join-Path $DestFolder $file.Name
    $destOk = $false

    try {
        if (Test-Path $destPath) {
            $skipped++
            Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "skipped" }
            $destOk = $true
        } else {
            Copy-Item -Path $file.FullName -Destination $destPath -ErrorAction Stop
            $srcSize  = (Get-Item $file.FullName).Length
            $destSize = (Get-Item $destPath).Length

            if ($srcSize -eq $destSize) {
                $copied++
                Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "copied" }
                $destOk = $true
            } else {
                $errors++
                Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "error"; message = "Size mismatch after copy" }
            }
        }

        if ($destOk -and $Action -eq "Move") {
            Remove-Item -Path $file.FullName -Force -ErrorAction Stop
            $moved++
            Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "deletedSource" }
        }
    } catch {
        $errors++
        Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "error"; message = $_.Exception.Message }
    }
}

Emit-Event @{ type = "summary"; checked = $all.Count; localOnly = $localOnly.Count; copied = $copied; skipped = $skipped; deletedSource = $moved; errors = $errors }
Write-Output "Done. Copied $copied, skipped $skipped, deleted-source $moved, errors $errors."
