# Vaxity

Profile card page, ready for GitHub Pages.

## Hosting

1. Push everything in this folder to the root of your repo (`vaxity1829/Vaxity`).
2. Repo Settings, Pages, Source: "Deploy from a branch", Branch: `main`, Folder: `/ (root)`.
3. The site goes live at `https://vaxity1829.github.io/Vaxity/`.

All paths are relative, so it also works from a custom domain or a different repo name. If you rename the repo or add a domain, update the two `og:` URLs at the top of `index.html`.

## Layout

- `index.html`: markup and SVG filters
- `css/style.css`: styles
- `js/script.js`: metaball buttons, menu, input handling
- `js/cursor.js`: the star cursor (only loaded on mouse devices)
- `assets/avatar.jpg`, `assets/banner.jpg`: the images
- `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest`: icons made from the profile picture

Change the TikTok and Roblox links in `index.html`.
