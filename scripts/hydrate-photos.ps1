param(
    [Parameter(Mandatory = $true)][string]$SourceFolder,
    [string]$Extensions = "*",              # comma-separated, e.g. "jpg,heic,mov" or "*" for all
    [int]$Count = 0,                        # 0 = no limit (process all matches)
    [ValidateSet("Newest", "Oldest")][string]$OrderBy = "Newest"
)

$ErrorActionPreference = "Stop"

# --- Cloud Files API attribute bits used by iCloud for Windows / OneDrive-style placeholders ---
$FILE_ATTRIBUTE_RECALL_ON_OPEN        = 0x40000    # 262144
$FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000   # 4194304

function Test-IsCloudOnly {
    param([System.IO.FileInfo]$File)
    $val = [int]$File.Attributes
    return (($val -band $FILE_ATTRIBUTE_RECALL_ON_OPEN) -ne 0) -or (($val -band $FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) -ne 0)
}

function Emit-Event {
    param([hashtable]$Data)
    # Structured line the Node backend parses. Plain Write-Host lines are also
    # forwarded to the UI log as-is, but ::EVENT:: lines drive the progress bar.
    $json = $Data | ConvertTo-Json -Compress
    Write-Output "::EVENT::$json"
}

if (-not (Test-Path $SourceFolder)) {
    Emit-Event @{ type = "error"; message = "Source folder not found: $SourceFolder" }
    exit 1
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

$cloudOnly = $sorted | Where-Object { Test-IsCloudOnly $_ }

$targets = if ($Count -gt 0) { $cloudOnly | Select-Object -First $Count } else { $cloudOnly }

$total = $targets.Count
Write-Output "Found $($all.Count) matching files, $($cloudOnly.Count) are cloud-only. Hydrating $total ..."
Emit-Event @{ type = "start"; total = $total }

$hydrated = 0
$errors   = 0
$i = 0

foreach ($file in $targets) {
    $i++
    try {
        # Reading the file forces Windows' Cloud Files API to download the real content.
        $stream = [System.IO.File]::OpenRead($file.FullName)
        $buffer = New-Object byte[] 65536
        while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { }
        $stream.Close()

        $hydrated++
        Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "hydrated" }
    } catch {
        $errors++
        Emit-Event @{ type = "progress"; done = $i; total = $total; file = $file.Name; action = "error"; message = $_.Exception.Message }
    }
}

Emit-Event @{ type = "summary"; checked = $all.Count; cloudOnly = $cloudOnly.Count; hydrated = $hydrated; errors = $errors }
Write-Output "Done. Hydrated $hydrated of $total targeted files ($errors errors)."
