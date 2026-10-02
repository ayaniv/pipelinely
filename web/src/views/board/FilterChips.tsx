// The project chip row: every chip toggles independently, and there is no
// synthetic "All" entry — an empty selection already means all (D6).
export interface FilterChipsProps {
  options: readonly string[]
  selected: ReadonlySet<string>
  onToggle: (project: string) => void
}

export function FilterChips({ options, selected, onToggle }: FilterChipsProps) {
  return (
    <>
      {options.map((project) => (
        <button
          key={project}
          type="button"
          className={`filter-chip${selected.has(project) ? ' is-active' : ''}`}
          data-testid={`filter-chip-project-${project}`}
          data-value={project}
          onClick={() => onToggle(project)}
        >
          {project}
        </button>
      ))}
    </>
  )
}
