# Project Instructions

## ROV firmware telemetry specifications

The ROV firmware repository is expected to live next to this repository in the
same parent folder:

```text
<github-folder>/
  calypso-ui/
  DistributionBoard/
```

When working on telemetry, protocol parsing, UI alignment with ROV data, or
anything that depends on firmware-side message definitions, consult the firmware
specification documents in the sibling repository before changing behavior.

Primary reference:

```text
../DistributionBoard/ROV_CPU_Rev.B/Documentation/TELEMETRY_UI_ALIGNMENT.md
```

If the primary file is missing or appears stale, search the sibling repository
for Markdown specifications:

```powershell
rg --files -g "*.md" ../DistributionBoard
```

Prefer the firmware specification as the source of truth for telemetry fields,
units, ranges, message names, and update expectations. If UI documentation in
this repository disagrees with the firmware specification, call out the mismatch
and update the UI-side documentation or implementation only after checking the
firmware-side document.
