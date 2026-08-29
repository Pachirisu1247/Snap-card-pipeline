<#
Starts the Phase 1 Art Intake and Placement Studio at http://127.0.0.1:5010.

This is deliberately dependency-free: Windows PowerShell hosts the local app,
so the first review workflow can be tested before installing Photoshop or any
machine-learning packages.
#>
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 5010
)

$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSCommandPath
$ProjectRoot = Split-Path -Parent $AppRoot
$CardsCsv = Join-Path $ProjectRoot 'photopea_batch\snap_cards.msz_latest.csv'
$TemplatePsd = Join-Path $ProjectRoot 'photopea_batch\AgathaNew.psd'
$CardPsdDir = Join-Path $ProjectRoot 'photopea_batch\output_psd_calibrated_logo'
$FontsDir = Join-Path $ProjectRoot 'Fonts'
$HtmlPath = Join-Path $AppRoot 'art_desk.html'
$RendererPath = Join-Path $AppRoot 'render_real_psd_overlays.html'
$DataDir = Join-Path $AppRoot 'data'
$AssetsDir = Join-Path $AppRoot 'assets\original'
$OverlayDir = Join-Path $AppRoot 'assets\template_overlays'
$StatePath = Join-Path $DataDir 'state.json'
$QueuePath = Join-Path $DataDir 'real_psd_test_queue.json'

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-TemplateSize {
    if (-not (Test-Path -LiteralPath $TemplatePsd)) {
        return [pscustomobject]@{ width = 1700; height = 2400; source = 'fallback' }
    }

    # PSD header: signature (4), version (2), reserved (6), channels (2),
    # height (4), width (4). We only need the document aspect ratio here.
    $bytes = [System.IO.File]::ReadAllBytes($TemplatePsd)
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
    if (-not (Test-Path -LiteralPath $CardsCsv)) {
        throw "Card CSV not found: $CardsCsv"
    }

    if (-not (Test-Path -LiteralPath $CardPsdDir)) {
        throw "Generated PSD directory not found: $CardPsdDir"
    }

    # Only use cards with an actual completed PSD in the repository. The Art
    # Desk preview must never fall back to a fabricated CSS version of a card.
    $cards = @(Import-Csv -LiteralPath $CardsCsv)
    $cardById = @{}
    foreach ($card in $cards) { $cardById[[string]$card.id] = $card }
    $cards = @(Get-ChildItem -LiteralPath $CardPsdDir -Filter '*.psd' | ForEach-Object {
        if ($cardById.ContainsKey($_.BaseName)) { $cardById[$_.BaseName] }
    })
    if ($cards.Count -lt 48) { throw "Expected at least 48 mapped generated PSDs, found $($cards.Count)." }

    # Stable randomized 48-card sample, drawn only from the completed PSD set.
    $random = [System.Random]::new(20260803)
    for ($i = $cards.Count - 1; $i -gt 0; $i--) {
        $j = $random.Next($i + 1)
        $swap = $cards[$i]
        $cards[$i] = $cards[$j]
        $cards[$j] = $swap
    }
    $queue = @($cards | Select-Object -First 48 | ForEach-Object {
        [pscustomobject]@{
            id = $_.id
            cost = [string]$_.cost
            power = [string]$_.power
            rules = [string]$_.rules
        }
    })
    $queue | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $QueuePath -Encoding UTF8
    return $queue
}

function Get-State {
    if (-not (Test-Path -LiteralPath $StatePath)) {
        return [pscustomobject]@{ version = 1; cards = [pscustomobject]@{} }
    }
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($null -eq $state.cards) {
        $state | Add-Member -Force -NotePropertyName cards -NotePropertyValue ([pscustomobject]@{})
    }
    return $state
}

function Save-State($State) {
    $State | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Read-HttpRequest($Stream) {
    # HttpListener is unavailable in the sandboxed PowerShell host. This tiny
    # loopback-only HTTP reader gives Phase 1 a zero-dependency local server.
    $header = [System.Collections.Generic.List[byte]]::new()
    $tail = [System.Collections.Generic.Queue[byte]]::new()
    while ($true) {
        $next = $Stream.ReadByte()
        if ($next -lt 0) { throw 'Connection closed before request headers.' }
        $byte = [byte]$next
        $header.Add($byte)
        $tail.Enqueue($byte)
        if ($tail.Count -gt 4) { $tail.Dequeue() | Out-Null }
        if ($tail.Count -eq 4 -and (@($tail) -join ',') -eq '13,10,13,10') { break }
        if ($header.Count -gt 65536) { throw 'Request headers were too large.' }
    }
    $headerText = [Text.Encoding]::ASCII.GetString($header.ToArray())
    $lines = $headerText -split "`r`n"
    $requestLine = $lines[0] -split ' '
    if ($requestLine.Count -lt 2) { throw 'Malformed HTTP request line.' }
    $headers = @{}
    foreach ($line in $lines | Select-Object -Skip 1) {
        $separator = $line.IndexOf(':')
        if ($separator -gt 0) { $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim() }
    }
    $contentLength = if ($headers.ContainsKey('content-length')) { [int]$headers['content-length'] } else { 0 }
    # A 25 MB binary image becomes roughly 33 MB after browser base64 encoding.
    if ($contentLength -gt 40MB) { throw 'Request body is too large.' }
    $body = [byte[]]::new($contentLength)
    $offset = 0
    while ($offset -lt $contentLength) {
        $read = $Stream.Read($body, $offset, $contentLength - $offset)
        if ($read -le 0) { throw 'Connection closed before request body.' }
        $offset += $read
    }
    return [pscustomobject]@{ Method = $requestLine[0].ToUpperInvariant(); Path = ([Uri]::UnescapeDataString(($requestLine[1] -split '\?')[0])); Headers = $headers; Body = $body }
}

function Write-Response($Stream, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes) {
    $reason = switch ($StatusCode) { 200 { 'OK' } 400 { 'Bad Request' } 404 { 'Not Found' } default { 'Error' } }
    $header = "HTTP/1.1 $StatusCode $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Bytes.Length)`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush()
}

function Write-Json($Stream, $Value, [int]$StatusCode = 200) {
    $json = $Value | ConvertTo-Json -Depth 12 -Compress
    Write-Response $Stream $StatusCode 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($json))
}

function Write-Text($Stream, [int]$StatusCode, [string]$Text) {
    Write-Response $Stream $StatusCode 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($Text))
}

function Read-JsonBody($Request) {
    $body = [Text.Encoding]::UTF8.GetString($Request.Body)
    if ([string]::IsNullOrWhiteSpace($body)) { throw 'Request body was empty.' }
    return $body | ConvertFrom-Json
}

function Get-CardRecord($State, [string]$CardId) {
    $property = $State.cards.PSObject.Properties[$CardId]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Set-CardRecord($State, [string]$CardId, $Record) {
    $State.cards | Add-Member -Force -NotePropertyName $CardId -NotePropertyValue $Record
}

function Get-ImageExtension([string]$Mime) {
    switch ($Mime.ToLowerInvariant()) {
        'image/jpeg' { return '.jpg' }
        'image/png' { return '.png' }
        'image/webp' { return '.webp' }
        'image/gif' { return '.gif' }
        'image/avif' { return '.avif' }
        default { throw "Unsupported image type: $Mime" }
    }
}

Ensure-Directory $DataDir
Ensure-Directory $AssetsDir
Ensure-Directory $OverlayDir
$queue = Get-TestQueue
$template = Get-TemplateSize

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host ''
Write-Host "Art Desk is running at http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host "Phase 1 test queue: $($queue.Count) randomized cards"
Write-Host 'Press Ctrl+C to stop the server.'

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        # Browsers may open an idle speculative connection before sending a
        # request. Without a timeout, that one socket would freeze this small
        # single-process Phase 1 server and make localhost appear dead.
        $client.ReceiveTimeout = 2000
        $client.SendTimeout = 5000
        $stream = $client.GetStream()
        try {
            $request = Read-HttpRequest $stream
            $path = $request.Path

            if ($request.Method -eq 'GET' -and $path -eq '/') {
                Write-Response $stream 200 'text/html; charset=utf-8' ([System.IO.File]::ReadAllBytes($HtmlPath))
                continue
            }

            if ($request.Method -eq 'GET' -and $path -eq '/render-real-psd-overlays') {
                Write-Response $stream 200 'text/html; charset=utf-8' ([System.IO.File]::ReadAllBytes($RendererPath))
                continue
            }

            if ($request.Method -eq 'GET' -and $path.StartsWith('/font/')) {
                $fontName = $path.Substring(6)
                if ($fontName -notmatch '^[A-Za-z0-9 ._-]+\.(otf|ttf)$') { throw 'Invalid font request.' }
                $fontPath = Join-Path $FontsDir $fontName
                if (-not (Test-Path -LiteralPath $fontPath)) { Write-Text $stream 404 'Font is missing.'; continue }
                $contentType = if ($fontName.ToLowerInvariant().EndsWith('.otf')) { 'font/otf' } else { 'font/ttf' }
                Write-Response $stream 200 $contentType ([System.IO.File]::ReadAllBytes($fontPath))
                continue
            }

            if ($request.Method -eq 'GET' -and $path -eq '/api/bootstrap') {
                $state = Get-State
                Write-Json $stream ([pscustomobject]@{
                    queue = $queue
                    state = $state.cards
                    template = $template
                    queue_kind = 'Phase 1 randomized test queue from real generated PSDs'
                })
                continue
            }

            if ($request.Method -eq 'GET' -and $path.StartsWith('/psd/')) {
                $cardId = $path.Substring(5)
                if ($cardId -notmatch '^[a-z0-9-]+$' -or $queue.id -notcontains $cardId) { throw 'Invalid PSD request.' }
                $psdPath = Join-Path $CardPsdDir "$cardId.psd"
                if (-not (Test-Path -LiteralPath $psdPath)) { Write-Text $stream 404 'Generated PSD is missing.'; continue }
                Write-Response $stream 200 'image/vnd.adobe.photoshop' ([System.IO.File]::ReadAllBytes($psdPath))
                continue
            }

            if ($request.Method -eq 'POST' -and $path -eq '/api/save-template-overlay') {
                $payload = Read-JsonBody $request
                $cardId = [string]$payload.card_id
                if ($queue.id -notcontains $cardId) { throw "Unknown card id: $cardId" }
                $dataUrl = [string]$payload.image_data_url
                $match = [regex]::Match($dataUrl, '^data:image/png;base64,([A-Za-z0-9+/=\r\n]+)$')
                if (-not $match.Success) { throw 'Template overlay must be a PNG data URL.' }
                $bytes = [Convert]::FromBase64String($match.Groups[1].Value)
                if ($bytes.Length -gt 12MB) { throw 'Template overlay was unexpectedly large.' }
                [System.IO.File]::WriteAllBytes((Join-Path $OverlayDir "$cardId.png"), $bytes)
                Write-Json $stream ([pscustomobject]@{ ok = $true; overlay_url = "/template-overlay/$cardId" })
                continue
            }

            if ($request.Method -eq 'GET' -and $path.StartsWith('/template-overlay/')) {
                $cardId = $path.Substring(18)
                if ($cardId -notmatch '^[a-z0-9-]+$') { throw 'Invalid template overlay request.' }
                $overlayPath = Join-Path $OverlayDir "$cardId.png"
                if (-not (Test-Path -LiteralPath $overlayPath)) { Write-Text $stream 404 'Template overlay has not been rendered yet.'; continue }
                Write-Response $stream 200 'image/png' ([System.IO.File]::ReadAllBytes($overlayPath))
                continue
            }

            if ($request.Method -eq 'POST' -and $path -eq '/api/decision') {
                $payload = Read-JsonBody $request
                $cardId = [string]$payload.card_id
                if ($queue.id -notcontains $cardId) { throw "Unknown card id: $cardId" }
                $status = [string]$payload.status
                if ($status -notin @('approved', 'skipped', 'needs_review', 'selected')) {
                    throw "Invalid card status: $status"
                }

                $state = Get-State
                $existing = Get-CardRecord $state $cardId
                $isSkip = $status -eq 'skipped'
                $record = [pscustomobject]@{
                    status = $status
                    source_kind = if ($isSkip) { '' } else { [string]$payload.source_kind }
                    source_url = if ($isSkip) { '' } else { [string]$payload.source_url }
                    # Skipping means this card has no selected art. The previous
                    # downloaded file is retained locally rather than deleted.
                    image_filename = if ($isSkip) { '' } elseif ($existing) { [string]$existing.image_filename } else { '' }
                    crop = if ($isSkip) { [pscustomobject]@{ scale = 1; pan_x = 0; pan_y = 0; mode = 'manual' } } else { $payload.crop }
                    note = [string]$payload.note
                    updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record
                Save-State $state
                Write-Json $stream ([pscustomobject]@{ ok = $true; record = $record })
                continue
            }

            if ($request.Method -eq 'POST' -and $path -eq '/api/upload-image') {
                $payload = Read-JsonBody $request
                $cardId = [string]$payload.card_id
                if ($queue.id -notcontains $cardId) { throw "Unknown card id: $cardId" }
                $dataUrl = [string]$payload.image_data_url
                $match = [regex]::Match($dataUrl, '^data:(image/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/=\r\n]+)$')
                if (-not $match.Success) { throw 'Upload must be a PNG, JPEG, WebP, GIF, or AVIF data URL.' }
                $bytes = [Convert]::FromBase64String($match.Groups[2].Value)
                if ($bytes.Length -gt 25MB) { throw 'The Phase 1 uploader accepts images up to 25 MB.' }
                $mime = $match.Groups[1].Value
                $extension = Get-ImageExtension $mime
                $filename = "$cardId$extension"
                [System.IO.File]::WriteAllBytes((Join-Path $AssetsDir $filename), $bytes)

                $state = Get-State
                $existing = Get-CardRecord $state $cardId
                $record = [pscustomobject]@{
                    # Replacing art must require a fresh approval; an old approved
                    # decision must never silently bless a newly uploaded image.
                    status = 'selected'
                    source_kind = [string]$payload.source_kind
                    source_url = [string]$payload.source_url
                    image_filename = $filename
                    crop = if ($existing) { $existing.crop } else { [pscustomobject]@{ scale = 1; pan_x = 0; pan_y = 0; mode = 'manual' } }
                    note = if ($existing) { [string]$existing.note } else { '' }
                    updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record
                Save-State $state
                Write-Json $stream ([pscustomobject]@{ ok = $true; asset_url = "/art/$cardId"; record = $record })
                continue
            }

            if ($request.Method -eq 'POST' -and $path -eq '/api/import-url') {
                $payload = Read-JsonBody $request
                $cardId = [string]$payload.card_id
                $imageUrl = [string]$payload.image_url
                if ($queue.id -notcontains $cardId) { throw "Unknown card id: $cardId" }
                if ($imageUrl -notmatch '^https?://') { throw 'Use a direct http or https image URL.' }

                $webRequest = [System.Net.HttpWebRequest]::Create($imageUrl)
                $webRequest.Method = 'GET'
                $webRequest.Timeout = 20000
                $webRequest.ReadWriteTimeout = 20000
                $webRequest.UserAgent = 'MarvelSnapArtDesk/0.1 (local personal review tool)'
                $response = $webRequest.GetResponse()
                try {
                    $mime = ([string]$response.ContentType -split ';')[0].Trim().ToLowerInvariant()
                    $extension = Get-ImageExtension $mime
                    $input = $response.GetResponseStream()
                    $memory = [System.IO.MemoryStream]::new()
                    try {
                        $buffer = [byte[]]::new(81920)
                        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                            $memory.Write($buffer, 0, $read)
                            if ($memory.Length -gt 25MB) { throw 'The Phase 1 importer accepts images up to 25 MB.' }
                        }
                    } finally {
                        $input.Dispose()
                    }
                    $filename = "$cardId$extension"
                    [System.IO.File]::WriteAllBytes((Join-Path $AssetsDir $filename), $memory.ToArray())
                    $memory.Dispose()
                } finally {
                    $response.Close()
                }

                $state = Get-State
                $existing = Get-CardRecord $state $cardId
                $record = [pscustomobject]@{
                    # Importing a new URL also resets approval until it is reviewed.
                    status = 'selected'
                    source_kind = 'direct_url'
                    source_url = [string]$payload.source_url
                    image_filename = $filename
                    crop = if ($existing) { $existing.crop } else { [pscustomobject]@{ scale = 1; pan_x = 0; pan_y = 0; mode = 'manual' } }
                    note = if ($existing) { [string]$existing.note } else { '' }
                    updated_at = [DateTime]::UtcNow.ToString('o')
                }
                Set-CardRecord $state $cardId $record
                Save-State $state
                Write-Json $stream ([pscustomobject]@{ ok = $true; asset_url = "/art/$cardId"; record = $record })
                continue
            }

            if ($request.Method -eq 'GET' -and $path.StartsWith('/art/')) {
                $cardId = $path.Substring(5)
                if ($cardId -notmatch '^[a-z0-9-]+$') { throw 'Invalid asset request.' }
                $state = Get-State
                $record = Get-CardRecord $state $cardId
                if ($null -eq $record -or [string]::IsNullOrWhiteSpace([string]$record.image_filename)) {
                    Write-Text $stream 404 'No saved art for this card.'
                    continue
                }
                $assetPath = Join-Path $AssetsDir ([string]$record.image_filename)
                if (-not (Test-Path -LiteralPath $assetPath)) {
                    Write-Text $stream 404 'Saved asset is missing from disk.'
                    continue
                }
                $contentType = switch ([IO.Path]::GetExtension($assetPath).ToLowerInvariant()) {
                    '.jpg' { 'image/jpeg' }
                    '.jpeg' { 'image/jpeg' }
                    '.png' { 'image/png' }
                    '.webp' { 'image/webp' }
                    '.gif' { 'image/gif' }
                    '.avif' { 'image/avif' }
                    default { 'application/octet-stream' }
                }
                Write-Response $stream 200 $contentType ([System.IO.File]::ReadAllBytes($assetPath))
                continue
            }

            Write-Text $stream 404 'Not found.'
        } catch {
            # A timed-out or abandoned preconnection cannot receive an error
            # response. Never let that failed response take down the listener.
            try {
                Write-Json $stream ([pscustomobject]@{ ok = $false; error = $_.Exception.Message }) 400
            } catch {}
        } finally {
            $stream.Dispose()
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
