// Small "ⓘ" icon that shows an explanation on hover or keyboard focus.
// Pure CSS tooltip (see .info-tip rules in App.css) — no library needed.
// Usage: <InfoTip text="Explanation shown on hover" />
// Pass align="right" when the icon sits in the rightmost column of a table,
// so the bubble doesn't run off the edge of the screen.
export default function InfoTip({ text, align = 'left' }) {
  if (!text) return null
  return (
    <span className={`info-tip ${align === 'right' ? 'align-right' : ''}`} tabIndex={0} data-tooltip={text}>
      i
    </span>
  )
}
