# MM43 - Script de Simulación de Conflictos y Escenarios
# Este script crea un repositorio temporal y genera diversos estados para probar la extensión.

$testDir = Join-Path $PSScriptRoot "mm43_lab"
if (Test-Path $testDir) { Remove-Item -Recurse -Force $testDir }
New-Item -ItemType Directory -Path $testDir
Set-Location $testDir

Write-Host "--- Inicializando Laboratorio MM43 ---" -ForegroundColor Cyan

# 1. Setup Repositorio (Simulando Local y Remoto)
git init --bare remote.git
git clone remote.git local
Set-Location local
git config user.name "Tester"
git config user.email "tester@mm43.com"

# 2. Commit Base (En el Servidor)
"Contenido inicial" | Out-File -FilePath "shared.txt"
git add .
git commit -m "Initial commit
MM43-VV: {`"tester`": 1}"
git push origin master

# 3. Escenario A: Commit en Servidor (Verde)
"Cambio en servidor" | Out-File -Append -FilePath "shared.txt"
git add .
git commit -m "Feature Srv: Trabajo integrado
MM43-VV: {`"tester`": 2}"
git push origin master

# 4. Escenario B: Commit Local (Rojo)
"Cambio local" | Out-File -Append -FilePath "shared.txt"
git add .
git commit -m "Feature Loc: Trabajo pendiente
MM43-VV: {`"tester`": 3}"

# 5. Escenario C: Commits Huérfanos (Sin MM43)
"Cambio anonimo 1" | Out-File -FilePath "orphan.txt"
git add .
git commit -m "Commit sin metadatos 1"
"Cambio anonimo 2" | Out-File -Append -FilePath "orphan.txt"
git add .
git commit -m "Commit sin metadatos 2"

# 6. Escenario D: Conflicto Semántico (Concurrencia)
# Vamos a crear un commit que ignore el tiempo lógico de 'tester':3
# Simulamos a 'dev_b' trabajando en paralelo sobre 'shared.txt'
$metaB = "{`"dev_b`": 1}" # No conoce el cambio 2 o 3 de tester
"Cambio conflictivo de B" | Out-File -Append -FilePath "shared.txt"
git add .
git commit -m "Feature B: Trabajo concurrente
MM43-VV: $metaB"

# 7. Crear Refs de Features para que la extensión las reconozca
git update-ref refs/features/FEATURE-TEST-01/start HEAD~4
git update-ref refs/features/FEATURE-TEST-01/head HEAD

Write-Host "`n--- Laboratorio Creado en: $testDir ---" -ForegroundColor Green
Write-Host "Pasos para probar:"
Write-Host "1. Abre la carpeta '$testDir\local' en VS Code."
Write-Host "2. Abre el panel de MM43."
Write-Host "3. Verás commits verdes (en servidor) y rojos (locales)."
Write-Host "4. Verás 2 commits huérfanos listos para asociar."
Write-Host "5. Verás una alerta de Conflicto Semántico entre 'tester' y 'dev_b'."
