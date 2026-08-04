[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory,

    [ValidateRange(1, 86400)]
    [int]$DurationSeconds = 60,

    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ChattoProcessIds {
    param([int]$RootProcessId)

    $processRows = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name FROM Win32_Process')
    $descendantIds = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$descendantIds.Add($RootProcessId)

    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($row in $processRows) {
            $parentId = [int]$row.ParentProcessId
            $childId = [int]$row.ProcessId
            if ($descendantIds.Contains($parentId) -and -not $descendantIds.Contains($childId)) {
                [void]$descendantIds.Add($childId)
                $changed = $true
            }
        }
    }

    $selected = @()
    foreach ($row in $processRows) {
        $id = [int]$row.ProcessId
        $name = [string]$row.Name
        if ($id -eq $RootProcessId) {
            $selected += [PSCustomObject]@{ ProcessId = $id; Name = $name; Role = 'host' }
        }
        elseif ($descendantIds.Contains($id) -and $name -ieq 'msedgewebview2.exe') {
            $selected += [PSCustomObject]@{ ProcessId = $id; Name = $name; Role = 'webview2' }
        }
    }
    return $selected
}

function Get-GpuPercentByProcess {
    param([int[]]$ProcessIds)

    $values = @{}
    foreach ($id in $ProcessIds) {
        $values[$id] = $null
    }

    try {
        $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples
        foreach ($id in $ProcessIds) {
            $matching = @($samples | Where-Object { $_.InstanceName -match "(^|_)pid_$id(_|$)" })
            if ($matching.Count -gt 0) {
                $sum = ($matching | Measure-Object -Property CookedValue -Sum).Sum
                if ($null -ne $sum -and -not [double]::IsNaN([double]$sum)) {
                    $values[$id] = [Math]::Round([double]$sum, 3)
                }
            }
        }
    }
    catch {
        # GPU Engine counters are optional and unavailable on some systems.
    }

    return $values
}

if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    throw "Process $ProcessId is not running. Start Chatto and pass its process ID."
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Path $resolvedOutput -Force)
$startedAt = Get-Date
$fileTimestamp = $startedAt.ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$jsonPath = Join-Path $resolvedOutput "chatto-resources-$fileTimestamp.json"
$csvPath = Join-Path $resolvedOutput "chatto-resources-$fileTimestamp.csv"
$logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)
$previousCpu = @{}
$previousSampleAt = @{}
$rows = New-Object 'System.Collections.Generic.List[object]'

do {
    $sampleAt = Get-Date
    $targets = @(Get-ChattoProcessIds -RootProcessId $ProcessId)
    if ($targets.Count -eq 0) {
        break
    }
    $gpuByProcess = Get-GpuPercentByProcess -ProcessIds @($targets | ForEach-Object { $_.ProcessId })

    foreach ($target in $targets) {
        $process = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            continue
        }

        $cpuPercent = $null
        if ($previousCpu.ContainsKey($target.ProcessId)) {
            $elapsedSeconds = ($sampleAt - $previousSampleAt[$target.ProcessId]).TotalSeconds
            $cpuDelta = [double]$process.CPU - [double]$previousCpu[$target.ProcessId]
            if ($elapsedSeconds -gt 0 -and $cpuDelta -ge 0) {
                $cpuPercent = [Math]::Round(($cpuDelta / $elapsedSeconds / $logicalProcessors) * 100, 3)
            }
        }
        $previousCpu[$target.ProcessId] = [double]$process.CPU
        $previousSampleAt[$target.ProcessId] = $sampleAt

        $rows.Add([PSCustomObject]@{
            TimestampUtc = $sampleAt.ToUniversalTime().ToString('o')
            ProcessId = [int]$target.ProcessId
            Role = [string]$target.Role
            ProcessName = [string]$target.Name
            CpuPercent = $cpuPercent
            WorkingSetBytes = [long]$process.WorkingSet64
            PrivateMemoryBytes = [long]$process.PrivateMemorySize64
            GpuPercent = $gpuByProcess[$target.ProcessId]
        })
    }

    $elapsed = ((Get-Date) - $startedAt).TotalSeconds
    if ($elapsed -ge $DurationSeconds) {
        break
    }
    Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, $DurationSeconds - $elapsed))
} while ($true)

$rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
$rows | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8

[PSCustomObject]@{
    JsonFile = [System.IO.Path]::GetFileName($jsonPath)
    CsvFile = [System.IO.Path]::GetFileName($csvPath)
    Samples = $rows.Count
}
