import { useState } from 'react';
import { Mail, Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

type Mode = 'login' | 'signup';

const FIREBASE_ERRORS: Record<string, string> = {
  'auth/invalid-credential':       'Invalid email or password.',
  'auth/user-not-found':           'No account found with this email.',
  'auth/wrong-password':           'Incorrect password.',
  'auth/email-already-in-use':     'An account with this email already exists.',
  'auth/weak-password':            'Password must be at least 6 characters.',
  'auth/invalid-email':            'Please enter a valid email address.',
  'auth/too-many-requests':        'Too many attempts. Try again later.',
  'auth/popup-closed-by-user':     'Google sign-in was cancelled.',
  'auth/network-request-failed':   'Network error. Check your connection.',
  'auth/configuration-not-found':  'Firebase not configured. Add your .env.local credentials.',
};

function friendlyError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return FIREBASE_ERRORS[(err as { code: string }).code] ?? 'Something went wrong. Try again.';
  }
  return 'Something went wrong. Try again.';
}

export function LoginPage() {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await signIn(email, password);
      } else {
        if (!name.trim()) { setError('Please enter your name.'); setLoading(false); return; }
        await signUp(email, password, name.trim());
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '0.75rem 1rem 0.75rem 2.6rem',
    background: 'rgba(60,52,44,0.048)',
    border: '1px solid rgba(60,52,44,0.12)',
    borderRadius: '10px', color: '#2b2926',
    fontSize: '0.88rem', outline: 'none',
    fontFamily: 'inherit', transition: 'border-color 0.2s',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: '#f4f1ec',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Background grid */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: 'linear-gradient(rgba(110,104,144,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(110,104,144,0.04) 1px,transparent 1px)',
        backgroundSize: '48px 48px',
      }} />
      {/* Glow */}
      <div style={{ position: 'absolute', top: '30%', left: '50%', transform: 'translate(-50%,-50%)', width: '600px', height: '400px', pointerEvents: 'none',
        background: 'radial-gradient(ellipse, rgba(110,104,144,0.12) 0%, transparent 70%)' }} />

      <div style={{
        position: 'relative', width: '100%', maxWidth: '420px', margin: '0 1rem',
        background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(110,104,144,0.2)',
        borderRadius: '20px', padding: '2.5rem',
        boxShadow: '0 24px 64px rgba(60,52,44,0.21), 0 0 0 1px rgba(110,104,144,0.1)',
        backdropFilter: 'blur(24px)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '1.3rem', fontWeight: 800, letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
            निर्माण <span style={{ color: '#4f7d78' }}>AI</span>
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#2b2926', marginBottom: '0.25rem' }}>
            {mode === 'login' ? 'Welcome back' : 'Create account'}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'rgba(60,52,44,0.4)' }}>
            {mode === 'login' ? 'Sign in to your workspace' : 'Start designing smarter buildings'}
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {/* Name (signup only) */}
          {mode === 'signup' && (
            <div style={{ position: 'relative' }}>
              <User size={15} color="rgba(60,52,44,0.3)" style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input type="text" placeholder="Full name" value={name} onChange={e => setName(e.target.value)}
                style={inputStyle} autoComplete="name" />
            </div>
          )}

          {/* Email */}
          <div style={{ position: 'relative' }}>
            <Mail size={15} color="rgba(60,52,44,0.3)" style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
            <input type="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)}
              style={inputStyle} autoComplete="email" required />
          </div>

          {/* Password */}
          <div style={{ position: 'relative' }}>
            <Lock size={15} color="rgba(60,52,44,0.3)" style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
            <input type={showPw ? 'text' : 'password'} placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
              style={{ ...inputStyle, paddingRight: '2.8rem' }} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
            <button type="button" onClick={() => setShowPw(v => !v)} style={{
              position: 'absolute', right: '0.85rem', top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'rgba(60,52,44,0.3)', display: 'flex',
            }}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', background: 'rgba(176,96,79,0.1)', border: '1px solid rgba(176,96,79,0.25)', borderRadius: '8px', padding: '0.6rem 0.75rem', fontSize: '0.75rem', color: '#9a5040' }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
              {error}
            </div>
          )}

          {/* Submit */}
          <button type="submit" disabled={loading} style={{
            marginTop: '0.25rem', padding: '0.8rem',
            background: loading ? 'rgba(110,104,144,0.4)' : '#5d6b80',
            border: 'none', borderRadius: '10px', color: '#fff',
            fontSize: '0.88rem', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
            letterSpacing: '0.02em', transition: 'opacity 0.2s',
          }}>
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.1rem 0' }}>
          <div style={{ flex: 1, height: '1px', background: 'rgba(60,52,44,0.096)' }} />
          <span style={{ fontSize: '0.68rem', color: 'rgba(60,52,44,0.3)', fontWeight: 600 }}>OR</span>
          <div style={{ flex: 1, height: '1px', background: 'rgba(60,52,44,0.096)' }} />
        </div>

        {/* Google */}
        <button onClick={handleGoogle} disabled={loading} style={{
          width: '100%', padding: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem',
          background: 'rgba(60,52,44,0.048)', border: '1px solid rgba(60,52,44,0.12)',
          borderRadius: '10px', color: '#2b2926', fontSize: '0.85rem', fontWeight: 600,
          cursor: loading ? 'not-allowed' : 'pointer', transition: 'background 0.2s',
        }}>
          {/* Google G */}
          <svg width="16" height="16" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>

        {/* Toggle mode */}
        <div style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.78rem', color: 'rgba(60,52,44,0.4)' }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError(''); }}
            style={{ background: 'none', border: 'none', color: '#5f5a80', fontWeight: 700, cursor: 'pointer', fontSize: 'inherit', fontFamily: 'inherit', padding: 0 }}>
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
