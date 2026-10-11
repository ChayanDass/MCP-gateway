import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Login } from "./Login";
import { Shell } from "./Shell";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);

  // Ask who is signed in. Only a 401 means "signed out". A network failure gets a retry screen,
  // so a gateway restart does not look like a logout.
  const check = useCallback(() => {
    setUnreachable(false);
    api<Me>("GET", "/api/auth/me")
      .then(setMe)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setUnreachable(true);
      });
  }, []);

  useEffect(check, [check]);

  if (unreachable) {
    return (
      <div className="fatal" role="alert">
        <div className="fatal-card">
          <h1>Can't reach the gateway</h1>
          <p className="muted">The dashboard is running, but the gateway isn't responding. It may be restarting.</p>
          <div className="fatal-actions">
            <button className="primary" onClick={check}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
  if (me === undefined) return <p className="muted pad">Loading…</p>;
  if (me === null) return <Login onLogin={setMe} />;
  return <Shell me={me} onLogout={() => setMe(null)} />;
}
