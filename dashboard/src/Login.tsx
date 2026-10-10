import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Me } from "./api";
import { GatewayMark } from "./Logo";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

// Sign in with Google (when configured) or with an email and password.
export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ googleClientId: string }>("GET", "/api/gateway")
      .then((g) => setGoogleClientId(g.googleClientId))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!googleClientId) return;
    const init = () => {
      if (!window.google || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (r) => {
          setError(null);
          setBusy(true);
          try {
            onLogin(await api<Me>("POST", "/api/auth/google", { credential: r.credential }));
          } catch (err) {
            setError(err instanceof Error ? err.message : "Google sign-in failed");
          } finally {
            setBusy(false);
          }
        },
      });
      window.google.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large", width: 320, text: "signin_with" });
    };
    if (window.google) {
      init();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = init;
    document.head.appendChild(script);
  }, [googleClientId, onLogin]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onLogin(await api<Me>("POST", "/api/auth/login", { email, password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login card">
        <div className="login-brand">
          <GatewayMark />
          <h1>MCP Gateway</h1>
        </div>
        <p className="sub">Sign in with your team account.</p>

        {googleClientId && <div ref={buttonRef} className="google-slot" />}
        {googleClientId && <div className="divider"><span>or</span></div>}

        <form className="login-form" onSubmit={submit}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          {error && <p className="error small">{error}</p>}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
