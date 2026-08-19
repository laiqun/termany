#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    Build and deploy the Termany web app to Cloudflare Pages.
.DESCRIPTION
    Runs pnpm build, ensures SPA fallback rules, then deploys via wrangler.
.PARAMETER ProjectName
    Cloudflare Pages project name. Defaults to "termany-web".
.PARAMETER Base
    Optional Vite base path, e.g. "/termany/" for sub-directory deployments.
.PARAMETER SkipInstall
    Skip pnpm install.
.PARAMETER CommitDirty
    Pass --commit-dirty=true to wrangler.
.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -ProjectName my-termany -Base /demo/
#>
param(
    [string]$ProjectName = "termany-web",
    [string]$Base = "",
    [switch]$SkipInstall,
    [switch]$CommitDirty
)

$ErrorActionPreference = "Stop"

# Resolve script directory so it works no matter where you run it from
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$webDir = Resolve-Path (Join-Path $scriptDir ".")
Push-Location $webDir

try {
    Write-Host "Working directory: $webDir" -ForegroundColor Cyan

    if (-not $SkipInstall) {
        Write-Host "Installing dependencies..." -ForegroundColor Cyan
        pnpm install
    }

    # Ensure SPA fallback rules exist
    $redirectsPath = Join-Path $webDir "public" "_redirects"
    if (-not (Test-Path $redirectsPath)) {
        Write-Host "Creating public/_redirects for SPA fallback..." -ForegroundColor Yellow
        Set-Content -Path $redirectsPath -Value "/*    /index.html   200" -Encoding UTF8NoBOM
    }
    else {
        Write-Host "public/_redirects already exists." -ForegroundColor Green
    }

    # Build
    Write-Host "Building web app..." -ForegroundColor Cyan
    $buildCmd = "pnpm build"
    if ($Base) {
        $buildCmd += " -- --base=$Base"
    }
    Invoke-Expression $buildCmd
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code $LASTEXITCODE"
    }

    # Verify dist
    $distDir = Join-Path $webDir "dist"
    if (-not (Test-Path $distDir)) {
        throw "dist/ directory not found after build"
    }
    if (-not (Test-Path (Join-Path $distDir "_redirects"))) {
        Write-Warning "dist/_redirects missing; copying from public/"
        Copy-Item $redirectsPath (Join-Path $distDir "_redirects")
    }

    # Ensure Pages project exists
    Write-Host "Checking Cloudflare Pages project '$ProjectName'..." -ForegroundColor Cyan
    $check = npx wrangler pages project list --format=json 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    $exists = $check | Where-Object { $_.name -eq $ProjectName }
    if (-not $exists) {
        Write-Host "Project not found, creating '$ProjectName'..." -ForegroundColor Yellow
        npx wrangler pages project create $ProjectName --production-branch=main
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create Pages project"
        }
    }
    else {
        Write-Host "Project '$ProjectName' exists." -ForegroundColor Green
    }

    # Deploy
    Write-Host "Deploying to Cloudflare Pages..." -ForegroundColor Cyan
    $deployCmd = "npx wrangler pages deploy dist --project-name=$ProjectName"
    if ($CommitDirty) {
        $deployCmd += " --commit-dirty=true"
    }
    Invoke-Expression $deployCmd
    if ($LASTEXITCODE -ne 0) {
        throw "Deployment failed with exit code $LASTEXITCODE"
    }

    Write-Host "Done." -ForegroundColor Green
}
finally {
    Pop-Location
}
