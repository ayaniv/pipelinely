import { useEffect, useRef, useState } from 'react'
import { postWeeklyFocus, type PostActionOptions } from '../../api/actions'
import { FrameSlot } from '../../components/FrameSlot'
import { weekRangeLabel } from './boardModel'

// The weekly-focus banner: free text, click to edit, saved optimistically.
// Renders into two frame mount points — the dates label and the hero row.

const PLACEHOLDER = "Click to set this week's focus…"

export interface WeeklyFocusProps extends Partial<PostActionOptions> {
  text: string
  now: Date
  locale?: string
}

interface OptimisticSave {
  // Identity for "is this still the save that failed?" — an earlier save
  // failing must not wipe a newer save's text.
  value: string
}

export function WeeklyFocus({ text, now, locale, fetchImpl = fetch, log = console.error }: WeeklyFocusProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [optimistic, setOptimistic] = useState<OptimisticSave | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Escape unmounts the editor, which can still deliver a blur — that blur
  // must not save what was just discarded. Enter has the same shape (save,
  // then the blur its own unmount causes).
  const isFinishedRef = useRef(false)

  const shown = optimistic ? optimistic.value : text

  // The optimistic text lives only until the server says anything different:
  // once `text` changes it is dropped for good, so a later return to an
  // earlier server value can't resurrect a stale optimistic one.
  useEffect(() => { setOptimistic(null) }, [text])

  useEffect(() => {
    if (!isEditing) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [isEditing])

  const startEditing = () => {
    isFinishedRef.current = false
    setDraft(shown)
    setIsEditing(true)
  }

  const save = () => {
    if (isFinishedRef.current) return
    isFinishedRef.current = true
    setIsEditing(false)
    const next = draft.trim()
    const entry: OptimisticSave = { value: next }
    setOptimistic(entry)
    void postWeeklyFocus(next, { fetchImpl, log }).then((outcome) => {
      // Reverting is the honest failure display: showing text that was never
      // persisted would read as saved. postWeeklyFocus already logged it.
      if (!outcome.ok) setOptimistic((current) => (current === entry ? null : current))
    })
  }

  const cancel = () => {
    isFinishedRef.current = true
    setIsEditing(false)
  }

  return (
    <>
      <FrameSlot containerId="weekly-focus-dates">
        <span data-testid="weekly-focus-dates">{weekRangeLabel(now, locale)}</span>
      </FrameSlot>
      <FrameSlot containerId="weekly-focus-row">
        {isEditing ? (
          <textarea
            ref={inputRef}
            className="weekly-focus-input"
            id="weekly-focus-input"
            data-testid="weekly-focus-input"
            rows={1}
            placeholder="What's the focal point this week?"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                save()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
            }}
          />
        ) : (
          <span className={`weekly-focus-text${shown ? '' : ' is-empty'}`} id="weekly-focus-text" data-testid="weekly-focus-text" onClick={startEditing}>
            {shown || PLACEHOLDER}
          </span>
        )}
      </FrameSlot>
    </>
  )
}
