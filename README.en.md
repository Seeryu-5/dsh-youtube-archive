# dsh-youtube-archive

> **Watch it, own it.** Every YouTube video you actually play in Brave becomes a local Markdown note with captions, translation, paragraph notes and English expressions.

MIT · macOS + Brave · DeepSeek Harness plugin

Most tools start from "I want to summarize this video". This one starts from "I already watched it, so it is in my library."

- **Local-first.** Captions, translations and notes never leave your disk. Plain Markdown you own.
- **Pay only when you click.** No model calls while playing or capturing. Summary and translation are buttons with a token estimate.
- **Long videos don't get truncated.** Manual translation runs in batches, resumes after interruption, and has no total-chunk cap.
- **Logged-in captions.** Captions are read from the player response, so members-only and age-restricted videos work too.

## Why not just use BibiGPT / NoteGPT / Immersive Translate?

They are better for "understand one video quickly", and you should use them for that. This project exists for a narrower case:

| | BibiGPT / NoteGPT | Immersive Translate | **This** |
| --- | --- | --- | --- |
| Trigger | Paste a link | Open the page | **Auto-archive after 45s of playback** |
| Data location | Vendor cloud | Local render, cloud translate | **Fully local** |
| Output | Web page / PDF | Bilingual page | **Markdown tree + index** |
| Pricing | Subscription | Free / Pro | **Pay per token, or local model** |
| Long videos | Length limits | N/A | **Batched, resumable** |
| Logged-in captions | Usually unavailable | N/A | **Yes** |

## How it works

```
Brave (youtube.com, logged in)
  content.js        playback state + page metadata
  injected-main.js  captions from the player response (MAIN world)
  content.js        live CC overlay, captured segment by segment
        │ chrome.runtime
  background.js     retry queue → POST 127.0.0.1
        ▼
DSH plugin (Node host)
  ingest-server → tracker (effective watch time) → local Markdown archive
        └─ model calls only when you press a button
```

Effective watch time is media time: paused, seeking and muted-background time do not count. A note is created after `minWatchSeconds` (default 45s).

## Install

Requirements: macOS, Brave, and a working DeepSeek Harness desktop install.

```bash
git clone https://github.com/Seeryu-5/dsh-youtube-archive.git
cd dsh-youtube-archive

# adjust the CLI path to your DSH installation
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "file:$PWD"
```

Restart DeepSeek Harness (plugin modules are cached and not hot-reloaded).

Then load `extension/` via `brave://extensions` → Developer mode → Load unpacked. Open the extension options and press "测试连接" to verify the port and archive count.

Play a video for at least 45 seconds; a placeholder note appears within ~30 seconds. Captions are written when playback ends or after one minute of idle. Open `http://127.0.0.1:47821/` and use the 总结 / 字幕 tabs to generate a summary or translation on demand.

Full manual (Chinese): [使用手册.md](使用手册.md).

## Configuration

Add overrides to `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: dsh-youtube-archive
  config:
    outputDir: ~/Documents/YouTube知识库
    minWatchSeconds: 45
    autoSummary: false   # manual by default
    autoTranslate: false # manual by default
```

See the Chinese README for the full option table.

## Token cost

Playback, caption capture, indexing and browsing make **zero** model calls. Only the two buttons cost money, and each shows an estimate first.

## Privacy

- Local server binds to `127.0.0.1`, requires the `X-DSH-Archive: 1` header, rejects browser origins.
- The extension only matches `https://www.youtube.com/*` and only posts to `127.0.0.1`.
- Summary and translation send title/description/captions to the model provider you configured in DSH — same as a normal chat. Don't press the button if you don't want that.
- This project does not download videos, bypass paywalls or crawl at scale. Use it in line with YouTube's Terms of Service.

## Limitations

- Only verified on Brave (Chromium 152).
- Requires DeepSeek Harness; standalone mode is on the roadmap.
- macOS system-level Live Captions are not in the DOM and cannot be captured.
- Auto-caption segmentation and proper nouns are limited by YouTube ASR.

## Development

```bash
node --test test/*.test.mjs
./scripts/deploy-local.sh   # sync into the DSH profile and restart DSH
```

## License

[MIT](LICENSE) © 2026 chenrumeng
