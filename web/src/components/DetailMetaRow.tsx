// The detail head's meta row — pairs come from taskScope.ts's
// detailMetaPairs, computed by the caller (TaskDetail).

export interface DetailMetaRowProps {
  pairs: [string, string][]
}

export function DetailMetaRow({ pairs }: DetailMetaRowProps) {
  return (
    <>
      {pairs.map(([label, value]) => (
        <div className="detail-meta-pair" key={label}>
          <span data-testid="detail-meta-label">{label}</span>
          <span data-testid="detail-meta-value">{value}</span>
        </div>
      ))}
    </>
  )
}
