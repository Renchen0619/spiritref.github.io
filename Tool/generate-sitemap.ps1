# generate-sitemap.ps1
# Auto-generate sitemap.xml from Data\postFB.json
# Place this file in the Tool\ folder and run via run-sitemap.bat (double-click)
# or: powershell -ExecutionPolicy Bypass -File .\Tool\generate-sitemap.ps1

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Project root is the parent of the Tool folder
$root = Split-Path -Parent $scriptDir

$jsonPath = Join-Path $root "Data\postFB.json"
if (-not (Test-Path $jsonPath)) {
    Write-Error "Cannot find $jsonPath"
    exit 1
}

$data = Get-Content -Raw -Encoding UTF8 $jsonPath | ConvertFrom-Json

$base = "https://spiritref.github.io"
$today = (Get-Date).ToString("yyyy-MM-dd")

$entries = @()

# Static public pages
$static = @(
    @{ loc="$base/services/"; lastmod=$today; changefreq="weekly"; priority="1.0" },
    @{ loc="$base/services/faq/"; lastmod=$today; changefreq="weekly"; priority="0.8" },
    @{ loc="$base/services/notices/"; lastmod=$today; changefreq="daily"; priority="0.8" },
    @{ loc="$base/services/consult.html"; lastmod=$today; changefreq="monthly"; priority="0.5" },
    @{ loc="$base/ghoststory/"; lastmod=$today; changefreq="daily"; priority="0.9" },
    @{ loc="$base/"; lastmod=$today; changefreq="weekly"; priority="0.8" }
)
foreach ($s in $static) { $entries += $s }

# Article pages (compute combined ID from postFB.json)
foreach ($post in $data) {
    $props = @($post.PSObject.Properties)
    $postId = [string]$props[0].Value
    if (-not $postId) { $postId = "0" }
    $raw = $null
    foreach ($pr in $props) {
        if ($pr.Value -is [string] -and $pr.Value -match '^\d{4}/\d{2}/\d{2}') {
            $raw = $pr.Value
            break
        }
    }
    $ts = "0000"
    $lastmod = $today
    if ($raw) {
        try {
            $d = [DateTime]::ParseExact($raw, "yyyy/MM/dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture)
            $ts = $d.ToString("yyyyMMddHHmmss")
            $lastmod = $d.ToString("yyyy-MM-dd")
        } catch {
            try {
                $d = [DateTime]::Parse($raw)
                $ts = $d.ToString("yyyyMMddHHmmss")
                $lastmod = $d.ToString("yyyy-MM-dd")
            } catch {
                $null = $_
            }
        }
    }
    $combined = "${postId}_${ts}"
    $url = "$base/ghoststory/article/?id=$combined"
    $entry = @{ loc=$url; lastmod=$lastmod; changefreq="monthly"; priority="0.6" }
    $entries += $entry
}

# Build XML
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<?xml version="1.0" encoding="UTF-8"?>')
[void]$sb.AppendLine('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
foreach ($e in $entries) {
    [void]$sb.AppendLine('  <url>')
    [void]$sb.AppendLine("    <loc>$($e.loc)</loc>")
    [void]$sb.AppendLine("    <lastmod>$($e.lastmod)</lastmod>")
    [void]$sb.AppendLine("    <changefreq>$($e.changefreq)</changefreq>")
    [void]$sb.AppendLine("    <priority>$($e.priority)</priority>")
    [void]$sb.AppendLine('  </url>')
}
[void]$sb.AppendLine('</urlset>')

$outPath = Join-Path $root "sitemap.xml"
$sb.ToString() | Out-File -FilePath $outPath -Encoding utf8

Write-Host "Generated: $outPath"
Write-Host "Total URLs: $($entries.Count)"