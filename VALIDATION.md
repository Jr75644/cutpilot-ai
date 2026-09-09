# CutPilot v0.3 validation

Validated on 2026-09-08 before packaging.

## Passed

- `python -m compileall app` — backend syntax clean.
- TypeScript syntax transpile for every `.ts` / `.tsx` source file — clean.
- TypeScript structural type pass using local React API stubs — clean.
- Timeline save round-trip smoke test:
  - source scenes 1 → 2 → 3;
  - manually reordered to 3 → split 2A → split 2B → 1;
  - backend preserved the exact new render order and stable split clip IDs.
- FFmpeg reorder render smoke test:
  - generated red → blue → green source;
  - rendered green → blue A → blue B → red;
  - sampled output pixels confirmed green, then blue, then red at expected timeline positions.
- Render request now carries current caption/source-audio/voice settings.
- Repository scan contains no committed `.env`, API key, runtime `data/`, `node_modules`, or Python cache folders.

## Full CI configured

`.github/workflows/ci.yml` runs on GitHub with:

1. Python 3.12 setup.
2. FFmpeg install.
3. Python dependency install.
4. backend compile.
5. timeline round-trip smoke test.
6. actual FFmpeg reorder-render smoke test.
7. Node 22 setup.
8. frontend dependency install.
9. full `npm run build`.

## Local environment limitation

This ChatGPT container could not reach the npm registry, so a real local `npm install` could not complete. The source passed TypeScript parsing and a structural type check instead. The GitHub CI workflow is the authoritative full React/Vite build check once repository writes are available.
