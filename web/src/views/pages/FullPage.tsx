import { useLayoutEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useBodyClass } from '../../useBodyClass'
import { rememberedBoardTabUrl } from '../board/boardTabRoutes'

// The shared frame of a full page (Settings, Help, Docs): its own /<page> URL
// with the board hidden behind it (body.full-page-open, the class app.css's
// `body.full-page-open #board` rules key on), left with Escape or the
// sidebar's own nav. Mounted by its route, so it exists only while open.

export interface FullPageProps {
  pageId: string
  title: string
  // A line under the title, and something to the right of it. Without either
  // the title stands alone, exactly as on Settings, Help and Docs.
  subtitle?: ReactNode
  headerAside?: ReactNode
  children: ReactNode
}

export function FullPage({ pageId, title, subtitle, headerAside, children }: FullPageProps) {
  const navigate = useNavigate()
  useBodyClass('full-page-open')

  // A layout effect, like useBodyClass: the URL changes in the same commit that
  // mounts this page, and a passive effect attaches after paint, so an Escape
  // pressed right after the URL moved was dropped.
  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') navigate(rememberedBoardTabUrl())
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  const heading = <h2 className="detail-title">{title}</h2>
  const hasHeaderExtras = subtitle !== undefined || headerAside !== undefined

  return (
    <div id={pageId} data-testid={pageId}>
      {hasHeaderExtras ? (
        <div className="full-page-header">
          <div className="full-page-heading">
            {heading}
            {subtitle}
          </div>
          {headerAside}
        </div>
      ) : heading}
      {children}
    </div>
  )
}
