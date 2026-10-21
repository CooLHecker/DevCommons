import { useEffect } from 'react'
import './auth.css'
import { classes } from './classes'

/**
 * The frame around every screen.
 *   layout      'fullscreen' (default) | 'inline' (flows inside your own container) | 'modal'
 *   logo        node shown above the title
 *   header      node (or function returning one) that replaces the whole title block
 *   classNames  extra classes per element, see classes.js
 *   onClose     modal only: called on Escape / backdrop click
 */
export default function AuthLayout({ title, subtitle, children, footer, layout = 'fullscreen', logo, header, classNames, onClose }) {
  const c = classes(classNames)

  useEffect(() => {
    if (layout !== 'modal' || !onClose) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [layout, onClose])

  const card = (
    <section
      className={c('card')}
      {...(layout === 'modal' ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : undefined } : {})}
    >
      {header !== undefined ? (
        typeof header === 'function' ? header({ title, subtitle }) : header
      ) : (
        <header className={c('header')}>
          {logo && <div className="auth-logo">{logo}</div>}
          <h1 className={c('title')}>{title}</h1>
          {subtitle && <p className={c('subtitle')}>{subtitle}</p>}
        </header>
      )}
      {children}
      {footer && <footer className={c('footer')}>{footer}</footer>}
    </section>
  )

  const pageClass = `${c('page')} auth-page--${layout}`
  if (layout === 'fullscreen') return <main className={pageClass}>{card}</main>
  return (
    <div className={pageClass} onMouseDown={layout === 'modal' && onClose ? (e) => e.target === e.currentTarget && onClose() : undefined}>
      {card}
    </div>
  )
}

export function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  )
}
