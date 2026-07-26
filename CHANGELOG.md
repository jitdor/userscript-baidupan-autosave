# Changelog

## 1.0.1

- Added an always-visible **⚙ Auto-save** settings button on Baidu Pan pages.
- Made destination configuration accessible in AdGuard for Mac 2.19, which does not expose userscript menu commands.
- Kept the userscript-manager menu commands for Tampermonkey and compatible managers.

## 1.0.0

- Added a userscript menu for changing or resetting the Baidu Pan destination.
- Added recursive creation for configurable nested destination folders.
- Serialized transfer work across tabs with Web Locks and a lease fallback.
- Added cross-tab write throttling and shared cooldowns.
- Added bounded exponential retry handling for transient network, HTTP, parsing, and Baidu API failures.
- Made transfer retries idempotent and included the destination in duplicate-job detection.
- Added stable raw install and update URLs.

The initial distributable used metadata version `1.4.0` so installations of the supplied `1.3.0` script recognized it as an update. Release 1.0.1 uses userscript metadata version `1.4.1`.
