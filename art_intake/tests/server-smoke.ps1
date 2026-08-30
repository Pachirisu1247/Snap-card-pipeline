[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 5098)

$ErrorActionPreference = 'Stop'
$ArtDeskRoot = Split-Path -Parent $PSScriptRoot
$ServerPath = Join-Path $ArtDeskRoot 'Start-ArtDesk.ps1'
$MockPath = Join-Path $PSScriptRoot 'fixtures\brave-images.json'
$Runtime = Join-Path $PSScriptRoot ('.runtime-' + [Guid]::NewGuid().ToString('N'))
$RuntimeFull = [IO.Path]::GetFullPath($Runtime)
$TestsFull = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$Stdout = Join-Path $RuntimeFull 'server.stdout.log'
$Stderr = Join-Path $RuntimeFull 'server.stderr.log'

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}

function Invoke-JsonPost([string]$Path, $Body) {
    return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port$Path" -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 12 -Compress) -TimeoutSec 15
}

New-Item -ItemType Directory -Path $RuntimeFull -Force | Out-Null
$oldMock = [string]$env:ART_DESK_MOCK_SEARCH_RESPONSE
$env:ART_DESK_MOCK_SEARCH_RESPONSE = $MockPath
$process = $null

try {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ServerPath, '-Port', $Port, '-RuntimeRoot', $RuntimeFull)
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $bootstrap = $null
    do {
        Start-Sleep -Milliseconds 200
        try { $bootstrap = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 2; break }
        catch { if ($process.HasExited) { break } }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($process.HasExited -or $null -eq $bootstrap) {
        Get-Content -LiteralPath $Stdout -ErrorAction SilentlyContinue
        Get-Content -LiteralPath $Stderr -ErrorAction SilentlyContinue
        throw 'Art Desk test server did not start.'
    }

    Assert-Equal @($bootstrap.queue).Count 48 'Bootstrap queue must contain all calibration cards'
    Assert-Equal $bootstrap.calibration.version 1 'Bootstrap must include calibration contract v1'
    Assert-Equal @($bootstrap.candidate_inventory.PSObject.Properties).Count 0 'Fresh runtime candidate inventory must be empty'
    Assert-Equal $bootstrap.capabilities.analysis_version 3 'Bootstrap must advertise analysis contract v3'
    Assert-Equal $bootstrap.capabilities.framing_profile 'snap-loose-v1' 'Bootstrap must advertise the framing profile'
    Assert-Equal $bootstrap.capabilities.search_configured $true 'Mock search must count as configured'
    Assert-Equal @($bootstrap.duplicate_art.PSObject.Properties).Count 0 'Fresh runtime duplicate-art map must be empty'
    if ($bootstrap.capabilities.https_backend -notin @('python-openssl', 'windows-native')) { throw 'Bootstrap did not advertise a supported HTTPS backend.' }
    $cardId = [string]$bootstrap.queue[0].id

    Assert-Equal (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/").StatusCode 200 'Root route failed'
    Assert-Equal (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/static/app.js").StatusCode 200 'App module route failed'
    $transformersVendor = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/static/vendor/transformers.js"
    Assert-Equal $transformersVendor.StatusCode 200 'AI vendor route failed'
    if ($transformersVendor.RawContentLength -lt 400000) { throw 'Compressed AI vendor route did not expand the complete bundle.' }
    Assert-Equal (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/static/vendor/ort.webgpu.bundle.min.mjs").StatusCode 200 'ONNX vendor route failed'

    $search = Invoke-JsonPost '/api/search-candidates' @{ card_id = $cardId; query = 'Havok Marvel comic art'; count = 48 }
    Assert-Equal @($search.candidates).Count 2 'Mock search normalization failed'
    if ([string]::IsNullOrWhiteSpace([string]$search.candidates[0].id)) { throw 'Candidate id was not generated.' }
    $saved = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/candidates/$cardId"
    Assert-Equal @($saved.candidates).Count 2 'Candidate metadata did not persist'

    $settings = Invoke-JsonPost '/api/settings/search' @{ brave_api_key = 'test-key-that-is-long-enough' }
    Assert-Equal $settings.search_configured $true 'Search settings route failed'
    $settingsText = [IO.File]::ReadAllText((Join-Path $RuntimeFull 'data\settings.local.json'))
    if ($settingsText -notmatch 'test-key-that-is-long-enough') { throw 'Search key was not stored in the isolated runtime.' }

    # A valid one-pixel PNG exercises content sniffing and isolated writes.
    $png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    $uploaded = Invoke-JsonPost '/api/upload-image' @{ card_id = $cardId; image_data_url = "data:image/png;base64,$png"; source_kind = 'local_file'; source_url = 'https://example.com/source' }
    Assert-Equal $uploaded.record.status 'selected' 'Upload must reset status to selected'
    Assert-Equal $uploaded.record.analysis $null 'Upload must invalidate old analysis'
    $secondCardId = [string]$bootstrap.queue[1].id
    $duplicateRejected = $false
    try { Invoke-JsonPost '/api/upload-image' @{ card_id = $secondCardId; image_data_url = "data:image/png;base64,$png"; source_kind = 'local_file'; source_url = '' } | Out-Null }
    catch { $duplicateRejected = $_.Exception.Message -match '400' }
    if (-not $duplicateRejected) { throw 'Cross-card duplicate artwork was not rejected.' }

    $analysis = @{
        image = @{ width = 1800; height = 2400 }
        foreground = @{ box = @{ x = 0.2; y = 0.05; width = 0.6; height = 0.9 }; confidence = 0.8 }
        providers = @('test')
        solution = @{ confidence = 0.7 }
    }
    $analyzed = Invoke-JsonPost '/api/analysis' @{ card_id = $cardId; crop = @{ scale = 1.1; pan_x = 3; pan_y = -2; mode = 'auto'; analysis_version = 3; framing_profile = 'snap-loose-v1' }; analysis = $analysis }
    Assert-Equal $analyzed.record.crop.analysis_version 3 'Analysis crop was not persisted'

    $approved = Invoke-JsonPost '/api/decision' @{ card_id = $cardId; status = 'approved'; source_kind = 'local_file'; source_url = 'https://example.com/source'; note = 'smoke'; crop = $analyzed.record.crop; analysis = $analysis; candidate_id = '' }
    Assert-Equal $approved.record.status 'approved' 'Approval did not persist'
    Assert-Equal (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/art/$cardId").StatusCode 200 'Saved art route failed'
    $jsonReport = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/calibration-report.json"
    Assert-Equal @($jsonReport.rows).Count 48 'JSON calibration report must include the whole queue'
    Assert-Equal @($jsonReport.rows | Where-Object { $_.card_id -eq $cardId })[0].outcome 'zero_touch' 'JSON report did not classify untouched approval'
    $csvReport = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/calibration-report.csv"
    if ($csvReport.Headers['Content-Disposition'] -notmatch 'attachment') { throw 'CSV report is missing its download header.' }
    if ($csvReport.Content -notmatch 'card_id.*confidence_band.*outcome') { throw 'CSV report is missing expected metric columns.' }

    $privateRejected = $false
    try { Invoke-JsonPost '/api/import-url' @{ card_id = $cardId; image_url = 'http://127.0.0.1/private.png'; source_url = '' } | Out-Null }
    catch { $privateRejected = $_.Exception.Message -match '400' }
    if (-not $privateRejected) { throw 'Private-network image URL was not rejected.' }

    $skipped = Invoke-JsonPost '/api/decision' @{ card_id = $cardId; status = 'skipped'; note = ''; crop = $analyzed.record.crop; analysis = $analysis }
    Assert-Equal $skipped.record.image_filename '' 'Skip must clear the active art selection'
    Assert-Equal $skipped.record.analysis $null 'Skip must clear analysis'

    $statePath = Join-Path $RuntimeFull 'data\state.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-Equal $state.version 2 'Atomic state file is not contract v2'

    $calibrationResponse = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/calibration"
    $calibrationCard = $calibrationResponse.calibration.cards.PSObject.Properties[$cardId].Value
    Assert-Equal $calibrationCard.analysis_count 1 'Calibration must record analysis automatically'
    Assert-Equal $calibrationCard.candidate_count 2 'Calibration must record candidate discovery automatically'
    Assert-Equal $calibrationCard.status 'skipped' 'Calibration must follow the final review decision'
    if ($null -eq $calibrationCard.baseline_crop) { throw 'Calibration baseline crop was not preserved.' }
    $sessionId = [string]$calibrationResponse.calibration.session_id

    # Restart the isolated server and prove that calibration/search checkpoints
    # survive the process boundary rather than living only in browser memory.
    $process.Kill(); $process.WaitForExit()
    $restartOut = Join-Path $RuntimeFull 'server-restart.stdout.log'; $restartErr = Join-Path $RuntimeFull 'server-restart.stderr.log'
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $restartOut -RedirectStandardError $restartErr -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15); $restarted = $null
    do {
        Start-Sleep -Milliseconds 200
        try { $restarted = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 2; break }
        catch { if ($process.HasExited) { break } }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $restarted) { throw 'Art Desk test server did not restart.' }
    Assert-Equal $restarted.calibration.session_id $sessionId 'Calibration session changed across restart'
    Assert-Equal $restarted.candidate_inventory.PSObject.Properties[$cardId].Value.count 2 'Candidate inventory did not survive restart'
    Assert-Equal $restarted.calibration.cards.PSObject.Properties[$cardId].Value.analysis_count 1 'Analysis evidence did not survive restart'

    # A provider failure is evidence too: it must increment health telemetry
    # without erasing the previously cached successful candidate set.
    $process.Kill(); $process.WaitForExit()
    $env:ART_DESK_MOCK_SEARCH_RESPONSE = Join-Path $RuntimeFull 'missing-provider-response.json'
    $failureOut = Join-Path $RuntimeFull 'server-failure.stdout.log'; $failureErr = Join-Path $RuntimeFull 'server-failure.stderr.log'
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $failureOut -RedirectStandardError $failureErr -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15); $failureServer = $null
    do {
        Start-Sleep -Milliseconds 200
        try { $failureServer = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 2; break }
        catch { if ($process.HasExited) { break } }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $failureServer) { throw 'Provider-failure test server did not start.' }
    $providerRejected = $false
    try { Invoke-JsonPost '/api/search-candidates' @{ card_id = $cardId; query = 'failure telemetry test'; count = 80 } | Out-Null }
    catch { $providerRejected = $_.Exception.Message -match '400' }
    if (-not $providerRejected) { throw 'Missing mock provider response did not fail safely.' }
    $failureCalibration = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/calibration"
    Assert-Equal $failureCalibration.calibration.cards.PSObject.Properties[$cardId].Value.provider_failures 1 'Provider failure telemetry did not persist'
    Assert-Equal $failureCalibration.candidate_inventory.PSObject.Properties[$cardId].Value.count 2 'Provider failure erased the last good candidate set'

    Write-Host "Server smoke passed: 48-card bootstrap, static assets, candidate persistence, calibration restart recovery, provider-failure isolation, upload, analysis, decision, and SSRF rejection." -ForegroundColor Green
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $env:ART_DESK_MOCK_SEARCH_RESPONSE = $oldMock
    if ($RuntimeFull.StartsWith($TestsFull, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $RuntimeFull)) {
        Remove-Item -LiteralPath $RuntimeFull -Recurse -Force
    }
}
