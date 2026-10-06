# Changelog

## ResourceTrace companion 1.0.7

- Observe a visible injected Baidu passcode href on purchased source pages and capture it only for the same purchased share. Late-added overlays update the resource without navigation. Conflicting links are left for review.
- The native ResourceTrace app displays the stored URL as **Link** in purchase notes. Baidu Pan Auto-Save itself remains 1.0.6.


## 1.0.6

- Added an optional ResourceTrace capture handshake before closing a successfully saved Baidu tab. Already captured, unpaired and absent companions retain the ordinary closing delay; a paired companion waiting for filename evidence gets at most five seconds.
- Published the ResourceTrace 1.0.6 companion under `companion/`, with stable install/update URLs, immediate Baidu observation, synchronous PNG evidence queueing, cross-tab queues and migration from older ResourceTrace storage.
- Added tests for close-time readiness, timeout, absent companions, late filename evidence, concurrent queues and companion capture helpers.
- Preserved existing save/navigation queues, retry behavior and extraction-code handling.

## 1.0.5

- Reload the page immediately when Baidu reports an invalid extraction code
  (`提取码输入错误，请重试`) instead of retrying the request with backoff.

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

## ResourceTrace companion 1.0.8

- Queue purchased metadata only on a real click of the top-left floating Baidu link, including middle-click and keyboard activation.
- Retain synchronous queueing before navigation, visible-purchase validation, share correlation and automatic Baidu evidence capture.
- Test that load, mutations, timers, pairing and recapture cannot ingest an unclicked purchase.
