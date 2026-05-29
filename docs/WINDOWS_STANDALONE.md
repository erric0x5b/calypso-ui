# Calypso UI standalone Windows

Questa modalità affianca la distribuzione Docker/BlueOS senza sostituirla.

Il binario Windows avvia lo stesso backend FastAPI del container e serve la UI da
`/ui`, ma usa directory dati compatibili con Windows.

## Prerequisiti build

- Windows 10/11 x64
- Python 3.11 o superiore
- Inno Setup 6, solo per creare l'installer
- `ffmpeg.exe`, opzionale ma necessario per convertire stream RTSP in MJPEG

## Build exe

Eseguire da PowerShell nella root del repository:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r .\packaging\windows\requirements-build.txt
pyinstaller --clean --noconfirm .\packaging\windows\calypso-ui.spec
```

L'output viene creato in:

```text
dist\CalypsoUI\CalypsoUI.exe
```

Per testarlo:

```powershell
.\dist\CalypsoUI\CalypsoUI.exe
```

Il programma apre automaticamente:

```text
http://127.0.0.1:8080/ui
```

Per avviarlo senza browser:

```powershell
.\dist\CalypsoUI\CalypsoUI.exe --no-browser
```

Per aprire la UI a schermo intero con Edge/Chrome:

```powershell
.\dist\CalypsoUI\CalypsoUI.exe --fullscreen
```

In alternativa, per abilitarlo da collegamento o installer:

```powershell
$env:CALYPSO_FULLSCREEN = "1"
.\dist\CalypsoUI\CalypsoUI.exe
```

## ffmpeg

Se serve il proxy video RTSP, copiare `ffmpeg.exe` qui prima di creare
l'installer:

```text
dist\CalypsoUI\ffmpeg\ffmpeg.exe
```

In alternativa impostare la variabile ambiente:

```powershell
$env:CALYPSO_FFMPEG_BIN = "C:\path\to\ffmpeg.exe"
```

## Directory dati

La build standalone usa per default:

```text
%LOCALAPPDATA%\Calypso UI\
%LOCALAPPDATA%\Calypso UI\logs\
%LOCALAPPDATA%\Calypso UI\config\lights_config.json
```

Si possono sovrascrivere con:

```powershell
$env:CALYPSO_DATA_DIR = "D:\Calypso"
$env:CALYPSO_LOG_DIR = "D:\Calypso\logs"
$env:CALYPSO_LIGHTS_CFG = "D:\Calypso\config\lights_config.json"
```

## Installer

Dopo aver creato `dist\CalypsoUI`, compilare lo script:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" .\packaging\windows\CalypsoUI.iss
```

L'installer viene creato in:

```text
dist\installer\CalypsoUI-Setup-0.4.6.exe
```

## Porte e rete

La standalone usa per default:

- HTTP: `127.0.0.1:8080`
- UDP RX: `14590`
- UDP TX: `14591`
- Controller UDP: `5010`

Su Windows potrebbe essere necessario autorizzare l'app nel firewall per le porte
UDP.
