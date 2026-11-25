# LeadScout end-to-end check launcher.
#
# Starts a throwaway browser profile with the unpacked extension loaded and a
# DevTools port open, runs tools\e2e.mjs against it, then closes the browser and
# deletes the profile. Your own browser profile, settings and data are never touched.
#
#   powershell -ExecutionPolicy Bypass -File tools\e2e.ps1
#   powershell -ExecutionPolicy Bypass -File tools\e2e.ps1 -Browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
#
# If the first browser does not load the extension, the other one is tried.

param(
    [string]$Browser = '',
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Google Chrome no longer allows --load-extension on the command line (its own
# log says "--disable-extensions-except is not allowed in Google Chrome"), so
# Edge — or a Chromium build — is the browser this check runs in.
$chromium = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Chromium\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($Browser) { $order = @($Browser) }
elseif ($chromium) { $order = @($chromium) }
else { throw 'No Microsoft Edge or Chromium found. Pass -Browser <path to msedge.exe>.' }

if (-not $Port) { $Port = Get-Random -Minimum 9400 -Maximum 9900 }

# Loading an unpacked extension from the command line occasionally does not
# take on the first launch (the browser starts, the extension does not). A
# second launch with a fresh profile fixes it, so the first browser gets one
# more try before the run is called failed.
$attempts = @($order)
if ($order.Count -ge 1) { $attempts = @($order) + @($order[0]) }

$code = 1
$attemptNumber = 0
foreach ($candidate in $attempts) {
    $attemptNumber++
    $profile = Join-Path $env:TEMP ('leadscout-e2e-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    $browserLog = Join-Path $profile 'browser.err.log'

    $browserArgs = @(
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        "--remote-debugging-port=$Port",
        "--user-data-dir=`"$profile`"",
        "--disable-extensions-except=`"$root`"",
        "--load-extension=`"$root`"",
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        # The browser's own log: it names the reason when the extension fails to load.
        '--enable-logging=stderr',
        'about:blank'
    )

    # The browser writes its own log straight to a file. Routing its output
    # through a PowerShell pipe while this script waits on node can leave the
    # pipe undrained, and the browser then blocks mid-start-up with no
    # service workers running at all.
    $commandLine = '"' + $candidate + '" ' + ($browserArgs -join ' ') + ' 2> "' + $browserLog + '"'
    Write-Host ('browser: ' + $candidate + '  (launch ' + $attemptNumber + ' of ' + $attempts.Count + ')')
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', ('"' + $commandLine + '"') `
        -WindowStyle Hidden -PassThru
    try {
        & node (Join-Path $root 'tools\e2e.mjs') --log $browserLog
        $code = $LASTEXITCODE
    }
    finally {
        # Close every process started for this throwaway profile (the shell
        # that launched the browser carries the profile path too).
        Get-CimInstance Win32_Process |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 800
        Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
    }
    # 3 means "the extension did not load in this launch": try the next launch.
    if ($code -ne 3) { break }
    $Port = Get-Random -Minimum 9400 -Maximum 9900
}
exit $code
