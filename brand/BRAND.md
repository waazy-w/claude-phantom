# claude-phantom brand kit

The mark is a phantom: the thing that shows up after your process dies, does the work, and
leaves a note. It is green because green is the colour of a passing test — the state phantom
is trying to get you back to.

## Files

| File | Use |
|---|---|
| `phantom-mark.svg` | Primary mark. Transparent background, for light surfaces. |
| `phantom-mark-dark.svg` | Primary mark with soft glow, for dark surfaces (terminals, dark-mode READMEs). |
| `phantom-mark-mono-black.svg` / `-white.svg` / `-green.svg` | Single-colour marks. Eyes are cut out, so they take the background colour. Use for print, embossing, status bars, and anywhere a gradient will not render. |
| `phantom-wordmark.svg` / `phantom-wordmark-dark.svg` | Horizontal lock-up: mark + `phantom` + `CLAUDE-PHANTOM`. |
| `favicon.svg` | Mark on a rounded dark tile. Use for favicons, app icons, avatars. |
| `social-preview.svg` | 1280×640 GitHub social preview / Open Graph card. |
| `png/` | Rasterised exports of all of the above (transparent where the SVG is). |

Regenerate the PNGs with headless Chrome; see `scripts` note at the bottom.

## Colour

| Name | Hex | Role |
|---|---|---|
| Phantom Green | `#2EE59D` | Primary. Mark on dark, accent text on dark, terminal highlights. |
| Mint | `#5CF0B4` | Top of the body gradient; highlights. |
| Deep Green | `#0F9D6A` | Accent on light surfaces (passes AA on white for large text; use Graphite for body). |
| Void | `#0B1210` | Dark ground. Eyes. Text on light. |
| Graphite | `#1F2A25` | Body text on light surfaces. |
| Sage | `#9DB8AB` | Secondary text on dark surfaces. |
| Mist | `#F3FBF7` | Light ground. Text on dark. |

The body gradient runs Mint `#5CF0B4` (top) → `#1FC985` (bottom), vertical. When a gradient is
unavailable, use flat Phantom Green.

Status colours are not brand colours. Phantom's CLI uses the terminal's own yellow for warnings
and red for errors; do not restyle those in green.

## Typography

Everything phantom says, it says in a terminal, so the brand face is monospace.

- **Display / wordmark:** the system monospace stack — `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`. Bold, tight tracking (−3%) for `phantom`; medium, wide tracking (+12%) uppercase for `CLAUDE-PHANTOM`.
- **Web/docs body:** IBM Plex Sans (or the system sans). Pair with JetBrains Mono or IBM Plex Mono for code and labels.

The SVG wordmarks reference the system stack rather than embedding a font, so they render
slightly differently per platform. For pixel-stable use, ship the PNGs.

## The mark

- Built on a 256 unit grid. Body: 160 wide, 80 radius dome, three 53.33-unit lobes at the hem.
- Eyes are 22×40 pills with a 6×12 catchlight. Keep both; the mark reads as a ghost and not a
  blob because of them.
- **Clear space:** keep a margin of at least one eye-width (22/256 of the mark's width) on all sides.
- **Minimum size:** 16 px for the mark, 24 px for the favicon tile, 120 px wide for the wordmark.
- Below 24 px, use the mono variants — the gradient and catchlight disappear anyway.

## Do / don't

- Do use the dark variant on dark backgrounds; the glow is what separates it from the ground.
- Do use the mono variants when you only get one colour.
- Don't recolour the mark. Green is the identity. The one exception is the mono-black/white variants.
- Don't rotate, skew, add a drop shadow, or outline it.
- Don't put text inside or over the mark.
- Don't stretch the wordmark; scale it proportionally.
- Don't use the social preview as a logo; it is a card.

## Voice

Lowercase, short, declarative. `phantom` is a binary, not a product name, and is written in
lowercase code style in prose. The package is `claude-phantom`. The CLI prefix is `phantom ›`.

Example: *your app crashed. phantom is on it.*

## Regenerating PNGs

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=512,512 \
  --screenshot=brand/png/phantom-mark-512.png "file://$PWD/brand/phantom-mark.svg"
```

Wrap the SVG in an `<img>` sized to the window when the target size differs from the SVG's
intrinsic size.
