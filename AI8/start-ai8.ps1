$ErrorActionPreference = "Stop"

function Write-Step {
    param(
        [string]$Message
    )

    Write-Host "[AI8] $Message" -ForegroundColor Cyan
}

function Read-EnvFile {
    param(
        [string]$Path
    )

    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $separator = $trimmed.IndexOf("=")
        if ($separator -lt 1) {
            continue
        }

        $key = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim()

        if ($value.Length -ge 2) {
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        $values[$key] = $value
    }

    return $values
}

function Get-ConfiguredPort {
    param(
        [hashtable]$EnvValues
    )

    $parsedPort = 0
    if ($EnvValues.ContainsKey("PORT") -and [int]::TryParse($EnvValues["PORT"], [ref]$parsedPort) -and $parsedPort -gt 0) {
        return $parsedPort
    }

    return 7862
}

function Get-ListeningProcessIds {
    param(
        [int]$Port
    )

    try {
        return @(
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique |
                Where-Object { $_ -and $_ -gt 0 }
        )
    } catch {
        return @()
    }
}

function Get-ProcessCommandLine {
    param(
        [int]$ProcessId
    )

    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
        return [string]$process.CommandLine
    } catch {
        return ""
    }
}

function Stop-ProcessIfRunning {
    param(
        [int]$ProcessId,
        [string]$Reason
    )

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return $false
    }

    Write-Step "$Reason (PID $ProcessId)"
    Stop-Process -Id $ProcessId -Force
    Start-Sleep -Milliseconds 500
    return $true
}

function Remove-StalePidFile {
    param(
        [string]$PidFilePath
    )

    if (Test-Path -LiteralPath $PidFilePath) {
        Remove-Item -LiteralPath $PidFilePath -Force
    }
}

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $projectDir
$serverScript = Join-Path $projectDir "server.js"
$envPath = Join-Path $projectDir ".env"
$pidFilePath = Join-Path $projectDir ".ai8.pid"
$envValues = Read-EnvFile -Path $envPath
$port = Get-ConfiguredPort -EnvValues $envValues

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Node.js was not found in PATH. Install Node.js first."
}

if (-not (Test-Path -LiteralPath (Join-Path $projectDir "node_modules"))) {
    Write-Step "node_modules not found. Running npm install..."
    Push-Location $projectDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

if (Test-Path -LiteralPath $pidFilePath) {
    $trackedPid = 0
    $pidText = (Get-Content -LiteralPath $pidFilePath -Raw).Trim()
    if ([int]::TryParse($pidText, [ref]$trackedPid)) {
        Stop-ProcessIfRunning -ProcessId $trackedPid -Reason "Stopping the previous launcher-managed AI8 instance"
    }
    Remove-StalePidFile -PidFilePath $pidFilePath
}

foreach ($listeningPid in Get-ListeningProcessIds -Port $port) {
    $process = Get-Process -Id $listeningPid -ErrorAction SilentlyContinue
    if (-not $process) {
        continue
    }

    $commandLine = Get-ProcessCommandLine -ProcessId $listeningPid
    $isNodeProcess = $process.ProcessName -match "^node(\.exe)?$"
    $looksLikeAi8 =
        $commandLine -match [regex]::Escape($projectDir) -or
        $commandLine -match "(?i)(^|[ ""'])AI8[\\/].*server\.js($|[ ""'])" -or
        $commandLine -match "(?i)(^|[ ""'])server\.js($|[ ""'])"

    if ($isNodeProcess -and $looksLikeAi8) {
        Stop-ProcessIfRunning -ProcessId $listeningPid -Reason "Stopping the AI8 process already listening on port $port"
        continue
    }

    throw "Port $port is already occupied by PID $listeningPid ($($process.ProcessName)). Close that process or change PORT in AI8/.env."
}

$baseUrl = "http://127.0.0.1:$port"
Write-Step "Starting AI8 adapter from $serverScript"
Write-Step "OpenAI base: $baseUrl/v1"
Write-Step "Admin page: $baseUrl/admin"

$nodeProcess = $null

try {
    $nodeProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList "server.js" -WorkingDirectory $projectDir -NoNewWindow -PassThru
    Set-Content -LiteralPath $pidFilePath -Value $nodeProcess.Id -NoNewline
    $nodeProcess.WaitForExit()
    exit $nodeProcess.ExitCode
} finally {
    Remove-StalePidFile -PidFilePath $pidFilePath
}
