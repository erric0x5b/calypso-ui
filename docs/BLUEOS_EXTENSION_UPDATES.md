# BlueOS Extension Updates

Calypso UI is published as a BlueOS extension image on GHCR:

```text
ghcr.io/erric0x5b/calypso-ui
```

BlueOS detects extension updates reliably from SemVer tags in an extension
collection manifest. Do not rely on `latest` for production updates.

## Collection URL

Add this custom collection URL in BlueOS Extensions Manager:

```text
https://raw.githubusercontent.com/erric0x5b/calypso-ui/master/blueos/manifest.json
```

After the collection is added, BlueOS can compare the installed version with the
versions listed in the manifest and offer the newer version.

## Release Flow

1. Update these version references:

```text
docker/Dockerfile LABEL version
backend/app/main.py /register_service version
blueos_Install.json tag
README.md image tag
```

2. Build and push the versioned image:

```powershell
docker buildx build --builder calypso_builder `
  --platform linux/amd64,linux/arm64,linux/arm/v7 `
  -f docker/Dockerfile `
  -t ghcr.io/erric0x5b/calypso-ui:0.4.7 `
  -t ghcr.io/erric0x5b/calypso-ui:latest `
  --push .
```

3. Regenerate the BlueOS manifest from the pushed GHCR tag:

```powershell
python tools/update_blueos_manifest.py 0.4.7
```

Pass all published versions if the manifest should keep older versions listed:

```powershell
python tools/update_blueos_manifest.py 0.4.8 0.4.7
```

4. Commit and push the updated version files and `blueos/manifest.json`.
