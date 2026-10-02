import type { DoneDateGroup } from '../../../../src/types'
import { DENSITY_WEEKS, buildDensityGrid, sessionDensityByDay } from './densityModel'

// The You panel: the design's own GitHub-style 53-week density calendar. Its
// exact shade values and layout come from the design file, since those are
// visual constants, not demo content; the level bucketing scales real counts
// against the busiest real day (see densityModel.ts). The whole content of
// the panel, so it renders unconditionally — an empty grid is the honest
// answer for a history with no sessions, where a blank panel would look
// broken. Gets the UNFILTERED done groups: You is a whole-history view.

const DENSITY_SHADES = ['var(--grid)', 'var(--sageSoft)', '#bcd0d9', 'var(--accent)', '#4d7689']
const DENSITY_DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']
// A month run narrower than this has no room for its own label without
// overlapping the next one — left blank rather than crowded.
const MIN_LABELLED_MONTH_WEEKS = 2
const DAY_LABEL_GUTTER_PX = 34

const emptyBorder = (level: number) => (level === 0 ? 'var(--border)' : 'transparent')

export function YouView({ doneGroups, now }: { doneGroups: DoneDateGroup[]; now: Date }) {
  const { weeks, monthRuns, total } = buildDensityGrid(sessionDensityByDay(doneGroups), now)

  return (
    <div className="work-density">
      <div className="work-density-head">
        <span data-testid="density-total" data-count={total}>{total.toLocaleString('en-US')} sessions in the last year</span>
        <span className="work-density-label">work density</span>
      </div>
      <div className="work-density-card">
        <div className="work-density-scroll">
          <div className="work-density-grid">
            <div className="work-density-months" style={{ marginLeft: DAY_LABEL_GUTTER_PX }}>
              {monthRuns.map((run, index) => (
                <div
                  key={index}
                  style={{ flex: `${run.weeks} 1 0`, minWidth: 0, fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden' }}
                >
                  {run.weeks < MIN_LABELLED_MONTH_WEEKS ? '' : run.label}
                </div>
              ))}
            </div>
            <div className="work-density-body">
              <div className="work-density-daylabels">
                {DENSITY_DAY_LABELS.map((label, index) => (
                  <div
                    key={index}
                    style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', fontSize: 10.5, lineHeight: 1, color: 'var(--text3)' }}
                  >
                    {label}
                  </div>
                ))}
              </div>
              <div className="work-density-weeks">
                {weeks.map((week, weekIndex) => (
                  <div key={weekIndex} style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 0', minWidth: 0 }}>
                    {week.map((cell) => (
                      <div
                        key={cell.key}
                        data-testid="density-cell"
                        data-date={cell.key}
                        data-count={cell.count}
                        data-level={cell.level}
                        title={`${cell.count} session${cell.count === 1 ? '' : 's'} · ${cell.label}`}
                        style={{
                          width: '100%', minWidth: 6, aspectRatio: '1', borderRadius: 2, boxSizing: 'border-box',
                          background: DENSITY_SHADES[cell.level], border: `1px solid ${emptyBorder(cell.level)}`,
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="work-density-legend">
          <span>less</span>
          {DENSITY_SHADES.map((background, level) => (
            <div key={level} className="work-density-swatch" style={{ background, border: `1px solid ${emptyBorder(level)}` }} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  )
}

// Exported for the test that pins the grid's size to the model's.
export { DENSITY_WEEKS }
