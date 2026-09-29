# Generates the installer artwork (NSIS header/sidebar, WiX banner/dialog) from the brand mark
# src-tauri/icons/icon.png. Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts/make-installer-images.ps1
# Output: src-tauri/icons/installer/*.bmp (24-bit BMP, the format both NSIS and WiX require).
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "src-tauri/icons/icon.png"
$outDir = Join-Path $root "src-tauri/icons/installer"
New-Item -ItemType Directory -Force $outDir | Out-Null
$logo = [System.Drawing.Image]::FromFile($source)

function New-Canvas([int]$w, [int]$h, [System.Drawing.Color]$bg) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($bg)
    return @($bmp, $g)
}

function Save-Bmp($bmp, $g, [string]$name) {
    $g.Dispose()
    $bmp.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
}

$white = [System.Drawing.Color]::White
$dark = [System.Drawing.Color]::FromArgb(255, 25, 26, 27)
$titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 237, 237, 237))
$subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 140, 140, 140))

# NSIS header (150x57, top-right of every inner page): logo on white.
$c = New-Canvas 150 57 $white
$c[1].DrawImage($logo, 93, 3, 51, 51)
Save-Bmp $c[0] $c[1] "nsis-header.bmp"

# NSIS sidebar (164x314, Welcome/Finish pages): dark panel, logo, product name.
$c = New-Canvas 164 314 $dark
$c[1].DrawImage($logo, 22, 60, 120, 120)
$font = New-Object System.Drawing.Font("Segoe UI Semibold", 13)
$small = New-Object System.Drawing.Font("Segoe UI", 8)
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$c[1].DrawString("OpenMind Studio", $font, $titleBrush, (New-Object System.Drawing.RectangleF(0, 195, 164, 30)), $center)
$c[1].DrawString("Portable code editor", $small, $subBrush, (New-Object System.Drawing.RectangleF(0, 225, 164, 20)), $center)
Save-Bmp $c[0] $c[1] "nsis-sidebar.bmp"

# WiX banner (493x58, top of inner pages; WiX draws the title text on the left): logo on the right.
$c = New-Canvas 493 58 $white
$c[1].DrawImage($logo, 433, 4, 50, 50)
Save-Bmp $c[0] $c[1] "wix-banner.bmp"

# WiX dialog (493x312, Welcome/Finish; the left 164 px are the picture, WiX writes text on the right).
$c = New-Canvas 493 312 $white
$c[1].FillRectangle((New-Object System.Drawing.SolidBrush($dark)), 0, 0, 164, 312)
$c[1].DrawImage($logo, 22, 60, 120, 120)
$c[1].DrawString("OpenMind Studio", $font, $titleBrush, (New-Object System.Drawing.RectangleF(0, 195, 164, 30)), $center)
$c[1].DrawString("Portable code editor", $small, $subBrush, (New-Object System.Drawing.RectangleF(0, 225, 164, 20)), $center)
Save-Bmp $c[0] $c[1] "wix-dialog.bmp"

$logo.Dispose()
Write-Output "Installer images written to $outDir"
