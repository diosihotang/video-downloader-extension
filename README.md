# Video Downloader Pro 🎬

Chrome extension for detecting and downloading videos from any website — inspired by yt-dlp and Video DownloadHelper.

## Features

- **Auto-detect** video/audio from network requests (MP4, WebM, MKV, MP3, AAC, OGG, etc.)
- **HLS → MP4 in one click** — downloads every segment of an `.m3u8` stream (best quality), joins them and saves a single MP4. Handles MPEG-TS and fragmented-MP4 (CMAF) streams, byte ranges and AES-128
- **Ignores stream segments** — the `.mp4`/`.ts` pieces a player fetches are not listed (downloading one of those only gave a few seconds of video)
- **DOM scanning** — finds `<video>` and `<audio>` elements, `og:video` meta tags, and JSON-LD structured data
- **Badge counter** — shows number of detected media on the extension icon
- **Named after the page** — e.g. `useState _ Epic React.mp4`
- **Copy URL** — for use with external tools like yt-dlp
- Shows quality, duration and size; progress bar with cancel
- Dark UI with clean card layout

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **"Load unpacked"**
4. Select this folder

## Usage

1. Navigate to any page with a video (YouTube, Twitter, Reddit, news sites, etc.)
2. Play the video so it starts loading
3. Click the extension icon in your toolbar
4. The detected video URLs will appear in the popup
5. Click **Download MP4**. The download keeps running if you close the popup.

## For HLS/DASH Streams

HLS (`.m3u8`) streams are downloaded and converted inside the extension (offscreen document + [mux.js](https://github.com/videojs/mux.js)). DASH (`.mpd`) is detected but not downloadable yet — use **Copy URL** and an external tool:

```bash
yt-dlp "https://example.com/stream.m3u8"
```

Or with ffmpeg:
```bash
ffmpeg -i "https://example.com/stream.m3u8" -c copy output.mp4
```

## File Structure

```
video-downloader-extension/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker: detection, probing, download jobs
├── offscreen.html/.js  # Runs HLS → MP4 jobs (survives the popup closing)
├── lib/hls.js          # Playlist parsing, segment download, MP4 assembly
├── lib/detector.js     # Decides which requests are real videos
├── lib/vendor/mux.min.js  # MPEG-TS → MP4 remuxer (mux.js 7.0.3)
├── content.js          # DOM scanner: finds <video> elements
├── popup.html          # Extension popup UI
├── popup.css           # Popup styles
├── popup.js            # Popup logic
├── icons/              # Extension icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── generate_icons.js   # Script to regenerate icons
└── generate_icons.py   # Alternative icon generator (requires Pillow)
```

## Limitations

- Cannot bypass DRM (Widevine, PlayReady) protected content
- YouTube uses adaptive streaming + DRM — use yt-dlp CLI for YouTube
- HLS with SAMPLE-AES / DRM, separate audio tracks, or live streams are not supported (a clear error is shown)
- The whole video is assembled in memory before saving; very long 1080p videos need a few hundred MB of RAM
