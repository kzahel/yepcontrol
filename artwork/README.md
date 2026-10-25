# YepControl artwork

`icon.svg` and `feature-graphic.svg` are editable vector sources. Their PNG
exports are the 512 × 512 Google Play icon and 1024 × 500 feature graphic.
The phone outline distinguishes YepControl from its sibling while retaining
the owner's green Y/check family mark, adapted from the MIT-licensed
[YepAnywhere artwork](https://github.com/kzahel/yepanywhere/tree/main/packages/android/artwork).
Copyright 2026 Kyle Graehl; project MIT license applies.

Render with librsvg:

```sh
rsvg-convert -o artwork/play-store-icon.png artwork/icon.svg
rsvg-convert -o artwork/feature-graphic.png artwork/feature-graphic.svg
```

The native adaptive launcher icon uses the same phone/Y mark and a solid
family-green background. API 33+ includes a monochrome themed icon.
Store screenshots must be captured from the actual app with synthetic content;
keep raw captures private and copy only reviewed, intentionally public exports
into the distribution folder. Never publish a live pairing code or phone data.

## Google Play website badge

`web/public/google-play-badge.png` is Google's official English badge, downloaded
2026-10-25 from
https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png.
It links to YepControl's public listing. Google Play and its logo are Google LLC
trademarks; this third-party brand asset is not relicensed under this project's
MIT license. Preserve the supplied badge artwork and proportions.
