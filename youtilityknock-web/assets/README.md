# App store art (icons + splash)

These are the **source** images for the iOS and Android app icons and splash
screens. They are turned into every required platform size by
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets):

```bash
npm run assets:generate          # writes into ios/ and android/ (run after `cap add`)
```

CI (`codemagic.yaml`) regenerates them on every build, so the per-size output
is never committed — only these sources are.

| File                  | Size      | Used for |
|-----------------------|-----------|----------|
| `icon-only.png`       | 1024×1024 | iOS app icon (full-bleed) |
| `icon-foreground.png` | 1024×1024 | Android adaptive-icon foreground (transparent) |
| `icon-background.png` | 1024×1024 | Android adaptive-icon background |
| `splash.png`          | 2732×2732 | Launch splash (light) |
| `splash-dark.png`     | 2732×2732 | Launch splash (dark) |

To rebrand, replace these files (keep the names + sizes) and re-run
`npm run assets:generate`. Brand colors: accent `#0ea5e9`, dark `#0f1727`.
