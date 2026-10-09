import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import { Login } from "./Login";
import { Shell } from "./Shell";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api<Me>("GET", "/api/auth/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) return <p className="muted pad">Loading…</p>;
  if (me === null) return <Login onLogin={setMe} />;
  return <Shell me={me} onLogout={() => setMe(null)} />;
}
