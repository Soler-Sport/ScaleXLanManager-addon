# ScaleXLanManager-addon

A [DragonFruit](https://github.com/Open-Resin-Alliance/DragonFruit) complex
plugin that sends print jobs straight to a
[ScaleX LAN Manager](https://github.com/Soler-Sport/ScaleX-Lan-Manager_Addon_Network-Sending)
print farm (SDCP resin printers, e.g. Elegoo Saturn 4 / EL3D-4), instead of
exporting a file and uploading it by hand. It mirrors the role `own_manager.py`
plays for CHITUBOX, but as a native DragonFruit network plugin.

## Status: v1, intentionally scoped down

This plugin implements exactly the endpoints ScaleX's own reference client
(`own_manager.py`, in the manager repo above) actually uses on its live send
path, reverse-engineered from that script's own `SESSION NOTES` docstring and
`fetch_printers`/`forward_to_scalex`/`poll_scalex_upload`/`start_stored_file`.
It deliberately leaves out a few things:

- **No CTB exposure patching** (`/api/ctb/params` +
  `/api/ctb/patch-and-upload`, ScaleX's "apply recommended exposure" flow).
  Real, but extra surface with real risk if gotten wrong (a full ~1 minute
  server-side file rewrite); can be added later using
  `network/scalexClient.ts` as the base.
- **No bulk/`from-draft` endpoints.** `own_manager.py`'s own SESSION NOTES
  call these out explicitly: ScaleX marks them "experimental" in its own API
  response, and they were observed live starting a real print without ever
  being asked to. This plugin only uses the single-printer endpoints
  `own_manager.py` itself settled on for the same reason.
- **No auto-start-print.** Every upload here is queue-only
  (`X-Start-Print: false`). DragonFruit's shared `uploadPrintJobWithProgress`
  contract has no "start printing" field to plumb a user's intent through in
  the first place, and given the point above, that felt like the right
  default rather than something to work around. Start a queued job from
  ScaleX's own UI, or wire up `startScaleXStoredFile` from
  `network/scalexClient.ts` behind a future monitoring adapter.
- **No live print monitoring / pause / resume / cancel / emergency-stop.**
  `own_manager.py` never calls any such endpoint — there is nothing to port
  them from, and DragonFruit's monitoring adapter contract requires all of
  those operations to resolve to something real. Fabricating endpoints that
  were never confirmed to exist felt worse than leaving this out.
- **No LAN broadcast discovery.** ScaleX has no mDNS/broadcast presence
  (confirmed by `own_manager.py` just hardcoding `SCALEX_HOST`/`SCALEX_PORT`),
  so `discover` only probes an explicit host or a short list of common
  hostnames — no NanoDLP-style subnet sweep.

## Design decision: the "printer" picker

DragonFruit's plugin contract (`PluginNetworkUiAdapterContract`) was built
around NanoDLP's model: one connection = one printer, with a single per-job
pick — an on-device "material profile" (`materials`/`materialsEdit`),
threaded through to upload as `profileId`.

ScaleX doesn't fit that shape: one host:port manages a whole *farm* of
printers, and there's no separate "which printer" slot in the contract to add
without changing core (which the plugin framework explicitly asks plugins not
to do — see `plugins/CONTRIBUTING_COMPLEX_PLUGINS.md`, "core app surfaces stay
generic").

So this plugin repurposes the material-profile picker as the *printer*
picker: `scalex/printers/list` (wired to the `materials` operation) returns
each ScaleX-managed printer as if it were a material profile — id, a label
(with an offline/busy suffix), and the full printer object as `meta`.
Whichever one the user picks becomes `profileId`, which
`network/index.ts`'s `uploadPrintJobWithProgress` reads straight back out as
the target printer id. `materialsEdit` (`scalex/printers/edit`) always
returns "not supported" — ScaleX doesn't expose editing those remotely
anyway, and `remoteMaterialEditingWipNotice` in `pluginDefinition.ts` greys
the Edit button out.

## Known limitation: filename extension on the Blob upload path

`uploadPrintJobWithProgress` can receive either a native temp file path or an
in-memory `Blob`. As of this writing, DragonFruit core's own
`printingArtifact.blob` is always `null` (only `nativeTempPath` is actually
populated — see `src/features/slicing/sliceExportOrchestrator.ts` and the
send-to-printer call site in `src/app/page.tsx`), so the native-path branch
is the one that matters in practice, and it derives the real filename
(including the correct slicer-output extension, e.g. `.ctb`) straight from
the temp file's own path — no guessing.

The Blob branch can't do that: the shared upload contract only passes `path`,
which is the artifact's filename **without** its extension
(`printingArtifact.outputName` with the extension stripped, see `pathBase` in
`src/app/page.tsx`). ScaleX needs the real extension in `X-File-Name` so the
printer firmware recognizes the format — unlike NanoDLP, it isn't a
proprietary endpoint that accepts an arbitrary made-up name. Until core
passes the real extension (or a `File` instead of a bare `Blob`) through that
contract, the Blob branch assumes `.ctb` and logs a console warning when it's
used. If DragonFruit core ever starts populating `zipBlob` for a printer
whose slicer output isn't `.ctb`, that assumption will be wrong.

## Layout

```
pluginDefinition.ts           ComplexPluginDefinition (capabilities, network adapter)
network/
  networkHandlers.ts          required entrypoint: handlePluginNetworkOperation
  index.ts                    client-safe barrel + uploadPrintJobWithProgress
  scalexClient.ts             ScaleX REST client (fetch-based; host/port parsing, printer/upload status helpers)
  scalexHandlers.ts           server-side handlePluginNetworkOperation (Node-only, not exported from index.ts)
  scalexUploadWithProgress.ts client-safe upload (Blob via XHR, native path via server-side stream + poll)
  handlers/
    connect.ts                 scalex/connect      — probe the manager host
    discover.ts                 scalex/discover     — probe a host/hostname list (no broadcast)
    printers.ts                scalex/printers/list, scalex/printers/edit — the printer picker (see above)
    upload.ts                  scalex/upload/start, scalex/upload/progress — native-file-path streaming upload
```

## Setting this up locally

1. Clone this repo as `plugins/scalex-lan-manager/` inside a DragonFruit
   checkout (as a submodule once this repo has a remote, or a plain folder
   for local testing).
2. Add `"scalex-lan-manager"` to `src/config/complex-plugin-allowlist.json`.
3. `npm run generate:plugin-registry && npm run check:generated-plugin-registry`
4. `npm run build` (and `cargo check --manifest-path src-tauri/Cargo.toml` —
   this plugin ships no Rust, so that should be a no-op for it specifically).

See DragonFruit's own `plugins/CONTRIBUTING_COMPLEX_PLUGINS.md` for the full
contribution flow.

## Source

The ScaleX API surface here (`/api/printers`, `/api/printers/{id}/files`,
`/api/uploads/{id}`, `/api/printers/{id}/stored-files/start`) is taken from
[`own_manager.py`](https://github.com/Soler-Sport/ScaleX-Lan-Manager_Addon_Network-Sending/blob/main/own_manager.py),
which documents it as reverse-engineered from ScaleX's own `app.js` and live
tests. If ScaleX's API changes, that script (and this plugin's
`network/scalexClient.ts`) will need updating together.
