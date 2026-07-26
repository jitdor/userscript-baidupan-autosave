# Changelog

## 1.0.0

- Added a userscript menu for changing or resetting the Baidu Pan destination.
- Added recursive creation for configurable nested destination folders.
- Serialized transfer work across tabs with Web Locks and a lease fallback.
- Added cross-tab write throttling and shared cooldowns.
- Added bounded exponential retry handling for transient network, HTTP, parsing, and Baidu API failures.
- Made transfer retries idempotent and included the destination in duplicate-job detection.
- Added stable raw install and update URLs.

The distributable userscript uses metadata version `1.4.0` so existing installations of the supplied `1.3.0` script recognize it as an update.
