# LeadScout icon generator - renders PNG icons with GDI+ (no dependencies)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$icons = @(16, 32, 48, 128)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$iconsDir = Join-Path $root '..\icons'
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

function New-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Rounded-square gradient background (indigo -> violet)
    $gradRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $gradRect,
        [System.Drawing.Color]::FromArgb(255, 79, 70, 229),
        [System.Drawing.Color]::FromArgb(255, 147, 51, 234),
        45.0)
    $r = [Math]::Max(3, [int][Math]::Floor($size * 0.22))
    $d = 2 * $r
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0, 0, $d, $d, 180, 90)
    $gp.AddArc($size - $d, 0, $d, $d, 270, 90)
    $gp.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $gp.AddArc(0, $size - $d, $d, $d, 90, 90)
    $gp.CloseFigure()
    $g.FillPath($brush, $gp)

    # Magnifying-glass lens (white ring)
    $penW = [Math]::Max(2.0, $size * 0.105)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $cx = $size * 0.44
    $cy = $size * 0.42
    $rad = $size * 0.20
    $g.DrawEllipse($pen, ($cx - $rad), ($cy - $rad), (2 * $rad), (2 * $rad))

    # Handle
    $x1 = $size * 0.585; $y1 = $size * 0.565
    $x2 = $size * 0.775; $y2 = $size * 0.755
    $g.DrawLine($pen, [single]$x1, [single]$y1, [single]$x2, [single]$y2)

    # Sparkle dots inside the lens (people/data points)
    if ($size -ge 32) {
        $dotR = [Math]::Max(1.0, $size * 0.045)
        $dots = @(
            @{ x = $size * 0.385; y = $size * 0.375 },
            @{ x = $size * 0.490; y = $size * 0.335 },
            @{ x = $size * 0.450; y = $size * 0.480 }
        )
        foreach ($dot in $dots) {
            $g.FillEllipse([System.Drawing.Brushes]::White,
                ($dot.x - $dotR), ($dot.y - $dotR), (2 * $dotR), (2 * $dotR))
        }
    }

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $brush.Dispose(); $pen.Dispose(); $bmp.Dispose()
    Write-Host "wrote $path ($size px)"
}

foreach ($s in $icons) {
    New-Icon $s (Join-Path $iconsDir ("icon$($s).png"))
}
Write-Host 'done'
