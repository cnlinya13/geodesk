import {
  ArrowRight,
  BadgeCheck,
  Building2,
  ChevronRight,
  CircleCheck,
  Copy,
  Download,
  FileCheck,
  Globe,
  LayoutDashboard,
  Link,
  ListChecks,
  LockKeyhole,
  LockKeyholeOpen,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Ruler,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Children, memo, useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import type { StageId, StageState } from '../types'
import { localeName, useI18n, type LocalePreference } from '../i18n'

export type IconName =
  | 'layout-dashboard' | 'settings' | 'plus' | 'sparkles' | 'globe' | 'link' | 'save'
  | 'chevron-right' | 'arrow-right' | 'x' | 'copy' | 'circle-check' | 'pencil'
  | 'search' | 'play' | 'refresh-cw' | 'download' | 'badge-check' | 'ruler'
  | 'file-check' | 'lock-keyhole' | 'lock-keyhole-open' | 'message-square' | 'building-2' | 'target' | 'list-checks' | 'shield-check' | 'trash-2'

const iconComponents: Record<IconName, LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  settings: Settings,
  plus: Plus,
  sparkles: Sparkles,
  globe: Globe,
  link: Link,
  save: Save,
  'chevron-right': ChevronRight,
  'arrow-right': ArrowRight,
  x: X,
  copy: Copy,
  'circle-check': CircleCheck,
  pencil: Pencil,
  search: Search,
  play: Play,
  'refresh-cw': RefreshCw,
  download: Download,
  'badge-check': BadgeCheck,
  ruler: Ruler,
  'file-check': FileCheck,
  'shield-check': ShieldCheck,
  'lock-keyhole': LockKeyhole,
  'lock-keyhole-open': LockKeyholeOpen,
  'message-square': MessageSquare,
  'building-2': Building2,
  target: Target,
  'list-checks': ListChecks,
  'trash-2': Trash2,
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Component = iconComponents[name]
  return <Component size={size} strokeWidth={1.8} aria-hidden="true" />
}

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  icon?: ReactNode
}

export function Button({ variant = 'primary', icon, className = '', children, ...props }: ButtonProps) {
  return (
    <button className={`button button--${variant} ${className}`.trim()} {...props}>
      {icon ? <span className="button__icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </button>
  )
}

export function MetricCard({ label, value, caption, icon, className = '' }: {
  label: string
  value: ReactNode
  caption?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div className={`metric-card ${className}`.trim()}>
      <div className="metric-card__top"><span>{label}</span>{icon ? <span className="metric-card__icon" aria-hidden="true">{icon}</span> : null}</div>
      <div className="metric-card__value-row"><strong>{value}</strong>{caption !== undefined ? <small>{caption}</small> : null}</div>
    </div>
  )
}

export function OperationBar({ left, center, right, className = '' }: {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return <div className={`operation-bar ${className}`.trim()}><div className="operation-bar__left">{left}</div><div className="operation-bar__center">{center}</div><div className="operation-bar__right">{right}</div></div>
}

export type OperationFeedbackTone = 'neutral' | 'success' | 'warning' | 'error'

function hasOperationFeedbackContent(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (typeof child === 'string') return child.trim().length > 0
    if (typeof child === 'number') return true
    return Boolean(child)
  })
}

export function OperationFeedback({ children, tone = 'neutral', className = '' }: {
  children?: ReactNode
  tone?: OperationFeedbackTone
  className?: string
}) {
  if (!hasOperationFeedbackContent(children)) return null
  return (
    <div
      className={`operation-feedback operation-feedback--${tone} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {children}
    </div>
  )
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={`icon-button ${className}`.trim()} type="button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  )
}

type FieldProps = {
  id: string
  label: string
  required?: boolean
  error?: string
  hint?: string
  disabled?: boolean
  multiline?: boolean
  rows?: number
} & Omit<InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>

export function Field({ id, label, required, error, hint, disabled, multiline, rows = 5, ...props }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="field__required"> *</span> : null}
      </label>
      {multiline ? (
        <textarea id={id} rows={rows} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy} {...props} />
      ) : (
        <input id={id} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={describedBy} {...props} />
      )}
      {hint ? <p id={`${id}-hint`} className="field__hint">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="field__error" role="alert">{error}</p> : null}
    </div>
  )
}

export function StatusBadge({ tone = 'neutral', children }: { tone?: 'success' | 'warning' | 'danger' | 'neutral'; children: ReactNode }) {
  return <span className={`status-badge status-badge--${tone}`}><span className="status-badge__dot" aria-hidden="true" />{children}</span>
}

export function Modal({ title, titleAccessory, children, onSubmit, onClose, submitting = false, submitLabel, error, footer, className = '', focusManagement = false, closeOnBackdrop = false }: {
  title: string
  titleAccessory?: ReactNode
  children: ReactNode
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onClose: () => void
  submitting?: boolean
  submitLabel: string
  error?: string
  footer?: ReactNode
  className?: string
  focusManagement?: boolean
  closeOnBackdrop?: boolean
}) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  const submittingRef = useRef(submitting)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => { submittingRef.current = submitting }, [submitting])

  useEffect(() => {
    if (!focusManagement || typeof document === 'undefined') return
    const dialog = dialogRef.current
    if (!dialog) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const scrollContainer = document.querySelector<HTMLElement>('.workspace-stage-viewport')
    const previousScrollTop = scrollContainer?.scrollTop ?? null
    const previousContainerOverflow = scrollContainer?.style.overflow ?? ''
    const previousBodyOverflow = document.body.style.overflow
    if (scrollContainer) scrollContainer.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'

    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusFirst = () => {
      const first = dialog.querySelector<HTMLElement>(focusableSelector)
      first?.focus()
    }
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!submittingRef.current) {
          event.preventDefault()
          closeRef.current()
        }
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusables()
      if (elements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const focusTimer = window.setTimeout(focusFirst, 0)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      if (scrollContainer) {
        scrollContainer.style.overflow = previousContainerOverflow
        if (previousScrollTop !== null) scrollContainer.scrollTop = previousScrollTop
      }
      document.body.style.overflow = previousBodyOverflow
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [focusManagement])

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget && !submitting) onClose()
      }}
    >
      <div ref={dialogRef} className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={focusManagement ? -1 : undefined}>
        <form onSubmit={onSubmit}>
          <div className="modal__header">
            {titleAccessory ? <div className="modal__title-group"><h2 id="modal-title">{title}</h2><span className="modal__title-accessory">{titleAccessory}</span></div> : <h2 id="modal-title">{title}</h2>}
            <IconButton label={t('common.closed')} onClick={onClose} disabled={submitting}><Icon name="x" size={17} /></IconButton>
          </div>
          <div className="modal__body">
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            {children}
          </div>
          {footer ?? (
            <div className="modal__footer">
              <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button>
              <Button type="submit" icon={<Icon name="arrow-right" size={16} />} disabled={submitting}>{submitting ? t('common.saving') : submitLabel}</Button>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

export const stages: Array<{ id: StageId; label: string }> = [
  { id: 'scope', label: '监测口径' },
  { id: 'diagnosis', label: '诊断报告' },
  { id: 'optimization', label: '优化建议' },
  { id: 'monitoring', label: '持续监测' },
]

export const PhaseNav = memo(function PhaseNav({ active, states, onSelect, disabledReasons = {} }: { active: StageId; states: Record<StageId, StageState>; onSelect: (id: StageId) => void; disabledReasons?: Partial<Record<StageId, string>> }) {
  const { t } = useI18n()
  const stageLabels: Record<StageId, string> = {
    scope: t('phase.scope'),
    diagnosis: t('phase.diagnosis'),
    optimization: t('phase.optimization'),
    monitoring: t('phase.monitoring'),
  }
  return (
    <nav className="phase-nav" aria-label={t('phase.aria')}>
      {stages.map((stage, index) => {
        const state = states[stage.id]
        const isActive = active === stage.id
        return (
          <span className="phase-nav__item-wrap" key={stage.id}>
            <button
              type="button"
              className={`phase-nav__item phase-nav__item--${state} ${isActive ? 'phase-nav__item--active' : ''}`}
              aria-current={isActive ? 'step' : undefined}
              disabled={state === 'disabled'}
              onClick={() => onSelect(stage.id)}
              title={state === 'disabled' ? disabledReasons[stage.id] ?? t('phase.disabledTitle') : undefined}
            >
              <span className="phase-nav__index">{String(index + 1)}</span>
              <span>{stageLabels[stage.id]}</span>
            </button>
            {index < stages.length - 1 ? <span className="phase-nav__arrow" aria-hidden="true"><Icon name="arrow-right" size={18} /></span> : null}
          </span>
        )
      })}
    </nav>
  )
})

export function GlobalHeader({ projectName, onHome, onEdit, editLabel }: {
  projectName?: string
  onHome: () => void
  onEdit?: () => void
  editLabel?: string
}) {
  const { t, preference, locale, setPreference } = useI18n()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) setSettingsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setSettingsOpen(false)
      settingsButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [settingsOpen])

  useEffect(() => {
    if (settingsOpen) settingsButtonRef.current?.focus()
  }, [settingsOpen])

  return (
    <header className={`global-header ${projectName ? 'global-header--project' : ''}`.trim()}>
      <div className="global-header__left">
        <button type="button" className="brand-button" onClick={onHome} aria-label={t('header.homeAria')}><Icon name="layout-dashboard" size={14} /><span>{t('header.workspace')}</span></button>
        {projectName ? (
          <div className="project-context">
            <span className="project-context__divider" aria-hidden="true" />
            <div className="project-context__company">
              <span className="project-context__name" title={projectName}>{projectName}</span>
              {onEdit ? <IconButton label={editLabel ?? t('header.editProject')} className="icon-button--small" onClick={onEdit}><Icon name="pencil" size={14} /></IconButton> : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className="settings-menu" ref={settingsRef}>
        <button
          ref={settingsButtonRef}
          type="button"
          className="settings-button"
          aria-label={t('settings.button')}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        ><Icon name="settings" size={22} /></button>
        {settingsOpen ? (
          <div className="settings-popover" role="dialog" aria-label={t('settings.title')}>
            <div className="settings-popover__title">{t('settings.title')}</div>
            <fieldset className="settings-popover__options">
              <legend className="sr-only">{t('settings.title')}</legend>
              <label><input type="radio" name="geodesk-locale" checked={preference === 'auto'} onChange={() => setPreference('auto')} /><span>{t('settings.auto')}</span></label>
              <label><input type="radio" name="geodesk-locale" checked={preference === 'zh-CN'} onChange={() => setPreference('zh-CN')} /><span>{t('settings.zh')}</span></label>
              <label><input type="radio" name="geodesk-locale" checked={preference === 'en'} onChange={() => setPreference('en')} /><span>{t('settings.en')}</span></label>
            </fieldset>
            <div className="settings-popover__current">{t('settings.current', { locale: localeName(locale) })}</div>
          </div>
        ) : null}
      </div>
    </header>
  )
}
