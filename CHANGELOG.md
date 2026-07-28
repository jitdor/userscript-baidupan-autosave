# Changelog

## 1.0.4

- Added a two-lane page-load gate for Baidu share tabs to reduce concurrent
  unlock and rendering requests.
- Kept the first lane available immediately and delayed the second lane by ten
  seconds at the start of each burst.
- Released each lane when its save succeeds, fails terminally, or cannot read
  the share, allowing the next alternating tab to resume.
- Added renewable slot leases so a manually closed or crashed tab cannot block
  the page-load queue permanently.

## 1.0.3

- Changed the global lock to cover one bounded Baidu write attempt instead of an entire job.
- Released the write slot before retry backoff so failing jobs no longer block healthy tabs.
- Added a 25-second timeout to Baidu requests so a hung fetch cannot hold the queue indefinitely.
- Restricted transfer execution, not only the settings button, to top-level tabs.
- Added a cross-tab queue panel with job state, elapsed time, write-slot status, retry details, and destination controls.
- Limited global cooldowns to explicit rate-limit responses.

## 1.0.2

- Restricted the on-page settings button to the top-level Baidu document, preventing duplicate buttons from same-origin iframes.
- Aligned the userscript metadata, package, and GitHub release versions at `1.0.2`.

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

The initial distributable used metadata version `1.4.0`, and release 1.0.1 used `1.4.1`. Starting with release 1.0.2, the userscript metadata and GitHub release versions stay aligned.
