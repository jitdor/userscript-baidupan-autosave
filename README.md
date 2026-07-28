# Baidu Pan Auto-Save

A userscript for Edge, Chrome, and other compatible browsers that automatically saves unlocked Baidu Pan shares into your cloud account.

## Install

[Install the latest userscript](https://raw.githubusercontent.com/jitdor/userscript-baidupan-autosave/main/baidupan-autosave.user.js)

Open that link with Tampermonkey, AdGuard, or another userscript manager. The script's `@updateURL` and `@downloadURL` both point to the file on the `main` branch, so normal periodic update checks always follow the latest stable version.

Starting with `1.0.2`, the userscript metadata version, package version, and GitHub release version are kept identical.

## Configure the destination

The default destination is `/wckbot16`.

On AdGuard for Mac:

1. Open any `pan.baidu.com` page.
2. Click **⚙ Auto-save** in the lower-right corner.
3. Select **Change destination** in the queue panel.
4. Enter an absolute folder path such as `/incoming/baidu`.

On Tampermonkey or another manager that supports userscript menu commands, you can instead open its userscript menu and select **Set destination folder…**.

Nested folders are created automatically. The setting is stored by the userscript manager and applies to future save jobs. The on-page button shows the current destination in its tooltip. Use **Reset destination folder** from a supported userscript menu, or enter `/wckbot16` through the button, to restore the default.

## How concurrency is handled

Opening many share links no longer starts many transfers at once:

- Share-page startup uses two alternating lanes. The first tab resumes
  immediately, the second resumes after ten seconds, the third waits for the
  first tab to finish, the fourth waits for the second tab, and so on.
- Waiting tabs stop at `document-start` before Baidu's page application and
  unlock requests run, then reload when their lane becomes available.
- A successful auto-save releases its page-load lane immediately before the
  tab closes. Terminal failures also release the lane so later tabs can
  continue.
- Each Baidu write attempt joins one exclusive browser queue.
- A persisted delay spaces out Baidu write requests.
- Each job is checked again after it reaches the front of the queue, preventing duplicate work.
- Network errors, HTTP throttling, malformed responses, and non-permanent Baidu API failures use bounded exponential backoff with jitter.
- A failing job releases the write slot before backoff, allowing other tabs to continue.
- Requests time out after 25 seconds instead of holding the queue indefinitely.
- Transfers use `ondup=skip`, making a retry safe if Baidu completed a request but its response was lost.
- Browsers without the Web Locks API use a renewable local-storage lease as a fallback.

Click **⚙ Auto-save** to open the live queue panel. It shows active and recent jobs, elapsed time, current phase, retries, destination, and whether the shared write slot is busy. Completed and failed entries can be cleared from the panel.

The write lock is released automatically if a queued or active tab closes.
Page-load lanes use renewable leases as a fallback when a tab is closed
manually or crashes. Leave queued tabs open until their status changes to
success or failure.

## Notes

- Sign in to Baidu Pan before opening share links.
- Password-protected shares must already be unlocked in the tab.
- Automatic tab closing can be blocked for tabs opened manually; the completed tab can then be closed by hand.
- Baidu's private web APIs may change without notice.

## Development

```sh
npm test
npm run check
```

No build step or third-party runtime dependency is required. The root `.user.js` file is the distributable.

## License

[MIT](LICENSE)
