import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Me } from "./api";
import { GatewayMark } from "./Logo";
import { Notice } from "./shared";

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
    <div className="grid min-h-screen place-items-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <GatewayMark size={44} />
          <CardTitle className="pt-2 text-xl">MCP Gateway</CardTitle>
          <CardDescription>Sign in with your team account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {googleClientId && <div ref={buttonRef} className="flex justify-center" />}
          {googleClientId && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
            {error && <Notice tone="err">{error}</Notice>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
