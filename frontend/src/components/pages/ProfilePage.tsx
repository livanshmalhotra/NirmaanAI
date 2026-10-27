import { useState, useRef } from 'react';
import { Camera, Mail, User, Shield, Save, ArrowLeft, LogOut, Bell, Crown, Loader2, CheckCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { updateProfile } from 'firebase/auth';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { auth, storage } from '../../lib/firebase';

interface ProfilePageProps {
  onBack: () => void;
}

export function ProfilePage({ onBack }: ProfilePageProps) {
  const { user, signOut } = useAuth();

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [photoPreview, setPhotoPreview] = useState<string | null>(user?.photoURL ?? null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const initials = (displayName || user?.displayName || user?.email?.[0] || 'U')
    .split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Validate size (max 5 MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Photo must be under 5 MB.');
      return;
    }
    setPendingFile(file);
    const reader = new FileReader();
    reader.onload = ev => setPhotoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    setError('');
  };

  const uploadPhoto = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const storageRef = ref(storage, `avatars/${auth.currentUser!.uid}/profile.jpg`);
      const task = uploadBytesResumable(storageRef, file, { contentType: file.type });
      task.on(
        'state_changed',
        snap => setUploadProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
        err => reject(err),
        async () => {
          const url = await getDownloadURL(task.snapshot.ref);
          setUploadProgress(null);
          resolve(url);
        }
      );
    });
  };

  const handleSave = async () => {
    if (!auth.currentUser) return;
    setSaving(true);
    setError('');
    try {
      let photoURL = user?.photoURL ?? null;

      // Upload new photo if one was picked
      if (pendingFile) {
        photoURL = await uploadPhoto(pendingFile);
        setPendingFile(null);
      }

      await updateProfile(auth.currentUser, {
        displayName: displayName.trim() || (user?.displayName ?? ''),
        ...(photoURL ? { photoURL } : {}),
      });

      // Reflect new photoURL in preview immediately
      if (photoURL) setPhotoPreview(photoURL);

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed.';
      if (msg.includes('storage/unauthorized')) {
        setError('Storage permission denied. Enable Firebase Storage rules in your console.');
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    padding: '0.75rem 1rem',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '10px',
    color: 'var(--text-primary)',
    fontSize: '0.88rem',
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.2s',
  };

  const hasChanges = displayName !== (user?.displayName ?? '') || !!pendingFile;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div style={{ padding: '1.25rem 2rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.4rem 0.75rem', color: 'var(--text-secondary)', fontSize: '0.78rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Your Profile</h2>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Changes are saved to Firebase Cloud</p>
        </div>
        {saved && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#5c7d59', fontSize: '0.78rem', fontWeight: 600 }}>
            <CheckCircle size={15} /> Saved to cloud
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2rem', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: '600px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Hero card */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', padding: '1.5rem', background: 'rgba(93,107,128,0.036)', border: '1px solid rgba(110,104,144,0.2)', borderRadius: '16px' }}>
            {/* Avatar with upload */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              {photoPreview ? (
                <img src={photoPreview} alt="avatar" style={{ width: '80px', height: '80px', borderRadius: '50%', objectFit: 'cover', border: '3px solid rgba(110,104,144,0.4)' }} />
              ) : (
                <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#5d6b80', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 800, color: '#fff', border: '3px solid rgba(110,104,144,0.4)' }}>
                  {initials}
                </div>
              )}

              {/* Upload progress ring */}
              {uploadProgress !== null && (
                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(43,41,38,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                  <span style={{ fontSize: '0.65rem', fontWeight: 800, color: '#fff' }}>{uploadProgress}%</span>
                </div>
              )}

              {/* Camera button */}
              <button
                onClick={() => fileRef.current?.click()}
                title="Change photo"
                style={{ position: 'absolute', bottom: 0, right: 0, width: '28px', height: '28px', borderRadius: '50%', background: '#5d6b80', border: '2px solid var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
              >
                <Camera size={13} color="#fff" />
              </button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handlePhotoChange} style={{ display: 'none' }} />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.displayName ?? 'User'}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.6rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.email}
              </div>
              {pendingFile && (
                <div style={{ fontSize: '0.65rem', color: '#a57c3a', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <Camera size={10} /> New photo ready — click Save to upload
                </div>
              )}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', background: 'rgba(110,104,144,0.12)', border: '1px solid rgba(110,104,144,0.3)', borderRadius: '20px', padding: '0.2rem 0.65rem' }}>
                <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#5c7d59' }} />
                <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#5f5a80', letterSpacing: '0.06em' }}>FREE PLAN</span>
              </div>
            </div>

            <button onClick={() => onBack()} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#5d6b80', border: 'none', borderRadius: '10px', padding: '0.55rem 1rem', color: '#fff', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>
              <Crown size={13} /> Upgrade
            </button>
          </div>

          {/* Account details form */}
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '16px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ fontSize: '0.65rem', letterSpacing: '0.1em', fontWeight: 700, color: 'var(--text-tertiary)' }}>ACCOUNT DETAILS</div>

            {/* Name */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                <User size={13} /> Full Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Enter your name"
                style={inputStyle}
              />
            </div>

            {/* Email read-only */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                <Mail size={13} /> Email Address
              </label>
              <input
                type="email"
                value={user?.email ?? ''}
                readOnly
                style={{ ...inputStyle, opacity: 0.55, cursor: 'not-allowed' }}
              />
              <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '0.3rem' }}>Email address cannot be changed</div>
            </div>

            {/* Sign-in method */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.65rem 0.85rem', background: 'var(--bg-secondary)', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Shield size={14} color="var(--text-tertiary)" />
                <div>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>Sign-in Method</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
                    {user?.providerData?.[0]?.providerId === 'google.com' ? 'Google' : 'Email & Password'}
                  </div>
                </div>
              </div>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#5c7d59', background: 'rgba(92,125,89,0.1)', border: '1px solid rgba(92,125,89,0.2)', borderRadius: '20px', padding: '0.15rem 0.55rem' }}>Active</span>
            </div>

            {/* Upload progress bar */}
            {uploadProgress !== null && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>
                  <span>Uploading photo to Firebase Storage...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div style={{ height: '4px', background: 'var(--bg-tertiary)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${uploadProgress}%`, background: 'linear-gradient(90deg, #7d8aa3, #8fa9a2)', borderRadius: '2px', transition: 'width 0.2s' }} />
                </div>
              </div>
            )}

            {error && (
              <div style={{ fontSize: '0.75rem', color: '#9a5040', background: 'rgba(176,96,79,0.08)', border: '1px solid rgba(176,96,79,0.2)', borderRadius: '8px', padding: '0.6rem 0.8rem', lineHeight: 1.5 }}>
                {error}
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={saving || (!hasChanges && !pendingFile)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                padding: '0.75rem',
                background: saved ? '#5c7d59' : hasChanges || pendingFile ? '#5d6b80' : 'var(--bg-tertiary)',
                border: 'none', borderRadius: '10px', color: saved || hasChanges || pendingFile ? '#fff' : 'var(--text-tertiary)',
                fontSize: '0.85rem', fontWeight: 700,
                cursor: saving || (!hasChanges && !pendingFile) ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.75 : 1,
                transition: 'background 0.3s',
              }}
            >
              {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : saved ? <CheckCircle size={15} /> : <Save size={14} />}
              {saving ? (uploadProgress !== null ? `Uploading ${uploadProgress}%...` : 'Saving...') : saved ? 'Saved to cloud!' : 'Save Changes'}
              <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
            </button>
          </div>

          {/* Preferences */}
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '16px', padding: '1.5rem' }}>
            <div style={{ fontSize: '0.65rem', letterSpacing: '0.1em', fontWeight: 700, color: 'var(--text-tertiary)', marginBottom: '1rem' }}>PREFERENCES</div>
            {[
              { icon: <Bell size={14} />, label: 'Email Notifications', sub: 'Receive project updates via email', color: '#5c7d59', on: true },
              { icon: <Shield size={14} />, label: 'Two-Factor Auth', sub: 'Available on Identity Platform upgrade', color: 'var(--text-tertiary)', on: false, disabled: true },
            ].map(({ icon, label, sub, color, on, disabled }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.85rem', marginBottom: '0.85rem', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div style={{ color: 'var(--text-tertiary)' }}>{icon}</div>
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>{sub}</div>
                  </div>
                </div>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: disabled ? 'var(--text-tertiary)' : color, background: disabled ? 'var(--bg-secondary)' : on ? 'rgba(92,125,89,0.1)' : 'rgba(165,124,58,0.1)', border: `1px solid ${disabled ? 'var(--border-subtle)' : on ? 'rgba(92,125,89,0.25)' : 'rgba(165,124,58,0.25)'}`, borderRadius: '20px', padding: '0.15rem 0.55rem' }}>
                  {disabled ? 'Unavailable' : on ? 'On' : 'Off'}
                </span>
              </div>
            ))}
          </div>

          {/* Danger zone */}
          <div style={{ background: 'rgba(176,96,79,0.04)', border: '1px solid rgba(176,96,79,0.15)', borderRadius: '16px', padding: '1.5rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.65rem', letterSpacing: '0.1em', fontWeight: 700, color: '#9a5040', marginBottom: '1rem' }}>DANGER ZONE</div>
            <button onClick={signOut} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(176,96,79,0.1)', border: '1px solid rgba(176,96,79,0.25)', borderRadius: '10px', padding: '0.65rem 1.25rem', color: '#9a5040', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              <LogOut size={14} /> Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
