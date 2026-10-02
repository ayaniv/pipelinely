import type { MergeBanner as MergeBannerData } from '../api/actions'

// The persistent merge failure/warning banner (Design §7): a multi-line
// blocker list doesn't fit in a button-flash label, and a flash on a button
// an SSE push then replaces would be lost.

export function MergeBanner({ banner }: { banner: MergeBannerData | null }) {
  if (!banner) return null
  return (
    <div className="ctx-warning merge-banner" data-testid="merge-banner" data-tone={banner.tone}>
      <ul>
        {banner.lines.map((line, index) => (
          <li key={index} data-testid="merge-banner-line">{line}</li>
        ))}
      </ul>
    </div>
  )
}
