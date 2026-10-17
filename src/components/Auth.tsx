/**
 * v0.2.3 用户账号前端：登录页、用户菜单、admin 创建账号。
 * 视觉沿用现有 Button / Field / Modal，不引入 UI 库。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  adminListUsers,
  adminResetPassword,
  adminUpdateUser,
  changePassword,
  createAccount,
  login,
  logout,
  type CurrentUser,
} from '../api'
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
  onUserChanged,
}: {
  user: CurrentUser
  onLogout: () => void
  onUserChanged: (user: CurrentUser) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
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
            onClick={() => {
              setOpen(false)
              setPasswordOpen(true)
            }}
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
              onClick={() => {
                setOpen(false)
                setUsersOpen(true)
              }}
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
      {passwordOpen ? (
        <ChangePasswordModal
          onClose={() => setPasswordOpen(false)}
          onChanged={(user) => {
            setPasswordOpen(false)
            onUserChanged(user)
          }}
        />
      ) : null}
      {usersOpen ? <UserManagementModal currentUserId={user.id} onClose={() => setUsersOpen(false)} /> : null}
    </div>
  )
}

/** 改密逻辑与字段（无 form 包裹，由调用方决定放在 Modal 还是整页）。 */
function useChangePasswordFields(onChanged: (user: CurrentUser) => void) {
  const { t, locale } = useI18n()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)

  async function submit() {
    if (submitting) return
    if (newPassword !== confirm) {
      setError({ type: 'translation', key: 'auth.password.mismatch' })
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      onChanged(await changePassword(oldPassword, newPassword))
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.wrong_password'))
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = !submitting && oldPassword !== '' && newPassword !== '' && confirm !== ''
  const fields = (
    <>
      <Field
        id="pw-old"
        label={t('auth.password.old')}
        required
        type="password"
        autoComplete="current-password"
        value={oldPassword}
        onChange={(event) => setOldPassword(event.target.value)}
      />
      <Field
        id="pw-new"
        label={t('auth.password.new')}
        required
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
      />
      <Field
        id="pw-confirm"
        label={t('auth.password.confirm')}
        required
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {error ? (
        <p className="login-card__error" role="alert">
          {resolveUiMessage(error, locale)}
        </p>
      ) : null}
    </>
  )
  return { fields, submit, submitting, canSubmit }
}

function ChangePasswordModal({ onClose, onChanged }: { onClose: () => void; onChanged: (user: CurrentUser) => void }) {
  const { t } = useI18n()
  const { fields, submit, submitting, canSubmit } = useChangePasswordFields(onChanged)
  return (
    <Modal
      title={t('auth.password.title')}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      onClose={onClose}
      submitting={submitting}
      submitLabel={t('auth.password.submit')}
    >
      {fields}
    </Modal>
  )
}

/** v0.2.4：admin 重置临时密码后，用户下次登录强制改密（不可关闭）。 */
export function ForceChangePasswordPage({ onChanged }: { onChanged: (user: CurrentUser) => void }) {
  const { t } = useI18n()
  const { fields, submit, submitting, canSubmit } = useChangePasswordFields(onChanged)
  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-card__title">{t('auth.password.title')}</h1>
        <p role="note">{t('auth.password.mustChange')}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {fields}
          <Button type="submit" disabled={!canSubmit || submitting}>
            {t('auth.password.submit')}
          </Button>
        </form>
      </div>
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

/** v0.2.4：用户管理（admin）。列表、重置密码、停用/启用、改角色。 */
function UserManagementModal({ currentUserId, onClose }: { currentUserId: string; onClose: () => void }) {
  const { t, locale } = useI18n()
  const [users, setUsers] = useState<CurrentUser[] | null>(null)
  const [error, setError] = useState<UiMessage | null>(null)
  const [resetTarget, setResetTarget] = useState<CurrentUser | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = async () => {
    try {
      setUsers(await adminListUsers())
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.request_failed'))
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runAction(id: string, action: () => Promise<unknown>) {
    setBusyId(id)
    setError(null)
    try {
      await action()
      await reload()
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.request_failed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal
      title={t('auth.users.title')}
      onSubmit={(event) => event.preventDefault()}
      onClose={onClose}
      submitLabel={t('auth.users.title')}
      footer={<></>}
      className="modal--wide"
    >
      {error ? <p className="login-card__error" role="alert">{resolveUiMessage(error, locale)}</p> : null}
      {users === null ? (
        <p>{t('auth.login.submitting')}</p>
      ) : (
        <table className="users-table">
          <thead>
            <tr>
              <th>{t('auth.users.username')}</th>
              <th>{t('auth.users.displayName')}</th>
              <th>{t('auth.users.role')}</th>
              <th>{t('auth.users.status')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === currentUserId
              const busy = busyId === u.id
              return (
                <tr key={u.id}>
                  <td>
                    @{u.username}
                    {isSelf ? ` ${t('auth.users.self')}` : null}
                  </td>
                  <td>{u.displayName}</td>
                  <td>{t(u.role === 'admin' ? 'auth.role.admin' : 'auth.role.user')}</td>
                  <td>{u.isActive ? t('auth.users.active') : t('auth.users.inactive')}</td>
                  <td className="users-table__actions">
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      onClick={() => setResetTarget(u)}
                    >
                      {t('auth.users.resetPassword')}
                    </button>
                    {!isSelf ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() => runAction(u.id, () => adminUpdateUser(u.id, { isActive: !u.isActive }))}
                      >
                        {u.isActive ? t('auth.users.deactivate') : t('auth.users.activate')}
                      </button>
                    ) : null}
                    {!isSelf ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() =>
                          runAction(u.id, () => adminUpdateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }))
                        }
                      >
                        {u.role === 'admin' ? t('auth.users.makeUser') : t('auth.users.makeAdmin')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {resetTarget ? (
        <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} onDone={() => setResetTarget(null)} />
      ) : null}
    </Modal>
  )
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: CurrentUser
  onClose: () => void
  onDone: () => void
}) {
  const { t, locale } = useI18n()
  const [newPassword, setNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await adminResetPassword(user.id, newPassword)
      onDone()
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.password_too_short'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={`${t('auth.users.reset.title')} — @${user.username}`}
      onSubmit={handleSubmit}
      onClose={onClose}
      submitting={submitting}
      submitLabel={t('auth.users.resetPassword')}
    >
      <p role="note">{t('auth.users.reset.hint')}</p>
      <Field
        id="reset-new-password"
        label={t('auth.password.new')}
        required
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
      />
      {error ? (
        <p className="login-card__error" role="alert">
          {resolveUiMessage(error, locale)}
        </p>
      ) : null}
    </Modal>
  )
}
