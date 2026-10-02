import { useEffect, type ReactNode } from 'react'
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
  children: ReactNode
}

export function FullPage({ pageId, title, children }: FullPageProps) {
  const navigate = useNavigate()
  useBodyClass('full-page-open')

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') navigate(rememberedBoardTabUrl())
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <div id={pageId} data-testid={pageId}>
      <h2 className="detail-title">{title}</h2>
      {children}
    </div>
  )
}
