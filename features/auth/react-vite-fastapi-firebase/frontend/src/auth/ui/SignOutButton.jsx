import { useAuth } from '../core/AuthContext'

/** <SignOutButton />  or  <SignOutButton className="btn">Log out</SignOutButton> */
export default function SignOutButton({ children = 'Sign out', ...props }) {
  const { logout } = useAuth()
  return (
    <button type="button" onClick={logout} {...props}>
      {children}
    </button>
  )
}
