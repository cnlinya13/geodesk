/**
 * v0.2.3 用户账号前端：登录页、用户菜单、admin 创建账号。
 * 视觉沿用现有 Button / Field / Modal，不引入 UI 库。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createAccount, login, logout, type CurrentUser } from '../api'
import { apiErrorMessage, resolveUiMessage, useI18n, type UiMessage } from '../i18n'
import { Button, Field, Modal } from './UI'

export function LoginPage({ onLoggedIn }: { onLoggedIn: (user: CurrentUser) => void }) {
  const { t, locale } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      onLoggedIn(await login(username.trim(), password))
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.invalid_credentials'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-card__title">{t('auth.login.title')}</h1>
        <Field
          id="login-username"
          label={t('auth.login.username')}
          required
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <Field
          id="login-password"
          label={t('auth.login.password')}
          required
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? (
          <p className="login-card__error" role="alert">
            {resolveUiMessage(error, locale)}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting || username.trim() === '' || password === ''}>
          {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>
    </div>
  )
}

export function UserMenu({
  user,
  onLogout,
}: {
  user: CurrentUser
  onLogout: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  async function handleLogout() {
    try {
      await logout()
    } finally {
      onLogout()
    }
  }

  const isAdmin = user.role === 'admin'

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        className="user-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-menu__name">{user.displayName}</span>
        <span className={`user-menu__role user-menu__role--${user.role}`}>
          {t(isAdmin ? 'auth.role.admin' : 'auth.role.user')}
        </span>
      </button>
      {open ? (
        <div className="user-menu__popover" role="menu" aria-label={t('auth.menu.account')}>
          <div className="user-menu__header">
            <div className="user-menu__header-name">{user.displayName}</div>
            <div className="user-menu__header-username">@{user.username}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="user-menu__item"
            disabled
            title={t('auth.comingSoon')}
            onClick={() => setOpen(false)}
          >
            {t('auth.changePassword')}
          </button>
          {isAdmin ? (
            <button
              type="button"
              role="menuitem"
              className="user-menu__item"
              onClick={() => {
                setOpen(false)
                setCreateOpen(true)
              }}
            >
              {t('auth.createAccount')}
            </button>
          ) : null}
          {isAdmin ? (
            <button
              type="button"
              role="menuitem"
              className="user-menu__item"
              disabled
              title={t('auth.comingSoon')}
              onClick={() => setOpen(false)}
            >
              {t('auth.userManagement')}
            </button>
          ) : null}
          <button type="button" role="menuitem" className="user-menu__item" onClick={handleLogout}>
            {t('auth.logout')}
          </button>
        </div>
      ) : null}
      {createOpen ? <CreateAccountModal onClose={() => setCreateOpen(false)} /> : null}
    </div>
  )
}

function CreateAccountModal({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    setSuccess(false)
    try {
      await createAccount({
        username: username.trim(),
        password,
        displayName: displayName.trim() || undefined,
        role,
      })
      setUsername('')
      setPassword('')
      setDisplayName('')
      setRole('user')
      setSuccess(true)
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.username_taken'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={t('auth.create.title')}
      onSubmit={handleSubmit}
      onClose={onClose}
      submitting={submitting}
      submitLabel={t('auth.create.submit')}
      error={error ? resolveUiMessage(error, locale) : undefined}
    >
      {success ? <p role="status">{t('auth.create.success')}</p> : null}
      <Field
        id="create-username"
        label={t('auth.create.username')}
        required
        autoComplete="off"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <Field
        id="create-password"
        label={t('auth.create.password')}
        required
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Field
        id="create-display-name"
        label={t('auth.create.displayName')}
        autoComplete="off"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <div className="field">
        <label htmlFor="create-role">{t('auth.create.role')}</label>
        <select id="create-role" value={role} onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'user')}>
          <option value="user">{t('auth.role.user')}</option>
          <option value="admin">{t('auth.role.admin')}</option>
        </select>
      </div>
    </Modal>
  )
}
