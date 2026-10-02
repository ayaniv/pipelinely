import { ParentLinkIcon } from './icons'

// Renders nothing for a task with no parent relationship (no projectTitle).
// onNavigate is passed in by the caller rather than this component deciding
// how to navigate.

export interface ParentLinkChipProps {
  projectTitle: string | undefined
  projectBase: string | undefined
  testId: string
  onNavigate: (parentSlug: string) => void
}

export function ParentLinkChip({ projectTitle, projectBase, testId, onNavigate }: ParentLinkChipProps) {
  if (!projectTitle) return null
  return (
    <a
      className="card-parent-chip"
      href="#"
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault()
        onNavigate(projectBase || '')
      }}
    >
      <ParentLinkIcon />
      <span>{projectTitle}</span>
    </a>
  )
}
