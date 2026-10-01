# Instagram to Bunny Storage Saver

A Chrome / Edge / Brave extension (Manifest V3) that saves Instagram photos, videos and reels straight into your **Bunny Storage** zone. Each file goes from Instagram's CDN, through your browser's memory, to Bunny. Nothing is written to your computer.

## Install

1. Download this repository: green **Code** button > **Download ZIP**, then unzip it. Or run `git clone https://github.com/ByteFox947/insta.git`.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. The settings page opens automatically.

To update later, replace the files in that same folder with the new version (or run `git pull`), then click the reload icon on the extension in `chrome://extensions`. Your settings are kept as long as you keep loading it from the same folder.

## Connect Bunny Storage

1. In the Bunny dashboard, open **Storage** and select your storage zone (create one if needed).
2. Open **FTP & API Access** and copy the **Password**. This is the storage zone password, not your account API key.
3. In the extension settings, enter the zone name, its primary region and the password. Click **Test connection**, then **Save**.
4. Optional: add your Pull Zone URL (e.g. `https://myzone.b-cdn.net`) to get public links in the `.json` files.

## Use it

1. Log in to instagram.com in the same browser.
2. Open a **profile**, click the orange button in the bottom-right corner (or the extension's toolbar icon), pick **Posts** and/or **Reels**, then click **Save all from @user**.
3. On a **post or reel** page, click **Save this post**.

**It runs in the background.** After you click Save, switch to other tabs or windows and keep working:
- The toolbar icon shows how many files are done, then **OK** (or **!**) when it finishes. Hover over it for details.
- You get a desktop notification when it's done. Click it to jump back to the tab.
- While the job runs, the extension stops Chrome's Memory Saver from unloading that tab.

Only the Instagram tab itself has to stay open. Closing it, reloading it, or typing another website into it stops the job. Browsing Instagram inside it is fine. Running the job again picks up where it left off, because files already in Bunny are skipped.

Panel options:
- **Only new** stops after 12 already-saved posts in a row. Use it for regular top-ups.
- **Max posts** limits how many posts are processed (0 = all). Handy for a first test.

## Where files go

```
<zone>/instagram/<username>/posts/2026-09-30_<shortcode>_1.jpg
<zone>/instagram/<username>/posts/2026-09-30_<shortcode>_2.mp4    <- 2nd item of a carousel
<zone>/instagram/<username>/posts/2026-09-30_<shortcode>.json     <- caption, date, likes, links
<zone>/instagram/<username>/reels/2026-09-28_<shortcode>_1.mp4
```

- The date is the post date (UTC).
- The extension always picks the highest resolution Instagram offers.
- The `instagram` folder name can be changed in settings.

## Good to know

- **Instagram access.** The extension uses the same internal endpoints as instagram.com, with your logged-in session, so it can only reach content you can already see. Instagram changes these endpoints now and then; if saving breaks, `src/content/instagram-api.js` is the file to update.
- **Instagram's limits.** Instagram temporarily limits accounts that load too much, too fast. When it does, it often sends its home page instead of the requested data.
  - The extension waits 6–12 s between Instagram requests (the pause is configurable in settings).
  - If Instagram asks it to slow down, it waits 1, 2, then 4 minutes before giving up. If Instagram sends its home page instead, it waits 2, 5, then 15 minutes.
  - Very large profiles take a while, and heavy use can still get an account limited for an hour or more. A VPN makes this more likely.
- **Your password.**
  - It is stored in `chrome.storage.local` on this device only (not synced).
  - Only the extension's hidden uploader page can read it, and it is only ever sent to `*.storage.bunnycdn.com`.
  - Anyone who has it can change or delete everything in the zone, so use a dedicated zone and never share a copy of the extension that has your password in it.
- **Content rights.** Instagram's Terms prohibit automated collection, and most posts are copyrighted. Save your own content or content you have permission to keep. With a public Pull Zone, anyone who has a link can open the file.
- **Not included:** stories, highlights and tagged posts. Firefox is not supported, because the extension relies on Chrome's offscreen documents.

## How it works

| Part | Role |
| --- | --- |
| `src/content/` | Runs on instagram.com: detects the page, draws the panel, calls Instagram's API, runs save jobs. |
| `src/offscreen/` | Hidden extension page. Downloads each file into memory and uploads it with `PUT` to the Bunny Storage API, with a SHA-256 checksum so Bunny rejects corrupted uploads. It exists because Chrome stops service workers whose requests take longer than 30 s. |
| `src/background.js` | Starts the uploader page, keeps the password away from the Instagram tab, shows job progress on the toolbar icon, keeps the job's tab from being unloaded, and sends the "finished" notification. |
| `src/options/` | Settings page. |

## Troubleshooting

| Message | What to do |
| --- | --- |
| Bunny rejected the request (HTTP 401) | Check the zone name, the storage zone password and the region. |
| Log in to Instagram in this browser first | Log in on instagram.com, then try again. |
| … this browser doesn't look logged in to Instagram | Log in at instagram.com in the same Chrome profile the extension is installed in. |
| Instagram is temporarily limiting your account … | Instagram is pausing your account's access for a while. The extension waits and retries by itself. If it still stops, try again in about an hour, turn off any VPN, and keep the pause in settings at 6 or more. Files already saved are skipped. |
| Instagram wants you to confirm your account | Complete the check on instagram.com. |
| … is private and you don't follow them | You can only save what your account can see. |
| The extension was updated or reloaded … | Refresh the Instagram tab. |
| Instagram rate limit, waiting (…) | Normal. It retries automatically. If it gives up, wait about 30 minutes and raise the pause in settings. |

Each error in the panel's log is followed by a `Details:` line, for example `GET /api/v1/feed/user/123/ → HTTP 200 after a redirect to /`. Include it when reporting a problem.
