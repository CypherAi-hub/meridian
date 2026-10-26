param([ValidateSet('all','paper','dashboard','test','typecheck','install','kill')][string]$Mode='all')
$ErrorActionPreference='Stop'
$packageRoot=$PSScriptRoot
Set-Location -LiteralPath $packageRoot
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
if(-not $nodeCommand){throw 'Install Node.js 22.12+ or 24+ from nodejs.org, then run this script again.'}
$nodePath=$nodeCommand.Source
if($Mode -eq 'install'){
  $npmCommand=Get-Command npm.cmd -ErrorAction SilentlyContinue
  if($npmCommand){& $npmCommand.Source ci --ignore-scripts;exit $LASTEXITCODE}
  $pnpmRuntime=Join-Path (Split-Path (Split-Path $nodePath -Parent) -Parent) 'node_modules/pnpm/bin/pnpm.cjs'
  if(-not(Test-Path -LiteralPath $pnpmRuntime)){throw 'npm is unavailable. Install the official Node.js distribution with npm.'}
  & $nodePath $pnpmRuntime --package=npm dlx npm ci --ignore-scripts
  exit $LASTEXITCODE
}
if(-not(Test-Path -LiteralPath (Join-Path $packageRoot 'node_modules/tsx/dist/cli.mjs'))){throw 'Install package dependencies first: .\Start-Phantom.ps1 install'}
switch($Mode){
 'test' {& $nodePath 'node_modules/vitest/vitest.mjs' run;exit $LASTEXITCODE}
 'typecheck' {& $nodePath 'node_modules/typescript/bin/tsc' --noEmit;exit $LASTEXITCODE}
 'kill' {& $nodePath --env-file-if-exists=.env --import tsx src/cli.ts kill;exit $LASTEXITCODE}
 'paper' {& $nodePath --env-file-if-exists=.env --import tsx src/cli.ts paper;exit $LASTEXITCODE}
 'dashboard' {& $nodePath 'node_modules/next/dist/bin/next' dev dashboard --hostname 127.0.0.1 --port 8791;exit $LASTEXITCODE}
 'all' {
  foreach($port in @(8790,8791)){
   if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){Write-Output "Port $port is already running; reusing it.";continue}
   $stdoutPath=Join-Path $packageRoot "data/service-$port.log"
   $stderrPath=Join-Path $packageRoot "data/service-$port.error.log"
   New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'data') | Out-Null
   if($port -eq 8790){$arguments=@('--env-file-if-exists=.env','--import','tsx','src/cli.ts','paper')}
   else{$arguments=@('node_modules/next/dist/bin/next','dev','dashboard','--hostname','127.0.0.1','--port','8791')}
   $service=Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
   Write-Output "Started PHANTOM service on port $port (PID $($service.Id))."
  }
  Write-Output 'Dashboard: http://127.0.0.1:8791. All bot fills are paper. Keep the host awake using its supported app/system settings.'
 }
}
