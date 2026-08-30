<#
Starts Art Desk 2 at http://127.0.0.1:5010.

The user-facing runtime is deliberately dependency-free: Windows PowerShell
hosts the loopback-only API and static files. Heavy image analysis runs inside
the browser, while this process owns durable state, remote-image validation,
candidate metadata, and the authentic generated PSD/template assets.
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 5010,

    # Tests can isolate every mutable file without copying the repository.
    # Normal launches leave this blank and use art_intake itself.
    [string]$RuntimeRoot = ''
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 otherwise negotiates obsolete TLS defaults against
# modern image CDNs. Keep any OS-enabled protocols and explicitly add TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$AppRoot = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = $AppRoot }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$ProjectRoot = Split-Path -Parent $AppRoot
$CardsCsv = Join-Path $ProjectRoot 'photopea_batch\snap_cards.msz_latest.csv'
$TemplatePsd = Join-Path $ProjectRoot 'photopea_batch\AgathaNew.psd'
$CardPsdDir = Join-Path $ProjectRoot 'photopea_batch\output_psd_calibrated_logo'
$FontsDir = Join-Path $ProjectRoot 'Fonts'
$HtmlPath = Join-Path $AppRoot 'art_desk.html'
$RendererPath = Join-Path $AppRoot 'render_real_psd_overlays.html'
$SecureFetchPath = Join-Path $AppRoot 'secure_fetch.py'
$StaticDir = Join-Path $AppRoot 'static'
$DataDir = Join-Path $RuntimeRoot 'data'
$AssetsDir = Join-Path $RuntimeRoot 'assets\original'
$OverlayDir = Join-Path $AppRoot 'assets\template_overlays'
$CandidateDataDir = Join-Path $DataDir 'candidates'
$CandidateCacheDir = Join-Path $RuntimeRoot 'cache\candidates'
$StatePath = Join-Path $DataDir 'state.json'
$QueuePath = Join-Path $DataDir 'real_psd_test_queue.json'
$SettingsPath = Join-Path $DataDir 'settings.local.json'
$CalibrationPath = Join-Path $DataDir 'calibration-session.json'
$Script:QueueIds = @{}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Save-JsonAtomic([string]$Path, $Value, [int]$Depth = 20) {
    Ensure-Directory (Split-Path -Parent $Path)
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    # -InputObject preserves top-level arrays on Windows PowerShell 5.1. The
    # pipeline form serializes them as an unexpected {"value": [...]} wrapper.
    # ConvertFrom-Json in Windows PowerShell 5.1 can attach a wrapper adapter
    # to root arrays. Re-enumerating produces an ordinary Object[] that keeps
    # its JSON array shape.
    $serializable = if ($Value -is [Array]) { @($Value | ForEach-Object { $_ }) } else { $Value }
    $json = ConvertTo-Json -InputObject $serializable -Depth $Depth
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $Path) {
            try { [IO.File]::Replace($temporary, $Path, $null) }
            catch { Move-Item -LiteralPath $temporary -Destination $Path -Force }
        } else {
            Move-Item -LiteralPath $temporary -Destination $Path
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Save-BytesAtomic([string]$Path, [byte[]]$Bytes) {
    Ensure-Directory (Split-Path -Parent $Path)
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    try { Move-Item -LiteralPath $temporary -Destination $Path -Force }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Read-GzipBytes([string]$Path) {
    $source = [IO.File]::OpenRead($Path)
    try {
        $gzip = [IO.Compression.GZipStream]::new($source, [IO.Compression.CompressionMode]::Decompress)
        try {
            $memory = [IO.MemoryStream]::new()
            try {
                $gzip.CopyTo($memory)
                return ,$memory.ToArray()
            } finally { $memory.Dispose() }
        } finally { $gzip.Dispose() }
    } finally { $source.Dispose() }
}

function Get-TemplateSize {
    if (-not (Test-Path -LiteralPath $TemplatePsd)) {
        return [pscustomobject]@{ width = 1700; height = 2400; source = 'fallback' }
    }
    $bytes = [IO.File]::ReadAllBytes($TemplatePsd)
    if ($bytes.Length -lt 26 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne '8BPS') {
        return [pscustomobject]@{ width = 1700; height = 2400; source = 'fallback' }
    }
    $height = [BitConverter]::ToInt32(@($bytes[17], $bytes[16], $bytes[15], $bytes[14]), 0)
    $width = [BitConverter]::ToInt32(@($bytes[21], $bytes[20], $bytes[19], $bytes[18]), 0)
    return [pscustomobject]@{ width = $width; height = $height; source = 'AgathaNew.psd' }
}

function Get-TestQueue {
    if (Test-Path -LiteralPath $QueuePath) {
        return @(Get-Content -LiteralPath $QueuePath -Raw | ConvertFrom-Json)
    }
    # Isolated test roots can reuse the tracked queue without mutating it.
    $trackedQueue = Join-Path $AppRoot 'data\real_psd_test_queue.json'
    if ($RuntimeRoot -ne $AppRoot -and (Test-Path -LiteralPath $trackedQueue)) {
        $loaded = @(Get-Content -LiteralPath $trackedQueue -Raw | ConvertFrom-Json)
        Save-JsonAtomic $QueuePath $loaded 6
        return $loaded
    }
    if (-not (Test-Path -LiteralPath $CardsCsv)) { throw "Card CSV not found: $CardsCsv" }
    if (-not (Test-Path -LiteralPath $CardPsdDir)) { throw "Generated PSD directory not found: $CardPsdDir" }

    $cardById = @{}
    foreach ($card in @(Import-Csv -LiteralPath $CardsCsv)) { $cardById[[string]$card.id] = $card }
    $cards = @(Get-ChildItem -LiteralPath $CardPsdDir -Filter '*.psd' | ForEach-Object {
        if ($cardById.ContainsKey($_.BaseName)) { $cardById[$_.BaseName] }
    })
    if ($cards.Count -lt 48) { throw "Expected at least 48 mapped generated PSDs, found $($cards.Count)." }

    $random = [Random]::new(20260803)
    for ($i = $cards.Count - 1; $i -gt 0; $i--) {
        $j = $random.Next($i + 1)
        $swap = $cards[$i]; $cards[$i] = $cards[$j]; $cards[$j] = $swap
    }
    $queue = @($cards | Select-Object -First 48 | ForEach-Object {
        [pscustomobject]@{ id = $_.id; cost = [string]$_.cost; power = [string]$_.power; rules = [string]$_.rules }
    })
    Save-JsonAtomic $QueuePath $queue 6
    return $queue
}

function Get-State {
    if (-not (Test-Path -LiteralPath $StatePath)) {
        return [pscustomobject]@{ version = 2; cards = [pscustomobject]@{} }
    }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($null -eq $state.cards) { $state | Add-Member -Force NoteProperty cards ([pscustomobject]@{}) }
    $state.version = 2
    return $state
}

function Save-State($State) {
    $State.version = 2
    Save-JsonAtomic $StatePath $State 24
}

function Get-CardRecord($State, [string]$CardId) {
    $property = $State.cards.PSObject.Properties[$CardId]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Set-CardRecord($State, [string]$CardId, $Record) {
    $State.cards | Add-Member -Force -NotePropertyName $CardId -NotePropertyValue $Record
}

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-SavedAssetPath($Record) {
    if ($null -eq $Record -or [string]::IsNullOrWhiteSpace([string]$Record.image_filename)) { return $null }
    $path = [IO.Path]::GetFullPath((Join-Path $AssetsDir ([string]$Record.image_filename)))
    $root = [IO.Path]::GetFullPath($AssetsDir).TrimEnd('\') + '\'
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return $path
}

function Assert-UniqueArtwork($State, [string]$CardId, [byte[]]$Bytes) {
    $incomingHash = Get-BytesSha256 $Bytes
    foreach ($property in @($State.cards.PSObject.Properties)) {
        if ([string]$property.Name -eq $CardId) { continue }
        $path = Get-SavedAssetPath $property.Value
        if ($null -eq $path) { continue }
        $savedHash = [string]$property.Value.image_sha256
        if ($savedHash -notmatch '^[a-fA-F0-9]{64}$') { $savedHash = Get-BytesSha256 ([IO.File]::ReadAllBytes($path)) }
        if ($savedHash.ToLowerInvariant() -eq $incomingHash) {
            throw "That exact image is already assigned to $($property.Name). Choose different artwork for $CardId."
        }
    }
}

function Get-DuplicateArtConflicts($State) {
    $groups = @{}
    foreach ($property in @($State.cards.PSObject.Properties)) {
        $path = Get-SavedAssetPath $property.Value
        if ($null -eq $path) { continue }
        $hash = [string]$property.Value.image_sha256
        if ($hash -notmatch '^[a-fA-F0-9]{64}$') { $hash = Get-BytesSha256 ([IO.File]::ReadAllBytes($path)) }
        $hash = $hash.ToLowerInvariant()
        if (-not $groups.ContainsKey($hash)) { $groups[$hash] = [Collections.Generic.List[object]]::new() }
        $quality = 0
        if ($null -ne $property.Value.analysis) { $quality += 2 }
        if (-not [string]::IsNullOrWhiteSpace([string]$property.Value.source_url)) { $quality += 1 }
        $groups[$hash].Add([pscustomobject]@{ card_id = [string]$property.Name; quality = $quality; updated_at = [string]$property.Value.updated_at })
    }
    $conflicts = [pscustomobject]@{}
    foreach ($hash in @($groups.Keys)) {
        $members = @($groups[$hash] | Sort-Object -Property @{ Expression = 'quality'; Descending = $true }, @{ Expression = 'updated_at'; Descending = $true })
        if ($members.Count -lt 2) { continue }
        $owner = [string]$members[0].card_id
        foreach ($member in @($members | Select-Object -Skip 1)) {
            $conflicts | Add-Member -Force NoteProperty ([string]$member.card_id) ([pscustomobject]@{ owner_card_id = $owner; sha256 = $hash })
        }
    }
    return $conflicts
}

function Assert-CardId([string]$CardId) {
    if ($CardId -notmatch '^[a-z0-9-]+$' -or -not $Script:QueueIds.ContainsKey($CardId)) {
        throw "Unknown or invalid card id: $CardId"
    }
}

function New-DefaultCrop([string]$Mode = 'manual') {
    return [pscustomobject]@{ scale = 1; pan_x = 0; pan_y = 0; mode = $Mode; analysis_version = 4; framing_profile = 'snap-extended-v1'; background_mode = 'cover'; extension_feather = 0 }
}

function Get-Settings {
    if (-not (Test-Path -LiteralPath $SettingsPath)) { return [pscustomobject]@{} }
    try { return Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json }
    catch { throw 'The local search settings file is not valid JSON.' }
}

function Get-BraveApiKey {
    if (-not [string]::IsNullOrWhiteSpace([string]$env:ART_DESK_BRAVE_API_KEY)) {
        return [string]$env:ART_DESK_BRAVE_API_KEY
    }
    $settings = Get-Settings
    return [string]$settings.brave_api_key
}

function Find-PythonRuntime {
    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace([string]$env:USERPROFILE)) {
        $candidates.Add((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'))
    }
    foreach ($name in @('python3', 'python')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) { $candidates.Add([string]$command.Source) }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Invoke-SecureFetchBytes([string]$Url, [hashtable]$Headers, [long]$MaximumBytes) {
    if ([string]::IsNullOrWhiteSpace([string]$Script:PythonPath)) { return $null }
    # Fail closed in both processes: the server checks before the helper checks
    # every DNS answer and redirect independently.
    Get-SafeRemoteUri $Url | Out-Null
    $networkDir = Join-Path $RuntimeRoot 'cache\network'; Ensure-Directory $networkDir
    $token = [Guid]::NewGuid().ToString('N')
    $requestPath = Join-Path $networkDir "$token.request.json"
    $outputPath = Join-Path $networkDir "$token.response.bin"
    try {
        Save-JsonAtomic $requestPath ([pscustomobject]@{ url = $Url; output = $outputPath; max_bytes = $MaximumBytes; headers = $Headers }) 6
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $Script:PythonPath
        $info.Arguments = '"' + $SecureFetchPath + '" "' + $requestPath + '"'
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($info)
        if (-not $process.WaitForExit(40000)) {
            try { $process.Kill() } catch {}
            throw 'Secure HTTPS helper timed out.'
        }
        $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
            $message = if ([string]::IsNullOrWhiteSpace($stderr)) { 'Secure HTTPS helper failed.' } else { $stderr.Trim() }
            throw $message
        }
        $metadata = $stdout | ConvertFrom-Json
        return [pscustomobject]@{ bytes = [IO.File]::ReadAllBytes($outputPath); final_url = [string]$metadata.final_url; content_type = [string]$metadata.content_type }
    } finally {
        if (Test-Path -LiteralPath $requestPath) { Remove-Item -LiteralPath $requestPath -Force }
        if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
    }
}

function Get-CandidateFile([string]$CardId) { return Join-Path $CandidateDataDir "$CardId.json" }

function Get-CandidateSet([string]$CardId) {
    Assert-CardId $CardId
    $path = Get-CandidateFile $CardId
    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{ version = 1; card_id = $CardId; query = ''; updated_at = $null; candidates = @() }
    }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Get-Candidate([string]$CardId, [string]$CandidateId) {
    if ($CandidateId -notmatch '^[a-f0-9]{16,64}$') { throw 'Invalid candidate id.' }
    $set = Get-CandidateSet $CardId
    $candidate = @($set.candidates | Where-Object { [string]$_.id -eq $CandidateId } | Select-Object -First 1)
    if ($candidate.Count -eq 0) { throw 'Candidate is no longer in this card search.' }
    return $candidate[0]
}

function Get-StableId([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)) }
    finally { $sha.Dispose() }
    return -join ($hash[0..11] | ForEach-Object { $_.ToString('x2') })
}

function Test-PrivateAddress([Net.IPAddress]$Address) {
    if ([Net.IPAddress]::IsLoopback($Address)) { return $true }
    $bytes = $Address.GetAddressBytes()
    if ($Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
        return ($bytes[0] -eq 10) -or
            ($bytes[0] -eq 127) -or
            ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
            ($bytes[0] -eq 0)
    }
    if ($Address.IsIPv4MappedToIPv6) { return Test-PrivateAddress $Address.MapToIPv4() }
    return ($Address.Equals([Net.IPAddress]::IPv6None)) -or
        ($Address.Equals([Net.IPAddress]::IPv6Loopback)) -or
        (($bytes[0] -band 0xfe) -eq 0xfc) -or
        ($bytes[0] -eq 0xfe -and (($bytes[1] -band 0xc0) -eq 0x80))
}

function Get-SafeRemoteUri([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https')) {
        throw 'Use an absolute http or https image URL.'
    }
    if ([string]::IsNullOrWhiteSpace($uri.Host) -or $uri.UserInfo) { throw 'The image URL host is invalid.' }
    $addresses = @([Net.Dns]::GetHostAddresses($uri.DnsSafeHost))
    if ($addresses.Count -eq 0 -or @($addresses | Where-Object { Test-PrivateAddress $_ }).Count -gt 0) {
        throw 'Local and private-network image URLs are not allowed.'
    }
    return $uri
}

function Get-ImageMime([byte[]]$Bytes) {
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xff -and $Bytes[1] -eq 0xd8 -and $Bytes[2] -eq 0xff) { return 'image/jpeg' }
    if ($Bytes.Length -ge 8 -and (@($Bytes[0..7]) -join ',') -eq '137,80,78,71,13,10,26,10') { return 'image/png' }
    if ($Bytes.Length -ge 6) {
        $start = [Text.Encoding]::ASCII.GetString($Bytes, 0, 6)
        if ($start -in @('GIF87a', 'GIF89a')) { return 'image/gif' }
    }
    if ($Bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -eq 'RIFF' -and [Text.Encoding]::ASCII.GetString($Bytes, 8, 4) -eq 'WEBP') { return 'image/webp' }
    if ($Bytes.Length -ge 16 -and [Text.Encoding]::ASCII.GetString($Bytes, 4, 4) -eq 'ftyp') {
        $box = [Text.Encoding]::ASCII.GetString($Bytes, 8, [Math]::Min(24, $Bytes.Length - 8))
        if ($box -match 'avif|avis') { return 'image/avif' }
    }
    throw 'The remote file is not a supported raster image.'
}

function Get-ImageExtension([string]$Mime) {
    switch ($Mime.ToLowerInvariant()) {
        'image/jpeg' { '.jpg' }
        'image/png' { '.png' }
        'image/webp' { '.webp' }
        'image/gif' { '.gif' }
        'image/avif' { '.avif' }
        default { throw "Unsupported image type: $Mime" }
    }
}

function Invoke-ImageDownload([string]$Url, [long]$MaximumBytes = 25MB) {
    if (-not [string]::IsNullOrWhiteSpace([string]$Script:PythonPath)) {
        $fetched = Invoke-SecureFetchBytes $Url @{
            Accept = 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.2'
            'User-Agent' = 'MarvelSnapArtDesk/2.0 (local personal review tool)'
        } $MaximumBytes
        $mime = Get-ImageMime $fetched.bytes
        return [pscustomobject]@{ bytes = $fetched.bytes; mime = $mime; final_url = $fetched.final_url }
    }
    $current = Get-SafeRemoteUri $Url
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        $request = [Net.HttpWebRequest]::Create($current)
        $request.Method = 'GET'; $request.Timeout = 20000; $request.ReadWriteTimeout = 20000
        $request.AllowAutoRedirect = $false
        $request.UserAgent = 'MarvelSnapArtDesk/2.0 (local personal review tool)'
        $request.Accept = 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.2'
        $response = $request.GetResponse()
        try {
            $status = [int]$response.StatusCode
            if ($status -ge 300 -and $status -lt 400) {
                if ($redirect -eq 5 -or [string]::IsNullOrWhiteSpace([string]$response.Headers['Location'])) { throw 'The image URL redirected too many times.' }
                $current = Get-SafeRemoteUri ([Uri]::new($current, [string]$response.Headers['Location']).AbsoluteUri)
                continue
            }
            if ($status -lt 200 -or $status -ge 300) { throw "The image server returned HTTP $status." }
            if ($response.ContentLength -gt $MaximumBytes) { throw "The image is larger than $([Math]::Round($MaximumBytes / 1MB)) MB." }
            $input = $response.GetResponseStream(); $memory = [IO.MemoryStream]::new()
            try {
                $buffer = [byte[]]::new(81920)
                while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $memory.Write($buffer, 0, $read)
                    if ($memory.Length -gt $MaximumBytes) { throw "The image is larger than $([Math]::Round($MaximumBytes / 1MB)) MB." }
                }
                $bytes = $memory.ToArray()
            } finally { $memory.Dispose(); $input.Dispose() }
            $mime = Get-ImageMime $bytes
            return [pscustomobject]@{ bytes = $bytes; mime = $mime; final_url = $current.AbsoluteUri }
        } finally { $response.Close() }
    }
    throw 'The image could not be downloaded.'
}

function Get-PropertyValue($Object, [string[]]$Paths) {
    foreach ($path in $Paths) {
        $value = $Object
        foreach ($segment in ($path -split '\.')) {
            if ($null -eq $value) { break }
            $property = $value.PSObject.Properties[$segment]
            if ($null -eq $property) { $value = $null; break }
            $value = $property.Value
        }
        if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) { return $value }
    }
    return $null
}

function Get-CalibrationSession {
    if (-not (Test-Path -LiteralPath $CalibrationPath)) {
        $created = [pscustomobject]@{
            version = 1; session_id = [Guid]::NewGuid().ToString('N'); target_count = $Script:QueueIds.Count
            started_at = [DateTime]::UtcNow.ToString('o'); updated_at = [DateTime]::UtcNow.ToString('o')
            cards = [pscustomobject]@{}
        }
        Save-JsonAtomic $CalibrationPath $created 30
        return $created
    }
    try { $session = Get-Content -LiteralPath $CalibrationPath -Raw | ConvertFrom-Json }
    catch { throw 'The local calibration session is not valid JSON.' }
    if ($null -eq $session.cards) { $session | Add-Member -Force NoteProperty cards ([pscustomobject]@{}) }
    $session.version = 1; $session.target_count = $Script:QueueIds.Count
    return $session
}

function Save-CalibrationSession($Session) {
    $Session.version = 1; $Session.target_count = $Script:QueueIds.Count; $Session.updated_at = [DateTime]::UtcNow.ToString('o')
    Save-JsonAtomic $CalibrationPath $Session 30
}

function Get-CalibrationCard($Session, [string]$CardId) {
    $property = $Session.cards.PSObject.Properties[$CardId]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function New-CalibrationCard([string]$CardId) {
    return [pscustomobject]@{
        card_id = $CardId; analysis_count = 0; baseline_crop = $null; baseline_confidence = $null
        confidence_band = 'unknown'; latest_analysis = $null; fallback = $false; providers = @()
        final_crop = $null; status = 'unreviewed'; candidate_count = 0; provider_failures = 0
        first_analyzed_at = $null; last_analyzed_at = $null; decided_at = $null; search_updated_at = $null
    }
}

function Set-CalibrationCard($Session, [string]$CardId, $Card) {
    $Session.cards | Add-Member -Force -NotePropertyName $CardId -NotePropertyValue $Card
}

function Get-ConfidenceBand($Confidence) {
    $value = 0.0
    if (-not [double]::TryParse([string]$Confidence, [ref]$value)) { return 'unknown' }
    if ($value -ge 0.78) { return 'high' }
    if ($value -ge 0.55) { return 'medium' }
    return 'low'
}

function Record-CalibrationAnalysis([string]$CardId, $Crop, $Analysis) {
    $session = Get-CalibrationSession; $card = Get-CalibrationCard $session $CardId
    if ($null -eq $card) { $card = New-CalibrationCard $CardId }
    $now = [DateTime]::UtcNow.ToString('o')
    $confidence = Get-PropertyValue $Analysis @('solution.confidence', 'confidence')
    if ($null -eq $confidence) { $confidence = Get-PropertyValue $Crop @('confidence') }
    $baselineVersion = Get-PropertyValue $card.baseline_crop @('analysis_version')
    $newVersion = Get-PropertyValue $Crop @('analysis_version')
    $replaceUnreviewedBaseline = [string]$card.status -in @('unreviewed', 'selected') -and $null -ne $newVersion -and [string]$baselineVersion -ne [string]$newVersion
    if ($null -eq $card.baseline_crop -or $replaceUnreviewedBaseline) {
        $card.baseline_crop = $Crop; $card.baseline_confidence = $confidence
        $card.confidence_band = Get-ConfidenceBand $confidence; $card.first_analyzed_at = $now
    }
    $card.analysis_count = [int]$card.analysis_count + 1; $card.latest_analysis = $Analysis; $card.last_analyzed_at = $now
    $fallbackValue = Get-PropertyValue $Analysis @('fallback')
    $card.fallback = [bool]$fallbackValue; $providers = Get-PropertyValue $Analysis @('providers')
    $card.providers = if ($null -eq $providers) { @() } else { @($providers) }
    Set-CalibrationCard $session $CardId $card; Save-CalibrationSession $session
    return $session
}

function Record-CalibrationDecision([string]$CardId, [string]$Status, $Crop, $Analysis) {
    $session = Get-CalibrationSession; $card = Get-CalibrationCard $session $CardId
    if ($null -eq $card) { $card = New-CalibrationCard $CardId }
    $card.status = $Status; $card.final_crop = $Crop; $card.decided_at = [DateTime]::UtcNow.ToString('o')
    if ($null -ne $Analysis) { $card.latest_analysis = $Analysis }
    Set-CalibrationCard $session $CardId $card; Save-CalibrationSession $session
    return $session
}

function Record-CalibrationSearch([string]$CardId, [int]$CandidateCount, [bool]$Failed) {
    $session = Get-CalibrationSession; $card = Get-CalibrationCard $session $CardId
    if ($null -eq $card) { $card = New-CalibrationCard $CardId }
    if ($Failed) { $card.provider_failures = [int]$card.provider_failures + 1 }
    else { $card.candidate_count = $CandidateCount }
    $card.search_updated_at = [DateTime]::UtcNow.ToString('o')
    Set-CalibrationCard $session $CardId $card; Save-CalibrationSession $session
    return $session
}

function Get-CandidateInventory {
    $inventory = [pscustomobject]@{}
    foreach ($cardId in @($Script:QueueIds.Keys)) {
        $set = Get-CandidateSet ([string]$cardId)
        if (@($set.candidates).Count -gt 0) {
            $inventory | Add-Member -Force NoteProperty ([string]$cardId) ([pscustomobject]@{
                count = @($set.candidates).Count; query = [string]$set.query; updated_at = $set.updated_at
            })
        }
    }
    return $inventory
}

function Get-CropDeltaData($Baseline, $Final) {
    if ($null -eq $Baseline -or $null -eq $Final) { return $null }
    $baseScale = [Math]::Max(0.01, [double](Get-PropertyValue $Baseline @('scale')))
    $finalScale = [Math]::Max(0.01, [double](Get-PropertyValue $Final @('scale')))
    $panX = [double](Get-PropertyValue $Final @('pan_x')) - [double](Get-PropertyValue $Baseline @('pan_x'))
    $panY = [double](Get-PropertyValue $Final @('pan_y')) - [double](Get-PropertyValue $Baseline @('pan_y'))
    $scalePercent = [Math]::Abs($finalScale / $baseScale - 1) * 100
    $panDistance = [Math]::Sqrt($panX * $panX + $panY * $panY)
    return [pscustomobject]@{
        scale_percent = [Math]::Round($scalePercent, 3); pan_distance = [Math]::Round($panDistance, 3)
        score = [Math]::Round($scalePercent + $panDistance * 0.5, 3)
    }
}

function Get-CalibrationOutcome($Card) {
    if ($null -eq $Card -or [string]$Card.status -notin @('approved', 'needs_review', 'skipped')) { return 'unreviewed' }
    if ([string]$Card.status -eq 'skipped') { return 'skipped' }
    $delta = Get-CropDeltaData $Card.baseline_crop $Card.final_crop
    if ($null -eq $delta) { if ([string]$Card.status -eq 'needs_review') { return 'needs_review' }; return 'unknown' }
    if ([string]$Card.status -eq 'needs_review') { return 'needs_review' }
    $manual = [bool](Get-PropertyValue $Card.final_crop @('manual_revision'))
    if ([string]$Card.confidence_band -ne 'low' -and [string]$Card.confidence_band -ne 'unknown' -and -not $manual -and $delta.score -le 0.5) { return 'zero_touch' }
    if ($delta.score -le 12) { return 'minor_adjustment' }
    return 'major_adjustment'
}

function Get-CalibrationReport {
    $session = Get-CalibrationSession; $rows = [Collections.Generic.List[object]]::new()
    foreach ($item in $queue) {
        $cardId = [string]$item.id; $card = Get-CalibrationCard $session $cardId
        if ($null -eq $card) { $card = New-CalibrationCard $cardId }
        $delta = Get-CropDeltaData $card.baseline_crop $card.final_crop
        $rows.Add([pscustomobject]@{
            card_id = $cardId; status = [string]$card.status; confidence_band = [string]$card.confidence_band
            outcome = Get-CalibrationOutcome $card; fallback = [bool]$card.fallback
            delta_score = if ($delta) { $delta.score } else { $null }
            scale_percent = if ($delta) { $delta.scale_percent } else { $null }
            pan_distance = if ($delta) { $delta.pan_distance } else { $null }
            critical_retained = Get-PropertyValue $card.latest_analysis @('solution.evaluation.critical_retained')
            critical_occlusion = Get-PropertyValue $card.latest_analysis @('solution.evaluation.critical_occlusion')
            candidate_count = [int]$card.candidate_count; provider_failures = [int]$card.provider_failures
        })
    }
    $rowArray = @($rows); $reviewed = @($rowArray | Where-Object { $_.outcome -ne 'unreviewed' })
    $eligible = @($reviewed | Where-Object { $_.confidence_band -notin @('low', 'unknown') -and $_.outcome -in @('zero_touch', 'minor_adjustment', 'major_adjustment') })
    $analyzed = @($rowArray | Where-Object { $_.confidence_band -ne 'unknown' })
    $zeroTouch = @($eligible | Where-Object { $_.outcome -eq 'zero_touch' }).Count
    $fallbackCount = @($analyzed | Where-Object { $_.fallback }).Count
    return [pscustomobject]@{
        generated_at = [DateTime]::UtcNow.ToString('o'); session = $session
        metrics = [pscustomobject]@{
            target_count = $rowArray.Count; reviewed_count = $reviewed.Count; analyzed_count = $analyzed.Count
            zero_touch_rate = if ($eligible.Count) { [Math]::Round($zeroTouch / $eligible.Count, 4) } else { $null }
            fallback_rate = if ($analyzed.Count) { [Math]::Round($fallbackCount / $analyzed.Count, 4) } else { $null }
        }
        rows = $rowArray
    }
}

function ConvertFrom-BraveImageResults($Response) {
    $results = @($Response.results)
    $normalized = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $results.Count; $index++) {
        $item = $results[$index]
        $original = [string](Get-PropertyValue $item @('properties.url', 'original', 'image_url'))
        $sourcePage = [string](Get-PropertyValue $item @('url', 'source', 'source_url'))
        $thumbnail = [string](Get-PropertyValue $item @('thumbnail.src', 'thumbnail.url', 'thumbnail'))
        if ([string]::IsNullOrWhiteSpace($original)) { continue }
        if ([string]::IsNullOrWhiteSpace($thumbnail)) { $thumbnail = $original }
        if ([string]::IsNullOrWhiteSpace($sourcePage)) { $sourcePage = $original }
        if ($original -notmatch '^https?://' -or $thumbnail -notmatch '^https?://') { continue }
        $widthValue = Get-PropertyValue $item @('properties.width', 'width')
        $heightValue = Get-PropertyValue $item @('properties.height', 'height')
        $width = 0; $height = 0
        [int]::TryParse([string]$widthValue, [ref]$width) | Out-Null
        [int]::TryParse([string]$heightValue, [ref]$height) | Out-Null
        $normalized.Add([pscustomobject]@{
            id = Get-StableId $original; title = [string](Get-PropertyValue $item @('title'))
            original_url = $original; thumbnail_url = $thumbnail; source_page_url = $sourcePage
            width = $width; height = $height; provider = 'brave-images-v1'; provider_rank = $index + 1
        })
    }
    return @($normalized)
}

function Invoke-BraveImageSearch([string]$Query, [int]$Count) {
    $mock = [string]$env:ART_DESK_MOCK_SEARCH_RESPONSE
    if (-not [string]::IsNullOrWhiteSpace($mock)) {
        if (-not (Test-Path -LiteralPath $mock)) { throw 'Configured mock search response is missing.' }
        return Get-Content -LiteralPath $mock -Raw | ConvertFrom-Json
    }
    $key = Get-BraveApiKey
    if ([string]::IsNullOrWhiteSpace($key)) { throw 'Configure a Brave Image Search API key first.' }
    $encoded = [Uri]::EscapeDataString($Query)
    $uri = "https://api.search.brave.com/res/v1/images/search?q=$encoded&count=$Count&safesearch=strict&country=US&search_lang=en"
    if (-not [string]::IsNullOrWhiteSpace([string]$Script:PythonPath)) {
        $fetched = Invoke-SecureFetchBytes $uri @{ Accept = 'application/json'; 'X-Subscription-Token' = $key; 'User-Agent' = 'MarvelSnapArtDesk/2.0' } 8MB
        return [Text.Encoding]::UTF8.GetString($fetched.bytes) | ConvertFrom-Json
    }
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Method = 'GET'; $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
    $request.UserAgent = 'MarvelSnapArtDesk/2.0'; $request.Accept = 'application/json'
    $request.Headers.Add('X-Subscription-Token', $key)
    $response = $request.GetResponse()
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
        try { return $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
    } finally { $response.Close() }
}

function Read-HttpRequest($Stream) {
    $header = [Collections.Generic.List[byte]]::new(); $tail = [Collections.Generic.Queue[byte]]::new()
    while ($true) {
        $next = $Stream.ReadByte(); if ($next -lt 0) { throw 'Connection closed before request headers.' }
        $byte = [byte]$next; $header.Add($byte); $tail.Enqueue($byte)
        if ($tail.Count -gt 4) { $tail.Dequeue() | Out-Null }
        if ($tail.Count -eq 4 -and (@($tail) -join ',') -eq '13,10,13,10') { break }
        if ($header.Count -gt 65536) { throw 'Request headers were too large.' }
    }
    $lines = [Text.Encoding]::ASCII.GetString($header.ToArray()) -split "`r`n"; $requestLine = $lines[0] -split ' '
    if ($requestLine.Count -lt 2) { throw 'Malformed HTTP request line.' }
    $headers = @{}
    foreach ($line in $lines | Select-Object -Skip 1) {
        $separator = $line.IndexOf(':')
        if ($separator -gt 0) { $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim() }
    }
    $contentLength = if ($headers.ContainsKey('content-length')) { [int]$headers['content-length'] } else { 0 }
    if ($contentLength -gt 40MB) { throw 'Request body is too large.' }
    $body = [byte[]]::new($contentLength); $offset = 0
    while ($offset -lt $contentLength) {
        $read = $Stream.Read($body, $offset, $contentLength - $offset); if ($read -le 0) { throw 'Connection closed before request body.' }; $offset += $read
    }
    return [pscustomobject]@{
        Method = $requestLine[0].ToUpperInvariant(); Path = [Uri]::UnescapeDataString(([string]$requestLine[1] -split '\?')[0])
        Headers = $headers; Body = $body
    }
}

function Write-Response($Stream, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes) {
    $reason = switch ($StatusCode) {
        200 { 'OK' } 400 { 'Bad Request' } 404 { 'Not Found' } 409 { 'Conflict' }
        413 { 'Payload Too Large' } 424 { 'Failed Dependency' } 429 { 'Too Many Requests' }
        500 { 'Internal Server Error' } default { 'Error' }
    }
    $header = "HTTP/1.1 $StatusCode $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Bytes.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header); $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush()
}

function Write-Json($Stream, $Value, [int]$StatusCode = 200) {
    $json = ConvertTo-Json -InputObject $Value -Depth 24 -Compress
    Write-Response $Stream $StatusCode 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($json))
}

function Write-Download($Stream, [string]$ContentType, [string]$Filename, [byte[]]$Bytes) {
    $header = "HTTP/1.1 200 OK`r`nContent-Type: $ContentType`r`nContent-Disposition: attachment; filename=`"$Filename`"`r`nContent-Length: $($Bytes.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header); $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush()
}

function Write-Text($Stream, [int]$StatusCode, [string]$Text) {
    Write-Response $Stream $StatusCode 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($Text))
}

function Read-JsonBody($Request) {
    $body = [Text.Encoding]::UTF8.GetString($Request.Body)
    if ([string]::IsNullOrWhiteSpace($body)) { throw 'Request body was empty.' }
    return $body | ConvertFrom-Json
}

function Get-StaticContentType([string]$Path) {
    switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        '.js' { 'text/javascript; charset=utf-8' } '.mjs' { 'text/javascript; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' } '.wasm' { 'application/wasm' }
        default { 'application/octet-stream' }
    }
}

Ensure-Directory $DataDir
Ensure-Directory $AssetsDir
Ensure-Directory $OverlayDir
Ensure-Directory $CandidateDataDir
Ensure-Directory $CandidateCacheDir
$Script:PythonPath = Find-PythonRuntime
$queue = @(Get-TestQueue | ForEach-Object { $_ })
foreach ($item in $queue) { $Script:QueueIds[[string]$item.id] = $true }
$template = Get-TemplateSize

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host ''
Write-Host "Art Desk 2 is running at http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host "$($queue.Count)-card real-PSD review queue; Ctrl+C stops the server."
Write-Host "HTTPS backend: $(if ($Script:PythonPath) { 'Python/OpenSSL' } else { 'Windows native' })"

try {
    while ($true) {
        $client = $listener.AcceptTcpClient(); $client.ReceiveTimeout = 2500; $client.SendTimeout = 10000; $stream = $client.GetStream()
        try {
            $request = Read-HttpRequest $stream; $path = $request.Path

            if ($request.Method -eq 'GET' -and $path -eq '/') {
                Write-Response $stream 200 'text/html; charset=utf-8' ([IO.File]::ReadAllBytes($HtmlPath)); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/static/')) {
                $relative = $path.Substring(8)
                if ($relative -notmatch '^[A-Za-z0-9/_.-]+\.(js|mjs|css|wasm)$') { throw 'Invalid static asset request.' }
                $file = [IO.Path]::GetFullPath((Join-Path $StaticDir ($relative -replace '/', '\')))
                $staticRoot = [IO.Path]::GetFullPath($StaticDir).TrimEnd('\') + '\'
                if (-not $file.StartsWith($staticRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid static asset path.' }
                if (Test-Path -LiteralPath $file) {
                    $bytes = [IO.File]::ReadAllBytes($file)
                } elseif (Test-Path -LiteralPath "$file.gz") {
                    $bytes = Read-GzipBytes "$file.gz"
                } else {
                    Write-Text $stream 404 'Static asset is missing.'; continue
                }
                Write-Response $stream 200 (Get-StaticContentType $file) $bytes; continue
            }
            if ($request.Method -eq 'GET' -and $path -eq '/render-real-psd-overlays') {
                Write-Response $stream 200 'text/html; charset=utf-8' ([IO.File]::ReadAllBytes($RendererPath)); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/font/')) {
                $fontName = $path.Substring(6); if ($fontName -notmatch '^[A-Za-z0-9 ._-]+\.(otf|ttf)$') { throw 'Invalid font request.' }
                $fontPath = Join-Path $FontsDir $fontName
                if (-not (Test-Path -LiteralPath $fontPath)) { Write-Text $stream 404 'Font is missing.'; continue }
                $contentType = if ($fontName.ToLowerInvariant().EndsWith('.otf')) { 'font/otf' } else { 'font/ttf' }
                Write-Response $stream 200 $contentType ([IO.File]::ReadAllBytes($fontPath)); continue
            }
            if ($request.Method -eq 'GET' -and $path -eq '/api/bootstrap') {
                $state = Get-State
                $searchConfigured = -not [string]::IsNullOrWhiteSpace((Get-BraveApiKey)) -or -not [string]::IsNullOrWhiteSpace([string]$env:ART_DESK_MOCK_SEARCH_RESPONSE)
                Write-Json $stream ([pscustomobject]@{
                    queue = $queue; state = $state.cards; template = $template
                    calibration = Get-CalibrationSession; candidate_inventory = Get-CandidateInventory
                    duplicate_art = Get-DuplicateArtConflicts $state
                    queue_kind = 'Art Desk 2 - randomized real generated-PSD calibration queue'
                    capabilities = [pscustomobject]@{
                        analysis_version = 4; framing_profile = 'snap-extended-v1'; extended_background = $true; advanced_ai = $true; search_configured = $searchConfigured
                        search_provider = 'brave-images-v1'; https_backend = if ($Script:PythonPath) { 'python-openssl' } else { 'windows-native' }
                    }
                }); continue
            }
            if ($request.Method -eq 'GET' -and $path -eq '/api/calibration-report.json') {
                $json = ConvertTo-Json -InputObject (Get-CalibrationReport) -Depth 30
                Write-Download $stream 'application/json; charset=utf-8' 'art-desk-calibration.json' ([Text.Encoding]::UTF8.GetBytes($json)); continue
            }
            if ($request.Method -eq 'GET' -and $path -eq '/api/calibration-report.csv') {
                $report = Get-CalibrationReport
                $csv = @($report.rows | ConvertTo-Csv -NoTypeInformation) -join "`r`n"
                Write-Download $stream 'text/csv; charset=utf-8' 'art-desk-calibration.csv' ([Text.Encoding]::UTF8.GetBytes("$csv`r`n")); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/psd/')) {
                $cardId = $path.Substring(5); Assert-CardId $cardId; $psdPath = Join-Path $CardPsdDir "$cardId.psd"
                if (-not (Test-Path -LiteralPath $psdPath)) { Write-Text $stream 404 'Generated PSD is missing.'; continue }
                Write-Response $stream 200 'image/vnd.adobe.photoshop' ([IO.File]::ReadAllBytes($psdPath)); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/save-template-overlay') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId
                $match = [regex]::Match([string]$payload.image_data_url, '^data:image/png;base64,([A-Za-z0-9+/=\r\n]+)$')
                if (-not $match.Success) { throw 'Template overlay must be a PNG data URL.' }
                $bytes = [Convert]::FromBase64String($match.Groups[1].Value); if ($bytes.Length -gt 12MB) { throw 'Template overlay was unexpectedly large.' }
                Save-BytesAtomic (Join-Path $OverlayDir "$cardId.png") $bytes
                Write-Json $stream ([pscustomobject]@{ ok = $true; overlay_url = "/template-overlay/$cardId" }); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/template-overlay/')) {
                $cardId = $path.Substring(18); Assert-CardId $cardId; $overlayPath = Join-Path $OverlayDir "$cardId.png"
                if (-not (Test-Path -LiteralPath $overlayPath)) { Write-Text $stream 404 'Template overlay has not been rendered yet.'; continue }
                Write-Response $stream 200 'image/png' ([IO.File]::ReadAllBytes($overlayPath)); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/settings/search') {
                $payload = Read-JsonBody $request; $key = ([string]$payload.brave_api_key).Trim()
                if ($key.Length -lt 10 -or $key.Length -gt 512) { throw 'The Brave Search API key format is invalid.' }
                Save-JsonAtomic $SettingsPath ([pscustomobject]@{ brave_api_key = $key; updated_at = [DateTime]::UtcNow.ToString('o') }) 4
                Write-Json $stream ([pscustomobject]@{ ok = $true; search_configured = $true }); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/search-candidates') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId
                $query = ([string]$payload.query).Trim(); if ($query.Length -lt 2 -or $query.Length -gt 400) { throw 'Search query must be between 2 and 400 characters.' }
                $count = [int]$payload.count; if ($count -lt 1) { $count = 1 }; if ($count -gt 200) { $count = 200 }
                try { $response = Invoke-BraveImageSearch $query $count; $candidates = @(ConvertFrom-BraveImageResults $response | Select-Object -First $count) }
                catch { Record-CalibrationSearch $cardId 0 $true | Out-Null; throw }
                $set = [pscustomobject]@{ version = 1; card_id = $cardId; query = $query; updated_at = [DateTime]::UtcNow.ToString('o'); candidates = $candidates }
                Save-JsonAtomic (Get-CandidateFile $cardId) $set 12
                $calibration = Record-CalibrationSearch $cardId @($candidates).Count $false
                Write-Json $stream ([pscustomobject]@{ ok = $true; candidates = $candidates; query = $query; calibration = $calibration }); continue
            }
            if ($request.Method -eq 'GET' -and $path -eq '/api/calibration') {
                Write-Json $stream ([pscustomobject]@{ ok = $true; calibration = Get-CalibrationSession; candidate_inventory = Get-CandidateInventory }); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/api/candidates/')) {
                $cardId = $path.Substring(16); $set = Get-CandidateSet $cardId
                Write-Json $stream ([pscustomobject]@{ ok = $true; candidates = @($set.candidates); query = [string]$set.query; updated_at = $set.updated_at }); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/candidate-thumb/')) {
                $parts = @($path.Substring(17) -split '/'); if ($parts.Count -ne 2) { throw 'Invalid candidate thumbnail request.' }
                $cardId = $parts[0]; $candidateId = $parts[1]; Assert-CardId $cardId; $candidate = Get-Candidate $cardId $candidateId
                $cacheDir = Join-Path $CandidateCacheDir $cardId; Ensure-Directory $cacheDir
                $cachePath = Join-Path $cacheDir "$candidateId.bin"; $mimePath = Join-Path $cacheDir "$candidateId.mime"
                if (-not (Test-Path -LiteralPath $cachePath) -or -not (Test-Path -LiteralPath $mimePath)) {
                    $download = Invoke-ImageDownload ([string]$candidate.thumbnail_url) 8MB; Save-BytesAtomic $cachePath $download.bytes
                    [IO.File]::WriteAllText($mimePath, $download.mime, [Text.UTF8Encoding]::new($false))
                }
                Write-Response $stream 200 ([IO.File]::ReadAllText($mimePath).Trim()) ([IO.File]::ReadAllBytes($cachePath)); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/select-candidate') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId
                $candidate = Get-Candidate $cardId ([string]$payload.candidate_id); $download = Invoke-ImageDownload ([string]$candidate.original_url) 25MB
                $state = Get-State; $existing = Get-CardRecord $state $cardId
                Assert-UniqueArtwork $state $cardId $download.bytes
                $filename = "$cardId-$($candidate.id)$(Get-ImageExtension $download.mime)"; Save-BytesAtomic (Join-Path $AssetsDir $filename) $download.bytes
                $record = [pscustomobject]@{
                    status = 'selected'; source_kind = 'art_scout'; source_url = [string]$candidate.source_page_url
                    image_filename = $filename; image_sha256 = Get-BytesSha256 $download.bytes; candidate_id = [string]$candidate.id; crop = New-DefaultCrop
                    analysis = $null; note = if ($existing) { [string]$existing.note } else { '' }; updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record; Save-State $state
                Write-Json $stream ([pscustomobject]@{ ok = $true; asset_url = "/art/$cardId"; record = $record }); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/analysis') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId
                $state = Get-State; $existing = Get-CardRecord $state $cardId
                if ($null -eq $existing -or [string]::IsNullOrWhiteSpace([string]$existing.image_filename)) { throw 'Select artwork before saving its analysis.' }
                $record = [pscustomobject]@{
                    status = 'selected'; source_kind = [string]$existing.source_kind; source_url = [string]$existing.source_url
                    image_filename = [string]$existing.image_filename; image_sha256 = [string]$existing.image_sha256; candidate_id = [string]$existing.candidate_id
                    crop = $payload.crop; analysis = $payload.analysis; note = [string]$existing.note; updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record; Save-State $state
                $calibration = Record-CalibrationAnalysis $cardId $payload.crop $payload.analysis
                Write-Json $stream ([pscustomobject]@{ ok = $true; record = $record; calibration = $calibration }); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/decision') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId; $status = [string]$payload.status
                if ($status -notin @('approved', 'skipped', 'needs_review', 'selected')) { throw "Invalid card status: $status" }
                $state = Get-State; $existing = Get-CardRecord $state $cardId; $isSkip = $status -eq 'skipped'
                if ($status -eq 'approved' -and ($null -eq $existing -or [string]::IsNullOrWhiteSpace([string]$existing.image_filename))) { throw 'Choose artwork before approving.' }
                $record = [pscustomobject]@{
                    status = $status; source_kind = if ($isSkip) { '' } else { [string]$payload.source_kind }
                    source_url = if ($isSkip) { '' } else { [string]$payload.source_url }
                    image_filename = if ($isSkip) { '' } elseif ($existing) { [string]$existing.image_filename } else { '' }
                    image_sha256 = if ($isSkip) { '' } elseif ($existing) { [string]$existing.image_sha256 } else { '' }
                    candidate_id = if ($isSkip) { '' } else { [string]$payload.candidate_id }
                    crop = if ($isSkip) { New-DefaultCrop } else { $payload.crop }; analysis = if ($isSkip) { $null } else { $payload.analysis }
                    note = [string]$payload.note; updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record; Save-State $state
                $calibration = Record-CalibrationDecision $cardId $status $record.crop $record.analysis
                Write-Json $stream ([pscustomobject]@{ ok = $true; record = $record; calibration = $calibration }); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/upload-image') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId
                $match = [regex]::Match([string]$payload.image_data_url, '^data:(image/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/=\r\n]+)$')
                if (-not $match.Success) { throw 'Upload must be a PNG, JPEG, WebP, GIF, or AVIF data URL.' }
                $bytes = [Convert]::FromBase64String($match.Groups[2].Value); if ($bytes.Length -gt 25MB) { throw 'Images must be 25 MB or smaller.' }
                $state = Get-State; $existing = Get-CardRecord $state $cardId
                Assert-UniqueArtwork $state $cardId $bytes
                $detected = Get-ImageMime $bytes; $filename = "$cardId$(Get-ImageExtension $detected)"; Save-BytesAtomic (Join-Path $AssetsDir $filename) $bytes
                $record = [pscustomobject]@{
                    status = 'selected'; source_kind = [string]$payload.source_kind; source_url = [string]$payload.source_url
                    image_filename = $filename; image_sha256 = Get-BytesSha256 $bytes; candidate_id = ''; crop = New-DefaultCrop; analysis = $null
                    note = if ($existing) { [string]$existing.note } else { '' }; updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record; Save-State $state
                Write-Json $stream ([pscustomobject]@{ ok = $true; asset_url = "/art/$cardId"; record = $record }); continue
            }
            if ($request.Method -eq 'POST' -and $path -eq '/api/import-url') {
                $payload = Read-JsonBody $request; $cardId = [string]$payload.card_id; Assert-CardId $cardId
                $download = Invoke-ImageDownload ([string]$payload.image_url) 25MB
                $state = Get-State; $existing = Get-CardRecord $state $cardId
                Assert-UniqueArtwork $state $cardId $download.bytes
                $filename = "$cardId$(Get-ImageExtension $download.mime)"; Save-BytesAtomic (Join-Path $AssetsDir $filename) $download.bytes
                $record = [pscustomobject]@{
                    status = 'selected'; source_kind = 'direct_url'; source_url = [string]$payload.source_url
                    image_filename = $filename; image_sha256 = Get-BytesSha256 $download.bytes; candidate_id = ''; crop = New-DefaultCrop; analysis = $null
                    note = if ($existing) { [string]$existing.note } else { '' }; updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record; Save-State $state
                Write-Json $stream ([pscustomobject]@{ ok = $true; asset_url = "/art/$cardId"; record = $record }); continue
            }
            if ($request.Method -eq 'GET' -and $path.StartsWith('/art/')) {
                $cardId = $path.Substring(5); Assert-CardId $cardId; $state = Get-State; $record = Get-CardRecord $state $cardId
                if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.image_filename)) { Write-Text $stream 404 'No saved art for this card.'; continue }
                $assetPath = [IO.Path]::GetFullPath((Join-Path $AssetsDir ([string]$record.image_filename))); $assetRoot = [IO.Path]::GetFullPath($AssetsDir).TrimEnd('\') + '\'
                if (-not $assetPath.StartsWith($assetRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $assetPath)) { Write-Text $stream 404 'Saved asset is missing from disk.'; continue }
                $bytes = [IO.File]::ReadAllBytes($assetPath); Write-Response $stream 200 (Get-ImageMime $bytes) $bytes; continue
            }

            Write-Text $stream 404 'Not found.'
        } catch {
            $message = $_.Exception.Message
            $statusCode = if ($message -match '(?i)\b429\b|rate.?limit|too many requests') { 429 } elseif ($message -match '(?i)\b50[0234]\b|temporar|timeout') { 500 } else { 400 }
            try { Write-Json $stream ([pscustomobject]@{ ok = $false; error = $message }) $statusCode } catch {}
        } finally { $stream.Dispose(); $client.Close() }
    }
} finally { $listener.Stop() }
